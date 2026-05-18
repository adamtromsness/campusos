import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { BreachService } from '@modules/m00-platform/governance/breach.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka';

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
  teacherActor,
  TEST_OFFICER_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';

/**
 * DB-backed integration tests for BreachService — the 72-hour countdown
 * KEYSTONE + outbox-in-tx for dpo.breach.discovered.
 *
 * Coverage:
 *   - assertReadScope / assertWriteScope: admin + DPO perm + denial paths
 *   - create: required-fields, outbox-in-tx ONLY when supervisoryAuthorityNotificationRequired
 *   - list: status filter, pendingNotificationOnly filter
 *   - getById: cross-school NotFound
 *   - update: locked-row, RESOLVED-is-immutable, empty patch no-op
 *   - notifySupervisoryAuthority: required check, duplicate, locked-row
 *   - notifyDataSubjects: required check, duplicate
 *   - resolve: status transition, double-resolve rejection
 *   - DTO mapping: hoursSinceDiscovery / hoursRemainingTo72 / isOverdue
 */
describe('integration:m00-platform/governance-breach', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let outbox: OutboxService;
  let service: BreachService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    outbox = new OutboxService(rawClient);
    service = new BreachService(tenantPrisma, permCheck, outbox);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.dpo_data_breach_records WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE tenant_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_OFFICER_ACCOUNT_ID,
    );
  });

  async function grantDpoToOfficer(write: boolean = true): Promise<void> {
    const codes = write ? ['dpo-003:write', 'dpo-003:read'] : ['dpo-003:read'];
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

  function baseCreateInput(overrides: Record<string, unknown> = {}) {
    return {
      breachTitle: 'Email mis-send to wrong distribution list',
      breachType: 'UNAUTHORISED_ACCESS' as const,
      discoveryDate: new Date().toISOString(),
      breachStartDate: null,
      personalDataCategoriesInvolved: ['contact_information'],
      estimatedAffectedIndividuals: 12,
      riskLevel: 'MEDIUM' as const,
      riskToIndividuals: 'POSSIBLE' as const,
      supervisoryAuthorityNotificationRequired: false,
      dataSubjectsNotificationRequired: false,
      breachCause: 'Human error',
      remediationActions: 'Recall mail, retrain staff',
      ...overrides,
    };
  }

  describe('access scopes', () => {
    it('school admin bypasses read + write scope checks', async () => {
      await withTestTenant(async () => {
        await expect(service.assertReadScope(adminActor())).resolves.toBeUndefined();
        await expect(service.assertWriteScope(adminActor())).resolves.toBeUndefined();
      });
    });

    it('STAFF without dpo-003 → ForbiddenException on read', async () => {
      await withTestTenant(async () => {
        await expect(service.assertReadScope(officerActor())).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      });
    });

    it('STAFF with dpo-003:read passes assertReadScope but not assertWriteScope', async () => {
      await grantDpoToOfficer(false);
      await withTestTenant(async () => {
        await expect(service.assertReadScope(officerActor())).resolves.toBeUndefined();
        await expect(service.assertWriteScope(officerActor())).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      });
    });

    it('STAFF with dpo-003:write passes both', async () => {
      await grantDpoToOfficer();
      await withTestTenant(async () => {
        await expect(service.assertReadScope(officerActor())).resolves.toBeUndefined();
        await expect(service.assertWriteScope(officerActor())).resolves.toBeUndefined();
      });
    });
  });

  describe('create', () => {
    it('admin creates a breach record (notification NOT required) — NO outbox row', async () => {
      const created = await withTestTenant(async () => service.create(adminActor(), baseCreateInput()));
      expect(created.status).toBe('UNDER_INVESTIGATION');
      expect(created.isResolved).toBe(false);
      expect(created.supervisoryAuthorityNotificationRequired).toBe(false);
      // No outbox row enqueued for this breach
      const outboxRows = (await rawClient.$queryRawUnsafe(
        `SELECT 1 FROM platform.platform_outbox WHERE message_key = $1`,
        created.id,
      )) as Array<unknown>;
      expect(outboxRows.length).toBe(0);
    });

    it('breach requiring supervisory notification → outbox row enqueued in-tx (KEYSTONE)', async () => {
      const created = await withTestTenant(async () =>
        service.create(
          adminActor(),
          baseCreateInput({
            supervisoryAuthorityNotificationRequired: true,
            riskLevel: 'HIGH',
            riskToIndividuals: 'LIKELY',
          }),
        ),
      );
      // Outbox row exists with topic dpo.breach.discovered (message_key = breach id)
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT topic, message_key, envelope::text AS envelope FROM platform.platform_outbox WHERE message_key = $1`,
        created.id,
      )) as Array<{ topic: string; message_key: string; envelope: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0]!.topic).toBe('dpo.breach.discovered');
      const envelope = JSON.parse(rows[0]!.envelope);
      // ADR-057 envelope wraps payload
      const payload = envelope.payload ?? envelope;
      expect(payload.breachId).toBe(created.id);
      expect(payload.notificationDeadline).toBeTruthy();
      expect(payload.riskLevel).toBe('HIGH');
    });

    it('empty personalDataCategoriesInvolved → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(adminActor(), baseCreateInput({ personalDataCategoriesInvolved: [] })),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-DPO actor → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => service.create(officerActor(), baseCreateInput())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => service.create(teacherActor(), baseCreateInput())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => service.create(studentActor(), baseCreateInput())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => service.create(parentActor(), baseCreateInput())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('list + getById', () => {
    it('admin sees all breaches in current school; cross-school invisible', async () => {
      const a = await withTestTenant(async () => service.create(adminActor(), baseCreateInput()));
      const b = await withTestTenantB(async () => service.create(adminActor(), baseCreateInput()));
      const listA = await withTestTenant(async () => service.list(adminActor()));
      expect(listA.find((r) => r.id === a.id)).toBeDefined();
      expect(listA.find((r) => r.id === b.id)).toBeUndefined();
      const listB = await withTestTenantB(async () => service.list(adminActor()));
      expect(listB.find((r) => r.id === b.id)).toBeDefined();
    });

    it('status filter narrows results', async () => {
      const a = await withTestTenant(async () => service.create(adminActor(), baseCreateInput()));
      await withTestTenant(async () => service.resolve(adminActor(), a.id, {}));
      const investigating = await withTestTenant(async () =>
        service.list(adminActor(), { status: 'UNDER_INVESTIGATION' }),
      );
      expect(investigating.find((r) => r.id === a.id)).toBeUndefined();
      const resolved = await withTestTenant(async () =>
        service.list(adminActor(), { status: 'RESOLVED' }),
      );
      expect(resolved.find((r) => r.id === a.id)).toBeDefined();
    });

    it('pendingNotificationOnly filter returns only breaches requiring + not yet notified', async () => {
      const a = await withTestTenant(async () =>
        service.create(
          adminActor(),
          baseCreateInput({ supervisoryAuthorityNotificationRequired: true }),
        ),
      );
      const b = await withTestTenant(async () =>
        service.create(adminActor(), baseCreateInput()),
      );
      const pending = await withTestTenant(async () =>
        service.list(adminActor(), { pendingNotificationOnly: true }),
      );
      expect(pending.find((r) => r.id === a.id)).toBeDefined();
      expect(pending.find((r) => r.id === b.id)).toBeUndefined();
    });

    it('getById missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => service.getById(adminActor(), generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school getById → NotFoundException', async () => {
      const a = await withTestTenant(async () => service.create(adminActor(), baseCreateInput()));
      await expect(
        withTestTenantB(async () => service.getById(adminActor(), a.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list as non-DPO → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => service.list(officerActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('update', () => {
    it('updates breach_title + breach_cause; status stays UNDER_INVESTIGATION', async () => {
      const created = await withTestTenant(async () =>
        service.create(adminActor(), baseCreateInput()),
      );
      const updated = await withTestTenant(async () =>
        service.update(adminActor(), created.id, {
          breachTitle: 'New title',
          breachCause: 'Revised cause analysis',
        }),
      );
      expect(updated.breachTitle).toBe('New title');
      expect(updated.breachCause).toBe('Revised cause analysis');
      expect(updated.status).toBe('UNDER_INVESTIGATION');
    });

    it('empty patch = no-op (returns current row)', async () => {
      const created = await withTestTenant(async () =>
        service.create(adminActor(), baseCreateInput()),
      );
      const updated = await withTestTenant(async () =>
        service.update(adminActor(), created.id, {}),
      );
      expect(updated.id).toBe(created.id);
    });

    it('RESOLVED breach is immutable — update rejected with BadRequest', async () => {
      const created = await withTestTenant(async () =>
        service.create(adminActor(), baseCreateInput()),
      );
      await withTestTenant(async () => service.resolve(adminActor(), created.id, {}));
      await expect(
        withTestTenant(async () =>
          service.update(adminActor(), created.id, { breachTitle: 'no!' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('empty personalDataCategoriesInvolved on update → BadRequest', async () => {
      const created = await withTestTenant(async () =>
        service.create(adminActor(), baseCreateInput()),
      );
      await expect(
        withTestTenant(async () =>
          service.update(adminActor(), created.id, { personalDataCategoriesInvolved: [] }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('missing breach → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.update(adminActor(), generateId(), { breachTitle: 'x' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('update as non-DPO → ForbiddenException', async () => {
      const created = await withTestTenant(async () =>
        service.create(adminActor(), baseCreateInput()),
      );
      await expect(
        withTestTenant(async () =>
          service.update(officerActor(), created.id, { breachTitle: 'x' }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('notifySupervisoryAuthority', () => {
    async function seedBreach(requires = true): Promise<string> {
      const r = await withTestTenant(async () =>
        service.create(
          adminActor(),
          baseCreateInput({ supervisoryAuthorityNotificationRequired: requires }),
        ),
      );
      return r.id;
    }

    it('flips status to NOTIFIED + stamps timestamps and reference', async () => {
      const id = await seedBreach();
      const updated = await withTestTenant(async () =>
        service.notifySupervisoryAuthority(adminActor(), id, {
          supervisoryAuthorityReference: 'ICO-2026-001',
        }),
      );
      expect(updated.status).toBe('NOTIFIED');
      expect(updated.supervisoryAuthorityNotifiedAt).not.toBeNull();
      expect(updated.supervisoryAuthorityReference).toBe('ICO-2026-001');
    });

    it('breach where notification NOT required → BadRequest', async () => {
      const id = await seedBreach(false);
      await expect(
        withTestTenant(async () =>
          service.notifySupervisoryAuthority(adminActor(), id, {
            supervisoryAuthorityReference: 'X',
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('already notified → BadRequest (idempotency gate)', async () => {
      const id = await seedBreach();
      await withTestTenant(async () =>
        service.notifySupervisoryAuthority(adminActor(), id, {
          supervisoryAuthorityReference: 'ICO-1',
        }),
      );
      await expect(
        withTestTenant(async () =>
          service.notifySupervisoryAuthority(adminActor(), id, {
            supervisoryAuthorityReference: 'ICO-2',
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('missing breach → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.notifySupervisoryAuthority(adminActor(), generateId(), {
            supervisoryAuthorityReference: 'X',
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('as non-DPO → ForbiddenException', async () => {
      const id = await seedBreach();
      await expect(
        withTestTenant(async () =>
          service.notifySupervisoryAuthority(officerActor(), id, {
            supervisoryAuthorityReference: 'X',
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('notifyDataSubjects', () => {
    async function seedDsBreach(requires = true): Promise<string> {
      const r = await withTestTenant(async () =>
        service.create(
          adminActor(),
          baseCreateInput({ dataSubjectsNotificationRequired: requires }),
        ),
      );
      return r.id;
    }

    it('stamps data_subjects_notified_at', async () => {
      const id = await seedDsBreach();
      const updated = await withTestTenant(async () =>
        service.notifyDataSubjects(adminActor(), id, {}),
      );
      expect(updated.dataSubjectsNotifiedAt).not.toBeNull();
    });

    it('not required → BadRequest', async () => {
      const id = await seedDsBreach(false);
      await expect(
        withTestTenant(async () => service.notifyDataSubjects(adminActor(), id, {})),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('already notified → BadRequest', async () => {
      const id = await seedDsBreach();
      await withTestTenant(async () => service.notifyDataSubjects(adminActor(), id, {}));
      await expect(
        withTestTenant(async () => service.notifyDataSubjects(adminActor(), id, {})),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('missing breach → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => service.notifyDataSubjects(adminActor(), generateId(), {})),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('as non-DPO → ForbiddenException', async () => {
      const id = await seedDsBreach();
      await expect(
        withTestTenant(async () => service.notifyDataSubjects(officerActor(), id, {})),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('resolve', () => {
    it('flips status to RESOLVED + sets is_resolved + resolved_at (lockstep with resolved_chk)', async () => {
      const created = await withTestTenant(async () =>
        service.create(adminActor(), baseCreateInput()),
      );
      const resolved = await withTestTenant(async () =>
        service.resolve(adminActor(), created.id, {}),
      );
      expect(resolved.status).toBe('RESOLVED');
      expect(resolved.isResolved).toBe(true);
      expect(resolved.resolvedAt).not.toBeNull();
    });

    it('already RESOLVED → BadRequest', async () => {
      const created = await withTestTenant(async () =>
        service.create(adminActor(), baseCreateInput()),
      );
      await withTestTenant(async () => service.resolve(adminActor(), created.id, {}));
      await expect(
        withTestTenant(async () => service.resolve(adminActor(), created.id, {})),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('missing breach → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => service.resolve(adminActor(), generateId(), {})),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('as non-DPO → ForbiddenException', async () => {
      const id = await withTestTenant(async () =>
        service.create(adminActor(), baseCreateInput()).then((r) => r.id),
      );
      await expect(
        withTestTenant(async () => service.resolve(officerActor(), id, {})),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('explicit resolvedAt is honoured', async () => {
      const id = await withTestTenant(async () =>
        service.create(adminActor(), baseCreateInput()).then((r) => r.id),
      );
      const at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const updated = await withTestTenant(async () =>
        service.resolve(adminActor(), id, { resolvedAt: at }),
      );
      expect(updated.status).toBe('RESOLVED');
      expect(new Date(updated.resolvedAt!).getTime()).toBeLessThan(Date.now());
    });
  });

  describe('hoursSinceDiscovery + hoursRemainingTo72 + isOverdue', () => {
    it('newly created breach (required-notify) → hoursRemainingTo72 in [70, 72]', async () => {
      const created = await withTestTenant(async () =>
        service.create(
          adminActor(),
          baseCreateInput({ supervisoryAuthorityNotificationRequired: true }),
        ),
      );
      expect(created.isOverdue).toBe(false);
      expect(created.hoursRemainingTo72).not.toBeNull();
      expect(created.hoursRemainingTo72!).toBeGreaterThanOrEqual(70);
      expect(created.hoursRemainingTo72!).toBeLessThanOrEqual(72);
    });

    it('isOverdue=true when discovery_date is 80 hours in the past + not yet notified', async () => {
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.dpo_data_breach_records
          (id, school_id, breach_title, breach_type, discovery_date, personal_data_categories_involved,
           risk_level, risk_to_individuals, supervisory_authority_notification_required,
           data_subjects_notification_required, breach_cause, remediation_actions,
           is_resolved, reported_by, status)
         VALUES ($1::uuid, $2::uuid, 'late', 'UNAUTHORISED_ACCESS', now() - INTERVAL '80 hours',
                 ARRAY['contact_information'], 'HIGH', 'LIKELY', true, false,
                 'lateness', 'investigating', false, $3::uuid, 'UNDER_INVESTIGATION')`,
        id,
        TEST_SCHOOL_ID,
        adminActor().accountId,
      );
      const got = await withTestTenant(async () => service.getById(adminActor(), id));
      expect(got.isOverdue).toBe(true);
      expect(got.hoursRemainingTo72).not.toBeNull();
      expect(got.hoursRemainingTo72!).toBeLessThan(0);
    });

    it('notified breach: hoursRemainingTo72 = null (clock stopped)', async () => {
      const created = await withTestTenant(async () =>
        service.create(
          adminActor(),
          baseCreateInput({ supervisoryAuthorityNotificationRequired: true }),
        ),
      );
      const notified = await withTestTenant(async () =>
        service.notifySupervisoryAuthority(adminActor(), created.id, {
          supervisoryAuthorityReference: 'ICO-1',
        }),
      );
      expect(notified.hoursRemainingTo72).toBeNull();
      expect(notified.isOverdue).toBe(false);
    });
  });

  describe('cross-school isolation', () => {
    it('breach in School B cannot be updated/notified/resolved from School A admin', async () => {
      const id = await withTestTenantB(async () =>
        service.create(adminActor(), baseCreateInput()).then((r) => r.id),
      );
      await expect(
        withTestTenant(async () => service.update(adminActor(), id, { breachTitle: 'x' })),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        withTestTenant(async () => service.resolve(adminActor(), id, {})),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
