import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ApplicationController } from '@modules/m81-enrolment/applications/application.controller';
import { ApplicationService } from '@modules/m81-enrolment/applications/application.service';
import { ApplicationScoringController } from '@modules/m81-enrolment/applications/application-scoring.controller';
import { ApplicationScoringService } from '@modules/m81-enrolment/applications/application-scoring.service';
import { ApplicationStageController } from '@modules/m81-enrolment/applications/application-stage.controller';
import { ApplicationStageService } from '@modules/m81-enrolment/applications/application-stage.service';
import { EnrollmentPeriodController } from '@modules/m81-enrolment/applications/enrollment-period.controller';
import { EnrollmentPeriodService } from '@modules/m81-enrolment/applications/enrollment-period.service';
import { EnrollmentSearchController } from '@modules/m81-enrolment/applications/enrollment-search.controller';
import { EnrollmentSearchService } from '@modules/m81-enrolment/applications/enrollment-search.service';
import { MidYearAdmissionController } from '@modules/m81-enrolment/applications/mid-year-admission.controller';
import { MidYearAdmissionService } from '@modules/m81-enrolment/applications/mid-year-admission.service';
import { OnboardingController } from '@modules/m81-enrolment/applications/onboarding.controller';
import { OnboardingService } from '@modules/m81-enrolment/applications/onboarding.service';
import { ReenrolmentController } from '@modules/m81-enrolment/applications/reenrolment.controller';
import { ReenrolmentService } from '@modules/m81-enrolment/applications/reenrolment.service';
import { OfferController } from '@modules/m81-enrolment/offers/offer.controller';
import { OfferService } from '@modules/m81-enrolment/offers/offer.service';
import { TourController } from '@modules/m81-enrolment/tours/tour.controller';
import { TourSlotService } from '@modules/m81-enrolment/tours/tour-slot.service';
import { TourBookingService } from '@modules/m81-enrolment/tours/tour-booking.service';
import { WaitlistController } from '@modules/m81-enrolment/waitlist/waitlist.controller';
import { WaitlistService } from '@modules/m81-enrolment/waitlist/waitlist.service';
import { WithdrawalController } from '@modules/m81-enrolment/withdrawals/withdrawal.controller';
import { WithdrawalService } from '@modules/m81-enrolment/withdrawals/withdrawal.service';
import { ExitTaskService } from '@modules/m81-enrolment/withdrawals/exit-task.service';
import { ExitTaskTemplateController } from '@modules/m81-enrolment/withdrawals/exit-task-template.controller';
import { ExitTaskTemplateService } from '@modules/m81-enrolment/withdrawals/exit-task-template.service';
import { CapacitySummaryService } from '@modules/m81-enrolment/capacity/capacity-summary.service';

import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import { makeRecordingKafka } from '../helpers/recording-kafka';
import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import {
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_PARENT_PERSON_ID,
  TEST_PARENT_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { TEST_SIS_ACADEMIC_YEAR_ID } from '../fixtures/sis';
import { seedStudent, linkStudentGuardian, cleanupSeededIds } from '../m20-sis/sis-helpers';

/**
 * Wave 4 — m81-enrolment controller DB-backed integration.
 *
 * Tests every @Get/@Post/@Patch/@Delete entry point across all m81
 * controllers by constructing the controller with real services and
 * invoking methods with synthetic AuthedRequest objects. This is the
 * lightweight alternative to a supertest harness — exercises the
 * controller code paths (delegation + actor resolution + query/body
 * marshalling) without spinning up an HTTP listener.
 *
 * Controllers covered:
 *   - ApplicationController, ApplicationScoringController,
 *     ApplicationStageController, EnrollmentPeriodController,
 *     EnrollmentSearchController, MidYearAdmissionController,
 *     OnboardingController, ReenrolmentController, OfferController,
 *     TourController, WaitlistController, WithdrawalController,
 *     ExitTaskTemplateController.
 *
 * The deep semantic coverage (state machine guards, outbox emits,
 * race / row-scope contracts) lives in the sibling specs
 * (application-lifecycle, offers, tours, waitlist-and-placement,
 * withdrawals, screening-and-search, capacity, enrolment-periods).
 * The value here is bumping the controllers from 0% to ≥80% so the
 * module-level coverage hits the Wave 4 target.
 */
describe('integration:m81-enrolment/controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let actorContext: ActorContextService;
  let kafka: ReturnType<typeof makeRecordingKafka>;
  let outbox: OutboxService;
  let capacity: CapacitySummaryService;

  // Services
  let appService: ApplicationService;
  let scoringService: ApplicationScoringService;
  let stageService: ApplicationStageService;
  let periodService: EnrollmentPeriodService;
  let searchService: EnrollmentSearchService;
  let midYearService: MidYearAdmissionService;
  let onboardingService: OnboardingService;
  let reenrolService: ReenrolmentService;
  let offerService: OfferService;
  let slotService: TourSlotService;
  let bookingService: TourBookingService;
  let waitlistService: WaitlistService;
  let withdrawalService: WithdrawalService;
  let exitTaskService: ExitTaskService;
  let templateService: ExitTaskTemplateService;

  // Controllers
  let appController: ApplicationController;
  let scoringController: ApplicationScoringController;
  let stageController: ApplicationStageController;
  let periodController: EnrollmentPeriodController;
  let searchController: EnrollmentSearchController;
  let midYearController: MidYearAdmissionController;
  let onboardingController: OnboardingController;
  let reenrolController: ReenrolmentController;
  let offerController: OfferController;
  let tourController: TourController;
  let waitlistController: WaitlistController;
  let withdrawalController: WithdrawalController;
  let templateController: ExitTaskTemplateController;

  // Per-spec state.
  let periodAId: string;

  // Cleanup trackers.
  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  function fakeAdminReq(): any {
    return {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
        email: 'admin@test.integration.local',
        displayName: 'Integration Admin',
        sessionId: 'test-session',
      },
    };
  }

  function fakeParentReq(): any {
    return {
      user: {
        sub: TEST_PARENT_ACCOUNT_ID,
        personId: TEST_PARENT_PERSON_ID,
        email: 'parent@test.integration.local',
        displayName: 'Integration Parent',
        sessionId: 'test-session-parent',
      },
    };
  }

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    actorContext = new ActorContextService(rawClient, permCheck, tenantPrisma);
    kafka = makeRecordingKafka();
    outbox = new OutboxService();
    capacity = new CapacitySummaryService();

    // Services
    appService = new ApplicationService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
      capacity,
    );
    scoringService = new ApplicationScoringService(tenantPrisma);
    stageService = new ApplicationStageService(tenantPrisma);
    periodService = new EnrollmentPeriodService(tenantPrisma);
    searchService = new EnrollmentSearchService(tenantPrisma);
    midYearService = new MidYearAdmissionService(tenantPrisma, permCheck);
    onboardingService = new OnboardingService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
    );
    offerService = new OfferService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
      outbox,
      capacity,
      onboardingService,
    );
    slotService = new TourSlotService(tenantPrisma, permCheck);
    bookingService = new TourBookingService(tenantPrisma, permCheck, outbox);
    waitlistService = new WaitlistService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
      capacity,
    );
    templateService = new ExitTaskTemplateService(tenantPrisma, permCheck);
    withdrawalService = new WithdrawalService(tenantPrisma, permCheck, outbox, templateService);
    exitTaskService = new ExitTaskService(tenantPrisma, permCheck);
    reenrolService = new ReenrolmentService(tenantPrisma, permCheck, withdrawalService);

    // Controllers
    appController = new ApplicationController(appService, actorContext);
    scoringController = new ApplicationScoringController(scoringService, actorContext);
    stageController = new ApplicationStageController(stageService, actorContext);
    periodController = new EnrollmentPeriodController(periodService, actorContext);
    searchController = new EnrollmentSearchController(searchService);
    midYearController = new MidYearAdmissionController(midYearService, actorContext);
    onboardingController = new OnboardingController(onboardingService, actorContext);
    reenrolController = new ReenrolmentController(reenrolService, actorContext);
    offerController = new OfferController(offerService, actorContext);
    tourController = new TourController(slotService, bookingService, actorContext);
    waitlistController = new WaitlistController(waitlistService, actorContext);
    withdrawalController = new WithdrawalController(
      withdrawalService,
      exitTaskService,
      actorContext,
    );
    templateController = new ExitTaskTemplateController(templateService, actorContext);

    // Seed admin permission cache for every m81 code we exercise.
    // ApplicationService etc. read from the iam_effective_access_cache via
    // PermissionCheckService.hasAnyPermissionInTenant when isSchoolAdmin
    // is false; admin actor.isSchoolAdmin=true short-circuits most checks,
    // but ActorContextService.resolveActor still queries sch-001:admin so
    // that key must be present.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid,
               ARRAY['sch-001:admin','enr-001:admin','enr-001:write','enr-001:read',
                     'enr-002:write','enr-003:write','enr-004:write',
                     'stu-003:read','stu-003:write','stu-003:admin',
                     'stu-004:read','stu-004:write','stu-004:admin']::text[],
               now(), 'test')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes`,
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
    );
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_ADMIN_ACCOUNT_ID,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    kafka.reset();

    // Re-seed the admin permission cache. Some sibling specs delete the
    // row by account_id (TEST_ADMIN_ACCOUNT_ID) when they run after the
    // controllers spec, so reseed before every test to make the spec
    // idempotent under any ordering.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid,
               ARRAY['sch-001:admin','enr-001:admin','enr-001:write','enr-001:read',
                     'enr-002:write','enr-003:write','enr-004:write',
                     'stu-003:read','stu-003:write','stu-003:admin',
                     'stu-004:read','stu-004:write','stu-004:admin']::text[],
               now(), 'm81-ctrl-test')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
    );

    // Wipe every enrolment row so each test starts clean.
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_application_scores`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_application_stages`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_student_onboarding_task_completions`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_student_onboarding_progress`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_onboarding_tasks`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_onboarding_checklists`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_capacity_summary`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_waitlist_entries`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_offers`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_application_notes`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_application_screening_responses`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_applications`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_intake_capacities`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_admission_streams`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_enrollment_periods`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_reenrollment_confirmations`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_withdrawal_exit_tasks`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_withdrawal_requests`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_withdrawal_task_templates`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_mid_year_admission_requests`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_tour_booking_guests`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_tour_bookings`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_tour_slots`);

    // Cross-suite collision guard: pay_family_accounts grows on offer-accept
    // and re-enrolment flows; m84-payments has UNIQUE keys that collide.
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.pay_family_account_students, ${TEST_SCHEMA}.pay_family_accounts CASCADE`,
    );

    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
    });

    // Seed an OPEN enrolment period for school A so anything controller
    // tests creating applications can hang off it.
    periodAId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.enr_enrollment_periods
         (id, school_id, academic_year_id, name, opens_at, closes_at, status, allows_mid_year_applications, allows_public_search)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'Ctrl Period A',
               now() - interval '7 days', now() + interval '30 days', 'OPEN', true, true)`,
      periodAId,
      TEST_SCHOOL_ID,
      TEST_SIS_ACADEMIC_YEAR_ID,
    );
  });

  async function trackedStudent(
    opts: Parameters<typeof seedStudent>[1] = {},
  ): Promise<{ studentId: string; personId: string; platformStudentId: string }> {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  /**
   * Bind the global parent actor as a guardian of the supplied student so
   * the row-scope checks pass. Idempotent on (school_id, person_id) so the
   * spec doesn't trip the sis_guardians UNIQUE.
   */
  async function bindParentActorToStudent(studentId: string): Promise<string> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_guardians
         (id, person_id, account_id, school_id, family_id, relationship)
       VALUES (gen_random_uuid(), $1::uuid, NULL, $2::uuid, NULL, 'PARENT')
       ON CONFLICT (school_id, person_id) DO NOTHING`,
      TEST_PARENT_PERSON_ID,
      TEST_SCHOOL_ID,
    );
    const rows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text FROM ${TEST_SCHEMA}.sis_guardians WHERE person_id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
      TEST_PARENT_PERSON_ID,
      TEST_SCHOOL_ID,
    );
    const guardianId = rows[0]!.id;
    await linkStudentGuardian(rawClient, studentId, guardianId);
    return guardianId;
  }

  function appPayload(
    overrides: Partial<{ studentFirstName: string; guardianEmail: string }> = {},
  ): any {
    return {
      enrollmentPeriodId: periodAId,
      studentFirstName: overrides.studentFirstName ?? 'Ctrl',
      studentLastName: 'Student',
      studentDateOfBirth: '2018-04-12',
      applyingForGrade: '5',
      guardianEmail: overrides.guardianEmail ?? 'ctrl@test.local',
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // ApplicationController
  // ────────────────────────────────────────────────────────────────────
  describe('ApplicationController', () => {
    it('list + getById + create + updateStatus + addNote', async () => {
      const created = await withTestTenant(async () =>
        appController.create(appPayload() as any, fakeAdminReq()),
      );
      expect(created.studentFirstName).toBe('Ctrl');

      const list = await withTestTenant(async () => appController.list({} as any, fakeAdminReq()));
      expect(list.map((r) => r.id)).toContain(created.id);

      const filtered = await withTestTenant(async () =>
        appController.list({ status: 'SUBMITTED' } as any, fakeAdminReq()),
      );
      expect(filtered.map((r) => r.id)).toContain(created.id);

      const detail = await withTestTenant(async () =>
        appController.getById(created.id, fakeAdminReq()),
      );
      expect(detail.id).toBe(created.id);

      const status1 = await withTestTenant(async () =>
        appController.updateStatus(
          created.id,
          { status: 'UNDER_REVIEW', reviewNote: 'ctrl review' } as any,
          fakeAdminReq(),
        ),
      );
      expect(status1.status).toBe('UNDER_REVIEW');

      const note = await withTestTenant(async () =>
        appController.addNote(
          created.id,
          { noteText: 'ctrl note', noteType: 'GENERAL' } as any,
          fakeAdminReq(),
        ),
      );
      expect(note.noteText).toBe('ctrl note');
    });

    it('getById unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          appController.getById('00000000-0000-0000-0000-000000000000', fakeAdminReq()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // EnrollmentPeriodController
  // ────────────────────────────────────────────────────────────────────
  describe('EnrollmentPeriodController', () => {
    it('list + getById + create + update + createStream + createCapacity', async () => {
      const list = await withTestTenant(async () => periodController.list());
      expect(list.map((p) => p.id)).toContain(periodAId);

      const detail = await withTestTenant(async () => periodController.getById(periodAId));
      expect(detail.id).toBe(periodAId);

      const opens = new Date();
      const closes = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const created = await withTestTenant(async () =>
        periodController.create(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            name: 'Ctrl Period New',
            opensAt: opens.toISOString(),
            closesAt: closes.toISOString(),
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.name).toBe('Ctrl Period New');

      const updated = await withTestTenant(async () =>
        periodController.update(created.id, { name: 'Ctrl Period Renamed' } as any, fakeAdminReq()),
      );
      expect(updated.name).toBe('Ctrl Period Renamed');

      const withStream = await withTestTenant(async () =>
        periodController.createStream(
          created.id,
          { name: 'Stream A', gradeLevel: '5' } as any,
          fakeAdminReq(),
        ),
      );
      expect(withStream.id).toBe(created.id);
      expect(withStream.streams.length).toBeGreaterThanOrEqual(1);

      const withCapacity = await withTestTenant(async () =>
        periodController.createCapacity(
          created.id,
          { gradeLevel: '5', totalPlaces: 25 } as any,
          fakeAdminReq(),
        ),
      );
      expect(withCapacity.capacities.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // EnrollmentSearchController (public)
  // ────────────────────────────────────────────────────────────────────
  describe('EnrollmentSearchController', () => {
    it('public search returns array', async () => {
      // Stamp lat/lng on School A so the Haversine returns it.
      await rawClient.$executeRawUnsafe(
        `UPDATE platform.schools SET latitude = $1, longitude = $2, full_address = $3 WHERE id = $4::uuid`,
        40.7128,
        -74.006,
        '1 Ctrl Ave, NYC',
        TEST_SCHOOL_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.enr_intake_capacities
           (id, enrollment_period_id, stream_id, grade_level, total_places, reserved_places)
         VALUES ($1::uuid, $2::uuid, NULL, '5', 30, 0)`,
        generateId(),
        periodAId,
      );

      const out = await withTestTenant(async () =>
        searchController.run({ lat: 40.7128, lng: -74.006, radiusMiles: 50 } as any),
      );
      expect(Array.isArray(out)).toBe(true);

      const filtered = await withTestTenant(async () =>
        searchController.run({
          lat: 40.7128,
          lng: -74.006,
          radiusMiles: 50,
          gradeLevel: '5',
        } as any),
      );
      expect(Array.isArray(filtered)).toBe(true);

      // Clean up the lat/lng stamp.
      await rawClient.$executeRawUnsafe(
        `UPDATE platform.schools SET latitude = NULL, longitude = NULL, full_address = NULL WHERE id = $1::uuid`,
        TEST_SCHOOL_ID,
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // ApplicationStageController
  // ────────────────────────────────────────────────────────────────────
  describe('ApplicationStageController', () => {
    it('list + advance', async () => {
      const created = await withTestTenant(async () =>
        appController.create(appPayload() as any, fakeAdminReq()),
      );

      const list0 = await withTestTenant(async () =>
        stageController.list(created.id, fakeAdminReq()),
      );
      expect(Array.isArray(list0)).toBe(true);

      const stage = await withTestTenant(async () =>
        stageController.advance(
          created.id,
          { toStatus: 'UNDER_REVIEW', notes: 'ctrl advance' } as any,
          fakeAdminReq(),
        ),
      );
      expect(stage.applicationId).toBe(created.id);
      expect(stage.toStatus).toBe('UNDER_REVIEW');

      const list1 = await withTestTenant(async () =>
        stageController.list(created.id, fakeAdminReq()),
      );
      expect(list1.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // ApplicationScoringController
  // ────────────────────────────────────────────────────────────────────
  describe('ApplicationScoringController', () => {
    it('create + list + patch + remove', async () => {
      const app = await withTestTenant(async () =>
        appController.create(appPayload() as any, fakeAdminReq()),
      );

      const score = await withTestTenant(async () =>
        scoringController.create(
          app.id,
          { criterionName: 'Academic', score: 8, maxScore: 10 } as any,
          fakeAdminReq(),
        ),
      );
      expect(score.criterionName).toBe('Academic');

      const list = await withTestTenant(async () => scoringController.list(app.id, fakeAdminReq()));
      expect(list.map((s) => s.id)).toContain(score.id);

      const patched = await withTestTenant(async () =>
        scoringController.patch(score.id, { score: 9, notes: 'updated' } as any, fakeAdminReq()),
      );
      expect(patched.score).toBe(9);
      expect(patched.notes).toBe('updated');

      await withTestTenant(async () => scoringController.remove(score.id, fakeAdminReq()));
      const after = await withTestTenant(async () =>
        scoringController.list(app.id, fakeAdminReq()),
      );
      expect(after.map((s) => s.id)).not.toContain(score.id);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // OfferController
  // ────────────────────────────────────────────────────────────────────
  describe('OfferController', () => {
    it('list + getById + issue + setConditionsMet + respond', async () => {
      const app = await withTestTenant(async () =>
        appController.create(appPayload() as any, fakeAdminReq()),
      );
      await withTestTenant(async () =>
        appController.updateStatus(app.id, { status: 'ACCEPTED' } as any, fakeAdminReq()),
      );

      const deadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      const offer = await withTestTenant(async () =>
        offerController.issue(
          app.id,
          {
            responseDeadline: deadline,
            offerType: 'CONDITIONAL',
            offerConditions: ['Pass entrance exam'],
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(offer.applicationId).toBe(app.id);
      expect(offer.offerType).toBe('CONDITIONAL');

      const list = await withTestTenant(async () => offerController.list(fakeAdminReq()));
      expect(list.map((o) => o.id)).toContain(offer.id);

      const detail = await withTestTenant(async () =>
        offerController.getById(offer.id, fakeAdminReq()),
      );
      expect(detail.id).toBe(offer.id);

      const verified = await withTestTenant(async () =>
        offerController.setConditionsMet(offer.id, { conditionsMet: true } as any, fakeAdminReq()),
      );
      expect(verified.conditionsMet).toBe(true);

      const responded = await withTestTenant(async () =>
        offerController.respond(offer.id, { familyResponse: 'DECLINED' } as any, fakeAdminReq()),
      );
      expect(responded.familyResponse).toBe('DECLINED');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // WaitlistController
  // ────────────────────────────────────────────────────────────────────
  describe('WaitlistController', () => {
    it('list + offerFromWaitlist', async () => {
      // Seed a WAITLISTED application + waitlist entry.
      const app = await withTestTenant(async () =>
        appController.create(appPayload() as any, fakeAdminReq()),
      );
      await withTestTenant(async () =>
        appController.updateStatus(app.id, { status: 'WAITLISTED' } as any, fakeAdminReq()),
      );
      // Insert a waitlist entry directly — the WaitlistService construction
      // path lives elsewhere; for the controller test we just need a row
      // for list() to return and offerFromWaitlist to act on.
      const waitlistId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.enr_waitlist_entries
           (id, school_id, enrollment_period_id, application_id, grade_level, priority_score, position, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, '5', 10, 1, 'ACTIVE')`,
        waitlistId,
        TEST_SCHOOL_ID,
        periodAId,
        app.id,
      );

      const list = await withTestTenant(async () =>
        waitlistController.list({} as any, fakeAdminReq()),
      );
      expect(list.map((e) => e.id)).toContain(waitlistId);

      const filtered = await withTestTenant(async () =>
        waitlistController.list(
          { enrollmentPeriodId: periodAId, status: 'ACTIVE' } as any,
          fakeAdminReq(),
        ),
      );
      expect(filtered.map((e) => e.id)).toContain(waitlistId);

      const deadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      const offered = await withTestTenant(async () =>
        waitlistController.offerFromWaitlist(
          waitlistId,
          { responseDeadline: deadline } as any,
          fakeAdminReq(),
        ),
      );
      expect(offered.status).toBe('OFFERED');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // OnboardingController
  // ────────────────────────────────────────────────────────────────────
  describe('OnboardingController', () => {
    it('listChecklists + getChecklist + createChecklist', async () => {
      // Initially empty
      const empty = await withTestTenant(async () => onboardingController.listChecklists());
      expect(empty).toHaveLength(0);

      const created = await withTestTenant(async () =>
        onboardingController.createChecklist(
          {
            name: 'Ctrl Checklist',
            admissionType: 'STANDARD_INTAKE',
            tasks: [
              {
                taskName: 'Submit Health Form',
                taskCategory: 'HEALTH',
                isMandatory: true,
              },
            ],
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.name).toBe('Ctrl Checklist');

      const list = await withTestTenant(async () => onboardingController.listChecklists());
      expect(list.map((c) => c.id)).toContain(created.id);

      const listIncl = await withTestTenant(async () =>
        onboardingController.listChecklists('true'),
      );
      expect(listIncl.map((c) => c.id)).toContain(created.id);

      const detail = await withTestTenant(async () =>
        onboardingController.getChecklist(created.id),
      );
      expect(detail.id).toBe(created.id);
      expect(detail.tasks?.length).toBeGreaterThanOrEqual(1);
    });

    it('getProgressForApplication returns null pre-acceptance', async () => {
      const app = await withTestTenant(async () =>
        appController.create(appPayload() as any, fakeAdminReq()),
      );
      const progress = await withTestTenant(async () =>
        onboardingController.getProgressForApplication(app.id, fakeAdminReq()),
      );
      expect(progress).toBeNull();
    });

    it('getProgressForApplication, getProgress, complete, waive (offer accept flow)', async () => {
      // Seed a checklist so onboarding generation on offer-accept has
      // something to materialise.
      await withTestTenant(async () =>
        onboardingController.createChecklist(
          {
            name: 'Onb Ctrl',
            admissionType: 'STANDARD_INTAKE',
            tasks: [
              { taskName: 'Form 1', taskCategory: 'ADMINISTRATIVE', isMandatory: true },
              { taskName: 'Form 2', taskCategory: 'HEALTH', isMandatory: false },
            ],
          } as any,
          fakeAdminReq(),
        ),
      );

      const app = await withTestTenant(async () =>
        appController.create(appPayload() as any, fakeAdminReq()),
      );
      await withTestTenant(async () =>
        appController.updateStatus(app.id, { status: 'ACCEPTED' } as any, fakeAdminReq()),
      );
      const deadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      const offer = await withTestTenant(async () =>
        offerController.issue(app.id, { responseDeadline: deadline } as any, fakeAdminReq()),
      );
      // Accept the offer to trigger onboarding progress generation.
      await withTestTenant(async () =>
        offerController.respond(offer.id, { familyResponse: 'ACCEPTED' } as any, fakeAdminReq()),
      );

      const progress = await withTestTenant(async () =>
        onboardingController.getProgressForApplication(app.id, fakeAdminReq()),
      );
      expect(progress).not.toBeNull();
      expect(progress!.applicationId).toBe(app.id);
      const completions = progress!.taskCompletions ?? [];
      expect(completions.length).toBeGreaterThanOrEqual(2);

      const byId = await withTestTenant(async () =>
        onboardingController.getProgress(progress!.id, fakeAdminReq()),
      );
      expect(byId.id).toBe(progress!.id);

      // Waive the non-mandatory task.
      const nonMandatory = completions.find((c) => c.isMandatory === false);
      if (nonMandatory) {
        const waived = await withTestTenant(async () =>
          onboardingController.waive(
            nonMandatory.id,
            { notes: 'not applicable' } as any,
            fakeAdminReq(),
          ),
        );
        expect(waived.completion.status).toBe('WAIVED');
      }

      // Complete the mandatory task.
      const mandatory = completions.find((c) => c.isMandatory === true);
      if (mandatory) {
        const done = await withTestTenant(async () =>
          onboardingController.complete(mandatory.id, { notes: 'done' } as any, fakeAdminReq()),
        );
        expect(done.completion.status).toBe('COMPLETED');
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // TourController
  // ────────────────────────────────────────────────────────────────────
  describe('TourController', () => {
    function futureDate(daysAhead: number): string {
      const d = new Date();
      d.setDate(d.getDate() + daysAhead);
      return d.toISOString().slice(0, 10);
    }

    it('createSlot + listAdmin + getSlot + patchSlot + listPublic', async () => {
      const slot = await withTestTenant(async () =>
        tourController.createSlot(
          {
            tourDate: futureDate(7),
            startTime: '09:00',
            endTime: '10:00',
            maxBookings: 5,
            isPublished: true,
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(slot.maxBookings).toBe(5);

      const adminList = await withTestTenant(async () => tourController.listAdmin(fakeAdminReq()));
      expect(adminList.map((s) => s.id)).toContain(slot.id);

      const detail = await withTestTenant(async () => tourController.getSlot(slot.id));
      expect(detail.id).toBe(slot.id);

      const patched = await withTestTenant(async () =>
        tourController.patchSlot(slot.id, { notes: 'Ctrl notes' } as any, fakeAdminReq()),
      );
      expect(patched.notes).toBe('Ctrl notes');

      const publicList = await withTestTenant(async () => tourController.listPublic());
      expect(publicList.map((s) => s.id)).toContain(slot.id);
    });

    it('bookPublic + listBookings + getBooking + patchBooking + linkApplication', async () => {
      const slot = await withTestTenant(async () =>
        tourController.createSlot(
          {
            tourDate: futureDate(8),
            startTime: '11:00',
            endTime: '12:00',
            maxBookings: 2,
            isPublished: true,
          } as any,
          fakeAdminReq(),
        ),
      );

      const booking = await withTestTenant(async () =>
        tourController.bookPublic(slot.id, {
          familyName: 'Ctrl Family',
          contactEmail: 'ctrl.book@test.local',
          firstName: 'Jane',
          lastName: 'Ctrl',
        } as any),
      );
      expect(booking.status).toBe('CONFIRMED');

      const list = await withTestTenant(async () => tourController.listBookings(fakeAdminReq()));
      expect(list.map((b) => b.id)).toContain(booking.id);

      const detail = await withTestTenant(async () =>
        tourController.getBooking(booking.id, fakeAdminReq()),
      );
      expect(detail.id).toBe(booking.id);

      const patched = await withTestTenant(async () =>
        tourController.patchBooking(booking.id, { status: 'COMPLETED' } as any, fakeAdminReq()),
      );
      expect(patched.status).toBe('COMPLETED');

      // Link to a freshly-created application.
      const app = await withTestTenant(async () =>
        appController.create(appPayload() as any, fakeAdminReq()),
      );
      const linked = await withTestTenant(async () =>
        tourController.linkApplication(
          booking.id,
          { applicationId: app.id } as any,
          fakeAdminReq(),
        ),
      );
      expect(linked.linkedApplicationId).toBe(app.id);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // WithdrawalController + ExitTaskTemplateController
  // ────────────────────────────────────────────────────────────────────
  describe('WithdrawalController + ExitTaskTemplateController', () => {
    function withdrawalInput(studentId: string, overrides: any = {}): any {
      return {
        studentId,
        initiatedBy: 'SCHOOL',
        withdrawalReasonCategory: 'TRANSFER_TO_OTHER_SCHOOL',
        lastAttendanceDate: new Date().toISOString().slice(0, 10),
        ...overrides,
      };
    }

    it('template list/upsert + withdrawal create/list/getById/cancel/placeHold + exit-task patch', async () => {
      // List templates — lazy-seeds the DEFAULT 7-task baseline.
      const tpl0 = await withTestTenant(async () => templateController.list(fakeAdminReq()));
      expect(tpl0.length).toBeGreaterThanOrEqual(1);

      // Upsert a custom template list.
      const tpl1 = await withTestTenant(async () =>
        templateController.upsert(
          {
            tasks: [
              {
                taskName: 'Return Library Books',
                taskCategory: 'RECORDS',
                sortOrder: 1,
              },
              {
                taskName: 'Settle Outstanding Fees',
                taskCategory: 'FINANCE',
                sortOrder: 2,
              },
            ],
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(tpl1.length).toBeGreaterThanOrEqual(2);

      // Create a withdrawal using the new template.
      const student = await trackedStudent();
      const created = await withTestTenant(async () =>
        withdrawalController.create(withdrawalInput(student.studentId) as any, fakeAdminReq()),
      );
      expect(created.studentId).toBe(student.studentId);

      const list = await withTestTenant(async () => withdrawalController.list(fakeAdminReq()));
      expect(list.map((w) => w.id)).toContain(created.id);

      const listByStatus = await withTestTenant(async () =>
        withdrawalController.list(fakeAdminReq(), 'REQUESTED'),
      );
      expect(listByStatus.map((w) => w.id)).toContain(created.id);

      const detail = await withTestTenant(async () =>
        withdrawalController.getById(created.id, fakeAdminReq()),
      );
      expect(detail.id).toBe(created.id);

      // List my-department exit tasks.
      const myTasks = await withTestTenant(async () =>
        withdrawalController.listMyDepartment(fakeAdminReq()),
      );
      expect(Array.isArray(myTasks)).toBe(true);

      const filteredTasks = await withTestTenant(async () =>
        withdrawalController.listMyDepartment(fakeAdminReq(), 'FINANCE'),
      );
      expect(Array.isArray(filteredTasks)).toBe(true);

      // Patch an exit task to COMPLETED.
      const task = detail.exitTasks[0]!;
      const patched = await withTestTenant(async () =>
        withdrawalController.patchTask(task.id, { status: 'COMPLETED' } as any, fakeAdminReq()),
      );
      expect(patched.status).toBe('COMPLETED');

      // Place a re-enrolment hold.
      const onHold = await withTestTenant(async () =>
        withdrawalController.placeHold(
          created.id,
          { hold: true, reason: 'audit pending' } as any,
          fakeAdminReq(),
        ),
      );
      expect(onHold.reEnrollmentHoldPlaced).toBe(true);

      // Cancel the withdrawal.
      const cancelled = await withTestTenant(async () =>
        withdrawalController.cancel(
          created.id,
          { reason: 'family changed mind' } as any,
          fakeAdminReq(),
        ),
      );
      expect(cancelled.status).toBe('CANCELLED');
    });

    it('complete flow: all tasks done → withdrawal completes', async () => {
      const student = await trackedStudent();
      const created = await withTestTenant(async () =>
        withdrawalController.create(withdrawalInput(student.studentId) as any, fakeAdminReq()),
      );

      const taskRows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text FROM ${TEST_SCHEMA}.enr_withdrawal_exit_tasks WHERE withdrawal_id = $1::uuid`,
        created.id,
      );
      for (const t of taskRows) {
        await withTestTenant(async () =>
          withdrawalController.patchTask(t.id, { status: 'COMPLETED' } as any, fakeAdminReq()),
        );
      }
      const completed = await withTestTenant(async () =>
        withdrawalController.complete(created.id, {} as any, fakeAdminReq()),
      );
      expect(completed.status).toBe('COMPLETED');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // ReenrolmentController
  // ────────────────────────────────────────────────────────────────────
  describe('ReenrolmentController', () => {
    it('submit + list + getById + summary', async () => {
      const student = await trackedStudent();
      await bindParentActorToStudent(student.studentId);

      const submitted = await withTestTenant(
        async () =>
          reenrolController.submit(
            {
              studentId: student.studentId,
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              confirmedContinuing: true,
            } as any,
            fakeParentReq(),
          ),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(submitted.confirmedContinuing).toBe(true);

      const list = await withTestTenant(async () => reenrolController.list(fakeAdminReq()));
      expect(list.map((r) => r.id)).toContain(submitted.id);

      const listByYear = await withTestTenant(async () =>
        reenrolController.list(fakeAdminReq(), TEST_SIS_ACADEMIC_YEAR_ID),
      );
      expect(listByYear.map((r) => r.id)).toContain(submitted.id);

      const listMine = await withTestTenant(
        async () => reenrolController.list(fakeParentReq(), undefined, 'true'),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(listMine.map((r) => r.id)).toContain(submitted.id);

      const detail = await withTestTenant(async () =>
        reenrolController.getById(submitted.id, fakeAdminReq()),
      );
      expect(detail.id).toBe(submitted.id);

      const summary = await withTestTenant(async () =>
        reenrolController.summary(TEST_SIS_ACADEMIC_YEAR_ID, fakeAdminReq()),
      );
      expect(summary.academicYearId).toBe(TEST_SIS_ACADEMIC_YEAR_ID);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // MidYearAdmissionController
  // ────────────────────────────────────────────────────────────────────
  describe('MidYearAdmissionController', () => {
    it('submit + list + getById + patch', async () => {
      const submitted = await withTestTenant(async () =>
        midYearController.submit(
          {
            studentFirstName: 'MY',
            studentLastName: 'Ctrl',
            studentDateOfBirth: '2018-04-12',
            applyingForGradeLevel: '5',
            requestedStartDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            admissionReason: 'FAMILY_RELOCATION',
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(submitted.studentFirstName).toBe('MY');

      const list = await withTestTenant(async () => midYearController.list(fakeAdminReq()));
      expect(list.map((r) => r.id)).toContain(submitted.id);

      const detail = await withTestTenant(async () =>
        midYearController.getById(submitted.id, fakeAdminReq()),
      );
      expect(detail.id).toBe(submitted.id);

      const patched = await withTestTenant(async () =>
        midYearController.patch(
          submitted.id,
          { capacityAvailable: true, status: 'CAPACITY_CHECKED' } as any,
          fakeAdminReq(),
        ),
      );
      expect(patched.capacityAvailable).toBe(true);
      expect(patched.status).toBe('CAPACITY_CHECKED');
    });

    it('getById unknown → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          midYearController.getById('00000000-0000-0000-0000-000000000000', fakeAdminReq()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // Silence unused-warning bait for the few helpers/services we instantiate
  // for the controllers but don't reach via the entry-point sweeps above.
  void BadRequestException;
  void ForbiddenException;
});
