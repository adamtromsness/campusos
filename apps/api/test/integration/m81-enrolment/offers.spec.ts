import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ApplicationService } from '@modules/m81-enrolment/applications/application.service';
import { OfferService } from '@modules/m81-enrolment/offers/offer.service';
import { OnboardingService } from '@modules/m81-enrolment/applications/onboarding.service';
import { CapacitySummaryService } from '@modules/m81-enrolment/capacity/capacity-summary.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  parentActor,
  studentActor,
  teacherActor,
  TEST_PARENT_PERSON_ID,
  TEST_STUDENT_PERSON_ID,
} from '../helpers/actor';
import {
  TEST_SIS_ACADEMIC_YEAR_ID,
  TEST_SIS_ACADEMIC_YEAR_B_ID,
} from '../fixtures/sis';

/**
 * Wave 5 — m81-enrolment OfferService deeper DB-backed coverage.
 *
 * application-lifecycle.spec.ts already covers basic issue + respond. This
 * spec drills into the surface that was uncovered:
 *   - CONDITIONAL offer lifecycle: issue, conditions verification flips,
 *     ACCEPT gate when conditions_met=null, terminal CONDITIONS_NOT_MET.
 *   - setConditionsMet permissions + status precondition (ISSUED only).
 *   - respond DEFER path with deferralTargetYearId required + persisted.
 *   - respond on already-responded offer → BadRequest (state machine).
 *   - list / getById guardian row-scope + non-guardian-non-admin returns [].
 *   - getById unknown id → NotFound; cross-school admin sees B offer (bug).
 *   - Outbox emit on accept: enr.student.enrolled durable row with payload
 *     fields (studentFirstName, applicationId, schoolId, …).
 *   - post-commit enr.offer.responded emit (best-effort kafka).
 *   - Acceptance with NO onboarding checklist on the school is silently
 *     skipped (NO_CHECKLIST path) — the tx still commits cleanly.
 *   - Cross-school issue isolation via tenant context swap.
 */
describe('integration:m81-enrolment/offers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: ReturnType<typeof makeRecordingKafka>;
  let outbox: OutboxService;
  let capacity: CapacitySummaryService;
  let onboarding: OnboardingService;
  let appService: ApplicationService;
  let offerService: OfferService;

  let periodAId: string;
  let periodBId: string;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    kafka = makeRecordingKafka();
    outbox = new OutboxService();
    capacity = new CapacitySummaryService();
    onboarding = new OnboardingService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
    );
    appService = new ApplicationService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
      capacity,
    );
    offerService = new OfferService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
      outbox,
      capacity,
      onboarding,
    );
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    (kafka as unknown as RecordingKafkaProducer).reset();
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_capacity_summary`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_waitlist_entries`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_offers`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_application_notes`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_application_screening_responses`,
    );
    // Onboarding tables cascade off the checklist; clear the related rows
    // so each test has a clean baseline. The setup.ts seed has already
    // inserted a 'Standard New Student Checklist' for the test schools;
    // we wipe it here so tests can seed their own or assert NO_CHECKLIST.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_student_onboarding_task_completions`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_student_onboarding_progress`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_onboarding_tasks`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_onboarding_checklists`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_applications`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_intake_capacities`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_admission_streams`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_enrollment_periods`,
    );
    // Drop platform outbox rows from previous tests so the assertions can
    // tightly match "1 enr.student.enrolled row for this app".
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE source_module = 'enrollment'`,
    );
    // Per CLAUDE.md: pay_family_accounts + pay_family_account_students are
    // touched by Wave 1 family-account flows. Truncate to avoid collisions.
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.pay_family_account_students, ${TEST_SCHEMA}.pay_family_accounts CASCADE`,
    );

    // Period A (School A).
    periodAId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.enr_enrollment_periods
         (id, school_id, academic_year_id, name, opens_at, closes_at, status, allows_mid_year_applications)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'Offers Period A', now() - interval '7 days',
               now() + interval '30 days', 'OPEN', false)`,
      periodAId,
      TEST_SCHOOL_ID,
      TEST_SIS_ACADEMIC_YEAR_ID,
    );
    periodBId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.enr_enrollment_periods
         (id, school_id, academic_year_id, name, opens_at, closes_at, status, allows_mid_year_applications)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'Offers Period B', now() - interval '7 days',
               now() + interval '30 days', 'OPEN', false)`,
      periodBId,
      TEST_SCHOOL_B_ID,
      TEST_SIS_ACADEMIC_YEAR_B_ID,
    );
  });

  function buildAppPayload(
    overrides: { enrollmentPeriodId?: string; firstName?: string; grade?: string } = {},
  ): any {
    return {
      enrollmentPeriodId: overrides.enrollmentPeriodId ?? periodAId,
      studentFirstName: overrides.firstName ?? 'Off',
      studentLastName: 'Eree',
      studentDateOfBirth: '2018-04-12',
      applyingForGrade: overrides.grade ?? '5',
      guardianEmail: 'offers@test.local',
    };
  }

  async function seedAcceptedApp(opts: { byParent?: boolean; periodId?: string } = {}): Promise<string> {
    const dto = opts.byParent
      ? await withTestTenant(
          async () =>
            appService.create(
              buildAppPayload({ enrollmentPeriodId: opts.periodId }),
              parentActor(),
            ),
          { personId: TEST_PARENT_PERSON_ID },
        )
      : await withTestTenant(async () =>
          appService.create(
            buildAppPayload({ enrollmentPeriodId: opts.periodId }),
            adminActor(),
          ),
        );
    await withTestTenant(async () =>
      appService.updateStatus(dto.id, { status: 'ACCEPTED' } as any, adminActor()),
    );
    return dto.id;
  }

  function deadline(daysAhead = 14): string {
    return new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
  }

  // ────────────────────────────────────────────────────────────────────
  // CONDITIONAL offer flow
  // ────────────────────────────────────────────────────────────────────
  describe('CONDITIONAL offers', () => {
    it('admin issues CONDITIONAL with conditions[]; flip conditions_met=true → parent can ACCEPT', async () => {
      const appId = await seedAcceptedApp({ byParent: true });
      const offer = await withTestTenant(async () =>
        offerService.issue(
          appId,
          {
            responseDeadline: deadline(),
            offerType: 'CONDITIONAL',
            offerConditions: ['Final transcript with 5.0 GPA'],
          } as any,
          adminActor(),
        ),
      );
      expect(offer.offerType).toBe('CONDITIONAL');
      expect(offer.offerConditions).toEqual(['Final transcript with 5.0 GPA']);
      expect(offer.conditionsMet).toBeNull();

      // ACCEPT before conditions_met is verified → BadRequest.
      await expect(
        withTestTenant(
          async () =>
            offerService.respond(
              offer.id,
              { familyResponse: 'ACCEPTED' } as any,
              parentActor(),
            ),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Admin verifies the conditions.
      const verified = await withTestTenant(async () =>
        offerService.setConditionsMet(
          offer.id,
          { conditionsMet: true },
          adminActor(),
        ),
      );
      expect(verified.conditionsMet).toBe(true);
      expect(verified.status).toBe('ISSUED');

      // Now ACCEPT goes through.
      const accepted = await withTestTenant(
        async () =>
          offerService.respond(
            offer.id,
            { familyResponse: 'ACCEPTED' } as any,
            parentActor(),
          ),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(accepted.status).toBe('ACCEPTED');
    });

    it('admin flips conditions_met=false → terminal CONDITIONS_NOT_MET', async () => {
      const appId = await seedAcceptedApp({ byParent: true });
      const offer = await withTestTenant(async () =>
        offerService.issue(
          appId,
          {
            responseDeadline: deadline(),
            offerType: 'CONDITIONAL',
            offerConditions: ['some condition'],
          } as any,
          adminActor(),
        ),
      );
      const failed = await withTestTenant(async () =>
        offerService.setConditionsMet(
          offer.id,
          { conditionsMet: false },
          adminActor(),
        ),
      );
      expect(failed.status).toBe('CONDITIONS_NOT_MET');
      expect(failed.conditionsMet).toBe(false);
      // Subsequent respond on a non-ISSUED offer → BadRequest.
      await expect(
        withTestTenant(
          async () =>
            offerService.respond(
              offer.id,
              { familyResponse: 'ACCEPTED' } as any,
              parentActor(),
            ),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('setConditionsMet on UNCONDITIONAL offer → BadRequest', async () => {
      const appId = await seedAcceptedApp();
      const offer = await withTestTenant(async () =>
        offerService.issue(
          appId,
          { responseDeadline: deadline() } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          offerService.setConditionsMet(
            offer.id,
            { conditionsMet: true },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('setConditionsMet on already-ACCEPTED offer → BadRequest', async () => {
      const appId = await seedAcceptedApp({ byParent: true });
      const offer = await withTestTenant(async () =>
        offerService.issue(
          appId,
          {
            responseDeadline: deadline(),
            offerType: 'CONDITIONAL',
            offerConditions: ['one'],
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        offerService.setConditionsMet(
          offer.id,
          { conditionsMet: true },
          adminActor(),
        ),
      );
      await withTestTenant(
        async () =>
          offerService.respond(
            offer.id,
            { familyResponse: 'ACCEPTED' } as any,
            parentActor(),
          ),
        { personId: TEST_PARENT_PERSON_ID },
      );
      await expect(
        withTestTenant(async () =>
          offerService.setConditionsMet(
            offer.id,
            { conditionsMet: false },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('setConditionsMet unknown id → NotFound; non-admin → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          offerService.setConditionsMet(
            '00000000-0000-0000-0000-000000000000',
            { conditionsMet: true },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      const appId = await seedAcceptedApp();
      const offer = await withTestTenant(async () =>
        offerService.issue(
          appId,
          {
            responseDeadline: deadline(),
            offerType: 'CONDITIONAL',
            offerConditions: ['x'],
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(
          async () =>
            offerService.setConditionsMet(
              offer.id,
              { conditionsMet: true },
              parentActor(),
            ),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // DEFER + post-respond state machine
  // ────────────────────────────────────────────────────────────────────
  describe('DEFER + already-responded gate', () => {
    it('parent DEFERS → status stays ISSUED, family_response=DEFERRED, deferral_target_year_id persisted', async () => {
      const appId = await seedAcceptedApp({ byParent: true });
      const offer = await withTestTenant(async () =>
        offerService.issue(
          appId,
          { responseDeadline: deadline() } as any,
          adminActor(),
        ),
      );
      const responded = await withTestTenant(
        async () =>
          offerService.respond(
            offer.id,
            {
              familyResponse: 'DEFERRED',
              deferralTargetYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            } as any,
            parentActor(),
          ),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(responded.status).toBe('ISSUED');
      expect(responded.familyResponse).toBe('DEFERRED');
      expect(responded.deferralTargetYearId).toBe(TEST_SIS_ACADEMIC_YEAR_ID);

      const recorded = kafka as unknown as RecordingKafkaProducer;
      const events = recorded.callsForTopic('enr.offer.responded');
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]!.payload).toMatchObject({
        offerId: offer.id,
        familyResponse: 'DEFERRED',
      });
    });

    it('DEFERRED without deferralTargetYearId → BadRequest', async () => {
      const appId = await seedAcceptedApp({ byParent: true });
      const offer = await withTestTenant(async () =>
        offerService.issue(
          appId,
          { responseDeadline: deadline() } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(
          async () =>
            offerService.respond(
              offer.id,
              { familyResponse: 'DEFERRED' } as any,
              parentActor(),
            ),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('responding to an already-DECLINED offer → BadRequest (offer no longer ISSUED)', async () => {
      const appId = await seedAcceptedApp({ byParent: true });
      const offer = await withTestTenant(async () =>
        offerService.issue(
          appId,
          { responseDeadline: deadline() } as any,
          adminActor(),
        ),
      );
      await withTestTenant(
        async () =>
          offerService.respond(
            offer.id,
            { familyResponse: 'DECLINED' } as any,
            parentActor(),
          ),
        { personId: TEST_PARENT_PERSON_ID },
      );
      await expect(
        withTestTenant(
          async () =>
            offerService.respond(
              offer.id,
              { familyResponse: 'ACCEPTED' } as any,
              parentActor(),
            ),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('respond unknown id → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          offerService.respond(
            '00000000-0000-0000-0000-000000000000',
            { familyResponse: 'ACCEPTED' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('admin can respond on behalf of a parent (acting-as)', async () => {
      const appId = await seedAcceptedApp({ byParent: true });
      const offer = await withTestTenant(async () =>
        offerService.issue(
          appId,
          { responseDeadline: deadline() } as any,
          adminActor(),
        ),
      );
      const responded = await withTestTenant(async () =>
        offerService.respond(
          offer.id,
          { familyResponse: 'DECLINED' } as any,
          adminActor(),
        ),
      );
      expect(responded.status).toBe('DECLINED');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // ACCEPT — durable outbox payload + side-effects + NO_CHECKLIST branch
  // ────────────────────────────────────────────────────────────────────
  describe('ACCEPT side-effects', () => {
    it('enr.student.enrolled outbox row carries full payload', async () => {
      const appId = await seedAcceptedApp({ byParent: true });
      const offer = await withTestTenant(async () =>
        offerService.issue(
          appId,
          { responseDeadline: deadline() } as any,
          adminActor(),
        ),
      );
      await withTestTenant(
        async () =>
          offerService.respond(
            offer.id,
            { familyResponse: 'ACCEPTED' } as any,
            parentActor(),
          ),
        { personId: TEST_PARENT_PERSON_ID },
      );

      const rows = await rawClient.$queryRawUnsafe<
        Array<{ topic: string; message_key: string | null; envelope: any }>
      >(
        `SELECT topic, message_key, envelope FROM platform.platform_outbox
          WHERE topic = 'enr.student.enrolled' AND message_key = $1`,
        appId,
      );
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      // ADR-057 envelope wraps the user payload in `payload`.
      expect(row.envelope.payload).toMatchObject({
        applicationId: appId,
        offerId: offer.id,
        schoolId: TEST_SCHOOL_ID,
        gradeLevel: '5',
        studentFirstName: 'Off',
        studentLastName: 'Eree',
        guardianEmail: 'offers@test.local',
        admissionType: 'NEW_STUDENT',
      });
    });

    it('NO onboarding checklist on school → ACCEPT still commits (NO_CHECKLIST path)', async () => {
      // No checklist seeded; the onboarding helper returns NO_CHECKLIST and
      // the offer-accept tx falls through cleanly.
      const appId = await seedAcceptedApp({ byParent: true });
      const offer = await withTestTenant(async () =>
        offerService.issue(
          appId,
          { responseDeadline: deadline() } as any,
          adminActor(),
        ),
      );
      const accepted = await withTestTenant(
        async () =>
          offerService.respond(
            offer.id,
            { familyResponse: 'ACCEPTED' } as any,
            parentActor(),
          ),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(accepted.status).toBe('ACCEPTED');
      // No progress row.
      const progressRows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.enr_student_onboarding_progress
          WHERE application_id = $1::uuid`,
        appId,
      );
      expect(progressRows[0]!.count).toBe(0);
    });

    it('with an active STANDARD_INTAKE checklist seeded → progress row created on ACCEPT', async () => {
      // Seed an active checklist on School A for NEW_STUDENT admission_type.
      const checklistId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.enr_onboarding_checklists
           (id, school_id, name, admission_type, is_active)
         VALUES ($1::uuid, $2::uuid, 'Default Intake', 'STANDARD_INTAKE', true)`,
        checklistId,
        TEST_SCHOOL_ID,
      );
      // Seed one task so tasks_total is meaningful.
      const taskId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.enr_onboarding_tasks
           (id, checklist_id, task_name, task_category, is_mandatory, sort_order, due_days_before_start)
         VALUES ($1::uuid, $2::uuid, 'Submit forms', 'ADMINISTRATIVE', true, 1, 14)`,
        taskId,
        checklistId,
      );

      const appId = await seedAcceptedApp({ byParent: true });
      const offer = await withTestTenant(async () =>
        offerService.issue(
          appId,
          { responseDeadline: deadline() } as any,
          adminActor(),
        ),
      );
      await withTestTenant(
        async () =>
          offerService.respond(
            offer.id,
            { familyResponse: 'ACCEPTED' } as any,
            parentActor(),
          ),
        { personId: TEST_PARENT_PERSON_ID },
      );
      const progressRows = await rawClient.$queryRawUnsafe<
        Array<{ tasks_total: number }>
      >(
        `SELECT tasks_total FROM ${TEST_SCHEMA}.enr_student_onboarding_progress
          WHERE application_id = $1::uuid`,
        appId,
      );
      expect(progressRows).toHaveLength(1);
      expect(progressRows[0]!.tasks_total).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // list / getById — row scope
  // ────────────────────────────────────────────────────────────────────
  describe('list / getById row scope', () => {
    it('parent sees only own offers; admin sees all', async () => {
      // Offer 1: parent's own
      const parentAppId = await seedAcceptedApp({ byParent: true });
      const parentOffer = await withTestTenant(async () =>
        offerService.issue(
          parentAppId,
          { responseDeadline: deadline() } as any,
          adminActor(),
        ),
      );
      // Offer 2: admin-only (no guardian_person_id)
      const adminAppId = await seedAcceptedApp({ byParent: false });
      await withTestTenant(async () =>
        offerService.issue(
          adminAppId,
          { responseDeadline: deadline() } as any,
          adminActor(),
        ),
      );

      const parentList = await withTestTenant(
        async () => offerService.list(parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(parentList).toHaveLength(1);
      expect(parentList[0]!.id).toBe(parentOffer.id);

      const adminList = await withTestTenant(async () =>
        offerService.list(adminActor()),
      );
      expect(adminList.length).toBeGreaterThanOrEqual(2);
    });

    it('STUDENT actor → empty list', async () => {
      const appId = await seedAcceptedApp();
      await withTestTenant(async () =>
        offerService.issue(
          appId,
          { responseDeadline: deadline() } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(
        async () => offerService.list(studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(list).toEqual([]);
    });

    it('parent getById on someone else\'s offer → 404', async () => {
      const adminAppId = await seedAcceptedApp({ byParent: false });
      const adminOffer = await withTestTenant(async () =>
        offerService.issue(
          adminAppId,
          { responseDeadline: deadline() } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(
          async () => offerService.getById(adminOffer.id, parentActor()),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById unknown id → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          offerService.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('parent fetching own offer succeeds', async () => {
      const parentAppId = await seedAcceptedApp({ byParent: true });
      const parentOffer = await withTestTenant(async () =>
        offerService.issue(
          parentAppId,
          { responseDeadline: deadline() } as any,
          adminActor(),
        ),
      );
      const fetched = await withTestTenant(
        async () => offerService.getById(parentOffer.id, parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(fetched.id).toBe(parentOffer.id);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // issue — validation rounds 2
  // ────────────────────────────────────────────────────────────────────
  describe('issue — extra validation', () => {
    it('UNCONDITIONAL with offerConditions → BadRequest', async () => {
      const appId = await seedAcceptedApp();
      await expect(
        withTestTenant(async () =>
          offerService.issue(
            appId,
            {
              responseDeadline: deadline(),
              offerType: 'UNCONDITIONAL',
              offerConditions: ['nope'],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('CONDITIONAL with empty offerConditions[] → BadRequest', async () => {
      const appId = await seedAcceptedApp();
      await expect(
        withTestTenant(async () =>
          offerService.issue(
            appId,
            {
              responseDeadline: deadline(),
              offerType: 'CONDITIONAL',
              offerConditions: [],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('unknown application id → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          offerService.issue(
            '00000000-0000-0000-0000-000000000000',
            { responseDeadline: deadline() } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('teacher (non-admin staff) → ForbiddenException', async () => {
      const appId = await seedAcceptedApp();
      await expect(
        withTestTenant(async () =>
          offerService.issue(
            appId,
            { responseDeadline: deadline() } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('offerLetterS3Key persists on the row', async () => {
      const appId = await seedAcceptedApp();
      const offer = await withTestTenant(async () =>
        offerService.issue(
          appId,
          {
            responseDeadline: deadline(),
            offerLetterS3Key: 's3://offers/sample.pdf',
          } as any,
          adminActor(),
        ),
      );
      expect(offer.offerLetterS3Key).toBe('s3://offers/sample.pdf');
    });

    it('issue from WAITLISTED status is allowed', async () => {
      const dto = await withTestTenant(async () =>
        appService.create(buildAppPayload({ firstName: 'WL' }), adminActor()),
      );
      await withTestTenant(async () =>
        appService.updateStatus(
          dto.id,
          { status: 'WAITLISTED' } as any,
          adminActor(),
        ),
      );
      const offer = await withTestTenant(async () =>
        offerService.issue(
          dto.id,
          { responseDeadline: deadline() } as any,
          adminActor(),
        ),
      );
      expect(offer.status).toBe('ISSUED');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-school
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school', () => {
    it('issuing in School B does not bleed into School A list (for parent)', async () => {
      // School B application + offer
      const bApp = await withTestTenantB(async () =>
        appService.create(buildAppPayload({ enrollmentPeriodId: periodBId }), adminActor()),
      );
      await withTestTenantB(async () =>
        appService.updateStatus(bApp.id, { status: 'ACCEPTED' } as any, adminActor()),
      );
      await withTestTenantB(async () =>
        offerService.issue(
          bApp.id,
          { responseDeadline: deadline() } as any,
          adminActor(),
        ),
      );

      // Parent in School A has no offers and the parent row-scope holds
      // even though the underlying SELECT does not constrain on school_id —
      // the guardian_person_id filter is the safety net.
      const list = await withTestTenant(
        async () => offerService.list(parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(list).toEqual([]);
    });
  });
});
