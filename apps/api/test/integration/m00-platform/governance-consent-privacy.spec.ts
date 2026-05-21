import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import {
  ConsentService,
  PrivacyNoticeService,
  ComplianceConfigService,
} from '@modules/m00-platform/governance/erasure.service';
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
  studentActor,
  TEST_OFFICER_PERSON_ID,
  TEST_OFFICER_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';

/**
 * DB-backed integration tests for the consent + privacy notice +
 * compliance config services that ship alongside ErasureService.
 */
describe('integration:m00-platform/governance-consent-privacy', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let access: GovernanceAccess;
  let consent: ConsentService;
  let privacy: PrivacyNoticeService;
  let config: ComplianceConfigService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    access = new GovernanceAccess(tenantPrisma);
    consent = new ConsentService(tenantPrisma, permCheck, access);
    privacy = new PrivacyNoticeService(tenantPrisma, permCheck);
    config = new ComplianceConfigService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.dpo_processing_consent_records WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.dpo_privacy_notices WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.dpo_processing_activities WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.dpo_compliance_dashboard_config WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_OFFICER_ACCOUNT_ID,
    );
  });

  async function grantOfficer(codes: string[]): Promise<void> {
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

  async function seedActivity(opts: { active?: boolean; school?: string } = {}): Promise<string> {
    const id = generateId();
    const school = opts.school ?? TEST_SCHOOL_ID;
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.dpo_processing_activities
        (id, school_id, activity_name, purpose, legal_basis, data_categories, data_subjects, is_active)
       VALUES ($1::uuid, $2::uuid, $3, 'p', 'CONSENT', ARRAY['c'], ARRAY['s'], $4)`,
      id,
      school,
      'PA-' + id,
      opts.active ?? true,
    );
    return id;
  }

  describe('ConsentService', () => {
    it('admin creates a consent record (CONSENT_GIVEN_AT auto-stamped when consented=true)', async () => {
      const paId = await seedActivity();
      const created = await withTestTenant(async () =>
        consent.create(adminActor(), {
          dataSubjectId: TEST_OFFICER_PERSON_ID,
          processingActivityId: paId,
          consented: true,
          consentMethod: 'PAPER',
        }),
      );
      expect(created.consented).toBe(true);
      expect(created.consentGivenAt).not.toBeNull();
      expect(created.processingActivityName).toBeTruthy();
    });

    it('officer with dpo-005:write can create', async () => {
      await grantOfficer(['dpo-005:write']);
      const paId = await seedActivity();
      const created = await withTestTenant(async () =>
        consent.create(officerActor(), {
          dataSubjectId: TEST_OFFICER_PERSON_ID,
          processingActivityId: paId,
          consented: true,
          consentMethod: 'PAPER',
        }),
      );
      expect(created.consented).toBe(true);
    });

    it('non-DPO create → Forbidden', async () => {
      const paId = await seedActivity();
      await expect(
        withTestTenant(async () =>
          consent.create(officerActor(), {
            dataSubjectId: TEST_OFFICER_PERSON_ID,
            processingActivityId: paId,
            consented: true,
            consentMethod: 'PAPER',
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('inactive processing activity → BadRequest', async () => {
      const paId = await seedActivity({ active: false });
      await expect(
        withTestTenant(async () =>
          consent.create(adminActor(), {
            dataSubjectId: TEST_OFFICER_PERSON_ID,
            processingActivityId: paId,
            consented: true,
            consentMethod: 'PAPER',
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cross-school processing activity → BadRequest', async () => {
      const paId = await seedActivity({ school: TEST_SCHOOL_B_ID });
      await expect(
        withTestTenant(async () =>
          consent.create(adminActor(), {
            dataSubjectId: TEST_OFFICER_PERSON_ID,
            processingActivityId: paId,
            consented: true,
            consentMethod: 'PAPER',
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cross-tenant data subject (no projection) → BadRequest', async () => {
      const paId = await seedActivity();
      await expect(
        withTestTenant(async () =>
          consent.create(adminActor(), {
            dataSubjectId: generateId(),
            processingActivityId: paId,
            consented: true,
            consentMethod: 'PAPER',
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('consented=false leaves consent_given_at NULL', async () => {
      const paId = await seedActivity();
      const created = await withTestTenant(async () =>
        consent.create(adminActor(), {
          dataSubjectId: TEST_OFFICER_PERSON_ID,
          processingActivityId: paId,
          consented: false,
          consentMethod: 'VERBAL',
        }),
      );
      expect(created.consented).toBe(false);
      expect(created.consentGivenAt).toBeNull();
    });

    it('list with consentedOnly filter excludes withdrawn rows', async () => {
      const paId = await seedActivity();
      const a = await withTestTenant(async () =>
        consent.create(adminActor(), {
          dataSubjectId: TEST_OFFICER_PERSON_ID,
          processingActivityId: paId,
          consented: true,
          consentMethod: 'PAPER',
        }),
      );
      const b = await withTestTenant(async () =>
        consent.create(adminActor(), {
          dataSubjectId: TEST_OFFICER_PERSON_ID,
          processingActivityId: await seedActivity(),
          consented: true,
          consentMethod: 'PAPER',
        }),
      );
      await withTestTenant(async () => consent.withdraw(adminActor(), b.id, {}));
      const consented = await withTestTenant(async () =>
        consent.list(adminActor(), { consentedOnly: true }),
      );
      expect(consented.find((r) => r.id === a.id)).toBeDefined();
      expect(consented.find((r) => r.id === b.id)).toBeUndefined();
    });

    it('list filters by dataSubjectId + processingActivityId', async () => {
      const paId = await seedActivity();
      const r = await withTestTenant(async () =>
        consent.create(adminActor(), {
          dataSubjectId: TEST_OFFICER_PERSON_ID,
          processingActivityId: paId,
          consented: true,
          consentMethod: 'PAPER',
        }),
      );
      const byDs = await withTestTenant(async () =>
        consent.list(adminActor(), { dataSubjectId: TEST_OFFICER_PERSON_ID }),
      );
      expect(byDs.find((c) => c.id === r.id)).toBeDefined();
      const byPa = await withTestTenant(async () =>
        consent.list(adminActor(), { processingActivityId: paId }),
      );
      expect(byPa.find((c) => c.id === r.id)).toBeDefined();
    });

    it('list as non-DPO → Forbidden', async () => {
      await expect(withTestTenant(async () => consent.list(officerActor()))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('officer with dpo-005:read can list', async () => {
      await grantOfficer(['dpo-005:read']);
      const list = await withTestTenant(async () => consent.list(officerActor()));
      expect(Array.isArray(list)).toBe(true);
    });

    it('withdraw flips consented + stamps withdrawn_at', async () => {
      const paId = await seedActivity();
      const r = await withTestTenant(async () =>
        consent.create(adminActor(), {
          dataSubjectId: TEST_OFFICER_PERSON_ID,
          processingActivityId: paId,
          consented: true,
          consentMethod: 'PAPER',
        }),
      );
      const withdrawn = await withTestTenant(async () =>
        consent.withdraw(adminActor(), r.id, { notes: 'No longer needed' }),
      );
      expect(withdrawn.consented).toBe(false);
      expect(withdrawn.consentWithdrawnAt).not.toBeNull();
    });

    it('double withdraw → BadRequest', async () => {
      const paId = await seedActivity();
      const r = await withTestTenant(async () =>
        consent.create(adminActor(), {
          dataSubjectId: TEST_OFFICER_PERSON_ID,
          processingActivityId: paId,
          consented: true,
          consentMethod: 'PAPER',
        }),
      );
      await withTestTenant(async () => consent.withdraw(adminActor(), r.id, {}));
      await expect(
        withTestTenant(async () => consent.withdraw(adminActor(), r.id, {})),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('withdraw missing row → BadRequest', async () => {
      await expect(
        withTestTenant(async () => consent.withdraw(adminActor(), generateId(), {})),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('withdraw as non-DPO → Forbidden', async () => {
      const paId = await seedActivity();
      const r = await withTestTenant(async () =>
        consent.create(adminActor(), {
          dataSubjectId: TEST_OFFICER_PERSON_ID,
          processingActivityId: paId,
          consented: true,
          consentMethod: 'PAPER',
        }),
      );
      await expect(
        withTestTenant(async () => consent.withdraw(officerActor(), r.id, {})),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('PrivacyNoticeService', () => {
    function baseNoticeInput(overrides: Record<string, unknown> = {}) {
      return {
        noticeVersion: 'v1.0',
        effectiveFrom: new Date().toISOString().slice(0, 10),
        contentSummary: 'Initial privacy notice',
        documentS3Key: 's3://privacy/v1.pdf',
        ...overrides,
      };
    }

    it('admin creates a draft notice', async () => {
      const n = await withTestTenant(async () => privacy.create(adminActor(), baseNoticeInput()));
      expect(n.noticeVersion).toBe('v1.0');
      expect(n.publishedAt).toBeNull();
      expect(n.supersededAt).toBeNull();
      expect(n.isCurrent).toBe(true);
    });

    it('officer with dpo-005:write can create', async () => {
      await grantOfficer(['dpo-005:write']);
      const n = await withTestTenant(async () => privacy.create(officerActor(), baseNoticeInput()));
      expect(n.id).toBeTruthy();
    });

    it('non-DPO create → Forbidden', async () => {
      await expect(
        withTestTenant(async () => privacy.create(officerActor(), baseNoticeInput())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('duplicate version per school → BadRequest', async () => {
      await withTestTenant(async () => privacy.create(adminActor(), baseNoticeInput()));
      await expect(
        withTestTenant(async () => privacy.create(adminActor(), baseNoticeInput())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('list returns all notices; ordered by effective_from DESC', async () => {
      const n1 = await withTestTenant(async () =>
        privacy.create(adminActor(), baseNoticeInput({ noticeVersion: 'v0.1' })),
      );
      const n2 = await withTestTenant(async () =>
        privacy.create(adminActor(), baseNoticeInput({ noticeVersion: 'v0.2' })),
      );
      const all = await withTestTenant(async () => privacy.list(studentActor()));
      expect(all.find((n) => n.id === n1.id)).toBeDefined();
      expect(all.find((n) => n.id === n2.id)).toBeDefined();
    });

    it('getCurrent returns null when no published notice exists', async () => {
      const got = await withTestTenant(async () => privacy.getCurrent(adminActor()));
      expect(got).toBeNull();
    });

    it('publish stamps published_at and supersedes prior published notices', async () => {
      const n1 = await withTestTenant(async () =>
        privacy.create(adminActor(), baseNoticeInput({ noticeVersion: 'v1.0' })),
      );
      const n2 = await withTestTenant(async () =>
        privacy.create(adminActor(), baseNoticeInput({ noticeVersion: 'v1.1' })),
      );
      const published1 = await withTestTenant(async () => privacy.publish(adminActor(), n1.id, {}));
      expect(published1.publishedAt).not.toBeNull();
      expect(published1.supersededAt).toBeNull();
      // Now publish n2 — n1 should become superseded
      await withTestTenant(async () => privacy.publish(adminActor(), n2.id, {}));
      const current = await withTestTenant(async () => privacy.getCurrent(adminActor()));
      expect(current!.id).toBe(n2.id);
    });

    it('publish missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => privacy.publish(adminActor(), generateId(), {})),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('publish as non-DPO → Forbidden', async () => {
      const n = await withTestTenant(async () => privacy.create(adminActor(), baseNoticeInput()));
      await expect(
        withTestTenant(async () => privacy.publish(officerActor(), n.id, {})),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-school publish → NotFound', async () => {
      const n = await withTestTenant(async () => privacy.create(adminActor(), baseNoticeInput()));
      await expect(
        withTestTenantB(async () => privacy.publish(adminActor(), n.id, {})),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('ComplianceConfigService', () => {
    it('get auto-creates config row on first read', async () => {
      const cfg = await withTestTenant(async () => config.get(adminActor()));
      expect(cfg.sarDefaultDeadlineDays).toBeGreaterThan(0);
      expect(cfg.breachEscalationHours).toBeGreaterThan(0);
    });

    it('admin update applies fields', async () => {
      const updated = await withTestTenant(async () =>
        config.update(adminActor(), {
          sarDefaultDeadlineDays: 45,
          breachEscalationHours: 72,
          retentionReviewReminderDays: 60,
        }),
      );
      expect(updated.sarDefaultDeadlineDays).toBe(45);
      expect(updated.breachEscalationHours).toBe(72);
      expect(updated.retentionReviewReminderDays).toBe(60);
    });

    it('update from scratch (no existing row) → auto-create + apply', async () => {
      const updated = await withTestTenant(async () =>
        config.update(adminActor(), { sarDefaultDeadlineDays: 35 }),
      );
      expect(updated.sarDefaultDeadlineDays).toBe(35);
    });

    it('empty update returns current value', async () => {
      const a = await withTestTenant(async () => config.get(adminActor()));
      const b = await withTestTenant(async () => config.update(adminActor(), {}));
      expect(b.sarDefaultDeadlineDays).toBe(a.sarDefaultDeadlineDays);
    });

    it('update as non-admin → Forbidden', async () => {
      await expect(
        withTestTenant(async () => config.update(officerActor(), { sarDefaultDeadlineDays: 40 })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('officer with dpo-001:admin can update', async () => {
      await grantOfficer(['dpo-001:admin']);
      const updated = await withTestTenant(async () =>
        config.update(officerActor(), { sarDefaultDeadlineDays: 50 }),
      );
      expect(updated.sarDefaultDeadlineDays).toBe(50);
    });

    it('cross-school: config rows are school-isolated', async () => {
      await withTestTenant(async () => config.update(adminActor(), { sarDefaultDeadlineDays: 40 }));
      const b = await withTestTenantB(async () => config.get(adminActor()));
      // School B gets its own default (auto-create on first read)
      expect(b.sarDefaultDeadlineDays).not.toBe(40);
    });
  });
});
