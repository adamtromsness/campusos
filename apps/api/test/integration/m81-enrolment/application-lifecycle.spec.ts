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
  TEST_ADMIN_ACCOUNT_ID,
  TEST_PARENT_PERSON_ID,
  TEST_STUDENT_PERSON_ID,
} from '../helpers/actor';
import {
  TEST_SIS_ACADEMIC_YEAR_ID,
  TEST_SIS_ACADEMIC_YEAR_B_ID,
} from '../fixtures/sis';

/**
 * Wave 4 — m81-enrolment ApplicationService + OfferService DB-backed
 * integration tests.
 *
 * Contracts verified:
 *   - Application submit (parent or admin), with enrollment period status gate
 *     and screening responses.
 *   - Application admin status transitions with FOR UPDATE row lock + transition
 *     guard (SUBMITTED → UNDER_REVIEW → ACCEPTED, etc.).
 *   - Offer issuance: gated on app status (ACCEPTED/WAITLISTED), CONDITIONAL vs
 *     UNCONDITIONAL validation, capacity recompute, UNIQUE on application.
 *   - Offer respond → ACCEPT flips application to ENROLLED, emits durable
 *     enr.student.enrolled via outbox + post-commit enr.offer.responded emit.
 *   - Row scope: parent sees only own applications, admin sees all.
 *   - Cross-school isolation: School A admin cannot see/touch School B
 *     applications.
 *   - Non-guardian/admin actor → 403 on create.
 *   - Confidential note filtering: parent does not see confidential notes.
 */
describe('integration:m81-enrolment/application-lifecycle', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: ReturnType<typeof makeRecordingKafka>;
  let outbox: OutboxService;
  let capacity: CapacitySummaryService;
  let onboarding: OnboardingService;
  let appService: ApplicationService;
  let offerService: OfferService;

  // Period ids re-created per beforeEach so each test sees a clean state.
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
    // Wipe enrolment rows across both schools. Order matters because of FKs:
    // - notes/screening/docs/offers/waitlist cascade off enr_applications.
    // - enr_applications.period FK is NO ACTION, so applications first.
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
    // OfferService.accept / WithdrawalService re-enrol flows create
    // pay_family_accounts + pay_family_account_students rows. They are
    // not cleaned by the enr_* wipe above and would collide with the
    // m84-payments suite's seed (UNIQUE on school_id + account_holder_id).
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.pay_family_account_students, ${TEST_SCHEMA}.pay_family_accounts CASCADE`,
    );

    // Seed open enrolment period for School A.
    periodAId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.enr_enrollment_periods
         (id, school_id, academic_year_id, name, opens_at, closes_at, status, allows_mid_year_applications)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'AY 2026-27 Open', now() - interval '7 days',
               now() + interval '30 days', 'OPEN', false)`,
      periodAId,
      TEST_SCHOOL_ID,
      TEST_SIS_ACADEMIC_YEAR_ID,
    );

    // Seed open enrolment period for School B (cross-school isolation).
    periodBId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.enr_enrollment_periods
         (id, school_id, academic_year_id, name, opens_at, closes_at, status, allows_mid_year_applications)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'AY 2026-27 B Open', now() - interval '7 days',
               now() + interval '30 days', 'OPEN', false)`,
      periodBId,
      TEST_SCHOOL_B_ID,
      TEST_SIS_ACADEMIC_YEAR_B_ID,
    );
  });

  function buildCreatePayload(
    overrides: Partial<{
      enrollmentPeriodId: string;
      studentFirstName: string;
      studentLastName: string;
      studentDateOfBirth: string;
      applyingForGrade: string;
      guardianEmail: string;
    }> = {},
  ): any {
    return {
      enrollmentPeriodId: overrides.enrollmentPeriodId ?? periodAId,
      studentFirstName: overrides.studentFirstName ?? 'Alex',
      studentLastName: overrides.studentLastName ?? 'Doe',
      studentDateOfBirth: overrides.studentDateOfBirth ?? '2018-04-12',
      applyingForGrade: overrides.applyingForGrade ?? '5',
      guardianEmail: overrides.guardianEmail ?? 'parent.alex@test.local',
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // create — parent or admin, status gate, screening
  // ────────────────────────────────────────────────────────────────────
  describe('create', () => {
    it('parent submits an application in OPEN period → enr.application.submitted emitted', async () => {
      const dto = await withTestTenant(
        async () => appService.create(buildCreatePayload(), parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(dto.status).toBe('SUBMITTED');
      expect(dto.guardianPersonId).toBe(TEST_PARENT_PERSON_ID);
      expect(dto.studentFirstName).toBe('Alex');
      expect(dto.applyingForGrade).toBe('5');

      const recorded = kafka as unknown as RecordingKafkaProducer;
      const submitted = recorded.callsForTopic('enr.application.submitted');
      expect(submitted).toHaveLength(1);
      expect(submitted[0]!.key).toBe(dto.id);
      expect(submitted[0]!.payload).toMatchObject({
        applicationId: dto.id,
        schoolId: TEST_SCHOOL_ID,
        enrollmentPeriodId: periodAId,
        applyingForGrade: '5',
      });

      // DB-side: status persists, school_id stamped from tenant.
      const rows = await rawClient.$queryRawUnsafe<
        Array<{ status: string; school_id: string; guardian_person_id: string }>
      >(
        `SELECT status, school_id::text AS school_id, guardian_person_id::text AS guardian_person_id
           FROM ${TEST_SCHEMA}.enr_applications WHERE id = $1::uuid`,
        dto.id,
      );
      expect(rows[0]!.status).toBe('SUBMITTED');
      expect(rows[0]!.school_id).toBe(TEST_SCHOOL_ID);
      expect(rows[0]!.guardian_person_id).toBe(TEST_PARENT_PERSON_ID);
    });

    it('admin submits an application → guardian_person_id is NULL (back-office)', async () => {
      const dto = await withTestTenant(async () =>
        appService.create(buildCreatePayload(), adminActor()),
      );
      expect(dto.status).toBe('SUBMITTED');
      expect(dto.guardianPersonId).toBeNull();
    });

    it('STUDENT persona → ForbiddenException', async () => {
      await expect(
        withTestTenant(
          async () => appService.create(buildCreatePayload(), studentActor()),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-admin STAFF persona (teacher) → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          appService.create(buildCreatePayload(), teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('UPCOMING enrollment period (not OPEN) → BadRequestException', async () => {
      // Flip the period to UPCOMING.
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.enr_enrollment_periods SET status = 'UPCOMING' WHERE id = $1::uuid`,
        periodAId,
      );
      await expect(
        withTestTenant(
          async () => appService.create(buildCreatePayload(), parentActor()),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('CLOSED period that does NOT allow mid-year admissions → BadRequest even on MID_YEAR_ADMISSION', async () => {
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.enr_enrollment_periods SET status = 'CLOSED', allows_mid_year_applications = false WHERE id = $1::uuid`,
        periodAId,
      );
      const payload = { ...buildCreatePayload(), admissionType: 'MID_YEAR_ADMISSION' };
      await expect(
        withTestTenant(
          async () => appService.create(payload, parentActor()),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('CLOSED period with allows_mid_year=true accepts MID_YEAR_ADMISSION submission', async () => {
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.enr_enrollment_periods SET status = 'CLOSED', allows_mid_year_applications = true WHERE id = $1::uuid`,
        periodAId,
      );
      const payload = { ...buildCreatePayload(), admissionType: 'MID_YEAR_ADMISSION' };
      const dto = await withTestTenant(
        async () => appService.create(payload, parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(dto.status).toBe('SUBMITTED');
      expect(dto.admissionType).toBe('MID_YEAR_ADMISSION');
    });

    it('unknown enrollment period → NotFoundException', async () => {
      const payload = {
        ...buildCreatePayload(),
        enrollmentPeriodId: '00000000-0000-0000-0000-000000000000',
      };
      await expect(
        withTestTenant(
          async () => appService.create(payload, parentActor()),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('persists screening responses as JSONB', async () => {
      const payload = {
        ...buildCreatePayload(),
        screening: [
          { questionKey: 'has_siblings', responseValue: true },
          { questionKey: 'preferred_start', responseValue: 'autumn' },
        ],
      };
      const dto = await withTestTenant(
        async () => appService.create(payload, parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(dto.screening).toHaveLength(2);
      const keys = dto.screening.map((s) => s.questionKey).sort();
      expect(keys).toEqual(['has_siblings', 'preferred_start']);
    });

    it('invalid date of birth → BadRequestException', async () => {
      const payload = { ...buildCreatePayload(), studentDateOfBirth: 'not-a-date' };
      await expect(
        withTestTenant(
          async () => appService.create(payload, parentActor()),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // list / getById — row scope
  // ────────────────────────────────────────────────────────────────────
  describe('list / getById row-scope', () => {
    it('parent sees ONLY own applications', async () => {
      // App 1: parent's own.
      const mine = await withTestTenant(
        async () =>
          appService.create(
            buildCreatePayload({ studentFirstName: 'My', guardianEmail: 'p1@x' }),
            parentActor(),
          ),
        { personId: TEST_PARENT_PERSON_ID },
      );
      // App 2: admin-submitted (no guardian).
      await withTestTenant(async () =>
        appService.create(
          buildCreatePayload({ studentFirstName: 'Other', guardianEmail: 'p2@x' }),
          adminActor(),
        ),
      );

      const parentList = await withTestTenant(
        async () => appService.list({}, parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(parentList).toHaveLength(1);
      expect(parentList[0]!.id).toBe(mine.id);
    });

    it('admin sees every application', async () => {
      await withTestTenant(
        async () =>
          appService.create(
            buildCreatePayload({ studentFirstName: 'A', guardianEmail: 'p1@x' }),
            parentActor(),
          ),
        { personId: TEST_PARENT_PERSON_ID },
      );
      await withTestTenant(async () =>
        appService.create(
          buildCreatePayload({ studentFirstName: 'B', guardianEmail: 'p2@x' }),
          adminActor(),
        ),
      );
      const adminList = await withTestTenant(async () =>
        appService.list({}, adminActor()),
      );
      expect(adminList.length).toBeGreaterThanOrEqual(2);
    });

    it('STUDENT actor → empty list', async () => {
      await withTestTenant(async () =>
        appService.create(buildCreatePayload(), adminActor()),
      );
      const list = await withTestTenant(
        async () => appService.list({}, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(list).toEqual([]);
    });

    it("parent getById on someone else's application → 404", async () => {
      const foreign = await withTestTenant(async () =>
        appService.create(
          buildCreatePayload({ guardianEmail: 'someoneelse@x' }),
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(
          async () => appService.getById(foreign.id, parentActor()),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('admin filter by status', async () => {
      const a = await withTestTenant(async () =>
        appService.create(buildCreatePayload({ studentFirstName: 'F1' }), adminActor()),
      );
      const b = await withTestTenant(async () =>
        appService.create(buildCreatePayload({ studentFirstName: 'F2' }), adminActor()),
      );
      // Move b → ACCEPTED.
      await withTestTenant(async () =>
        appService.updateStatus(b.id, { status: 'ACCEPTED' } as any, adminActor()),
      );
      const submittedOnly = await withTestTenant(async () =>
        appService.list({ status: 'SUBMITTED' }, adminActor()),
      );
      const ids = submittedOnly.map((r) => r.id);
      expect(ids).toContain(a.id);
      expect(ids).not.toContain(b.id);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // updateStatus — admin only, FOR UPDATE row lock + transitions
  // ────────────────────────────────────────────────────────────────────
  describe('updateStatus', () => {
    it('admin: SUBMITTED → UNDER_REVIEW → ACCEPTED legal transitions', async () => {
      const dto = await withTestTenant(async () =>
        appService.create(buildCreatePayload(), adminActor()),
      );
      const step1 = await withTestTenant(async () =>
        appService.updateStatus(
          dto.id,
          { status: 'UNDER_REVIEW' } as any,
          adminActor(),
        ),
      );
      expect(step1.status).toBe('UNDER_REVIEW');
      expect(step1.reviewedBy).toBe(TEST_ADMIN_ACCOUNT_ID);
      expect(step1.reviewedAt).not.toBeNull();

      const step2 = await withTestTenant(async () =>
        appService.updateStatus(
          dto.id,
          { status: 'ACCEPTED' } as any,
          adminActor(),
        ),
      );
      expect(step2.status).toBe('ACCEPTED');

      const recorded = kafka as unknown as RecordingKafkaProducer;
      const events = recorded.callsForTopic('enr.application.status_changed');
      expect(events.length).toBeGreaterThanOrEqual(2);
    });

    it('rejects illegal transition (SUBMITTED → REJECTED is legal; ACCEPTED → UNDER_REVIEW is NOT)', async () => {
      const dto = await withTestTenant(async () =>
        appService.create(buildCreatePayload(), adminActor()),
      );
      await withTestTenant(async () =>
        appService.updateStatus(
          dto.id,
          { status: 'ACCEPTED' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          appService.updateStatus(
            dto.id,
            { status: 'UNDER_REVIEW' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-admin caller → ForbiddenException', async () => {
      const dto = await withTestTenant(
        async () => appService.create(buildCreatePayload(), parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      await expect(
        withTestTenant(
          async () =>
            appService.updateStatus(
              dto.id,
              { status: 'UNDER_REVIEW' } as any,
              parentActor(),
            ),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          appService.updateStatus(
            '00000000-0000-0000-0000-000000000000',
            { status: 'UNDER_REVIEW' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reviewNote is appended as application note when provided', async () => {
      const dto = await withTestTenant(async () =>
        appService.create(buildCreatePayload(), adminActor()),
      );
      const result = await withTestTenant(async () =>
        appService.updateStatus(
          dto.id,
          { status: 'UNDER_REVIEW', reviewNote: 'screening complete' } as any,
          adminActor(),
        ),
      );
      expect(result.notes.length).toBeGreaterThanOrEqual(1);
      expect(result.notes.find((n) => n.noteText === 'screening complete')).toBeTruthy();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Offer lifecycle: issue → accept/decline
  // ────────────────────────────────────────────────────────────────────
  describe('offer issue → respond', () => {
    async function seedAcceptedApplication(): Promise<string> {
      const dto = await withTestTenant(
        async () => appService.create(buildCreatePayload(), parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      await withTestTenant(async () =>
        appService.updateStatus(
          dto.id,
          { status: 'ACCEPTED' } as any,
          adminActor(),
        ),
      );
      return dto.id;
    }

    it('admin issues UNCONDITIONAL offer → status ISSUED, enr.offer.issued emitted', async () => {
      const appId = await seedAcceptedApplication();
      const deadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      const offer = await withTestTenant(async () =>
        offerService.issue(
          appId,
          { responseDeadline: deadline } as any,
          adminActor(),
        ),
      );
      expect(offer.status).toBe('ISSUED');
      expect(offer.offerType).toBe('UNCONDITIONAL');

      const recorded = kafka as unknown as RecordingKafkaProducer;
      const issued = recorded.callsForTopic('enr.offer.issued');
      expect(issued).toHaveLength(1);
      expect(issued[0]!.key).toBe(offer.id);
    });

    it('issue on non-ACCEPTED/WAITLISTED app → BadRequest', async () => {
      const dto = await withTestTenant(async () =>
        appService.create(buildCreatePayload(), adminActor()),
      );
      const deadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      await expect(
        withTestTenant(async () =>
          offerService.issue(
            dto.id,
            { responseDeadline: deadline } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-admin issue → ForbiddenException', async () => {
      const appId = await seedAcceptedApplication();
      const deadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      await expect(
        withTestTenant(
          async () =>
            offerService.issue(
              appId,
              { responseDeadline: deadline } as any,
              parentActor(),
            ),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('duplicate offer issue on same application → BadRequest', async () => {
      const appId = await seedAcceptedApplication();
      const deadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      await withTestTenant(async () =>
        offerService.issue(
          appId,
          { responseDeadline: deadline } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          offerService.issue(
            appId,
            { responseDeadline: deadline } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('CONDITIONAL offer without offerConditions → BadRequest', async () => {
      const appId = await seedAcceptedApplication();
      const deadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      await expect(
        withTestTenant(async () =>
          offerService.issue(
            appId,
            { responseDeadline: deadline, offerType: 'CONDITIONAL' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('responseDeadline in the past → BadRequest', async () => {
      const appId = await seedAcceptedApplication();
      const past = new Date(Date.now() - 1000).toISOString();
      await expect(
        withTestTenant(async () =>
          offerService.issue(
            appId,
            { responseDeadline: past } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('parent ACCEPTS offer → application → ENROLLED + enr.student.enrolled outbox row', async () => {
      const appId = await seedAcceptedApplication();
      const deadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      const offer = await withTestTenant(async () =>
        offerService.issue(
          appId,
          { responseDeadline: deadline } as any,
          adminActor(),
        ),
      );

      const responded = await withTestTenant(
        async () =>
          offerService.respond(
            offer.id,
            { familyResponse: 'ACCEPTED' } as any,
            parentActor(),
          ),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(responded.status).toBe('ACCEPTED');
      expect(responded.familyResponse).toBe('ACCEPTED');

      // Application status flipped to ENROLLED.
      const appRows = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.enr_applications WHERE id = $1::uuid`,
        appId,
      );
      expect(appRows[0]!.status).toBe('ENROLLED');

      // Durable outbox row for enr.student.enrolled exists. The
      // OfferService uses `key: offer.application_id` so message_key = appId.
      // Compare both as plain text to dodge any cross-type cast funkiness.
      const outboxRows = await rawClient.$queryRawUnsafe<
        Array<{ topic: string; message_key: string | null }>
      >(
        `SELECT topic, message_key FROM platform.platform_outbox
          WHERE topic = 'enr.student.enrolled' AND message_key = $1`,
        appId,
      );
      expect(outboxRows.length).toBeGreaterThanOrEqual(1);
    });

    it('parent DECLINES offer → status DECLINED, application stays ACCEPTED', async () => {
      const appId = await seedAcceptedApplication();
      const deadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      const offer = await withTestTenant(async () =>
        offerService.issue(
          appId,
          { responseDeadline: deadline } as any,
          adminActor(),
        ),
      );
      const responded = await withTestTenant(
        async () =>
          offerService.respond(
            offer.id,
            { familyResponse: 'DECLINED' } as any,
            parentActor(),
          ),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(responded.status).toBe('DECLINED');
      const appRows = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.enr_applications WHERE id = $1::uuid`,
        appId,
      );
      expect(appRows[0]!.status).toBe('ACCEPTED');
    });

    it('non-owning parent cannot respond to an offer → ForbiddenException', async () => {
      // Admin-submitted application has no guardian_person_id; a parent
      // actor cannot respond to it.
      const dto = await withTestTenant(async () =>
        appService.create(buildCreatePayload(), adminActor()),
      );
      await withTestTenant(async () =>
        appService.updateStatus(
          dto.id,
          { status: 'ACCEPTED' } as any,
          adminActor(),
        ),
      );
      const deadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      const offer = await withTestTenant(async () =>
        offerService.issue(
          dto.id,
          { responseDeadline: deadline } as any,
          adminActor(),
        ),
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
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-school isolation — Codex FIX 2: ApplicationService.list() and
  // .getById() now bind `a.school_id = tenant.schoolId`, so cross-school
  // rows are invisible (404 on direct fetch, missing from list).
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it("School A admin's list excludes School B applications", async () => {
      // Create app in School B.
      await withTestTenantB(async () =>
        appService.create(
          buildCreatePayload({
            enrollmentPeriodId: periodBId,
            studentFirstName: 'SchoolB-Student',
          }),
          adminActor(),
        ),
      );
      // Create app in School A.
      const aAppDto = await withTestTenant(async () =>
        appService.create(
          buildCreatePayload({ studentFirstName: 'SchoolA-Student' }),
          adminActor(),
        ),
      );

      const aList = await withTestTenant(async () =>
        appService.list({}, adminActor()),
      );
      const names = aList.map((r) => r.studentFirstName);
      expect(names).toContain('SchoolA-Student');
      expect(names).not.toContain('SchoolB-Student');
      expect(aList.map((r) => r.id)).toContain(aAppDto.id);
    });

    it('School A admin getById of a School B application → NotFoundException', async () => {
      const bDto = await withTestTenantB(async () =>
        appService.create(
          buildCreatePayload({
            enrollmentPeriodId: periodBId,
            studentFirstName: 'B-Direct',
          }),
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => appService.getById(bDto.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // addNote — confidential filtering
  // ────────────────────────────────────────────────────────────────────
  describe('addNote + confidential filter', () => {
    it('admin adds a confidential note → parent does NOT see it via getById', async () => {
      const dto = await withTestTenant(
        async () => appService.create(buildCreatePayload(), parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      await withTestTenant(async () =>
        appService.addNote(
          dto.id,
          {
            noteType: 'INTERVIEW_NOTES',
            noteText: 'private screening notes',
            isConfidential: true,
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        appService.addNote(
          dto.id,
          { noteType: 'GENERAL', noteText: 'all good', isConfidential: false } as any,
          adminActor(),
        ),
      );
      const parentView = await withTestTenant(
        async () => appService.getById(dto.id, parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      const texts = parentView.notes.map((n) => n.noteText);
      expect(texts).toContain('all good');
      expect(texts).not.toContain('private screening notes');
      const adminView = await withTestTenant(async () =>
        appService.getById(dto.id, adminActor()),
      );
      const adminTexts = adminView.notes.map((n) => n.noteText);
      expect(adminTexts).toContain('all good');
      expect(adminTexts).toContain('private screening notes');
    });

    it('non-admin addNote → ForbiddenException', async () => {
      const dto = await withTestTenant(
        async () => appService.create(buildCreatePayload(), parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      await expect(
        withTestTenant(
          async () =>
            appService.addNote(
              dto.id,
              { noteText: 'parent note' } as any,
              parentActor(),
            ),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
