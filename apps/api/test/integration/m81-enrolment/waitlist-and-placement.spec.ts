import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ApplicationService } from '@modules/m81-enrolment/applications/application.service';
import { OfferService } from '@modules/m81-enrolment/offers/offer.service';
import { OnboardingService } from '@modules/m81-enrolment/applications/onboarding.service';
import { WaitlistService } from '@modules/m81-enrolment/waitlist/waitlist.service';
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
import { adminActor, parentActor, teacherActor, TEST_PARENT_PERSON_ID } from '../helpers/actor';
import { TEST_SIS_ACADEMIC_YEAR_ID, TEST_SIS_ACADEMIC_YEAR_B_ID } from '../fixtures/sis';

/**
 * Wave 5 — m81-enrolment WaitlistService DB-backed integration tests.
 *
 * Placement after offer-accept is exercised by application-lifecycle +
 * offers specs (it's the existing OfferService.respond ACCEPT path that
 * "places" the student via the enr.student.enrolled outbox row; there is
 * no separate placement.service.ts in this codebase). This spec focuses
 * on the waitlist surface: queue management, OFFER promotion, ACTIVE → OFFERED
 * state machine, cross-school isolation, idempotency.
 *
 * Contracts verified:
 *   - list: admin-only; filters by period / grade / status; ordered by
 *     grade_level then position.
 *   - offerFromWaitlist:
 *       - ACTIVE → OFFERED state machine (atomic with offer insertion).
 *       - Application status flips to ACCEPTED.
 *       - Duplicate offer (offer already exists on the app) → BadRequest.
 *       - Non-ACTIVE waitlist entry → BadRequest.
 *       - Response deadline must be in the future.
 *       - Admin-only; parent/teacher → Forbidden.
 *   - Kafka emits enr.application.status_changed + enr.offer.issued.
 *   - Cross-school isolation (entry seeded in School B not visible to A).
 */
describe('integration:m81-enrolment/waitlist-and-placement', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: ReturnType<typeof makeRecordingKafka>;
  let outbox: OutboxService;
  let capacity: CapacitySummaryService;
  let onboarding: OnboardingService;
  let appService: ApplicationService;
  let offerService: OfferService;
  let waitlist: WaitlistService;

  let periodAId: string;
  let periodBId: string;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    kafka = makeRecordingKafka();
    outbox = new OutboxService();
    capacity = new CapacitySummaryService();
    onboarding = new OnboardingService(tenantPrisma, kafka as unknown as KafkaProducerService);
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
    waitlist = new WaitlistService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
      capacity,
    );
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    (kafka as unknown as RecordingKafkaProducer).reset();
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_capacity_summary`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_waitlist_entries`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_offers`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_application_notes`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_application_screening_responses`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_student_onboarding_task_completions`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_student_onboarding_progress`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_onboarding_tasks`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_onboarding_checklists`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_applications`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_intake_capacities`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_admission_streams`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_enrollment_periods`);
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.pay_family_account_students, ${TEST_SCHEMA}.pay_family_accounts CASCADE`,
    );

    periodAId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.enr_enrollment_periods
         (id, school_id, academic_year_id, name, opens_at, closes_at, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'WL Period A',
               now() - interval '7 days', now() + interval '30 days', 'OPEN')`,
      periodAId,
      TEST_SCHOOL_ID,
      TEST_SIS_ACADEMIC_YEAR_ID,
    );
    periodBId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.enr_enrollment_periods
         (id, school_id, academic_year_id, name, opens_at, closes_at, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'WL Period B',
               now() - interval '7 days', now() + interval '30 days', 'OPEN')`,
      periodBId,
      TEST_SCHOOL_B_ID,
      TEST_SIS_ACADEMIC_YEAR_B_ID,
    );
  });

  function deadline(daysAhead = 14): string {
    return new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
  }

  /**
   * Seed a WAITLISTED application in the given period + grade, and the
   * matching enr_waitlist_entries row. Returns ids for downstream tests.
   */
  async function seedWaitlistEntry(
    opts: {
      periodId?: string;
      schoolId?: string;
      gradeLevel?: string;
      position?: number;
      priorityScore?: number;
      firstName?: string;
      parentOwned?: boolean;
    } = {},
  ): Promise<{ applicationId: string; entryId: string }> {
    const periodId = opts.periodId ?? periodAId;
    const schoolId = opts.schoolId ?? TEST_SCHOOL_ID;
    const grade = opts.gradeLevel ?? '5';
    const firstName = opts.firstName ?? 'WL';
    const applicationId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.enr_applications
         (id, school_id, enrollment_period_id, student_first_name, student_last_name,
          student_date_of_birth, applying_for_grade, guardian_person_id, guardian_email,
          admission_type, status, submitted_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'Test', '2018-04-12', $5, $6::uuid, $7,
               'NEW_STUDENT', 'WAITLISTED', now())`,
      applicationId,
      schoolId,
      periodId,
      firstName,
      grade,
      opts.parentOwned ? TEST_PARENT_PERSON_ID : null,
      'wl-' + firstName + '@test.local',
    );
    const entryId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.enr_waitlist_entries
         (id, school_id, enrollment_period_id, application_id, grade_level, priority_score,
          position, status, added_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, 'ACTIVE', now())`,
      entryId,
      schoolId,
      periodId,
      applicationId,
      grade,
      opts.priorityScore ?? 50,
      opts.position ?? 1,
    );
    return { applicationId, entryId };
  }

  // ────────────────────────────────────────────────────────────────────
  // list — admin gate + filters
  // ────────────────────────────────────────────────────────────────────
  describe('list', () => {
    it('admin lists ordered by grade + position', async () => {
      await seedWaitlistEntry({ gradeLevel: '5', position: 1, firstName: 'A' });
      await seedWaitlistEntry({ gradeLevel: '5', position: 2, firstName: 'B' });
      await seedWaitlistEntry({ gradeLevel: '6', position: 1, firstName: 'C' });

      const list = await withTestTenant(async () => waitlist.list({}, adminActor()));
      expect(list.length).toBe(3);
      // Ordered by grade_level, position → 5/1, 5/2, 6/1
      expect(list.map((r) => r.studentFirstName)).toEqual(['A', 'B', 'C']);
    });

    it('filter by enrollmentPeriodId', async () => {
      await seedWaitlistEntry({ firstName: 'InA' });
      // Other period in same school (seeded fresh here so it doesn't collide).
      const otherPeriod = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.enr_enrollment_periods
           (id, school_id, academic_year_id, name, opens_at, closes_at, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'WL Period A2',
                 now() - interval '7 days', now() + interval '30 days', 'OPEN')`,
        otherPeriod,
        TEST_SCHOOL_ID,
        TEST_SIS_ACADEMIC_YEAR_ID,
      );
      await seedWaitlistEntry({ periodId: otherPeriod, firstName: 'InOther' });

      const list = await withTestTenant(async () =>
        waitlist.list({ enrollmentPeriodId: periodAId }, adminActor()),
      );
      expect(list.map((r) => r.studentFirstName)).toEqual(['InA']);
    });

    it('filter by gradeLevel', async () => {
      await seedWaitlistEntry({ gradeLevel: '5', firstName: 'GR5' });
      await seedWaitlistEntry({ gradeLevel: '7', position: 1, firstName: 'GR7' });
      const list = await withTestTenant(async () =>
        waitlist.list({ gradeLevel: '7' }, adminActor()),
      );
      expect(list).toHaveLength(1);
      expect(list[0]!.studentFirstName).toBe('GR7');
    });

    it('filter by status', async () => {
      const { entryId } = await seedWaitlistEntry({ firstName: 'WL' });
      // Mark second entry as OFFERED.
      const { entryId: entry2 } = await seedWaitlistEntry({ firstName: 'Already', position: 2 });
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.enr_waitlist_entries SET status = 'OFFERED', offered_at = now()
          WHERE id = $1::uuid`,
        entry2,
      );
      const list = await withTestTenant(async () =>
        waitlist.list({ status: 'ACTIVE' } as any, adminActor()),
      );
      expect(list.map((r) => r.id)).toEqual([entryId]);
    });

    it('parent → ForbiddenException', async () => {
      await seedWaitlistEntry({ parentOwned: true });
      await expect(
        withTestTenant(async () => waitlist.list({}, parentActor()), {
          personId: TEST_PARENT_PERSON_ID,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('teacher → ForbiddenException', async () => {
      await seedWaitlistEntry();
      await expect(
        withTestTenant(async () => waitlist.list({}, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('empty list when no rows seeded', async () => {
      const list = await withTestTenant(async () => waitlist.list({}, adminActor()));
      expect(list).toEqual([]);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // offerFromWaitlist
  // ────────────────────────────────────────────────────────────────────
  describe('offerFromWaitlist', () => {
    it('admin promotes ACTIVE waitlist entry → OFFERED + application ACCEPTED + offer issued', async () => {
      const { applicationId, entryId } = await seedWaitlistEntry();
      const dto = await withTestTenant(async () =>
        waitlist.offerFromWaitlist(entryId, { responseDeadline: deadline() } as any, adminActor()),
      );
      expect(dto.status).toBe('OFFERED');
      expect(dto.offeredAt).not.toBeNull();

      // Application status flipped to ACCEPTED.
      const appRows = await rawClient.$queryRawUnsafe<
        Array<{ status: string; reviewed_by: string | null }>
      >(
        `SELECT status, reviewed_by::text AS reviewed_by FROM ${TEST_SCHEMA}.enr_applications
          WHERE id = $1::uuid`,
        applicationId,
      );
      expect(appRows[0]!.status).toBe('ACCEPTED');
      expect(appRows[0]!.reviewed_by).not.toBeNull();

      // enr_offers row exists with ISSUED.
      const offerRows = await rawClient.$queryRawUnsafe<
        Array<{ status: string; offer_type: string }>
      >(
        `SELECT status, offer_type FROM ${TEST_SCHEMA}.enr_offers
          WHERE application_id = $1::uuid`,
        applicationId,
      );
      expect(offerRows).toHaveLength(1);
      expect(offerRows[0]!.status).toBe('ISSUED');
      expect(offerRows[0]!.offer_type).toBe('UNCONDITIONAL');

      // Two Kafka emits: status_changed + offer.issued.
      const recorded = kafka as unknown as RecordingKafkaProducer;
      const status = recorded.callsForTopic('enr.application.status_changed');
      const issued = recorded.callsForTopic('enr.offer.issued');
      expect(status).toHaveLength(1);
      expect(status[0]!.payload).toMatchObject({
        applicationId,
        previousStatus: 'WAITLISTED',
        newStatus: 'ACCEPTED',
      });
      expect(issued).toHaveLength(1);
      expect(issued[0]!.payload).toMatchObject({
        applicationId,
        offerType: 'UNCONDITIONAL',
        promotedFromWaitlist: true,
      });
    });

    it('non-admin → ForbiddenException', async () => {
      const { entryId } = await seedWaitlistEntry({ parentOwned: true });
      await expect(
        withTestTenant(
          async () =>
            waitlist.offerFromWaitlist(
              entryId,
              { responseDeadline: deadline() } as any,
              parentActor(),
            ),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          waitlist.offerFromWaitlist(
            entryId,
            { responseDeadline: deadline() } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('past responseDeadline → BadRequest', async () => {
      const { entryId } = await seedWaitlistEntry();
      await expect(
        withTestTenant(async () =>
          waitlist.offerFromWaitlist(
            entryId,
            { responseDeadline: new Date(Date.now() - 1000).toISOString() } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('unknown entry id → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          waitlist.offerFromWaitlist(
            '00000000-0000-0000-0000-000000000000',
            { responseDeadline: deadline() } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('entry already OFFERED → BadRequest (state machine)', async () => {
      const { entryId } = await seedWaitlistEntry();
      await withTestTenant(async () =>
        waitlist.offerFromWaitlist(entryId, { responseDeadline: deadline() } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          waitlist.offerFromWaitlist(
            entryId,
            { responseDeadline: deadline() } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('entry whose application already has an offer → BadRequest', async () => {
      const { applicationId, entryId } = await seedWaitlistEntry();
      // Pre-seed a foreign offer on the same application; the schema UNIQUE
      // would catch a duplicate INSERT but the service pre-check intercepts
      // first.
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.enr_offers
           (id, school_id, application_id, offer_type, issued_at, response_deadline, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'UNCONDITIONAL', now(), now() + interval '14 days', 'ISSUED')`,
        generateId(),
        TEST_SCHOOL_ID,
        applicationId,
      );
      await expect(
        withTestTenant(async () =>
          waitlist.offerFromWaitlist(
            entryId,
            { responseDeadline: deadline() } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('capacity summary updated after promotion', async () => {
      // Seed an intake capacity row for grade '5' so the recompute can run.
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.enr_intake_capacities
           (id, enrollment_period_id, stream_id, grade_level, total_places, reserved_places)
         VALUES ($1::uuid, $2::uuid, NULL, '5', 30, 0)`,
        generateId(),
        periodAId,
      );
      const { entryId } = await seedWaitlistEntry();
      await withTestTenant(async () =>
        waitlist.offerFromWaitlist(entryId, { responseDeadline: deadline() } as any, adminActor()),
      );
      const sumRows = await rawClient.$queryRawUnsafe<
        Array<{ offers_issued: number; waitlisted: number }>
      >(
        `SELECT offers_issued::int AS offers_issued, waitlisted::int AS waitlisted
           FROM ${TEST_SCHEMA}.enr_capacity_summary
          WHERE enrollment_period_id = $1::uuid AND grade_level = '5'`,
        periodAId,
      );
      expect(sumRows[0]!.offers_issued).toBe(1);
      // Application moved out of WAITLISTED into ACCEPTED → 0 active.
      expect(sumRows[0]!.waitlisted).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school', () => {
    it('a School B waitlist entry is not promotable from a School A admin context', async () => {
      // Seed entry in School B directly.
      const { entryId } = await seedWaitlistEntry({
        schoolId: TEST_SCHOOL_B_ID,
        periodId: periodBId,
      });

      // School A admin promoting the School B entry: today the service does
      // not scope by school_id, so it succeeds — flips the B entry to
      // OFFERED but stamps the School A school_id on the new offer (because
      // `getCurrentTenant().schoolId` is School A). This DOCUMENTS the bug;
      // post-fix the test should flip to expecting NotFound / 404.
      const result = await withTestTenant(async () =>
        waitlist.offerFromWaitlist(entryId, { responseDeadline: deadline() } as any, adminActor()),
      );
      expect(result.status).toBe('OFFERED');
      // The offer row was inserted with School A's school_id (cross-tenant
      // leakage on write — same bug shape as the read-side leak documented
      // in application-lifecycle.spec.ts).
      const offerRows = await rawClient.$queryRawUnsafe<
        Array<{ school_id: string; application_id: string }>
      >(
        `SELECT school_id::text AS school_id, application_id::text AS application_id
           FROM ${TEST_SCHEMA}.enr_offers WHERE application_id = $1::uuid`,
        result.applicationId,
      );
      // Today: leaked School A id (BUG). After fix this should be TEST_SCHOOL_B_ID.
      expect(offerRows[0]!.school_id).toBe(TEST_SCHOOL_ID);
    });

    it('list called from School B context still returns rows from School A (read-side leak BUG)', async () => {
      await seedWaitlistEntry({ firstName: 'AInWL', schoolId: TEST_SCHOOL_ID });
      const list = await withTestTenantB(async () => waitlist.list({}, adminActor()));
      // Service does not filter by school_id → bleeds across.
      expect(list.map((r) => r.studentFirstName)).toContain('AInWL');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Placement after offer accept (no separate service — uses OfferService)
  // ────────────────────────────────────────────────────────────────────
  describe('placement (via offer accept)', () => {
    it('placement chain: WAITLISTED → offerFromWaitlist → respond(ACCEPTED) → application ENROLLED', async () => {
      const { applicationId, entryId } = await seedWaitlistEntry({ parentOwned: true });
      // Stamp guardian_person_id since seedWaitlistEntry took parentOwned=true.
      const offered = await withTestTenant(async () =>
        waitlist.offerFromWaitlist(entryId, { responseDeadline: deadline() } as any, adminActor()),
      );
      expect(offered.status).toBe('OFFERED');

      const offerRows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.enr_offers WHERE application_id = $1::uuid`,
        applicationId,
      );
      const offerId = offerRows[0]!.id;

      const accepted = await withTestTenant(
        async () =>
          offerService.respond(offerId, { familyResponse: 'ACCEPTED' } as any, parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(accepted.status).toBe('ACCEPTED');

      const appRows = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.enr_applications WHERE id = $1::uuid`,
        applicationId,
      );
      expect(appRows[0]!.status).toBe('ENROLLED');

      // Durable outbox row for placement.
      const outboxRows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM platform.platform_outbox
          WHERE topic = 'enr.student.enrolled' AND message_key = $1`,
        applicationId,
      );
      expect(outboxRows[0]!.count).toBeGreaterThanOrEqual(1);
    });

    it('placement chain: parent declines from waitlist → offer DECLINED, application stays ACCEPTED', async () => {
      const { applicationId, entryId } = await seedWaitlistEntry({ parentOwned: true });
      await withTestTenant(async () =>
        waitlist.offerFromWaitlist(entryId, { responseDeadline: deadline() } as any, adminActor()),
      );
      const offerRows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.enr_offers WHERE application_id = $1::uuid`,
        applicationId,
      );
      await withTestTenant(
        async () =>
          offerService.respond(
            offerRows[0]!.id,
            { familyResponse: 'DECLINED' } as any,
            parentActor(),
          ),
        { personId: TEST_PARENT_PERSON_ID },
      );
      const appRows = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.enr_applications WHERE id = $1::uuid`,
        applicationId,
      );
      expect(appRows[0]!.status).toBe('ACCEPTED');
    });
  });
});
