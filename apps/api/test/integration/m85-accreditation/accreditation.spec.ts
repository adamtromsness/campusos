import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { FrameworkService } from '@modules/m85-accreditation/framework.service';
import { EvidenceService } from '@modules/m85-accreditation/evidence.service';
import { SelfStudyService } from '@modules/m85-accreditation/self-study.service';
import { ActionPlanService } from '@modules/m85-accreditation/action-plan.service';
import { SiteVisitService } from '@modules/m85-accreditation/site-visit.service';
import { ActionPlanOverdueWorker } from '@modules/m85-accreditation/action-plan-overdue.worker';
import { deterministicActionPlanOverdueEventId } from '@modules/m85-accreditation/event-ids';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_SUBDOMAIN,
} from '../helpers/tenant-context';
import {
  adminActor,
  parentActor,
  studentActor,
  teacherActor,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import {
  resetAccreditationTables,
  seedAdoption,
  TEST_PLATFORM_FRAMEWORK_ID,
  TEST_PLATFORM_FRAMEWORK_B_ID,
  TEST_PLATFORM_FRAMEWORK_INACTIVE_ID,
  TEST_PLATFORM_STANDARD_A_ID,
  TEST_PLATFORM_STANDARD_B_ID,
  TEST_PLATFORM_STANDARD_C_ID,
  TEST_PLATFORM_STANDARD_UNADOPTED_ID,
} from '../fixtures/accreditation';

/**
 * Wave 7 — m85-accreditation services.
 *
 * Exercises:
 *   FrameworkService:
 *     - listFrameworks: mixes platform + tenant rows with is_adopted flag
 *     - listAdoptions: returns adopted platform frameworks for this school
 *     - createAdoption: UNIQUE caps double-adoption (409); 404 unknown framework
 *     - createCustomFramework: UNIQUE (school, name) caps duplicates (409)
 *     - listStandardsForFramework: platform branch + tenant branch
 *     - getStandardById: SOFT INTEGRITY resolver
 *   EvidenceService:
 *     - create (per evidence_type shape) + DRAFT → SUBMITTED → APPROVED/REJECTED
 *     - reviewed_chk lockstep with reviewed_by + reviewed_at
 *     - APPROVED triggers SiteVisitService.recomputeReadinessForSchool
 *     - list / getById / listByStatus
 *   SelfStudyService:
 *     - create with UNIQUE (standard, school, cycle) → 409 on re-rating
 *     - summary aggregates by domain + totals + multi-domain rollup
 *   ActionPlanService:
 *     - initial OVERDUE if target_date<today else PLANNED
 *     - FSM transitions + delete COMPLETE protection
 *     - updateSubAction auto-completes parent when all sub-actions COMPLETED
 *     - assertEmployeeInTenant — refuses foreign-school employee
 *   SiteVisitService:
 *     - create + update FSM + readinessForVisit gap list + score
 *     - immutability on VISIT_COMPLETE
 *   ActionPlanOverdueWorker.tickForSchool:
 *     - flips IN_PROGRESS → OVERDUE when target_date<today
 *     - enqueues acc.action_plan.overdue with deterministic event_id
 *   Cross-school isolation: every list/get path returns 0 / 404
 *     when called from School A against School B rows.
 */
describe('integration:m85-accreditation/services', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let outbox: OutboxService;
  let frameworks: FrameworkService;
  let evidence: EvidenceService;
  let selfStudy: SelfStudyService;
  let actionPlans: ActionPlanService;
  let siteVisits: SiteVisitService;
  let worker: ActionPlanOverdueWorker;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    outbox = new OutboxService();
    frameworks = new FrameworkService(tenantPrisma, permCheck);
    siteVisits = new SiteVisitService(tenantPrisma, permCheck);
    evidence = new EvidenceService(tenantPrisma, permCheck, siteVisits);
    selfStudy = new SelfStudyService(tenantPrisma, permCheck, siteVisits);
    actionPlans = new ActionPlanService(tenantPrisma, permCheck);
    worker = new ActionPlanOverdueWorker(tenantPrisma, outbox);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetAccreditationTables(rawClient);
  });

  function isoDate(daysOffset: number): string {
    return new Date(Date.now() + daysOffset * 86400_000).toISOString().slice(0, 10);
  }

  // ─────────────────────────── FrameworkService ───────────────────────────

  describe('FrameworkService.listFrameworks', () => {
    it('admin sees active platform frameworks with is_adopted=false', async () => {
      const list = await withTestTenant(async () => frameworks.listFrameworks(adminActor()));
      // The two ACTIVE test platform frameworks are present, plus any
      // demo-seeded platform frameworks (we filter by name to assert
      // ours appear with the right shape).
      const tpf = list.find((f) => f.id === TEST_PLATFORM_FRAMEWORK_ID);
      expect(tpf).toBeDefined();
      expect(tpf!.source).toBe('PLATFORM');
      expect(tpf!.isAdopted).toBe(false);
      expect(tpf!.standardCount).toBeGreaterThanOrEqual(3);
      // Inactive platform frameworks excluded
      const inactive = list.find((f) => f.id === TEST_PLATFORM_FRAMEWORK_INACTIVE_ID);
      expect(inactive).toBeUndefined();
    });

    it('adopted platform frameworks come back with isAdopted=true', async () => {
      await seedAdoption(rawClient);
      const list = await withTestTenant(async () => frameworks.listFrameworks(adminActor()));
      const tpf = list.find((f) => f.id === TEST_PLATFORM_FRAMEWORK_ID);
      expect(tpf!.isAdopted).toBe(true);
    });

    it('tenant custom frameworks are tagged TENANT', async () => {
      await withTestTenant(async () =>
        frameworks.createCustomFramework(adminActor(), {
          name: 'Bespoke Framework',
          description: 'School-defined',
        } as any),
      );
      const list = await withTestTenant(async () => frameworks.listFrameworks(adminActor()));
      const custom = list.find((f) => f.name === 'Bespoke Framework');
      expect(custom).toBeDefined();
      expect(custom!.source).toBe('TENANT');
      expect(custom!.isAdopted).toBe(true);
      expect(custom!.standardCount).toBe(0);
    });

    it('parent + student personas → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => frameworks.listFrameworks(parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => frameworks.listFrameworks(studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('teacher (STAFF + non-admin) is allowed to read frameworks', async () => {
      const list = await withTestTenant(async () => frameworks.listFrameworks(teacherActor()));
      expect(Array.isArray(list)).toBe(true);
    });
  });

  describe('FrameworkService.createAdoption', () => {
    it('admin adopts a platform framework', async () => {
      const adoption = await withTestTenant(async () =>
        frameworks.createAdoption(adminActor(), {
          platformFrameworkId: TEST_PLATFORM_FRAMEWORK_ID,
        } as any),
      );
      expect(adoption.platformFrameworkId).toBe(TEST_PLATFORM_FRAMEWORK_ID);
      expect(adoption.isActive).toBe(true);
      expect(adoption.schoolId).toBe(TEST_SCHOOL_ID);
    });

    it('double adoption → ConflictException via UNIQUE(school, framework)', async () => {
      await seedAdoption(rawClient);
      await expect(
        withTestTenant(async () =>
          frameworks.createAdoption(adminActor(), {
            platformFrameworkId: TEST_PLATFORM_FRAMEWORK_ID,
          } as any),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('unknown platform framework → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          frameworks.createAdoption(adminActor(), {
            platformFrameworkId: '00000000-0000-0000-0000-000000000000',
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('inactive platform framework → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          frameworks.createAdoption(adminActor(), {
            platformFrameworkId: TEST_PLATFORM_FRAMEWORK_INACTIVE_ID,
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('explicit adoptedAt is honoured', async () => {
      const out = await withTestTenant(async () =>
        frameworks.createAdoption(adminActor(), {
          platformFrameworkId: TEST_PLATFORM_FRAMEWORK_ID,
          adoptedAt: '2024-01-15',
        } as any),
      );
      expect(out.adoptedAt).toBe('2024-01-15');
    });

    it('non-staff persona → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          frameworks.createAdoption(parentActor(), {
            platformFrameworkId: TEST_PLATFORM_FRAMEWORK_ID,
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('FrameworkService.listAdoptions', () => {
    it('returns adopted frameworks scoped to this school', async () => {
      await seedAdoption(rawClient);
      await seedAdoption(rawClient, TEST_SCHOOL_B_ID); // School B noise

      const list = await withTestTenant(async () => frameworks.listAdoptions(adminActor()));
      expect(list.length).toBe(1);
      expect(list[0]!.platformFrameworkId).toBe(TEST_PLATFORM_FRAMEWORK_ID);
      expect(list[0]!.schoolId).toBe(TEST_SCHOOL_ID);

      // School B sees only its own adoption — cross-school isolation
      const listB = await withTestTenantB(async () => frameworks.listAdoptions(adminActor()));
      expect(listB.length).toBe(1);
      expect(listB[0]!.schoolId).toBe(TEST_SCHOOL_B_ID);
    });
  });

  describe('FrameworkService.createCustomFramework', () => {
    it('creates a custom framework with TENANT source', async () => {
      const f = await withTestTenant(async () =>
        frameworks.createCustomFramework(adminActor(), {
          name: '  Whitespace  ',
          description: 'spaced',
        } as any),
      );
      expect(f.source).toBe('TENANT');
      expect(f.name).toBe('Whitespace');
      expect(f.standardCount).toBe(0);
      expect(f.isAdopted).toBe(true);
    });

    it('UNIQUE (school, name) collision → ConflictException', async () => {
      await withTestTenant(async () =>
        frameworks.createCustomFramework(adminActor(), { name: 'Dup' } as any),
      );
      await expect(
        withTestTenant(async () =>
          frameworks.createCustomFramework(adminActor(), { name: 'Dup' } as any),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('FrameworkService.listStandardsForFramework', () => {
    it('platform branch returns ordered standards', async () => {
      const out = await withTestTenant(async () =>
        frameworks.listStandardsForFramework(adminActor(), TEST_PLATFORM_FRAMEWORK_ID),
      );
      const ours = out.filter((s) =>
        [
          TEST_PLATFORM_STANDARD_A_ID,
          TEST_PLATFORM_STANDARD_B_ID,
          TEST_PLATFORM_STANDARD_C_ID,
        ].includes(s.id),
      );
      expect(ours.length).toBe(3);
      expect(ours[0]!.source).toBe('PLATFORM');
      expect(ours[0]!.sortOrder).toBeLessThanOrEqual(ours[1]!.sortOrder);
    });

    it('tenant custom branch returns single placeholder standard', async () => {
      const f = await withTestTenant(async () =>
        frameworks.createCustomFramework(adminActor(), {
          name: 'Tenant Only',
          description: 'fallback text',
        } as any),
      );
      const out = await withTestTenant(async () =>
        frameworks.listStandardsForFramework(adminActor(), f.id),
      );
      expect(out.length).toBe(1);
      expect(out[0]!.source).toBe('TENANT');
      expect(out[0]!.standardCode).toBe('Tenant Only');
      expect(out[0]!.standardText).toBe('fallback text');
    });

    it('unknown framework → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          frameworks.listStandardsForFramework(
            adminActor(),
            '00000000-0000-0000-0000-000000000000',
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school tenant framework → NotFoundException', async () => {
      const f = await withTestTenantB(async () =>
        frameworks.createCustomFramework(adminActor(), { name: 'School B custom' } as any),
      );
      await expect(
        withTestTenant(async () => frameworks.listStandardsForFramework(adminActor(), f.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('FrameworkService.getStandardById', () => {
    it('SOFT INTEGRITY: resolves a platform standard when its framework is adopted', async () => {
      await seedAdoption(rawClient);
      const s = await withTestTenant(async () =>
        frameworks.getStandardById(adminActor(), TEST_PLATFORM_STANDARD_A_ID),
      );
      expect(s.id).toBe(TEST_PLATFORM_STANDARD_A_ID);
      expect(s.source).toBe('PLATFORM');
      expect(s.standardCode).toBe('1.1');
    });

    it('refuses a platform standard whose framework is NOT adopted by the school', async () => {
      // School adopts the primary; reference the unadopted-framework standard
      await seedAdoption(rawClient);
      await expect(
        withTestTenant(async () =>
          frameworks.getStandardById(adminActor(), TEST_PLATFORM_STANDARD_UNADOPTED_ID),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('resolves a tenant custom framework as a standard', async () => {
      const f = await withTestTenant(async () =>
        frameworks.createCustomFramework(adminActor(), { name: 'Custom' } as any),
      );
      const s = await withTestTenant(async () => frameworks.getStandardById(adminActor(), f.id));
      expect(s.source).toBe('TENANT');
      expect(s.standardCode).toBe('Custom');
    });

    it('missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          frameworks.getStandardById(adminActor(), '00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('empty standardId → BadRequestException', async () => {
      await expect(
        withTestTenant(async () => frameworks.getStandardById(adminActor(), '')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─────────────────────────── EvidenceService ───────────────────────────

  describe('EvidenceService.create + type-shape validation', () => {
    beforeEach(async () => {
      await seedAdoption(rawClient);
    });

    it('DOCUMENT evidence requires s3Key', async () => {
      await expect(
        withTestTenant(async () =>
          evidence.create(adminActor(), {
            standardId: TEST_PLATFORM_STANDARD_A_ID,
            evidenceType: 'DOCUMENT',
            title: 'Doc',
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const ok = await withTestTenant(async () =>
        evidence.create(adminActor(), {
          standardId: TEST_PLATFORM_STANDARD_A_ID,
          evidenceType: 'DOCUMENT',
          title: 'Doc',
          s3Key: 'bucket/key.pdf',
        } as any),
      );
      expect(ok.evidenceType).toBe('DOCUMENT');
      expect(ok.status).toBe('DRAFT');
      expect(ok.submittedAt).toBeNull();
    });

    it('URL evidence requires url', async () => {
      await expect(
        withTestTenant(async () =>
          evidence.create(adminActor(), {
            standardId: TEST_PLATFORM_STANDARD_A_ID,
            evidenceType: 'URL',
            title: 'Link',
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      const ok = await withTestTenant(async () =>
        evidence.create(adminActor(), {
          standardId: TEST_PLATFORM_STANDARD_A_ID,
          evidenceType: 'URL',
          title: 'Link',
          url: 'https://example.com',
        } as any),
      );
      expect(ok.url).toBe('https://example.com');
    });

    it('METRIC evidence requires metricValue', async () => {
      await expect(
        withTestTenant(async () =>
          evidence.create(adminActor(), {
            standardId: TEST_PLATFORM_STANDARD_A_ID,
            evidenceType: 'METRIC',
            title: 'Metric',
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      const ok = await withTestTenant(async () =>
        evidence.create(adminActor(), {
          standardId: TEST_PLATFORM_STANDARD_A_ID,
          evidenceType: 'METRIC',
          title: 'Metric',
          metricValue: '98%',
          description: 'Attendance',
        } as any),
      );
      expect(ok.metricValue).toBe('98%');
    });

    it('OBSERVATION + SURVEY accept just title/description', async () => {
      const obs = await withTestTenant(async () =>
        evidence.create(adminActor(), {
          standardId: TEST_PLATFORM_STANDARD_A_ID,
          evidenceType: 'OBSERVATION',
          title: 'Walkthrough',
          description: 'Notes',
        } as any),
      );
      expect(obs.evidenceType).toBe('OBSERVATION');
      const srv = await withTestTenant(async () =>
        evidence.create(adminActor(), {
          standardId: TEST_PLATFORM_STANDARD_A_ID,
          evidenceType: 'SURVEY',
          title: 'Parent survey',
        } as any),
      );
      expect(srv.evidenceType).toBe('SURVEY');
    });

    it('SOFT INTEGRITY: unknown standard → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          evidence.create(adminActor(), {
            standardId: '00000000-0000-0000-0000-000000000000',
            evidenceType: 'OBSERVATION',
            title: 'X',
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('parent persona → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          evidence.create(parentActor(), {
            standardId: TEST_PLATFORM_STANDARD_A_ID,
            evidenceType: 'OBSERVATION',
            title: 'X',
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('EvidenceService.review FSM', () => {
    beforeEach(async () => {
      await seedAdoption(rawClient);
    });

    async function seedDraft(standardId = TEST_PLATFORM_STANDARD_A_ID): Promise<string> {
      const out = await withTestTenant(async () =>
        evidence.create(adminActor(), {
          standardId,
          evidenceType: 'OBSERVATION',
          title: 'E',
          description: 'd',
        } as any),
      );
      return out.id;
    }

    it('DRAFT → SUBMITTED stamps submitted_at and keeps reviewed_by NULL', async () => {
      const id = await seedDraft();
      const out = await withTestTenant(async () =>
        evidence.review(adminActor(), id, { status: 'SUBMITTED' } as any),
      );
      expect(out.status).toBe('SUBMITTED');
      expect(out.submittedAt).toBeTruthy();
      expect(out.reviewedBy).toBeNull();
      expect(out.reviewedAt).toBeNull();
    });

    it('SUBMITTED → APPROVED stamps reviewed_by + reviewed_at lockstep', async () => {
      const id = await seedDraft();
      await withTestTenant(async () =>
        evidence.review(adminActor(), id, { status: 'SUBMITTED' } as any),
      );
      const approved = await withTestTenant(async () =>
        evidence.review(adminActor(), id, {
          status: 'APPROVED',
          reviewerNotes: 'looks good',
        } as any),
      );
      expect(approved.status).toBe('APPROVED');
      expect(approved.reviewedBy).toBeTruthy();
      expect(approved.reviewedAt).toBeTruthy();
      expect(approved.reviewerNotes).toBe('looks good');
    });

    it('SUBMITTED → REJECTED requires reviewerNotes', async () => {
      const id = await seedDraft();
      await withTestTenant(async () =>
        evidence.review(adminActor(), id, { status: 'SUBMITTED' } as any),
      );
      await expect(
        withTestTenant(async () =>
          evidence.review(adminActor(), id, { status: 'REJECTED' } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const rej = await withTestTenant(async () =>
        evidence.review(adminActor(), id, {
          status: 'REJECTED',
          reviewerNotes: 'needs more data',
        } as any),
      );
      expect(rej.status).toBe('REJECTED');
      expect(rej.reviewerNotes).toBe('needs more data');
    });

    it('cannot SUBMIT a non-DRAFT', async () => {
      const id = await seedDraft();
      await withTestTenant(async () =>
        evidence.review(adminActor(), id, { status: 'SUBMITTED' } as any),
      );
      await expect(
        withTestTenant(async () =>
          evidence.review(adminActor(), id, { status: 'SUBMITTED' } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cannot APPROVE a DRAFT', async () => {
      const id = await seedDraft();
      await expect(
        withTestTenant(async () =>
          evidence.review(adminActor(), id, { status: 'APPROVED' } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('review missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          evidence.review(adminActor(), '00000000-0000-0000-0000-000000000000', {
            status: 'SUBMITTED',
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('APPROVED triggers SiteVisitService.recomputeReadinessForSchool', async () => {
      // Submit and approve a rating so the score has BOTH legs.
      const sid = TEST_PLATFORM_STANDARD_A_ID;
      const id = await seedDraft(sid);
      await withTestTenant(async () =>
        evidence.review(adminActor(), id, { status: 'SUBMITTED' } as any),
      );

      // Submit a rating so the cycle exists + the standard is "rated"
      await withTestTenant(async () =>
        selfStudy.create(adminActor(), {
          standardId: sid,
          cycleId: '2025-2026',
          rating: 'ACCOMPLISHED',
          rationale: 'rationale',
        } as any),
      );

      // Create a site visit prep so recompute has something to UPDATE
      const visit = await withTestTenant(async () =>
        siteVisits.create(adminActor(), {
          visitDate: isoDate(60),
          accreditorOrg: 'AccreditOrg',
        } as any),
      );

      // Before approve: 3 adopted standards, 1 has rating, 0 evidence
      // → score = round(0 / 3 * 100) = 0
      await withTestTenant(async () =>
        evidence.review(adminActor(), id, {
          status: 'APPROVED',
          reviewerNotes: 'ok',
        } as any),
      );

      const refreshed = await withTestTenant(async () =>
        siteVisits.getById(adminActor(), visit.id),
      );
      // 1 of 3 standards now has BOTH rating + APPROVED evidence → 33
      expect(refreshed.readinessScore).toBe(33);
    });
  });

  describe('EvidenceService.list paths + cross-school', () => {
    beforeEach(async () => {
      await seedAdoption(rawClient);
      await seedAdoption(rawClient, TEST_SCHOOL_B_ID);
    });

    it('listForStandard scopes by school_id', async () => {
      await withTestTenant(async () =>
        evidence.create(adminActor(), {
          standardId: TEST_PLATFORM_STANDARD_A_ID,
          evidenceType: 'OBSERVATION',
          title: 'School A item',
        } as any),
      );
      await withTestTenantB(async () =>
        evidence.create(adminActor(), {
          standardId: TEST_PLATFORM_STANDARD_A_ID,
          evidenceType: 'OBSERVATION',
          title: 'School B item',
        } as any),
      );
      const listA = await withTestTenant(async () =>
        evidence.listForStandard(adminActor(), TEST_PLATFORM_STANDARD_A_ID),
      );
      expect(listA.length).toBe(1);
      expect(listA[0]!.title).toBe('School A item');
      const listB = await withTestTenantB(async () =>
        evidence.listForStandard(adminActor(), TEST_PLATFORM_STANDARD_A_ID),
      );
      expect(listB.length).toBe(1);
      expect(listB[0]!.title).toBe('School B item');
    });

    it('listByStatus filters by status', async () => {
      const made = await withTestTenant(async () =>
        evidence.create(adminActor(), {
          standardId: TEST_PLATFORM_STANDARD_A_ID,
          evidenceType: 'OBSERVATION',
          title: 'X',
        } as any),
      );
      await withTestTenant(async () =>
        evidence.review(adminActor(), made.id, { status: 'SUBMITTED' } as any),
      );
      const drafts = await withTestTenant(async () => evidence.listByStatus(adminActor(), 'DRAFT'));
      const submitted = await withTestTenant(async () =>
        evidence.listByStatus(adminActor(), 'SUBMITTED'),
      );
      expect(drafts.length).toBe(0);
      expect(submitted.length).toBe(1);

      // Without filter — both modes return rows
      const all = await withTestTenant(async () => evidence.listByStatus(adminActor()));
      expect(all.length).toBe(1);
    });

    it('getById null on miss', async () => {
      const out = await withTestTenant(async () =>
        evidence.getById(adminActor(), '00000000-0000-0000-0000-000000000000'),
      );
      expect(out).toBeNull();
    });

    it('getById cross-school returns null', async () => {
      const otherSchoolItem = await withTestTenantB(async () =>
        evidence.create(adminActor(), {
          standardId: TEST_PLATFORM_STANDARD_A_ID,
          evidenceType: 'OBSERVATION',
          title: 'X',
        } as any),
      );
      const out = await withTestTenant(async () =>
        evidence.getById(adminActor(), otherSchoolItem.id),
      );
      expect(out).toBeNull();
    });
  });

  // ─────────────────────────── SelfStudyService ───────────────────────────

  describe('SelfStudyService', () => {
    beforeEach(async () => {
      await seedAdoption(rawClient);
    });

    it('create stores a rating + UNIQUE caps duplicates', async () => {
      const out = await withTestTenant(async () =>
        selfStudy.create(adminActor(), {
          standardId: TEST_PLATFORM_STANDARD_A_ID,
          cycleId: '2025-2026',
          rating: 'EXEMPLARY',
          rationale: 'rationale text',
        } as any),
      );
      expect(out.rating).toBe('EXEMPLARY');
      expect(out.cycleId).toBe('2025-2026');

      await expect(
        withTestTenant(async () =>
          selfStudy.create(adminActor(), {
            standardId: TEST_PLATFORM_STANDARD_A_ID,
            cycleId: '2025-2026',
            rating: 'DEVELOPING',
            rationale: 'changed mind',
          } as any),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('different cycles for the same standard are allowed', async () => {
      await withTestTenant(async () =>
        selfStudy.create(adminActor(), {
          standardId: TEST_PLATFORM_STANDARD_A_ID,
          cycleId: '2024-2025',
          rating: 'DEVELOPING',
          rationale: 'cycle 1',
        } as any),
      );
      await withTestTenant(async () =>
        selfStudy.create(adminActor(), {
          standardId: TEST_PLATFORM_STANDARD_A_ID,
          cycleId: '2025-2026',
          rating: 'ACCOMPLISHED',
          rationale: 'cycle 2',
        } as any),
      );
      const list = await withTestTenant(async () =>
        selfStudy.listForCycle(adminActor(), '2025-2026'),
      );
      expect(list.length).toBe(1);
    });

    it('SOFT INTEGRITY: unknown standard → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          selfStudy.create(adminActor(), {
            standardId: '00000000-0000-0000-0000-000000000000',
            cycleId: '2025-2026',
            rating: 'EXEMPLARY',
            rationale: 'no',
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('parent persona → ForbiddenException on create', async () => {
      await expect(
        withTestTenant(async () =>
          selfStudy.create(parentActor(), {
            standardId: TEST_PLATFORM_STANDARD_A_ID,
            cycleId: '2025-2026',
            rating: 'EXEMPLARY',
            rationale: 'no',
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('summary aggregates by rating + per-domain rollup', async () => {
      // Use 3 standards; 2 in Curriculum domain, 1 in Leadership.
      await withTestTenant(async () =>
        selfStudy.create(adminActor(), {
          standardId: TEST_PLATFORM_STANDARD_A_ID,
          cycleId: '2025-2026',
          rating: 'EXEMPLARY',
          rationale: 'r1',
        } as any),
      );
      await withTestTenant(async () =>
        selfStudy.create(adminActor(), {
          standardId: TEST_PLATFORM_STANDARD_B_ID,
          cycleId: '2025-2026',
          rating: 'ACCOMPLISHED',
          rationale: 'r2',
        } as any),
      );
      await withTestTenant(async () =>
        selfStudy.create(adminActor(), {
          standardId: TEST_PLATFORM_STANDARD_C_ID,
          cycleId: '2025-2026',
          rating: 'DEVELOPING',
          rationale: 'r3',
        } as any),
      );

      const sum = await withTestTenant(async () => selfStudy.summary(adminActor(), '2025-2026'));
      expect(sum.cycleId).toBe('2025-2026');
      expect(sum.totals.EXEMPLARY).toBe(1);
      expect(sum.totals.ACCOMPLISHED).toBe(1);
      expect(sum.totals.DEVELOPING).toBe(1);
      expect(sum.totals.NOT_MET).toBe(0);
      expect(sum.totalRated).toBe(3);
      expect(sum.byDomain.length).toBe(2);
      const curriculum = sum.byDomain.find((b) => b.domain === 'Curriculum')!;
      expect(curriculum.EXEMPLARY + curriculum.ACCOMPLISHED).toBe(2);
      const leadership = sum.byDomain.find((b) => b.domain === 'Leadership')!;
      expect(leadership.DEVELOPING).toBe(1);
    });

    it('summary against tenant custom rating lands in "Custom" bucket', async () => {
      const custom = await withTestTenant(async () =>
        frameworks.createCustomFramework(adminActor(), { name: 'C1' } as any),
      );
      await withTestTenant(async () =>
        selfStudy.create(adminActor(), {
          standardId: custom.id,
          cycleId: '2025-2026',
          rating: 'NOT_MET',
          rationale: 'r',
        } as any),
      );
      const sum = await withTestTenant(async () => selfStudy.summary(adminActor(), '2025-2026'));
      expect(sum.totals.NOT_MET).toBe(1);
      expect(sum.byDomain.find((b) => b.domain === 'Custom')).toBeDefined();
    });

    it('getOne returns row, cross-school returns null', async () => {
      const out = await withTestTenant(async () =>
        selfStudy.create(adminActor(), {
          standardId: TEST_PLATFORM_STANDARD_A_ID,
          cycleId: '2025-2026',
          rating: 'EXEMPLARY',
          rationale: 'r',
        } as any),
      );
      const ok = await withTestTenant(async () => selfStudy.getOne(adminActor(), out.id));
      expect(ok!.id).toBe(out.id);
      // School B doesn't see School A's rating
      const miss = await withTestTenantB(async () => selfStudy.getOne(adminActor(), out.id));
      expect(miss).toBeNull();
    });

    it('listForCycle scopes by school_id (cross-school isolation)', async () => {
      await withTestTenant(async () =>
        selfStudy.create(adminActor(), {
          standardId: TEST_PLATFORM_STANDARD_A_ID,
          cycleId: '2025-2026',
          rating: 'EXEMPLARY',
          rationale: 'A',
        } as any),
      );
      await seedAdoption(rawClient, TEST_SCHOOL_B_ID);
      await withTestTenantB(async () =>
        selfStudy.create(adminActor(), {
          standardId: TEST_PLATFORM_STANDARD_A_ID,
          cycleId: '2025-2026',
          rating: 'DEVELOPING',
          rationale: 'B',
        } as any),
      );

      const listA = await withTestTenant(async () =>
        selfStudy.listForCycle(adminActor(), '2025-2026'),
      );
      const listB = await withTestTenantB(async () =>
        selfStudy.listForCycle(adminActor(), '2025-2026'),
      );
      expect(listA.length).toBe(1);
      expect(listA[0]!.rating).toBe('EXEMPLARY');
      expect(listB.length).toBe(1);
      expect(listB[0]!.rating).toBe('DEVELOPING');
    });
  });

  // ─────────────────────────── ActionPlanService ───────────────────────────

  describe('ActionPlanService.create + FSM', () => {
    beforeEach(async () => {
      await seedAdoption(rawClient);
    });

    function dto(extras: Record<string, unknown> = {}): any {
      return {
        standardId: TEST_PLATFORM_STANDARD_A_ID,
        goal: 'Improve outcomes',
        actions: [
          { description: 'Action 1', due_date: isoDate(7), status: 'PENDING' },
          { description: 'Action 2', due_date: isoDate(14), status: 'PENDING' },
        ],
        responsibleParty: TEST_ADMIN_EMPLOYEE_ID,
        targetDate: isoDate(30),
        notes: null,
        ...extras,
      };
    }

    it('future targetDate → initial PLANNED', async () => {
      const ap = await withTestTenant(async () => actionPlans.create(adminActor(), dto()));
      expect(ap.status).toBe('PLANNED');
      expect(ap.actions.length).toBe(2);
    });

    it('past targetDate → initial OVERDUE', async () => {
      const ap = await withTestTenant(async () =>
        actionPlans.create(adminActor(), dto({ targetDate: isoDate(-1) })),
      );
      expect(ap.status).toBe('OVERDUE');
    });

    it('responsibleParty in a foreign school → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          actionPlans.create(
            adminActor(),
            dto({ responsibleParty: '00000000-0000-0000-0000-000000000099' }),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('SOFT INTEGRITY: unknown standard → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          actionPlans.create(
            adminActor(),
            dto({ standardId: '00000000-0000-0000-0000-000000000000' }),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('normaliseActions rejects malformed sub-actions on create', async () => {
      await expect(
        withTestTenant(async () =>
          actionPlans.create(adminActor(), dto({ actions: [{ description: '' }] })),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        withTestTenant(async () =>
          actionPlans.create(adminActor(), dto({ actions: [{ description: 'no due' }] })),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        withTestTenant(async () =>
          actionPlans.create(
            adminActor(),
            dto({
              actions: [{ description: 'bad status', due_date: isoDate(1), status: 'NOPE' }],
            }),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('FSM allowed forward transitions PLANNED → IN_PROGRESS → COMPLETE', async () => {
      const ap = await withTestTenant(async () => actionPlans.create(adminActor(), dto()));
      const a = await withTestTenant(async () =>
        actionPlans.update(adminActor(), ap.id, { status: 'IN_PROGRESS' } as any),
      );
      expect(a.status).toBe('IN_PROGRESS');
      const b = await withTestTenant(async () =>
        actionPlans.update(adminActor(), ap.id, { status: 'COMPLETE' } as any),
      );
      expect(b.status).toBe('COMPLETE');
    });

    it('FSM forbidden transitions throw 400', async () => {
      const ap = await withTestTenant(async () => actionPlans.create(adminActor(), dto()));
      // PLANNED → COMPLETE is allowed; force into COMPLETE then attempt transition
      await withTestTenant(async () =>
        actionPlans.update(adminActor(), ap.id, { status: 'COMPLETE' } as any),
      );
      await expect(
        withTestTenant(async () =>
          actionPlans.update(adminActor(), ap.id, { status: 'IN_PROGRESS' } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cannot delete a COMPLETE action plan', async () => {
      const ap = await withTestTenant(async () => actionPlans.create(adminActor(), dto()));
      await withTestTenant(async () =>
        actionPlans.update(adminActor(), ap.id, { status: 'COMPLETE' } as any),
      );
      await expect(
        withTestTenant(async () => actionPlans.delete(adminActor(), ap.id)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('delete a PLANNED plan succeeds', async () => {
      const ap = await withTestTenant(async () => actionPlans.create(adminActor(), dto()));
      await withTestTenant(async () => actionPlans.delete(adminActor(), ap.id));
      await expect(
        withTestTenant(async () => actionPlans.getById(adminActor(), ap.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('updateSubAction auto-completes the parent when all sub-actions COMPLETED', async () => {
      const ap = await withTestTenant(async () =>
        actionPlans.create(
          adminActor(),
          dto({
            actions: [
              { description: 'A', due_date: isoDate(1), status: 'PENDING' },
              { description: 'B', due_date: isoDate(2), status: 'PENDING' },
            ],
          }),
        ),
      );
      // Move parent to IN_PROGRESS so subsequent transition is allowed
      await withTestTenant(async () =>
        actionPlans.update(adminActor(), ap.id, { status: 'IN_PROGRESS' } as any),
      );
      const after0 = await withTestTenant(async () =>
        actionPlans.updateSubAction(adminActor(), ap.id, {
          index: 0,
          status: 'COMPLETED',
        } as any),
      );
      expect(after0.status).toBe('IN_PROGRESS');
      expect(after0.actions[0]!.status).toBe('COMPLETED');
      const after1 = await withTestTenant(async () =>
        actionPlans.updateSubAction(adminActor(), ap.id, {
          index: 1,
          status: 'COMPLETED',
          description: 'Updated B',
          due_date: isoDate(3),
        } as any),
      );
      expect(after1.status).toBe('COMPLETE');
      expect(after1.actions[1]!.description).toBe('Updated B');
    });

    it('updateSubAction out-of-bounds index → BadRequestException', async () => {
      const ap = await withTestTenant(async () => actionPlans.create(adminActor(), dto()));
      await expect(
        withTestTenant(async () =>
          actionPlans.updateSubAction(adminActor(), ap.id, { index: 99 } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('update with no fields returns existing untouched', async () => {
      const ap = await withTestTenant(async () => actionPlans.create(adminActor(), dto()));
      const same = await withTestTenant(async () =>
        actionPlans.update(adminActor(), ap.id, {} as any),
      );
      expect(same.id).toBe(ap.id);
      expect(same.status).toBe(ap.status);
    });

    it('list filters by status + cross-school isolation', async () => {
      await withTestTenant(async () => actionPlans.create(adminActor(), dto()));
      await withTestTenant(async () =>
        actionPlans.create(adminActor(), dto({ targetDate: isoDate(-1) })),
      );
      const planned = await withTestTenant(async () => actionPlans.list(adminActor(), 'PLANNED'));
      expect(planned.length).toBe(1);
      const overdue = await withTestTenant(async () => actionPlans.list(adminActor(), 'OVERDUE'));
      expect(overdue.length).toBe(1);
      const all = await withTestTenant(async () => actionPlans.list(adminActor()));
      expect(all.length).toBe(2);

      const listB = await withTestTenantB(async () => actionPlans.list(adminActor()));
      expect(listB.length).toBe(0);
    });

    it('update responsibleParty path also validates cross-tenant', async () => {
      const ap = await withTestTenant(async () => actionPlans.create(adminActor(), dto()));
      await expect(
        withTestTenant(async () =>
          actionPlans.update(adminActor(), ap.id, {
            responsibleParty: '00000000-0000-0000-0000-000000000099',
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('update goal + notes + targetDate + actions all flow through', async () => {
      const ap = await withTestTenant(async () => actionPlans.create(adminActor(), dto()));
      const updated = await withTestTenant(async () =>
        actionPlans.update(adminActor(), ap.id, {
          goal: 'New goal',
          notes: 'noted',
          targetDate: isoDate(45),
          actions: [{ description: 'only one', due_date: isoDate(2), status: 'PENDING' }],
        } as any),
      );
      expect(updated.goal).toBe('New goal');
      expect(updated.notes).toBe('noted');
      expect(updated.actions.length).toBe(1);
    });
  });

  // ─────────────────────────── SiteVisitService ───────────────────────────

  describe('SiteVisitService', () => {
    beforeEach(async () => {
      await seedAdoption(rawClient);
    });

    it('create + getById + list', async () => {
      const visit = await withTestTenant(async () =>
        siteVisits.create(adminActor(), {
          visitDate: isoDate(45),
          accreditorOrg: 'AccreditOrg',
          leadContactName: 'Lead',
          leadContactEmail: 'l@e.com',
          notes: 'prep work',
        } as any),
      );
      expect(visit.status).toBe('PREPARING');
      // No ratings yet → 0% readiness
      expect(visit.readinessScore).toBe(0);

      const got = await withTestTenant(async () => siteVisits.getById(adminActor(), visit.id));
      expect(got.id).toBe(visit.id);

      const list = await withTestTenant(async () => siteVisits.list(adminActor()));
      expect(list.length).toBe(1);
    });

    it('update FSM PREPARING → READY → VISIT_COMPLETE', async () => {
      const v = await withTestTenant(async () =>
        siteVisits.create(adminActor(), {
          visitDate: isoDate(30),
          accreditorOrg: 'O',
        } as any),
      );
      const ready = await withTestTenant(async () =>
        siteVisits.update(adminActor(), v.id, { status: 'READY' } as any),
      );
      expect(ready.status).toBe('READY');
      const done = await withTestTenant(async () =>
        siteVisits.update(adminActor(), v.id, { status: 'VISIT_COMPLETE' } as any),
      );
      expect(done.status).toBe('VISIT_COMPLETE');

      // Cannot transition out of VISIT_COMPLETE
      await expect(
        withTestTenant(async () =>
          siteVisits.update(adminActor(), v.id, { status: 'READY' } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('update READY → PREPARING rollback is allowed', async () => {
      const v = await withTestTenant(async () =>
        siteVisits.create(adminActor(), {
          visitDate: isoDate(30),
          accreditorOrg: 'O',
        } as any),
      );
      await withTestTenant(async () =>
        siteVisits.update(adminActor(), v.id, { status: 'READY' } as any),
      );
      const rolled = await withTestTenant(async () =>
        siteVisits.update(adminActor(), v.id, { status: 'PREPARING' } as any),
      );
      expect(rolled.status).toBe('PREPARING');
    });

    it('readinessForVisit returns gap list across un-rated standards', async () => {
      const v = await withTestTenant(async () =>
        siteVisits.create(adminActor(), {
          visitDate: isoDate(30),
          accreditorOrg: 'O',
        } as any),
      );
      // Rate 1 of 3 + approve evidence for 1 (same standard)
      const e = await withTestTenant(async () =>
        evidence.create(adminActor(), {
          standardId: TEST_PLATFORM_STANDARD_A_ID,
          evidenceType: 'OBSERVATION',
          title: 'X',
        } as any),
      );
      await withTestTenant(async () =>
        evidence.review(adminActor(), e.id, { status: 'SUBMITTED' } as any),
      );
      await withTestTenant(async () =>
        evidence.review(adminActor(), e.id, {
          status: 'APPROVED',
          reviewerNotes: 'ok',
        } as any),
      );
      await withTestTenant(async () =>
        selfStudy.create(adminActor(), {
          standardId: TEST_PLATFORM_STANDARD_A_ID,
          cycleId: '2025-2026',
          rating: 'ACCOMPLISHED',
          rationale: 'r',
        } as any),
      );

      const report = await withTestTenant(async () =>
        siteVisits.readinessForVisit(adminActor(), v.id),
      );
      expect(report.totalAdoptedStandards).toBe(3);
      expect(report.standardsReady).toBe(1);
      expect(report.readinessScore).toBe(33);
      expect(report.gaps.length).toBe(2);
      const stdBGap = report.gaps.find((g) => g.standardId === TEST_PLATFORM_STANDARD_B_ID);
      expect(stdBGap!.hasRating).toBe(false);
      expect(stdBGap!.hasApprovedEvidence).toBe(false);
    });

    it('readinessForVisit short-circuits to 0 when school has no adopted standards', async () => {
      // Use School B which has no adoption seeded by this describe block
      const v = await withTestTenantB(async () =>
        siteVisits.create(adminActor(), {
          visitDate: isoDate(30),
          accreditorOrg: 'O',
        } as any),
      );
      const report = await withTestTenantB(async () =>
        siteVisits.readinessForVisit(adminActor(), v.id),
      );
      expect(report.totalAdoptedStandards).toBe(0);
      expect(report.readinessScore).toBe(0);
      expect(report.gaps.length).toBe(0);
    });

    it('VISIT_COMPLETE visit retains its score even when more evidence is approved', async () => {
      const v = await withTestTenant(async () =>
        siteVisits.create(adminActor(), {
          visitDate: isoDate(30),
          accreditorOrg: 'O',
        } as any),
      );
      // Score = 0 at create. Move to VISIT_COMPLETE — score frozen.
      await withTestTenant(async () =>
        siteVisits.update(adminActor(), v.id, { status: 'VISIT_COMPLETE' } as any),
      );
      const scoreFrozen = await withTestTenant(async () => siteVisits.getById(adminActor(), v.id));
      expect(scoreFrozen.readinessScore).toBe(0);

      // Now approve some evidence + add rating → recompute fires but
      // persistScore short-circuits when status=VISIT_COMPLETE.
      const e = await withTestTenant(async () =>
        evidence.create(adminActor(), {
          standardId: TEST_PLATFORM_STANDARD_A_ID,
          evidenceType: 'OBSERVATION',
          title: 'X',
        } as any),
      );
      await withTestTenant(async () =>
        evidence.review(adminActor(), e.id, { status: 'SUBMITTED' } as any),
      );
      await withTestTenant(async () =>
        evidence.review(adminActor(), e.id, {
          status: 'APPROVED',
          reviewerNotes: 'ok',
        } as any),
      );
      await withTestTenant(async () =>
        selfStudy.create(adminActor(), {
          standardId: TEST_PLATFORM_STANDARD_A_ID,
          cycleId: '2025-2026',
          rating: 'EXEMPLARY',
          rationale: 'r',
        } as any),
      );

      const after = await withTestTenant(async () => siteVisits.getById(adminActor(), v.id));
      // recomputeReadinessForSchool only updates non-VISIT_COMPLETE rows
      expect(after.readinessScore).toBe(0);
    });

    it('update non-status fields (visitDate / accreditorOrg / leadContact / notes)', async () => {
      const v = await withTestTenant(async () =>
        siteVisits.create(adminActor(), {
          visitDate: isoDate(30),
          accreditorOrg: 'O',
        } as any),
      );
      const updated = await withTestTenant(async () =>
        siteVisits.update(adminActor(), v.id, {
          visitDate: isoDate(45),
          accreditorOrg: '  Renamed  ',
          leadContactName: 'Lead',
          leadContactEmail: 'l@e.com',
          notes: 'updated',
        } as any),
      );
      expect(updated.accreditorOrg).toBe('Renamed');
      expect(updated.notes).toBe('updated');
    });

    it('update with no changes returns existing untouched', async () => {
      const v = await withTestTenant(async () =>
        siteVisits.create(adminActor(), {
          visitDate: isoDate(30),
          accreditorOrg: 'O',
        } as any),
      );
      const same = await withTestTenant(async () =>
        siteVisits.update(adminActor(), v.id, {} as any),
      );
      expect(same.id).toBe(v.id);
    });

    it('getById missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          siteVisits.getById(adminActor(), '00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list scopes by school_id (cross-school isolation)', async () => {
      await withTestTenant(async () =>
        siteVisits.create(adminActor(), {
          visitDate: isoDate(30),
          accreditorOrg: 'A',
        } as any),
      );
      await withTestTenantB(async () =>
        siteVisits.create(adminActor(), {
          visitDate: isoDate(30),
          accreditorOrg: 'B',
        } as any),
      );
      const listA = await withTestTenant(async () => siteVisits.list(adminActor()));
      const listB = await withTestTenantB(async () => siteVisits.list(adminActor()));
      expect(listA.length).toBe(1);
      expect(listA[0]!.accreditorOrg).toBe('A');
      expect(listB.length).toBe(1);
      expect(listB[0]!.accreditorOrg).toBe('B');
    });
  });

  // ─────────────────────── ActionPlanOverdueWorker ───────────────────────

  describe('ActionPlanOverdueWorker', () => {
    beforeEach(async () => {
      await seedAdoption(rawClient);
    });

    async function seedInProgress(
      opts: {
        schoolId?: string;
        targetDate?: string;
      } = {},
    ): Promise<string> {
      const dto = {
        standardId: TEST_PLATFORM_STANDARD_A_ID,
        goal: 'g',
        actions: [{ description: 'a', due_date: isoDate(1), status: 'PENDING' as const }],
        responsibleParty: TEST_ADMIN_EMPLOYEE_ID,
        targetDate: opts.targetDate ?? isoDate(30),
      };
      const useB = opts.schoolId === TEST_SCHOOL_B_ID;
      const ap = useB
        ? await withTestTenantB(async () => actionPlans.create(adminActor(), dto as any))
        : await withTestTenant(async () => actionPlans.create(adminActor(), dto as any));
      // Force into IN_PROGRESS so the sweep matches
      const upd = async () =>
        actionPlans.update(adminActor(), ap.id, { status: 'IN_PROGRESS' } as any);
      if (useB) await withTestTenantB(upd);
      else await withTestTenant(upd);

      // Backdate target_date if requested past
      if (opts.targetDate && new Date(opts.targetDate) < new Date(isoDate(0))) {
        await rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.acc_action_plans
           SET target_date = $1::date, status = 'IN_PROGRESS', updated_at = now()
           WHERE id = $2::uuid`,
          opts.targetDate,
          ap.id,
        );
      }
      return ap.id;
    }

    it('tickForSchool flips IN_PROGRESS with past target_date → OVERDUE and enqueues outbox row', async () => {
      const id = await seedInProgress({ targetDate: isoDate(-2) });

      const flipped = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN);
      expect(flipped).toBe(1);

      const row = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.acc_action_plans WHERE id = $1::uuid`,
        id,
      );
      expect(row[0]!.status).toBe('OVERDUE');

      const outboxRows = await rawClient.$queryRawUnsafe<
        Array<{ envelope: string; topic: string }>
      >(
        `SELECT topic, envelope::text AS envelope FROM platform.platform_outbox
         WHERE topic = 'acc.action_plan.overdue' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );
      expect(outboxRows.length).toBe(1);
      const env = JSON.parse(outboxRows[0]!.envelope);
      expect(env.event_id).toBe(deterministicActionPlanOverdueEventId(id));
      expect(env.payload.actionPlanId).toBe(id);
      expect(env.payload.schoolId).toBe(TEST_SCHOOL_ID);
      expect(env.payload.responsiblePartyEmployeeId).toBe(TEST_ADMIN_EMPLOYEE_ID);
    });

    it('tickForSchool ignores future-dated IN_PROGRESS plans', async () => {
      await seedInProgress({ targetDate: isoDate(30) });
      const flipped = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN);
      expect(flipped).toBe(0);
      const outboxRows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM platform.platform_outbox
         WHERE topic = 'acc.action_plan.overdue' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );
      expect(outboxRows.length).toBe(0);
    });

    it('tickForSchool is idempotent — second tick is a no-op', async () => {
      await seedInProgress({ targetDate: isoDate(-2) });
      const a = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN);
      const b = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN);
      expect(a).toBe(1);
      expect(b).toBe(0);
    });

    it('tickForSchool ignores PLANNED + COMPLETE + OVERDUE rows', async () => {
      // PLANNED with past target_date (should not flip — only IN_PROGRESS does)
      const dto = (extras: any) => ({
        standardId: TEST_PLATFORM_STANDARD_A_ID,
        goal: 'g',
        actions: [{ description: 'a', due_date: isoDate(1), status: 'PENDING' as const }],
        responsibleParty: TEST_ADMIN_EMPLOYEE_ID,
        targetDate: isoDate(30),
        ...extras,
      });
      // Create a PLANNED with past target_date — initial status becomes OVERDUE
      await withTestTenant(async () =>
        actionPlans.create(adminActor(), dto({ targetDate: isoDate(-3) })),
      );
      // Create a PLANNED future
      await withTestTenant(async () => actionPlans.create(adminActor(), dto({})));

      const flipped = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN);
      expect(flipped).toBe(0);
    });

    it('runOnce iterates active schools and returns totals', async () => {
      await seedInProgress({ targetDate: isoDate(-2) });
      const result = await worker.runOnce();
      expect(result.tenantsScanned).toBeGreaterThanOrEqual(1);
      expect(result.rowsFlipped).toBeGreaterThanOrEqual(1);
    });

    it('cross-school isolation: tickForSchool(SCHOOL_A) does not touch School B rows', async () => {
      // Seed independent person + account + employee for School B so
      // assertEmployeeInTenant accepts a B-side responsibleParty (the
      // canonical admin's hr_employees row is school-A-scoped).
      const personB = '019e1000-bbbb-7777-8888-000000008590';
      const accountB = '019e1000-bbbb-7777-8888-000000008591';
      const empB = '019e1000-bbbb-7777-8888-000000008592';
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'B', 'Admin', 'STAFF', true)
         ON CONFLICT (id) DO NOTHING`,
        personB,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_users
           (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
         VALUES ($1::uuid, $2::uuid, 'b-admin@test.integration.local', 'B Admin', 'ACTIVE', 'HUMAN', false)
         ON CONFLICT (id) DO NOTHING`,
        accountB,
        personB,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hr_employees
           (id, person_id, account_id, school_id, employee_number, employment_type, employment_status, hire_date)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'INT-B-001', 'FULL_TIME', 'ACTIVE', '2024-01-01')
         ON CONFLICT (id) DO NOTHING`,
        empB,
        personB,
        accountB,
        TEST_SCHOOL_B_ID,
      );
      await seedAdoption(rawClient, TEST_SCHOOL_B_ID);
      // School A action plan via the service (uses School A admin employee).
      const aPlanId = await seedInProgress({ targetDate: isoDate(-2), schoolId: TEST_SCHOOL_ID });
      // School B action plan — insert directly with empB.
      const bId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.acc_action_plans
           (id, school_id, standard_id, goal, actions, responsible_party, target_date, status, created_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'g', '[]'::jsonb, $4::uuid, $5::date, 'IN_PROGRESS', $6::uuid)`,
        bId,
        TEST_SCHOOL_B_ID,
        TEST_PLATFORM_STANDARD_A_ID,
        empB,
        isoDate(-2),
        accountB,
      );
      void aPlanId; // referenced to keep TS happy; the assertion below
      // checks the B row remained IN_PROGRESS.
      const flippedA = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN);
      expect(flippedA).toBe(1);
      const bRow = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.acc_action_plans WHERE id = $1::uuid`,
        bId,
      );
      expect(bRow[0]!.status).toBe('IN_PROGRESS');
    });
  });
});
