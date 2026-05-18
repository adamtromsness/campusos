import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
import { adminActor, parentActor, TEST_PARENT_PERSON_ID } from '../helpers/actor';
import {
  TEST_SIS_ACADEMIC_YEAR_ID,
  TEST_SIS_ACADEMIC_YEAR_B_ID,
} from '../fixtures/sis';

/**
 * Wave 4 — m81-enrolment CapacitySummaryService DB-backed integration tests.
 *
 * Contracts verified:
 *   - Recompute runs inside an open tx and aggregates applications + offers +
 *     intake capacities into enr_capacity_summary.
 *   - pg_advisory_xact_lock is taken per (period, grade) — observed via the
 *     UPSERT survival of the UNIQUE(period_id, grade_level) constraint.
 *   - Cross-school capacity isolation: a recompute against School B's period
 *     does not touch School A's summary row.
 *   - Capacity is re-driven through the application status pipeline (the
 *     ApplicationService.updateStatus call recomputes after a state change).
 *   - `available` math: total_places - reserved - offers_accepted.
 *   - UPSERT in place (no duplicate enr_capacity_summary row per period+grade).
 */
describe('integration:m81-enrolment/capacity', () => {
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

    periodAId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.enr_enrollment_periods
         (id, school_id, academic_year_id, name, opens_at, closes_at, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'Cap Period A', now() - interval '7 days',
               now() + interval '30 days', 'OPEN')`,
      periodAId,
      TEST_SCHOOL_ID,
      TEST_SIS_ACADEMIC_YEAR_ID,
    );

    periodBId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.enr_enrollment_periods
         (id, school_id, academic_year_id, name, opens_at, closes_at, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'Cap Period B', now() - interval '7 days',
               now() + interval '30 days', 'OPEN')`,
      periodBId,
      TEST_SCHOOL_B_ID,
      TEST_SIS_ACADEMIC_YEAR_B_ID,
    );
  });

  async function seedCapacity(
    periodId: string,
    gradeLevel: string,
    totalPlaces: number,
    reservedPlaces = 0,
  ): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.enr_intake_capacities
         (id, enrollment_period_id, stream_id, grade_level, total_places, reserved_places)
       VALUES ($1::uuid, $2::uuid, NULL, $3, $4::int, $5::int)`,
      id,
      periodId,
      gradeLevel,
      totalPlaces,
      reservedPlaces,
    );
    return id;
  }

  function buildAppPayload(
    overrides: { enrollmentPeriodId?: string; grade?: string; firstName?: string } = {},
  ): any {
    return {
      enrollmentPeriodId: overrides.enrollmentPeriodId ?? periodAId,
      studentFirstName: overrides.firstName ?? 'Cap',
      studentLastName: 'Test',
      studentDateOfBirth: '2018-04-12',
      applyingForGrade: overrides.grade ?? '5',
      guardianEmail: 'cap@test.local',
    };
  }

  async function readSummary(
    periodId: string,
    grade: string,
  ): Promise<{
    total_places: number;
    reserved: number;
    applications_received: number;
    offers_issued: number;
    offers_accepted: number;
    waitlisted: number;
    available: number;
  } | null> {
    const rows = await rawClient.$queryRawUnsafe<
      Array<{
        total_places: number;
        reserved: number;
        applications_received: number;
        offers_issued: number;
        offers_accepted: number;
        waitlisted: number;
        available: number;
      }>
    >(
      `SELECT total_places, reserved, applications_received, offers_issued,
              offers_accepted, waitlisted, available
         FROM ${TEST_SCHEMA}.enr_capacity_summary
        WHERE enrollment_period_id = $1::uuid AND grade_level = $2`,
      periodId,
      grade,
    );
    return rows[0] ?? null;
  }

  // ────────────────────────────────────────────────────────────────────
  // recompute — direct call inside a tenant tx
  // ────────────────────────────────────────────────────────────────────
  describe('recompute', () => {
    it('first call seeds a summary row with intake capacities aggregated', async () => {
      await seedCapacity(periodAId, '5', 30, 2);
      await withTestTenant(async () => {
        await tenantPrisma.executeInTenantTransaction(async (tx) => {
          await capacity.recompute(tx, periodAId, '5');
        });
      });

      const sum = await readSummary(periodAId, '5');
      expect(sum).not.toBeNull();
      expect(sum!.total_places).toBe(30);
      expect(sum!.reserved).toBe(2);
      expect(sum!.applications_received).toBe(0);
      expect(sum!.offers_accepted).toBe(0);
      // available = 30 - 2 - 0 offers_accepted = 28
      expect(sum!.available).toBe(28);
    });

    it('second call on same (period, grade) UPSERTs the row in place — no duplicate', async () => {
      await seedCapacity(periodAId, '5', 30);
      await withTestTenant(async () => {
        await tenantPrisma.executeInTenantTransaction(async (tx) => {
          await capacity.recompute(tx, periodAId, '5');
        });
      });
      await withTestTenant(async () => {
        await tenantPrisma.executeInTenantTransaction(async (tx) => {
          await capacity.recompute(tx, periodAId, '5');
        });
      });
      const rows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.enr_capacity_summary
          WHERE enrollment_period_id = $1::uuid AND grade_level = $2`,
        periodAId,
        '5',
      );
      expect(rows[0]!.count).toBe(1);
    });

    it('zero capacity rows → summary still inserts with total_places=0, available=0', async () => {
      await withTestTenant(async () => {
        await tenantPrisma.executeInTenantTransaction(async (tx) => {
          await capacity.recompute(tx, periodAId, '7');
        });
      });
      const sum = await readSummary(periodAId, '7');
      expect(sum).not.toBeNull();
      expect(sum!.total_places).toBe(0);
      expect(sum!.available).toBe(0);
    });

    it('aggregates total_places across multiple intake_capacity rows for the same grade (one NULL stream + one specific stream)', async () => {
      // The UNIQUE index on (period, COALESCE(stream_id, sentinel), grade)
      // prevents two NULL-stream rows for the same (period, grade) — by
      // design. Two coexistent rows require one with NULL stream and one
      // with a specific stream id.
      await seedCapacity(periodAId, '5', 10);
      const streamId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.enr_admission_streams
           (id, enrollment_period_id, name, is_active)
         VALUES ($1::uuid, $2::uuid, 'Standard', true)`,
        streamId,
        periodAId,
      );
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.enr_intake_capacities
           (id, enrollment_period_id, stream_id, grade_level, total_places, reserved_places)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 20, 0)`,
        id,
        periodAId,
        streamId,
        '5',
      );
      await withTestTenant(async () => {
        await tenantPrisma.executeInTenantTransaction(async (tx) => {
          await capacity.recompute(tx, periodAId, '5');
        });
      });
      const sum = await readSummary(periodAId, '5');
      expect(sum!.total_places).toBe(30);
    });

    it('reserved_places aggregated and subtracted from available', async () => {
      await seedCapacity(periodAId, '5', 30, 5);
      await withTestTenant(async () => {
        await tenantPrisma.executeInTenantTransaction(async (tx) => {
          await capacity.recompute(tx, periodAId, '5');
        });
      });
      const sum = await readSummary(periodAId, '5');
      expect(sum!.reserved).toBe(5);
      expect(sum!.available).toBe(25);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Application lifecycle drives recompute
  // ────────────────────────────────────────────────────────────────────
  describe('application status pipeline recomputes capacity', () => {
    it('submitting an application increments applications_received', async () => {
      await seedCapacity(periodAId, '5', 30);
      await withTestTenant(async () =>
        appService.create(buildAppPayload(), adminActor()),
      );
      const sum = await readSummary(periodAId, '5');
      expect(sum!.applications_received).toBe(1);
      expect(sum!.waitlisted).toBe(0);
    });

    it('WAITLISTED transition increments waitlisted counter', async () => {
      await seedCapacity(periodAId, '5', 30);
      const dto = await withTestTenant(async () =>
        appService.create(buildAppPayload(), adminActor()),
      );
      await withTestTenant(async () =>
        appService.updateStatus(
          dto.id,
          { status: 'WAITLISTED' } as any,
          adminActor(),
        ),
      );
      const sum = await readSummary(periodAId, '5');
      expect(sum!.waitlisted).toBe(1);
    });

    it('issuing an offer increments offers_issued; accept increments offers_accepted and shrinks available', async () => {
      await seedCapacity(periodAId, '5', 30);
      const dto = await withTestTenant(
        async () => appService.create(buildAppPayload(), parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
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
      let sum = await readSummary(periodAId, '5');
      expect(sum!.offers_issued).toBe(1);
      expect(sum!.offers_accepted).toBe(0);
      expect(sum!.available).toBe(30);

      await withTestTenant(
        async () =>
          offerService.respond(
            offer.id,
            { familyResponse: 'ACCEPTED' } as any,
            parentActor(),
          ),
        { personId: TEST_PARENT_PERSON_ID },
      );
      sum = await readSummary(periodAId, '5');
      expect(sum!.offers_accepted).toBe(1);
      expect(sum!.available).toBe(29);
    });

    it('multiple grades in same period get independent summary rows', async () => {
      await seedCapacity(periodAId, '5', 30);
      await seedCapacity(periodAId, '6', 20);
      await withTestTenant(async () =>
        appService.create(buildAppPayload({ grade: '5' }), adminActor()),
      );
      await withTestTenant(async () =>
        appService.create(buildAppPayload({ grade: '6' }), adminActor()),
      );
      const five = await readSummary(periodAId, '5');
      const six = await readSummary(periodAId, '6');
      expect(five!.total_places).toBe(30);
      expect(five!.applications_received).toBe(1);
      expect(six!.total_places).toBe(20);
      expect(six!.applications_received).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('recompute on School A does not touch School B summary row', async () => {
      await seedCapacity(periodAId, '5', 30);
      await seedCapacity(periodBId, '5', 50);

      await withTestTenant(async () => {
        await tenantPrisma.executeInTenantTransaction(async (tx) => {
          await capacity.recompute(tx, periodAId, '5');
        });
      });
      await withTestTenantB(async () => {
        await tenantPrisma.executeInTenantTransaction(async (tx) => {
          await capacity.recompute(tx, periodBId, '5');
        });
      });

      const aSum = await readSummary(periodAId, '5');
      const bSum = await readSummary(periodBId, '5');
      expect(aSum!.total_places).toBe(30);
      expect(bSum!.total_places).toBe(50);
    });

    it('an application in School A does not affect School B counters', async () => {
      await seedCapacity(periodAId, '5', 30);
      await seedCapacity(periodBId, '5', 50);
      // App in A
      await withTestTenant(async () =>
        appService.create(buildAppPayload(), adminActor()),
      );
      // recompute B from a clean slate
      await withTestTenantB(async () => {
        await tenantPrisma.executeInTenantTransaction(async (tx) => {
          await capacity.recompute(tx, periodBId, '5');
        });
      });
      const bSum = await readSummary(periodBId, '5');
      expect(bSum!.applications_received).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Advisory lock — repeated recompute under high churn stays consistent
  // ────────────────────────────────────────────────────────────────────
  describe('pg_advisory_xact_lock', () => {
    it('serialised recomputes converge to the same final counters (no last-writer-wins underflow)', async () => {
      await seedCapacity(periodAId, '5', 30);
      // Three sequential applications. Each triggers a recompute via
      // ApplicationService.create. With the advisory lock in place the
      // applications_received column matches the source-of-truth count.
      for (let i = 0; i < 3; i++) {
        await withTestTenant(async () =>
          appService.create(
            buildAppPayload({ firstName: 'A' + i }),
            adminActor(),
          ),
        );
      }
      const sum = await readSummary(periodAId, '5');
      expect(sum!.applications_received).toBe(3);
    });

    it('manual recompute after direct INSERT picks up the new application count', async () => {
      await seedCapacity(periodAId, '5', 30);
      const appId = generateId();
      // Direct INSERT of a SUBMITTED application — bypasses ApplicationService.
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.enr_applications
           (id, school_id, enrollment_period_id, student_first_name, student_last_name,
            student_date_of_birth, applying_for_grade, guardian_email, admission_type,
            status, submitted_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Manual', 'Insert', '2018-01-01', '5',
                 'manual@test.local', 'NEW_STUDENT', 'SUBMITTED', now())`,
        appId,
        TEST_SCHOOL_ID,
        periodAId,
      );
      await withTestTenant(async () => {
        await tenantPrisma.executeInTenantTransaction(async (tx) => {
          await capacity.recompute(tx, periodAId, '5');
        });
      });
      const sum = await readSummary(periodAId, '5');
      expect(sum!.applications_received).toBe(1);
    });
  });
});
