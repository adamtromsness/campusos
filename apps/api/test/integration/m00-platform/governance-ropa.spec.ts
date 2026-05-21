import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { RopaService } from '@modules/m00-platform/governance/ropa.service';
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
  studentActor,
  parentActor,
  TEST_OFFICER_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';

/**
 * DB-backed integration tests for RopaService — Article 30 ROPA register
 * + retention-policy CRUD + DPIA-gap detection on highRiskProcessing.
 */
describe('integration:m00-platform/governance-ropa', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let service: RopaService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    service = new RopaService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.dpo_processing_activities WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.dpo_retention_policies WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.dpo_dpias WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_OFFICER_ACCOUNT_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.dpo_compliance_dashboard_config WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  async function grantDpo(codes: string[]): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_OFFICER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      codes,
    );
  }

  function baseProcessingActivityInput(overrides: Record<string, unknown> = {}) {
    return {
      activityName: 'Cafeteria Imagery',
      purpose: 'Community engagement',
      legalBasis: 'PUBLIC_TASK' as const,
      dataCategories: ['photos'],
      dataSubjects: ['students'],
      transfersOutsideUkEea: false,
      automatedDecisionMaking: false,
      profiling: false,
      highRiskProcessing: false,
      ...overrides,
    };
  }

  function baseRetentionInput(overrides: Record<string, unknown> = {}) {
    return {
      dataCategory: 'Academic Records',
      retentionPeriod: '6 years post-graduation',
      legalBasisForRetention: 'FERPA',
      reviewFrequency: 'ANNUAL' as const,
      nextReviewDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      ...overrides,
    };
  }

  describe('scope checks', () => {
    it('admin bypasses all scope checks', async () => {
      await withTestTenant(async () => {
        await expect(service.assertDpoReadScope(adminActor())).resolves.toBeUndefined();
        await expect(service.assertDpoWriteScope(adminActor())).resolves.toBeUndefined();
        await expect(service.assertDpoAdminScope(adminActor())).resolves.toBeUndefined();
      });
    });

    it('STAFF with read scope passes read but not write/admin', async () => {
      await grantDpo(['dpo-001:read']);
      await withTestTenant(async () => {
        await expect(service.assertDpoReadScope(officerActor())).resolves.toBeUndefined();
        await expect(service.assertDpoWriteScope(officerActor())).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        await expect(service.assertDpoAdminScope(officerActor())).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      });
    });

    it('STAFF with admin scope passes all three', async () => {
      await grantDpo(['dpo-001:admin', 'dpo-001:write', 'dpo-001:read']);
      await withTestTenant(async () => {
        await expect(service.assertDpoAdminScope(officerActor())).resolves.toBeUndefined();
      });
    });

    it('non-staff persona → ForbiddenException on all', async () => {
      await withTestTenant(async () => {
        await expect(service.assertDpoReadScope(studentActor())).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        await expect(service.assertDpoWriteScope(parentActor())).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      });
    });
  });

  describe('processing activities CRUD', () => {
    it('admin creates a processing activity; DTO includes the data category arrays', async () => {
      const created = await withTestTenant(async () =>
        service.createProcessingActivity(adminActor(), baseProcessingActivityInput()),
      );
      expect(created.activityName).toBe('Cafeteria Imagery');
      expect(created.dataCategories).toEqual(['photos']);
      expect(created.dataSubjects).toEqual(['students']);
      expect(created.isActive).toBe(true);
      expect(created.hasDpiaGap).toBe(false);
    });

    it('highRiskProcessing=true + no dpiaId → hasDpiaGap=true (compliance dashboard surface)', async () => {
      const created = await withTestTenant(async () =>
        service.createProcessingActivity(
          adminActor(),
          baseProcessingActivityInput({ highRiskProcessing: true }),
        ),
      );
      expect(created.hasDpiaGap).toBe(true);
    });

    it('linking to retention policy → DTO carries retentionPolicyCategory', async () => {
      const rp = await withTestTenant(async () =>
        service.createRetentionPolicy(adminActor(), baseRetentionInput()),
      );
      const created = await withTestTenant(async () =>
        service.createProcessingActivity(
          adminActor(),
          baseProcessingActivityInput({ retentionPolicyId: rp.id }),
        ),
      );
      expect(created.retentionPolicyId).toBe(rp.id);
      expect(created.retentionPolicyCategory).toBe('Academic Records');
    });

    it('cross-school retentionPolicyId → BadRequest', async () => {
      const rp = await withTestTenantB(async () =>
        service.createRetentionPolicy(adminActor(), baseRetentionInput({ dataCategory: 'Diff' })),
      );
      await expect(
        withTestTenant(async () =>
          service.createProcessingActivity(
            adminActor(),
            baseProcessingActivityInput({ retentionPolicyId: rp.id }),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('empty dataCategories → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          service.createProcessingActivity(
            adminActor(),
            baseProcessingActivityInput({ dataCategories: [] }),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('empty dataSubjects → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          service.createProcessingActivity(
            adminActor(),
            baseProcessingActivityInput({ dataSubjects: [] }),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('duplicate activityName in same school → BadRequest (UNIQUE)', async () => {
      await withTestTenant(async () =>
        service.createProcessingActivity(adminActor(), baseProcessingActivityInput()),
      );
      await expect(
        withTestTenant(async () =>
          service.createProcessingActivity(adminActor(), baseProcessingActivityInput()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cross-school create with same name allowed', async () => {
      await withTestTenant(async () =>
        service.createProcessingActivity(adminActor(), baseProcessingActivityInput()),
      );
      const b = await withTestTenantB(async () =>
        service.createProcessingActivity(adminActor(), baseProcessingActivityInput()),
      );
      expect(b.id).toBeTruthy();
    });

    it('list (default) returns only is_active=true; includeInactive=true returns all', async () => {
      const a = await withTestTenant(async () =>
        service.createProcessingActivity(adminActor(), baseProcessingActivityInput()),
      );
      const b = await withTestTenant(async () =>
        service.createProcessingActivity(
          adminActor(),
          baseProcessingActivityInput({ activityName: 'Other' }),
        ),
      );
      await withTestTenant(async () =>
        service.updateProcessingActivity(adminActor(), b.id, { isActive: false }),
      );
      const active = await withTestTenant(async () =>
        service.listProcessingActivities(adminActor()),
      );
      expect(active.find((p) => p.id === a.id)).toBeDefined();
      expect(active.find((p) => p.id === b.id)).toBeUndefined();
      const all = await withTestTenant(async () =>
        service.listProcessingActivities(adminActor(), { includeInactive: true }),
      );
      expect(all.find((p) => p.id === b.id)).toBeDefined();
    });

    it('list gapsOnly filter → only high-risk without DPIA', async () => {
      const safe = await withTestTenant(async () =>
        service.createProcessingActivity(
          adminActor(),
          baseProcessingActivityInput({ activityName: 'Low risk' }),
        ),
      );
      const gap = await withTestTenant(async () =>
        service.createProcessingActivity(
          adminActor(),
          baseProcessingActivityInput({ activityName: 'High risk', highRiskProcessing: true }),
        ),
      );
      const gaps = await withTestTenant(async () =>
        service.listProcessingActivities(adminActor(), { gapsOnly: true }),
      );
      expect(gaps.find((p) => p.id === gap.id)).toBeDefined();
      expect(gaps.find((p) => p.id === safe.id)).toBeUndefined();
    });

    it('update fields + duplicate-name rejection on rename', async () => {
      const a = await withTestTenant(async () =>
        service.createProcessingActivity(adminActor(), baseProcessingActivityInput()),
      );
      const b = await withTestTenant(async () =>
        service.createProcessingActivity(
          adminActor(),
          baseProcessingActivityInput({ activityName: 'Other PA' }),
        ),
      );
      // Update purpose
      const updated = await withTestTenant(async () =>
        service.updateProcessingActivity(adminActor(), a.id, { purpose: 'Updated purpose' }),
      );
      expect(updated.purpose).toBe('Updated purpose');
      // Rename to collide
      await expect(
        withTestTenant(async () =>
          service.updateProcessingActivity(adminActor(), b.id, {
            activityName: 'Cafeteria Imagery',
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('update with empty dataCategories/dataSubjects → BadRequest', async () => {
      const a = await withTestTenant(async () =>
        service.createProcessingActivity(adminActor(), baseProcessingActivityInput()),
      );
      await expect(
        withTestTenant(async () =>
          service.updateProcessingActivity(adminActor(), a.id, { dataCategories: [] }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        withTestTenant(async () =>
          service.updateProcessingActivity(adminActor(), a.id, { dataSubjects: [] }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('update empty patch returns existing without modifying', async () => {
      const a = await withTestTenant(async () =>
        service.createProcessingActivity(adminActor(), baseProcessingActivityInput()),
      );
      const updated = await withTestTenant(async () =>
        service.updateProcessingActivity(adminActor(), a.id, {}),
      );
      expect(updated.id).toBe(a.id);
    });

    it('admin delete works; non-admin → ForbiddenException', async () => {
      const a = await withTestTenant(async () =>
        service.createProcessingActivity(adminActor(), baseProcessingActivityInput()),
      );
      await expect(
        withTestTenant(async () => service.deleteProcessingActivity(officerActor(), a.id)),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await withTestTenant(async () => service.deleteProcessingActivity(adminActor(), a.id));
      await expect(
        withTestTenant(async () => service.getProcessingActivity(adminActor(), a.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('delete missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => service.deleteProcessingActivity(adminActor(), generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school getProcessingActivity → NotFound', async () => {
      const a = await withTestTenant(async () =>
        service.createProcessingActivity(adminActor(), baseProcessingActivityInput()),
      );
      await expect(
        withTestTenantB(async () => service.getProcessingActivity(adminActor(), a.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('retention policies CRUD', () => {
    it('admin creates a retention policy', async () => {
      const rp = await withTestTenant(async () =>
        service.createRetentionPolicy(adminActor(), baseRetentionInput()),
      );
      expect(rp.dataCategory).toBe('Academic Records');
      expect(rp.reviewFrequency).toBe('ANNUAL');
    });

    it('duplicate dataCategory → BadRequest (UNIQUE on school,data_category)', async () => {
      await withTestTenant(async () =>
        service.createRetentionPolicy(adminActor(), baseRetentionInput()),
      );
      await expect(
        withTestTenant(async () =>
          service.createRetentionPolicy(adminActor(), baseRetentionInput()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('next_review_date is persisted exactly as supplied', async () => {
      const date = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const created = await withTestTenant(async () =>
        service.createRetentionPolicy(
          adminActor(),
          baseRetentionInput({ dataCategory: 'Near', nextReviewDate: date }),
        ),
      );
      // Verify the stored value
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT next_review_date::text AS d FROM ${TEST_SCHEMA}.dpo_retention_policies WHERE id = $1::uuid`,
        created.id,
      )) as Array<{ d: string }>;
      expect(rows[0]!.d).toBe(date);
    });

    it('list dueOnly returns only policies past reminder window', async () => {
      const nearDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const farDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const near = await withTestTenant(async () =>
        service.createRetentionPolicy(
          adminActor(),
          baseRetentionInput({ dataCategory: 'Near2', nextReviewDate: nearDate }),
        ),
      );
      const far = await withTestTenant(async () =>
        service.createRetentionPolicy(
          adminActor(),
          baseRetentionInput({ dataCategory: 'Far2', nextReviewDate: farDate }),
        ),
      );
      const due = await withTestTenant(async () =>
        service.listRetentionPolicies(adminActor(), { dueOnly: true }),
      );
      expect(due.find((p) => p.id === near.id)).toBeDefined();
      expect(due.find((p) => p.id === far.id)).toBeUndefined();
    });

    it('update fields + duplicate-rename rejection', async () => {
      const a = await withTestTenant(async () =>
        service.createRetentionPolicy(adminActor(), baseRetentionInput()),
      );
      const b = await withTestTenant(async () =>
        service.createRetentionPolicy(adminActor(), baseRetentionInput({ dataCategory: 'Other' })),
      );
      const updated = await withTestTenant(async () =>
        service.updateRetentionPolicy(adminActor(), a.id, { notes: 'reviewed' }),
      );
      expect(updated.notes).toBe('reviewed');
      await expect(
        withTestTenant(async () =>
          service.updateRetentionPolicy(adminActor(), b.id, { dataCategory: 'Academic Records' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('update empty patch returns existing', async () => {
      const a = await withTestTenant(async () =>
        service.createRetentionPolicy(adminActor(), baseRetentionInput()),
      );
      const updated = await withTestTenant(async () =>
        service.updateRetentionPolicy(adminActor(), a.id, {}),
      );
      expect(updated.id).toBe(a.id);
    });

    it('admin deletes; non-admin → Forbidden', async () => {
      const a = await withTestTenant(async () =>
        service.createRetentionPolicy(adminActor(), baseRetentionInput()),
      );
      await expect(
        withTestTenant(async () => service.deleteRetentionPolicy(officerActor(), a.id)),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await withTestTenant(async () => service.deleteRetentionPolicy(adminActor(), a.id));
      await expect(
        withTestTenant(async () => service.getRetentionPolicy(adminActor(), a.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('delete missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.deleteRetentionPolicy(adminActor(), generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school read → NotFound', async () => {
      const a = await withTestTenant(async () =>
        service.createRetentionPolicy(adminActor(), baseRetentionInput()),
      );
      await expect(
        withTestTenantB(async () => service.getRetentionPolicy(adminActor(), a.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list as non-DPO → Forbidden', async () => {
      await expect(
        withTestTenant(async () => service.listRetentionPolicies(officerActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
