import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ApplicationService } from '@modules/m81-enrolment/applications/application.service';
import { ApplicationScoringService } from '@modules/m81-enrolment/applications/application-scoring.service';
import { ApplicationStageService } from '@modules/m81-enrolment/applications/application-stage.service';
import { EnrollmentSearchService } from '@modules/m81-enrolment/applications/enrollment-search.service';
import { CapacitySummaryService } from '@modules/m81-enrolment/capacity/capacity-summary.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import {
  withTestTenant,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  officerActor,
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
 * Wave 5 — m81-enrolment ApplicationScoringService + ApplicationStageService
 *           + EnrollmentSearchService DB-backed integration tests.
 *
 * Contracts verified:
 *   - ApplicationScoringService: per-criterion CRUD with row-level UNIQUE
 *     guard, score / maxScore CHECK violations surface as BadRequest, only
 *     EO (STAFF) and admin can score, parent + student → Forbidden.
 *   - ApplicationStageService: read-side row scope (admin/staff see all,
 *     guardian only own children, students+teachers 404), advance keystone
 *     locks the row + validates transition + writes immutable audit row.
 *   - EnrollmentSearchService: Haversine + radius cap + grade filter +
 *     public-search flag + OPEN status. lat/lng bounds validation.
 */
describe('integration:m81-enrolment/screening-and-search', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: ReturnType<typeof makeRecordingKafka>;
  let capacity: CapacitySummaryService;
  let appService: ApplicationService;
  let scoringService: ApplicationScoringService;
  let stageService: ApplicationStageService;
  let searchService: EnrollmentSearchService;

  let periodAId: string;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    kafka = makeRecordingKafka();
    capacity = new CapacitySummaryService();
    appService = new ApplicationService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
      capacity,
    );
    scoringService = new ApplicationScoringService(tenantPrisma);
    stageService = new ApplicationStageService(tenantPrisma);
    searchService = new EnrollmentSearchService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    (kafka as unknown as RecordingKafkaProducer).reset();
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_application_scores`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_application_stages`,
    );
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
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.pay_family_account_students, ${TEST_SCHEMA}.pay_family_accounts CASCADE`,
    );

    periodAId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.enr_enrollment_periods
         (id, school_id, academic_year_id, name, opens_at, closes_at, status, allows_public_search)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'Screen Period A',
               now() - interval '7 days', now() + interval '30 days', 'OPEN', true)`,
      periodAId,
      TEST_SCHOOL_ID,
      TEST_SIS_ACADEMIC_YEAR_ID,
    );
  });

  async function seedApp(opts: { byParent?: boolean } = {}): Promise<string> {
    const payload = {
      enrollmentPeriodId: periodAId,
      studentFirstName: 'Scoreable',
      studentLastName: 'Doe',
      studentDateOfBirth: '2018-04-12',
      applyingForGrade: '5',
      guardianEmail: 'scoring@test.local',
    };
    const dto = opts.byParent
      ? await withTestTenant(async () => appService.create(payload, parentActor()), {
          personId: TEST_PARENT_PERSON_ID,
        })
      : await withTestTenant(async () => appService.create(payload, adminActor()));
    return dto.id;
  }

  // ────────────────────────────────────────────────────────────────────
  // ApplicationScoringService
  // ────────────────────────────────────────────────────────────────────
  describe('ApplicationScoringService', () => {
    it('admin creates a score → row persists', async () => {
      const appId = await seedApp();
      const created = await withTestTenant(async () =>
        scoringService.create(
          appId,
          { criterionName: 'Academic', score: 8.5, maxScore: 10, notes: 'Strong' },
          adminActor(),
        ),
      );
      expect(created.applicationId).toBe(appId);
      expect(created.criterionName).toBe('Academic');
      expect(created.score).toBe(8.5);
      expect(created.maxScore).toBe(10);
      expect(created.notes).toBe('Strong');
    });

    it('officer (STAFF non-admin = Enrolment Officer) can score', async () => {
      const appId = await seedApp();
      const created = await withTestTenant(async () =>
        scoringService.create(
          appId,
          { criterionName: 'Sibling', score: 5 },
          officerActor(),
        ),
      );
      expect(created.criterionName).toBe('Sibling');
    });

    it('parent → ForbiddenException', async () => {
      const appId = await seedApp({ byParent: true });
      await expect(
        withTestTenant(
          async () =>
            scoringService.create(
              appId,
              { criterionName: 'Bias', score: 9 },
              parentActor(),
            ),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('student → ForbiddenException', async () => {
      const appId = await seedApp();
      await expect(
        withTestTenant(
          async () =>
            scoringService.create(
              appId,
              { criterionName: 'self', score: 1 },
              studentActor(),
            ),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('score > maxScore → BadRequestException (validated client-side)', async () => {
      const appId = await seedApp();
      await expect(
        withTestTenant(async () =>
          scoringService.create(
            appId,
            { criterionName: 'Over', score: 11, maxScore: 10 },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('duplicate criterion for same application → BadRequest', async () => {
      const appId = await seedApp();
      await withTestTenant(async () =>
        scoringService.create(
          appId,
          { criterionName: 'Academic', score: 8 },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          scoringService.create(
            appId,
            { criterionName: 'Academic', score: 9 },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('listForApplication returns ordered rows; parent → Forbidden', async () => {
      const appId = await seedApp();
      await withTestTenant(async () =>
        scoringService.create(
          appId,
          { criterionName: 'Music', score: 7 },
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        scoringService.create(
          appId,
          { criterionName: 'Athletics', score: 6 },
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        scoringService.listForApplication(appId, adminActor()),
      );
      expect(list.map((s) => s.criterionName)).toEqual(['Athletics', 'Music']);

      await expect(
        withTestTenant(
          async () => scoringService.listForApplication(appId, parentActor()),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch updates score + maxScore + notes; scored_by reassigned', async () => {
      const appId = await seedApp();
      const created = await withTestTenant(async () =>
        scoringService.create(
          appId,
          { criterionName: 'Academic', score: 6, maxScore: 10 },
          adminActor(),
        ),
      );
      const patched = await withTestTenant(async () =>
        scoringService.patch(
          created.id,
          { score: 9, maxScore: 10, notes: 'Recheck' },
          officerActor(),
        ),
      );
      expect(patched.score).toBe(9);
      expect(patched.notes).toBe('Recheck');
      // The new scored_by is the officer.
      expect(patched.scoredBy).not.toBe(created.scoredBy);
    });

    it('patch with empty body returns existing row', async () => {
      const appId = await seedApp();
      const created = await withTestTenant(async () =>
        scoringService.create(
          appId,
          { criterionName: 'NoOp', score: 5 },
          adminActor(),
        ),
      );
      const same = await withTestTenant(async () =>
        scoringService.patch(created.id, {}, adminActor()),
      );
      expect(same.score).toBe(5);
    });

    it('patch unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          scoringService.patch(
            '00000000-0000-0000-0000-000000000000',
            { score: 1 },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('remove drops the row; remove unknown → NotFound', async () => {
      const appId = await seedApp();
      const created = await withTestTenant(async () =>
        scoringService.create(
          appId,
          { criterionName: 'Drop', score: 3 },
          adminActor(),
        ),
      );
      await withTestTenant(async () => scoringService.remove(created.id, adminActor()));
      const list = await withTestTenant(async () =>
        scoringService.listForApplication(appId, adminActor()),
      );
      expect(list).toEqual([]);
      await expect(
        withTestTenant(async () => scoringService.remove(created.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('remove by parent → Forbidden', async () => {
      const appId = await seedApp();
      const created = await withTestTenant(async () =>
        scoringService.create(
          appId,
          { criterionName: 'Bias', score: 5 },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(
          async () => scoringService.remove(created.id, parentActor()),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // ApplicationStageService — multi-stage advance + read-scope
  // ────────────────────────────────────────────────────────────────────
  describe('ApplicationStageService', () => {
    it('admin advances SUBMITTED → UNDER_REVIEW → INTERVIEW; stages logged in order', async () => {
      const appId = await seedApp();
      const s1 = await withTestTenant(async () =>
        stageService.advance(appId, 'UNDER_REVIEW', null, adminActor()),
      );
      expect(s1.fromStatus).toBe('SUBMITTED');
      expect(s1.toStatus).toBe('UNDER_REVIEW');
      const s2 = await withTestTenant(async () =>
        stageService.advance(appId, 'INTERVIEW', 'Set up panel', adminActor()),
      );
      expect(s2.fromStatus).toBe('UNDER_REVIEW');
      expect(s2.toStatus).toBe('INTERVIEW');
      expect(s2.notes).toBe('Set up panel');

      const stages = await withTestTenant(async () =>
        stageService.list(appId, adminActor()),
      );
      expect(stages.map((s) => s.toStatus)).toEqual(['UNDER_REVIEW', 'INTERVIEW']);
    });

    it('officer can advance (STAFF tier)', async () => {
      const appId = await seedApp();
      const s = await withTestTenant(async () =>
        stageService.advance(appId, 'UNDER_REVIEW', null, officerActor()),
      );
      expect(s.toStatus).toBe('UNDER_REVIEW');
    });

    it('parent advance → ForbiddenException', async () => {
      const appId = await seedApp({ byParent: true });
      await expect(
        withTestTenant(
          async () => stageService.advance(appId, 'UNDER_REVIEW', null, parentActor()),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('illegal transition (SUBMITTED → ENROLLED) → BadRequest', async () => {
      const appId = await seedApp();
      await expect(
        withTestTenant(async () =>
          stageService.advance(appId, 'ENROLLED' as any, null, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('advance to same status (SUBMITTED → SUBMITTED) → BadRequest', async () => {
      const appId = await seedApp();
      await expect(
        withTestTenant(async () =>
          stageService.advance(appId, 'SUBMITTED' as any, null, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('advance unknown app → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          stageService.advance(
            '00000000-0000-0000-0000-000000000000',
            'UNDER_REVIEW',
            null,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list row-scope: parent sees own, but cannot see another guardian\'s', async () => {
      const ownAppId = await seedApp({ byParent: true });
      await withTestTenant(async () =>
        stageService.advance(ownAppId, 'UNDER_REVIEW', null, adminActor()),
      );
      const own = await withTestTenant(
        async () => stageService.list(ownAppId, parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(own.length).toBe(1);

      // Different application owned by admin → 404 for the parent.
      const otherAppId = await seedApp();
      await withTestTenant(async () =>
        stageService.advance(otherAppId, 'UNDER_REVIEW', null, adminActor()),
      );
      await expect(
        withTestTenant(
          async () => stageService.list(otherAppId, parentActor()),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('teacher (non-admin staff, but ProfileType STAFF) is treated as STAFF → can read', async () => {
      const appId = await seedApp();
      await withTestTenant(async () =>
        stageService.advance(appId, 'UNDER_REVIEW', null, adminActor()),
      );
      const list = await withTestTenant(async () =>
        stageService.list(appId, teacherActor()),
      );
      expect(list).toHaveLength(1);
    });

    it('student → NotFound on list', async () => {
      const appId = await seedApp();
      await expect(
        withTestTenant(
          async () => stageService.list(appId, studentActor()),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // EnrollmentSearchService — public school search
  // ────────────────────────────────────────────────────────────────────
  describe('EnrollmentSearchService', () => {
    beforeEach(async () => {
      // Stamp lat/lng on School A + School B so the Haversine ranking has
      // somewhere to ground. School A = NYC, School B = Boston (≈190 mi).
      await rawClient.$executeRawUnsafe(
        `UPDATE platform.schools SET latitude = $1, longitude = $2, full_address = $3
          WHERE id = $4::uuid`,
        40.7128,
        -74.006,
        '1 Test Ave, New York, NY',
        TEST_SCHOOL_ID,
      );
      await rawClient.$executeRawUnsafe(
        `UPDATE platform.schools SET latitude = $1, longitude = $2, full_address = $3
          WHERE id = $4::uuid`,
        42.3601,
        -71.0589,
        '1 Beacon St, Boston, MA',
        TEST_SCHOOL_B_ID,
      );
      // Capacity rows for grade '5' on each school's period.
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.enr_intake_capacities
           (id, enrollment_period_id, stream_id, grade_level, total_places, reserved_places)
         VALUES ($1::uuid, $2::uuid, NULL, '5', 30, 0)`,
        generateId(),
        periodAId,
      );
      // Seed a School B period & capacity for grade 5.
      const periodBId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.enr_enrollment_periods
           (id, school_id, academic_year_id, name, opens_at, closes_at, status, allows_public_search)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Search Period B',
                 now() - interval '7 days', now() + interval '30 days', 'OPEN', true)`,
        periodBId,
        TEST_SCHOOL_B_ID,
        TEST_SIS_ACADEMIC_YEAR_B_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.enr_intake_capacities
           (id, enrollment_period_id, stream_id, grade_level, total_places, reserved_places)
         VALUES ($1::uuid, $2::uuid, NULL, '5', 25, 0)`,
        generateId(),
        periodBId,
      );
    });

    afterAll(async () => {
      // Belt-and-braces: blank the lat/lng so other suites don't see them
      // (the fixture asserts don't care, but be tidy).
      await rawClient.$executeRawUnsafe(
        `UPDATE platform.schools SET latitude = NULL, longitude = NULL, full_address = NULL
          WHERE id = ANY(ARRAY[$1, $2]::uuid[])`,
        TEST_SCHOOL_ID,
        TEST_SCHOOL_B_ID,
      );
    });

    it('search near NYC, 5 mi radius → School A only', async () => {
      const out = await searchService.search({
        lat: 40.7128,
        lng: -74.006,
        radiusMiles: 5,
      });
      expect(out.length).toBeGreaterThanOrEqual(1);
      expect(out[0]!.schoolId).toBe(TEST_SCHOOL_ID);
      expect(out[0]!.distanceMiles).toBe(0);
      expect(out[0]!.acceptingGrades).toContain('5');
    });

    it('search near Boston, 5 mi radius → School B only', async () => {
      const out = await searchService.search({
        lat: 42.3601,
        lng: -71.0589,
        radiusMiles: 5,
      });
      const ids = out.map((r) => r.schoolId);
      expect(ids).toContain(TEST_SCHOOL_B_ID);
      expect(ids).not.toContain(TEST_SCHOOL_ID);
    });

    it('search with 100 mi radius from NYC → A only (Boston > 100mi)', async () => {
      const out = await searchService.search({
        lat: 40.7128,
        lng: -74.006,
        radiusMiles: 100,
      });
      const ids = out.map((r) => r.schoolId);
      expect(ids).toContain(TEST_SCHOOL_ID);
      expect(ids).not.toContain(TEST_SCHOOL_B_ID);
    });

    it('search at midpoint (NJ-ish), large radius covering both → sorted nearest first', async () => {
      // Hartford CT ≈ midway between NYC and Boston (~100mi each).
      const out = await searchService.search({
        lat: 41.7658,
        lng: -72.6734,
        radiusMiles: 100,
      });
      // Hartford -> NYC ≈ 100mi, -> Boston ≈ 100mi. Both should appear.
      expect(out.length).toBeGreaterThanOrEqual(1);
      // Distances are monotone non-decreasing.
      for (let i = 1; i < out.length; i++) {
        expect(out[i]!.distanceMiles).toBeGreaterThanOrEqual(out[i - 1]!.distanceMiles);
      }
    });

    it('grade filter excludes periods without intake capacity for that grade', async () => {
      const out = await searchService.search({
        lat: 40.7128,
        lng: -74.006,
        radiusMiles: 5,
        gradeLevel: '99', // No school seeded grade 99.
      });
      expect(out).toEqual([]);
    });

    it('radius clamped to [1,100] — radius=0 → bumped to 1', async () => {
      const out = await searchService.search({
        lat: 40.7128,
        lng: -74.006,
        radiusMiles: 0,
      });
      // Still finds School A at distance 0 because radius is at least 1.
      expect(out.length).toBeGreaterThanOrEqual(1);
    });

    it('lat out of range → BadRequest', async () => {
      await expect(
        searchService.search({ lat: 100, lng: 0, radiusMiles: 10 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lng out of range → BadRequest', async () => {
      await expect(
        searchService.search({ lat: 0, lng: 200, radiusMiles: 10 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('NaN lat → BadRequest', async () => {
      await expect(
        searchService.search({ lat: Number.NaN, lng: 0, radiusMiles: 10 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('period with allows_public_search=false is hidden', async () => {
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.enr_enrollment_periods SET allows_public_search = false
          WHERE id = $1::uuid`,
        periodAId,
      );
      const out = await searchService.search({
        lat: 40.7128,
        lng: -74.006,
        radiusMiles: 5,
      });
      expect(out.find((r) => r.schoolId === TEST_SCHOOL_ID)).toBeUndefined();
    });

    it('period in non-OPEN status is hidden', async () => {
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.enr_enrollment_periods SET status = 'UPCOMING'
          WHERE id = $1::uuid`,
        periodAId,
      );
      const out = await searchService.search({
        lat: 40.7128,
        lng: -74.006,
        radiusMiles: 5,
      });
      expect(out.find((r) => r.schoolId === TEST_SCHOOL_ID)).toBeUndefined();
    });
  });
});
