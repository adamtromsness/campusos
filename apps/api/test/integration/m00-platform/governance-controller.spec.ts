import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { GovernanceController } from '@modules/m00-platform/governance/governance.controller';
import { RopaService } from '@modules/m00-platform/governance/ropa.service';
import { DpiaService } from '@modules/m00-platform/governance/dpia.service';
import { ProcessorService } from '@modules/m00-platform/governance/processors.service';
import { BreachService } from '@modules/m00-platform/governance/breach.service';
import { SarService } from '@modules/m00-platform/governance/sar.service';
import {
  ConsentService,
  ComplianceConfigService,
  ErasureService,
  PrivacyNoticeService,
} from '@modules/m00-platform/governance/erasure.service';
import { GovernanceAccess } from '@modules/m00-platform/governance/access';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { withTestTenant, TEST_SCHOOL_ID, TEST_SCHEMA } from '../helpers/tenant-context';
import { TEST_ADMIN_ACCOUNT_ID, TEST_ADMIN_PERSON_ID } from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';

/**
 * Covers GovernanceController — the HTTP delegation surface that the
 * service-level governance specs leave at 0%. Each test calls the
 * controller method with a synthetic AuthedRequest and verifies it
 * resolves the actor and delegates to the service correctly.
 *
 * Service-level happy paths + auth gates are already covered by the
 * per-service specs (governance-sar / governance-erasure / etc); the
 * controller spec just exercises the route handlers.
 */
describe('integration:m00-platform/governance-controller', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let controller: GovernanceController;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();

    const permCheck = new PermissionCheckService(rawClient);
    const actors = new ActorContextService(rawClient, permCheck, tenantPrisma);
    const access = new GovernanceAccess(tenantPrisma);
    const outbox = new OutboxService();
    const ropa = new RopaService(tenantPrisma, permCheck);
    const dpias = new DpiaService(tenantPrisma, ropa);
    const processors = new ProcessorService(tenantPrisma, permCheck);
    const breaches = new BreachService(tenantPrisma, permCheck, outbox);
    const sars = new SarService(tenantPrisma, permCheck, access);
    const erasures = new ErasureService(tenantPrisma, permCheck, access);
    const consents = new ConsentService(tenantPrisma, permCheck, access);
    const notices = new PrivacyNoticeService(tenantPrisma, permCheck);
    const config = new ComplianceConfigService(tenantPrisma, permCheck);

    controller = new GovernanceController(
      actors,
      tenantPrisma,
      ropa,
      dpias,
      processors,
      breaches,
      sars,
      erasures,
      consents,
      notices,
      config,
    );

    // Grant admin actor full DPO scope via the effective-access cache.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'gov-ctrl-test')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      [
        'sch-001:admin',
        'dpo-001:read',
        'dpo-001:write',
        'dpo-001:admin',
        'dpo-002:read',
        'dpo-002:write',
        'dpo-003:read',
        'dpo-003:write',
        'dpo-004:read',
        'dpo-004:write',
        'dpo-005:read',
        'dpo-005:write',
      ],
    );
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE assignment_version_hash = 'gov-ctrl-test'`,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Clean governance-state we create per test (idempotent and cheap).
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.dpo_data_breach_records WHERE school_id = $1::uuid AND breach_title LIKE 'GC-%'`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.dpo_processing_activities WHERE school_id = $1::uuid AND activity_name LIKE 'GC-%'`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.dpo_retention_policies WHERE school_id = $1::uuid AND data_category LIKE 'GC-%'`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.dpo_third_party_processors WHERE school_id = $1::uuid AND processor_name LIKE 'GC-%'`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.dpo_privacy_notices WHERE school_id = $1::uuid AND notice_version LIKE 'GC-%'`,
      TEST_SCHOOL_ID,
    );
  });

  function authedReq(): any {
    return {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
      },
    };
  }

  // ─── ROPA ─────────────────────────────────────────────────

  describe('ROPA endpoints', () => {
    it('createProcessingActivity → getProcessingActivity → update → list (gapsOnly, includeInactive) → delete', async () => {
      const req = authedReq();
      const created = await withTestTenant(async () =>
        controller.createProcessingActivity(req, {
          activityName: 'GC-Activity-' + generateId().slice(-6),
          purpose: 'Test',
          legalBasis: 'CONSENT',
          dataCategories: ['operational'],
          dataSubjects: ['students'],
          highRiskProcessing: false,
        } as any),
      );
      expect(created.id).toBeTruthy();

      const got = await withTestTenant(async () =>
        controller.getProcessingActivity(req, created.id),
      );
      expect(got.id).toBe(created.id);

      const updated = await withTestTenant(async () =>
        controller.updateProcessingActivity(req, created.id, {
          purpose: 'Updated purpose',
        } as any),
      );
      expect(updated.purpose).toBe('Updated purpose');

      const list = await withTestTenant(async () =>
        controller.listProcessingActivities(req, 'false', 'false'),
      );
      expect(list.find((p: any) => p.id === created.id)).toBeDefined();

      const listAll = await withTestTenant(async () =>
        controller.listProcessingActivities(req, 'true', 'false'),
      );
      expect(Array.isArray(listAll)).toBe(true);

      const gapsOnly = await withTestTenant(async () =>
        controller.listProcessingActivities(req, undefined, 'true'),
      );
      expect(Array.isArray(gapsOnly)).toBe(true);

      await withTestTenant(async () => controller.deleteProcessingActivity(req, created.id));
    });
  });

  // ─── Retention ────────────────────────────────────────────

  describe('Retention policy endpoints', () => {
    it('createRetentionPolicy → get → update → list (dueOnly) → delete', async () => {
      const req = authedReq();
      const created = await withTestTenant(async () =>
        controller.createRetentionPolicy(req, {
          dataCategory: 'GC-RC-' + generateId().slice(-6),
          retentionPeriod: '5y',
          legalBasisForRetention: 'LEGAL_OBLIGATION',
          nextReviewDate: '2030-01-01',
        } as any),
      );
      const got = await withTestTenant(async () => controller.getRetentionPolicy(req, created.id));
      expect(got.id).toBe(created.id);

      await withTestTenant(async () =>
        controller.updateRetentionPolicy(req, created.id, {
          retentionPeriod: '7y',
        } as any),
      );

      const list = await withTestTenant(async () => controller.listRetentionPolicies(req, 'false'));
      expect(list.find((p: any) => p.id === created.id)).toBeDefined();

      const dueOnly = await withTestTenant(async () =>
        controller.listRetentionPolicies(req, 'true'),
      );
      expect(Array.isArray(dueOnly)).toBe(true);

      await withTestTenant(async () => controller.deleteRetentionPolicy(req, created.id));
    });
  });

  // ─── DPIAs ────────────────────────────────────────────────

  describe('DPIA endpoints', () => {
    it('listDpias + getDpia + createDpia + updateDpia', async () => {
      const req = authedReq();
      const created = await withTestTenant(async () =>
        controller.createDpia(req, {
          dpiaTitle: 'GC-DPIA-' + generateId().slice(-6),
          triggerReason: 'Test trigger',
          descriptionOfProcessing: 'Test processing description',
        } as any),
      );
      const got = await withTestTenant(async () => controller.getDpia(req, created.id));
      expect(got.id).toBe(created.id);
      const list = await withTestTenant(async () => controller.listDpias(req));
      expect(list.find((d: any) => d.id === created.id)).toBeDefined();
      const filtered = await withTestTenant(async () => controller.listDpias(req, 'DRAFT'));
      expect(Array.isArray(filtered)).toBe(true);
      await withTestTenant(async () =>
        controller.updateDpia(req, created.id, {
          descriptionOfProcessing: 'Updated description',
        } as any),
      );
    });
  });

  // ─── Processors + DPAs ───────────────────────────────────

  describe('Processor + DPA endpoints', () => {
    it('createProcessor → get → update → list + DPA CRUD', async () => {
      const req = authedReq();
      const p = await withTestTenant(async () =>
        controller.createProcessor(req, {
          processorName: 'GC-Proc-' + generateId().slice(-6),
          processorType: 'CLOUD_INFRASTRUCTURE',
          registeredCountry: 'US',
          dataCategoriesProcessed: ['operational'],
          nextReviewDate: '2027-01-01',
        } as any),
      );
      const got = await withTestTenant(async () => controller.getProcessor(req, p.id));
      expect(got.id).toBe(p.id);
      await withTestTenant(async () =>
        controller.updateProcessor(req, p.id, {
          registeredCountry: 'EU',
        } as any),
      );
      const listAll = await withTestTenant(async () => controller.listProcessors(req));
      expect(listAll.find((x: any) => x.id === p.id)).toBeDefined();
      const gapsOnly = await withTestTenant(async () => controller.listProcessors(req, 'true'));
      expect(Array.isArray(gapsOnly)).toBe(true);

      // DPA flow
      const dpa = await withTestTenant(async () =>
        controller.createDpa(req, {
          processorId: p.id,
          agreementReference: 'AGR-' + generateId().slice(-6),
          effectiveFrom: '2026-01-01',
          effectiveTo: '2027-01-01',
          documentS3Key: 's3://gc-dpa',
          subProcessorsDisclosed: false,
          reviewDate: '2026-06-01',
        } as any),
      );
      const gotDpa = await withTestTenant(async () => controller.getDpa(req, dpa.id));
      expect(gotDpa.id).toBe(dpa.id);
      await withTestTenant(async () =>
        controller.updateDpa(req, dpa.id, {
          agreementReference: 'AGR-UPDATED',
        } as any),
      );
      const dpaList = await withTestTenant(async () => controller.listDpas(req));
      expect(dpaList.find((d: any) => d.id === dpa.id)).toBeDefined();
      const filteredDpas = await withTestTenant(async () => controller.listDpas(req, p.id));
      expect(filteredDpas.find((d: any) => d.id === dpa.id)).toBeDefined();
    });
  });

  // ─── Breaches ────────────────────────────────────────────

  describe('Breach endpoints', () => {
    it('createBreach + list + getBreach + update + notify + resolve', async () => {
      const req = authedReq();
      const b = await withTestTenant(async () =>
        controller.createBreach(req, {
          breachTitle: 'GC-' + generateId().slice(-6),
          discoveryDate: new Date().toISOString(),
          breachType: 'UNAUTHORISED_ACCESS',
          personalDataCategoriesInvolved: ['operational'],
          estimatedAffectedIndividuals: 1,
          riskLevel: 'LOW',
          riskToIndividuals: 'POSSIBLE',
          supervisoryAuthorityNotificationRequired: false,
          breachCause: 'misconfiguration',
          remediationActions: 'corrected',
        } as any),
      );
      const got = await withTestTenant(async () => controller.getBreach(req, b.id));
      expect(got.id).toBe(b.id);

      const list = await withTestTenant(async () => controller.listBreaches(req));
      expect(list.find((x: any) => x.id === b.id)).toBeDefined();

      const filtered = await withTestTenant(async () =>
        controller.listBreaches(req, 'UNDER_INVESTIGATION', 'false'),
      );
      expect(Array.isArray(filtered)).toBe(true);

      const pending = await withTestTenant(async () =>
        controller.listBreaches(req, undefined, 'true'),
      );
      expect(Array.isArray(pending)).toBe(true);

      await withTestTenant(async () =>
        controller.updateBreach(req, b.id, {
          remediationActions: 'updated remediation',
        } as any),
      );

      // Resolve
      await withTestTenant(async () =>
        controller.resolveBreach(req, b.id, {
          resolvedAt: new Date().toISOString(),
        } as any),
      );
    });

    it('notifySa + notifyDs paths', async () => {
      const req = authedReq();
      const b = await withTestTenant(async () =>
        controller.createBreach(req, {
          breachTitle: 'GC-notify-' + generateId().slice(-6),
          discoveryDate: new Date().toISOString(),
          breachType: 'UNAUTHORISED_ACCESS',
          personalDataCategoriesInvolved: ['operational'],
          estimatedAffectedIndividuals: 10,
          riskLevel: 'HIGH',
          riskToIndividuals: 'LIKELY',
          supervisoryAuthorityNotificationRequired: true,
          dataSubjectsNotificationRequired: true,
          breachCause: 'misconfiguration',
          remediationActions: 'corrected',
        } as any),
      );

      await withTestTenant(async () =>
        controller.notifySa(req, b.id, {
          supervisoryAuthorityReference: 'SA-001',
          notifiedAt: new Date().toISOString(),
        } as any),
      );
      await withTestTenant(async () =>
        controller.notifyDs(req, b.id, {
          notifiedAt: new Date().toISOString(),
        } as any),
      );
    });
  });

  // ─── SARs ────────────────────────────────────────────────

  describe('SAR endpoints', () => {
    it('list + filtered list + getById missing returns NotFound (via service)', async () => {
      const req = authedReq();
      const list = await withTestTenant(async () => controller.listSars(req));
      expect(Array.isArray(list)).toBe(true);
      const filtered = await withTestTenant(async () =>
        controller.listSars(req, 'PENDING', 'true'),
      );
      expect(Array.isArray(filtered)).toBe(true);
      await expect(
        withTestTenant(async () => controller.getSar(req, generateId())),
      ).rejects.toThrow();
    });
  });

  // ─── Erasures ────────────────────────────────────────────

  describe('Erasure endpoints', () => {
    it('list + filter + listPseudonymisations smoke', async () => {
      const req = authedReq();
      const list = await withTestTenant(async () => controller.listErasures(req));
      expect(Array.isArray(list)).toBe(true);
      const filtered = await withTestTenant(async () => controller.listErasures(req, 'PENDING'));
      expect(Array.isArray(filtered)).toBe(true);
      const pseudonymisations = await withTestTenant(async () =>
        controller.listPseudonymisations(req),
      );
      expect(Array.isArray(pseudonymisations)).toBe(true);
      const filteredPs = await withTestTenant(async () =>
        controller.listPseudonymisations(req, generateId()),
      );
      expect(Array.isArray(filteredPs)).toBe(true);
    });
  });

  // ─── Consents ────────────────────────────────────────────

  describe('Consent endpoints', () => {
    it('list (with all 3 query params) returns array', async () => {
      const req = authedReq();
      const list1 = await withTestTenant(async () => controller.listConsents(req));
      expect(Array.isArray(list1)).toBe(true);
      const list2 = await withTestTenant(async () =>
        controller.listConsents(req, generateId(), generateId(), 'true'),
      );
      expect(Array.isArray(list2)).toBe(true);
    });
  });

  // ─── Privacy Notices ─────────────────────────────────────

  describe('Privacy Notice endpoints', () => {
    it('createNotice + listNotices + currentNotice + publishNotice', async () => {
      const req = authedReq();
      const created = await withTestTenant(async () =>
        controller.createNotice(req, {
          noticeVersion: 'GC-v-' + generateId().slice(-6),
          effectiveFrom: new Date().toISOString().slice(0, 10),
          contentSummary: 'Test privacy notice content',
          documentS3Key: 's3://gc-notice',
        } as any),
      );
      const list = await withTestTenant(async () => controller.listNotices(req));
      expect(list.find((n: any) => n.id === created.id)).toBeDefined();

      await withTestTenant(async () => controller.publishNotice(req, created.id, {} as any));

      const current = await withTestTenant(async () => controller.currentNotice(req));
      expect(current).toBeDefined();
    });
  });

  // ─── Compliance Config ────────────────────────────────────

  describe('Compliance config endpoints', () => {
    it('getConfig returns + updateConfig sets values', async () => {
      const req = authedReq();
      const got = await withTestTenant(async () => controller.getConfig(req));
      expect(got).toBeDefined();
      const updated = await withTestTenant(async () =>
        controller.updateConfig(req, {
          sarDefaultDeadlineDays: 35,
        } as any),
      );
      expect(updated).toBeDefined();
    });
  });

  // ─── Dashboard ────────────────────────────────────────────

  describe('Dashboard endpoint', () => {
    it('dashboard returns the rollup envelope with the expected shape', async () => {
      const req = authedReq();
      const r = await withTestTenant(async () => controller.dashboard(req));
      expect(r.schoolId).toBe(TEST_SCHOOL_ID);
      expect(typeof r.ropaCount).toBe('number');
      expect(typeof r.highRiskActivities).toBe('number');
      expect(typeof r.dpiaGaps).toBe('number');
      expect(typeof r.activeBreaches).toBe('number');
      expect(typeof r.pendingSars).toBe('number');
      expect(typeof r.activeConsents).toBe('number');
    });
  });
});
