import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ErasureService } from '@modules/m00-platform/governance/erasure.service';
import { GovernanceAccess } from '@modules/m00-platform/governance/access.ts';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  officerActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_OFFICER_PERSON_ID,
  TEST_OFFICER_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';

/**
 * Wave 2 — DB-backed integration tests for ErasureService.
 * Replaces apps/api/src/modules/m00-platform/governance/erasure.service.spec.ts
 * (if present) and covers the IMMUTABLE dpo_pseudonymisation_log trigger
 * — the 5th DB-level IMMUTABLE contract verified by Wave 1+2 tests.
 *
 * Strategy doc Wave 2 contracts:
 *   - Erasure request → IMMUTABLE pseudonymisation log entry
 *   - dpo_pseudonymisation_log IMMUTABLE: UPDATE/DELETE → SQLSTATE 23001
 *   - Cross-tenant data-subject rejection (GovernanceAccess gate)
 *   - DPO-scope authorization (admin OR dpo-004:write)
 *   - State machine: COMPLETED / DENIED is terminal (immutable status)
 *   - Atomic pseudonymisation: platform_audit_log mutation + log insert
 *     land together or not at all
 *   - listPseudonymisations scoped to current school
 */
describe('integration:m00-platform/governance-erasure', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let access: GovernanceAccess;
  let service: ErasureService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    access = new GovernanceAccess(tenantPrisma);
    service = new ErasureService(tenantPrisma, permCheck, access);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // dpo_pseudonymisation_log carries the IMMUTABLE prevent_mutation
    // trigger so per-row DELETE fails — TRUNCATE bypasses BEFORE ROW.
    await rawClient.$executeRawUnsafe(`TRUNCATE ${TEST_SCHEMA}.dpo_pseudonymisation_log`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.dpo_erasure_requests WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    // Wipe iam_effective_access_cache for the actors so per-test DPO
    // permission seeding is deterministic.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_OFFICER_ACCOUNT_ID,
    );
    // Wipe pseudonymisation audit-log mutations: any prior test that
    // ran pseudonymiseAuditLog replaced platform_audit_log.metadata
    // for the data subject. The seed/audit log rows are otherwise
    // production-relevant; leave any non-test rows alone.
    // (No-op — tests below seed/clean their own audit rows.)
  });

  /**
   * Seed an iam_effective_access_cache row giving the officer actor
   * dpo-004:write at SCHOOL scope, so hasDpoScope returns true via the
   * STAFF + permission path.
   */
  async function grantDpoScopeToOfficer(): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_OFFICER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      ['dpo-004:write'],
    );
  }

  // Officer is the only test actor with hr_employees in the seed —
  // GovernanceAccess.assertDataSubjectInCurrentTenant requires this.
  const VALID_DATA_SUBJECT_ID = TEST_OFFICER_PERSON_ID;

  // ────────────────────────────────────────────────────────────────────
  // hasDpoScope
  // ────────────────────────────────────────────────────────────────────
  describe('hasDpoScope', () => {
    it('school admin → true (short-circuit, no DB lookup)', async () => {
      await withTestTenant(async () => {
        expect(await service.hasDpoScope(adminActor())).toBe(true);
      });
    });

    it.each([
      ['student', studentActor],
      ['parent', parentActor],
    ])('non-STAFF %s → false', async (_label, actor) => {
      await withTestTenant(async () => {
        expect(await service.hasDpoScope(actor())).toBe(false);
      });
    });

    it('STAFF without dpo-004:write → false', async () => {
      await withTestTenant(async () => {
        expect(await service.hasDpoScope(officerActor())).toBe(false);
      });
    });

    it('STAFF with dpo-004:write at SCHOOL scope → true', async () => {
      await grantDpoScopeToOfficer();
      await withTestTenant(async () => {
        expect(await service.hasDpoScope(officerActor())).toBe(true);
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // create + list + getById
  // ────────────────────────────────────────────────────────────────────
  describe('create + list + getById', () => {
    it('admin creates RECEIVED erasure request; getById returns it', async () => {
      const created = await withTestTenant(async () =>
        service.create(adminActor(), {
          dataSubjectId: VALID_DATA_SUBJECT_ID,
          requestDetails: 'GDPR Article 17 request',
        }),
      );
      expect(created.status).toBe('RECEIVED');
      expect(created.dataSubjectId).toBe(VALID_DATA_SUBJECT_ID);
      expect(created.requestDetails).toBe('GDPR Article 17 request');
      expect(created.completedAt).toBeNull();
      expect(created.reviewedById).toBeNull();

      const fetched = await withTestTenant(async () => service.getById(adminActor(), created.id));
      expect(fetched.id).toBe(created.id);
    });

    it('cross-tenant dataSubject → BadRequest (no projection in current tenant)', async () => {
      // A random uuid that's not a person in any tenant
      await expect(
        withTestTenant(async () => service.create(adminActor(), { dataSubjectId: generateId() })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([
      ['officer (no DPO perm)', officerActor],
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
    ])('create as %s → ForbiddenException', async (_label, actor) => {
      await expect(
        withTestTenant(async () =>
          service.create(actor(), { dataSubjectId: VALID_DATA_SUBJECT_ID }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('officer with dpo-004:write can create', async () => {
      await grantDpoScopeToOfficer();
      const created = await withTestTenant(async () =>
        service.create(officerActor(), { dataSubjectId: VALID_DATA_SUBJECT_ID }),
      );
      expect(created.status).toBe('RECEIVED');
    });

    it('list returns all erasure requests for the current school', async () => {
      await withTestTenant(async () => {
        await service.create(adminActor(), { dataSubjectId: VALID_DATA_SUBJECT_ID });
        await service.create(adminActor(), { dataSubjectId: VALID_DATA_SUBJECT_ID });
      });
      const all = await withTestTenant(async () => service.list(adminActor()));
      expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it('list with status filter narrows results', async () => {
      const created = await withTestTenant(async () =>
        service.create(adminActor(), { dataSubjectId: VALID_DATA_SUBJECT_ID }),
      );
      const matching = await withTestTenant(async () =>
        service.list(adminActor(), { status: 'RECEIVED' }),
      );
      expect(matching.find((e) => e.id === created.id)).toBeDefined();
      const empty = await withTestTenant(async () =>
        service.list(adminActor(), { status: 'COMPLETED' }),
      );
      expect(empty.find((e) => e.id === created.id)).toBeUndefined();
    });

    it('list as non-DPO → ForbiddenException', async () => {
      await expect(withTestTenant(async () => service.list(officerActor()))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('cross-school getById → NotFoundException', async () => {
      // Create in School A
      const created = await withTestTenant(async () =>
        service.create(adminActor(), { dataSubjectId: VALID_DATA_SUBJECT_ID }),
      );
      // School B admin cannot see it
      await expect(
        withTestTenantB(async () => service.getById(adminActor(), created.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // update — locked-row + status state machine
  // ────────────────────────────────────────────────────────────────────
  describe('update', () => {
    it('RECEIVED → REVIEWING flips status', async () => {
      const created = await withTestTenant(async () =>
        service.create(adminActor(), { dataSubjectId: VALID_DATA_SUBJECT_ID }),
      );
      const updated = await withTestTenant(async () =>
        service.update(adminActor(), created.id, { status: 'REVIEWING' }),
      );
      expect(updated.status).toBe('REVIEWING');
      expect(updated.completedAt).toBeNull();
    });

    it('RECEIVED → COMPLETED stamps completed_at + reviewedById', async () => {
      const created = await withTestTenant(async () =>
        service.create(adminActor(), { dataSubjectId: VALID_DATA_SUBJECT_ID }),
      );
      const updated = await withTestTenant(async () =>
        service.update(adminActor(), created.id, {
          status: 'COMPLETED',
          categoriesErased: ['profile', 'logs'],
        }),
      );
      expect(updated.status).toBe('COMPLETED');
      expect(updated.completedAt).not.toBeNull();
      expect(updated.reviewedById).not.toBeNull();
      expect(updated.categoriesErased).toEqual(['profile', 'logs']);
    });

    it('RECEIVED → DENIED with denial_basis', async () => {
      const created = await withTestTenant(async () =>
        service.create(adminActor(), { dataSubjectId: VALID_DATA_SUBJECT_ID }),
      );
      const updated = await withTestTenant(async () =>
        service.update(adminActor(), created.id, {
          status: 'DENIED',
          denialBasis: 'Legal hold — pending litigation',
        }),
      );
      expect(updated.status).toBe('DENIED');
      expect(updated.denialBasis).toBe('Legal hold — pending litigation');
      expect(updated.completedAt).not.toBeNull();
    });

    it('COMPLETED is terminal — further updates rejected with BadRequest', async () => {
      const created = await withTestTenant(async () =>
        service.create(adminActor(), { dataSubjectId: VALID_DATA_SUBJECT_ID }),
      );
      await withTestTenant(async () =>
        service.update(adminActor(), created.id, { status: 'COMPLETED' }),
      );
      await expect(
        withTestTenant(async () =>
          service.update(adminActor(), created.id, { status: 'RECEIVED' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('DENIED is terminal — further updates rejected', async () => {
      const created = await withTestTenant(async () =>
        service.create(adminActor(), { dataSubjectId: VALID_DATA_SUBJECT_ID }),
      );
      await withTestTenant(async () =>
        service.update(adminActor(), created.id, {
          status: 'DENIED',
          denialBasis: 'x',
        }),
      );
      await expect(
        withTestTenant(async () =>
          service.update(adminActor(), created.id, { notes: 'changed mind' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('empty patch is a no-op', async () => {
      const created = await withTestTenant(async () =>
        service.create(adminActor(), { dataSubjectId: VALID_DATA_SUBJECT_ID }),
      );
      const result = await withTestTenant(async () => service.update(adminActor(), created.id, {}));
      expect(result.id).toBe(created.id);
      expect(result.status).toBe('RECEIVED');
    });

    it('missing erasure request → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.update(adminActor(), '00000000-0000-0000-0000-000000000000', {
            notes: 'x',
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('update as non-DPO → ForbiddenException', async () => {
      const created = await withTestTenant(async () =>
        service.create(adminActor(), { dataSubjectId: VALID_DATA_SUBJECT_ID }),
      );
      await expect(
        withTestTenant(async () => service.update(officerActor(), created.id, { notes: 'x' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // pseudonymiseAuditLog — atomic platform_audit_log + dpo_pseudonymisation_log
  // ────────────────────────────────────────────────────────────────────
  describe('pseudonymiseAuditLog', () => {
    /**
     * Seed an erasure request + a platform.platform_audit_log row whose
     * actor_id is the data subject. The pseudonymisation should rewrite
     * the metadata to {pseudonymised: <token>} and record one log row.
     */
    async function seedErasureAndAuditRows(opts?: { actorRows?: number }) {
      const erasure = await withTestTenant(async () =>
        service.create(adminActor(), { dataSubjectId: VALID_DATA_SUBJECT_ID }),
      );
      const auditIds: string[] = [];
      const N = opts?.actorRows ?? 2;
      for (let i = 0; i < N; i++) {
        const id = generateId();
        await rawClient.$executeRawUnsafe(
          `INSERT INTO platform.platform_audit_log
             (id, actor_id, actor_type, action, action_category, entity_type, entity_id, tenant_id, metadata)
           VALUES ($1::uuid, $2::uuid, 'HUMAN', 'test_action', 'READ', 'iam_person', $2::uuid, $3::uuid, $4::jsonb)`,
          id,
          VALID_DATA_SUBJECT_ID,
          TEST_SCHOOL_ID,
          JSON.stringify({ original: 'value-' + i }),
        );
        auditIds.push(id);
      }
      return { erasureId: erasure.id, auditIds };
    }

    afterAll(async () => {
      // Clean up any test-created audit rows. The audit table is
      // partitioned and large; only delete rows we wrote.
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_audit_log WHERE action = 'test_action' AND actor_id = $1::uuid`,
        VALID_DATA_SUBJECT_ID,
      );
    });

    it('happy path: writes IMMUTABLE log row + rewrites matching platform_audit_log.metadata', async () => {
      const { erasureId, auditIds } = await seedErasureAndAuditRows({ actorRows: 3 });

      const log = await withTestTenant(async () =>
        service.pseudonymiseAuditLog(adminActor(), erasureId, {
          targetTable: 'platform_audit_log',
          targetField: 'metadata',
        }),
      );
      expect(log.targetTable).toBe('platform_audit_log');
      expect(log.targetField).toBe('metadata');
      expect(log.rowsPseudonymised).toBeGreaterThanOrEqual(3);
      expect(log.pseudonymisationToken).toMatch(/^psd_/);
      expect(log.erasureRequestId).toBe(erasureId);
      expect(log.dataSubjectId).toBe(VALID_DATA_SUBJECT_ID);

      // The matching platform_audit_log rows now carry the pseudonymised
      // metadata
      const rewritten = (await rawClient.$queryRawUnsafe(
        `SELECT metadata::text AS m FROM platform.platform_audit_log WHERE id = ANY($1::uuid[])`,
        auditIds,
      )) as Array<{ m: string }>;
      for (const r of rewritten) {
        const parsed = JSON.parse(r.m);
        expect(parsed.pseudonymised).toBe(log.pseudonymisationToken);
        expect(parsed.original).toBeUndefined();
      }
    });

    it('rejects unsupported targetTable', async () => {
      const erasure = await withTestTenant(async () =>
        service.create(adminActor(), { dataSubjectId: VALID_DATA_SUBJECT_ID }),
      );
      await expect(
        withTestTenant(async () =>
          service.pseudonymiseAuditLog(adminActor(), erasure.id, {
            targetTable: 'sis_students',
            targetField: 'metadata',
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects unsupported targetField', async () => {
      const erasure = await withTestTenant(async () =>
        service.create(adminActor(), { dataSubjectId: VALID_DATA_SUBJECT_ID }),
      );
      await expect(
        withTestTenant(async () =>
          service.pseudonymiseAuditLog(adminActor(), erasure.id, {
            targetTable: 'platform_audit_log',
            targetField: 'actor_id',
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects non-DPO actor', async () => {
      const erasure = await withTestTenant(async () =>
        service.create(adminActor(), { dataSubjectId: VALID_DATA_SUBJECT_ID }),
      );
      await expect(
        withTestTenant(async () =>
          service.pseudonymiseAuditLog(officerActor(), erasure.id, {
            targetTable: 'platform_audit_log',
            targetField: 'metadata',
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('platform_audit_log rewrite is school-scoped (tenant_id = current school)', async () => {
      // Seed an audit row for the data subject under School B
      const otherSchoolAuditId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_audit_log
           (id, actor_id, actor_type, action, action_category, entity_type, entity_id, tenant_id, metadata)
         VALUES ($1::uuid, $2::uuid, 'HUMAN', 'test_action', 'READ', 'iam_person', $2::uuid, $3::uuid, '{"sensitive":"B"}'::jsonb)`,
        otherSchoolAuditId,
        VALID_DATA_SUBJECT_ID,
        TEST_SCHOOL_B_ID,
      );

      const { erasureId } = await seedErasureAndAuditRows({ actorRows: 1 });
      await withTestTenant(async () =>
        service.pseudonymiseAuditLog(adminActor(), erasureId, {
          targetTable: 'platform_audit_log',
          targetField: 'metadata',
        }),
      );

      // The School B audit row must NOT have been pseudonymised
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT metadata::text AS m FROM platform.platform_audit_log WHERE id = $1::uuid`,
        otherSchoolAuditId,
      )) as Array<{ m: string }>;
      expect(JSON.parse(rows[0]!.m).sensitive).toBe('B');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // IMMUTABLE dpo_pseudonymisation_log (migration 177 trigger)
  // ────────────────────────────────────────────────────────────────────
  describe('IMMUTABLE dpo_pseudonymisation_log', () => {
    async function seedPseudonymisationLog(): Promise<string> {
      const erasure = await withTestTenant(async () =>
        service.create(adminActor(), { dataSubjectId: VALID_DATA_SUBJECT_ID }),
      );
      const result = await withTestTenant(async () =>
        service.pseudonymiseAuditLog(adminActor(), erasure.id, {
          targetTable: 'platform_audit_log',
          targetField: 'metadata',
        }),
      );
      return result.id;
    }

    it('UPDATE pseudonymisation_token → SQLSTATE 23001', async () => {
      const id = await seedPseudonymisationLog();
      let caught: { meta?: { code?: string }; message?: string } | undefined;
      try {
        await rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.dpo_pseudonymisation_log SET pseudonymisation_token = 'tampered' WHERE id = $1::uuid`,
          id,
        );
      } catch (err) {
        caught = err as { meta?: { code?: string }; message?: string };
      }
      expect(caught).toBeDefined();
      const code = caught?.meta?.code ?? '';
      const msg = caught?.message ?? '';
      expect(
        code === '23001' || msg.includes('23001') || msg.toLowerCase().includes('immutable'),
      ).toBe(true);
    });

    it('UPDATE rows_pseudonymised → SQLSTATE 23001', async () => {
      const id = await seedPseudonymisationLog();
      let caught: { meta?: { code?: string }; message?: string } | undefined;
      try {
        await rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.dpo_pseudonymisation_log SET rows_pseudonymised = 0 WHERE id = $1::uuid`,
          id,
        );
      } catch (err) {
        caught = err as { meta?: { code?: string }; message?: string };
      }
      expect(caught).toBeDefined();
      const code = caught?.meta?.code ?? '';
      const msg = caught?.message ?? '';
      expect(code === '23001' || msg.includes('23001')).toBe(true);
    });

    it('DELETE → SQLSTATE 23001', async () => {
      const id = await seedPseudonymisationLog();
      let caught: { meta?: { code?: string }; message?: string } | undefined;
      try {
        await rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.dpo_pseudonymisation_log WHERE id = $1::uuid`,
          id,
        );
      } catch (err) {
        caught = err as { meta?: { code?: string }; message?: string };
      }
      expect(caught).toBeDefined();
      const code = caught?.meta?.code ?? '';
      const msg = caught?.message ?? '';
      expect(code === '23001' || msg.includes('23001')).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // listPseudonymisations
  // ────────────────────────────────────────────────────────────────────
  describe('listPseudonymisations', () => {
    it('returns all log entries scoped to current school', async () => {
      const erasure = await withTestTenant(async () =>
        service.create(adminActor(), { dataSubjectId: VALID_DATA_SUBJECT_ID }),
      );
      await withTestTenant(async () =>
        service.pseudonymiseAuditLog(adminActor(), erasure.id, {
          targetTable: 'platform_audit_log',
          targetField: 'metadata',
        }),
      );

      const all = await withTestTenant(async () => service.listPseudonymisations(adminActor()));
      expect(all.length).toBeGreaterThanOrEqual(1);
      const filtered = await withTestTenant(async () =>
        service.listPseudonymisations(adminActor(), erasure.id),
      );
      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.erasureRequestId).toBe(erasure.id);
    });

    it('as non-DPO → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => service.listPseudonymisations(officerActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
