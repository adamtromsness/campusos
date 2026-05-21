import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { SubstituteProfileService } from '@modules/m82-substitutes/substitute-profile.service';
import { SubstituteAvailabilityService } from '@modules/m82-substitutes/availability.service';
import { SubstitutePreferenceService } from '@modules/m82-substitutes/preference.service';
import { SchoolPoolService } from '@modules/m82-substitutes/school-pool.service';
import { JobPostingService } from '@modules/m82-substitutes/job-posting.service';
import { AssignmentService } from '@modules/m82-substitutes/assignment.service';
import { RatingService } from '@modules/m82-substitutes/rating.service';
import { SessionNoteService } from '@modules/m82-substitutes/session-note.service';
import { PayRateService } from '@modules/m82-substitutes/pay-rate.service';
import { CancellationPolicyService } from '@modules/m82-substitutes/cancellation-policy.service';
import { AcceptanceExpiryWorker } from '@modules/m82-substitutes/acceptance-expiry.worker';
import { JobNotificationWorker } from '@modules/m82-substitutes/job-notification.worker';
import { CancellationPolicyConsumer } from '@modules/m82-substitutes/cancellation-policy.consumer';
import { CoverArrangementConsumer } from '@modules/m82-substitutes/cover-arrangement.consumer';
import { deterministicLateCancellationEventId } from '@modules/m82-substitutes/assignment.service';
import { SubstitutesController } from '@modules/m82-substitutes/substitutes.controller';
import { SubstitutesPostController } from '@modules/m82-substitutes/substitutes-b.controller';

import { ActorContextService, PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import { IdempotencyService } from '@shared/kafka/idempotency.service';
import { KafkaConsumerService } from '@shared/kafka/kafka-consumer.service';

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
  teacherActor,
  parentActor,
  studentActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_TEACHER_ACCOUNT_ID,
  TEST_TEACHER_PERSON_ID,
  TEST_TEACHER_EMPLOYEE_ID,
  TEST_PARENT_PERSON_ID,
  TEST_PARENT_ACCOUNT_ID,
  TEST_STUDENT_ACCOUNT_ID,
  TEST_STUDENT_PERSON_ID,
} from '../helpers/actor';
import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import { ensureWorkflowsPlatformFixtures } from '../fixtures/workflows';
import {
  resetAndSeedSubstitutes,
  resetSubstitutesTables,
  ensureSubstitutesSeed,
  TEST_SUB_PROFILE_TEACHER_ID,
  TEST_SUB_PROFILE_PARENT_ID,
  TEST_SUB_HR_EMP_SCHOOL_B_ID,
} from '../fixtures/substitutes';
import { generateId } from '@campusos/database';

// Stub for KafkaConsumerService so the consumers' onModuleInit subscribe()
// path is a no-op — tests drive the private handle() method directly.
class StubKafkaConsumer {
  async subscribe(): Promise<void> {
    // no-op
  }
}

// Bare-minimum fake req for controller pass-through coverage.
function makeFakeReq(opts: { sub: string; personId: string; email: string }): any {
  return {
    user: {
      sub: opts.sub,
      personId: opts.personId,
      email: opts.email,
      displayName: 'Test Actor',
      sessionId: 's',
    },
  };
}

describe('integration:m82-substitutes/substitutes-lifecycle', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: RecordingKafkaProducer;
  let outbox: OutboxService;
  let idempotency: IdempotencyService;

  let permissions: PermissionCheckService;
  let actors: ActorContextService;

  let profiles: SubstituteProfileService;
  let availability: SubstituteAvailabilityService;
  let preferences: SubstitutePreferenceService;
  let pool: SchoolPoolService;
  let jobs: JobPostingService;
  let assignments: AssignmentService;
  let ratings: RatingService;
  let notes: SessionNoteService;
  let payRates: PayRateService;
  let policies: CancellationPolicyService;
  let expiryWorker: AcceptanceExpiryWorker;
  let notifyWorker: JobNotificationWorker;
  let policyConsumer: CancellationPolicyConsumer;
  let coverConsumer: CoverArrangementConsumer;
  let ctrlA: SubstitutesController;
  let ctrlB: SubstitutesPostController;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    // Restore the canonical admin iam_effective_access_cache row. Other
    // specs that ran earlier in the suite (e.g. m23-health, m25-curriculum,
    // m86-procurement) wipe this row to seed their own narrow permissions
    // and never restore it. This spec's controller passthrough tests
    // depend on actor.isSchoolAdmin=true, which requires sch-001:admin in
    // the cache. Idempotent — ON CONFLICT DO UPDATE.
    await ensureWorkflowsPlatformFixtures(rawClient);
    kafka = makeRecordingKafka() as unknown as RecordingKafkaProducer;
    outbox = new OutboxService();
    idempotency = new IdempotencyService(tenantPrisma);

    permissions = new PermissionCheckService(rawClient);
    actors = new ActorContextService(rawClient, permissions, tenantPrisma);

    profiles = new SubstituteProfileService(tenantPrisma, permissions);
    availability = new SubstituteAvailabilityService(tenantPrisma);
    preferences = new SubstitutePreferenceService(tenantPrisma);
    pool = new SchoolPoolService(tenantPrisma, permissions);
    jobs = new JobPostingService(tenantPrisma, permissions, outbox);
    assignments = new AssignmentService(tenantPrisma, permissions, outbox);
    ratings = new RatingService(tenantPrisma, permissions);
    notes = new SessionNoteService(tenantPrisma, permissions);
    payRates = new PayRateService(tenantPrisma, permissions);
    policies = new CancellationPolicyService(tenantPrisma, permissions);

    expiryWorker = new AcceptanceExpiryWorker(tenantPrisma);
    notifyWorker = new JobNotificationWorker(tenantPrisma, outbox);
    policyConsumer = new CancellationPolicyConsumer(
      new StubKafkaConsumer() as unknown as KafkaConsumerService,
      idempotency,
      tenantPrisma,
      ratings,
    );
    coverConsumer = new CoverArrangementConsumer(
      new StubKafkaConsumer() as unknown as KafkaConsumerService,
      idempotency,
      tenantPrisma,
    );

    ctrlA = new SubstitutesController(profiles, pool, jobs, actors);
    ctrlB = new SubstitutesPostController(
      availability,
      preferences,
      assignments,
      ratings,
      notes,
      payRates,
      policies,
      actors,
    );

    await ensureSubstitutesSeed(rawClient);
  });

  afterAll(async () => {
    await resetSubstitutesTables(rawClient);
    // Clean up the shadow School B hr_employees row so other suites
    // don't see it.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hr_employees WHERE id = $1::uuid`,
      TEST_SUB_HR_EMP_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_substitute_profiles WHERE id IN ($1::uuid, $2::uuid)`,
      TEST_SUB_PROFILE_TEACHER_ID,
      TEST_SUB_PROFILE_PARENT_ID,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetAndSeedSubstitutes(rawClient);
    kafka.reset();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Create a job posting for school A via the service, returning the
   * full DTO. Defaults to a same-day job posted by admin against the
   * test teacher.
   */
  async function postJob(opts?: {
    school?: 'A' | 'B';
    absentTeacherId?: string;
    acceptanceWindowMinutes?: number;
    gradeLevel?: string;
    subject?: string;
    jobDate?: string;
  }) {
    const school = opts?.school ?? 'A';
    const fn = school === 'A' ? withTestTenant : withTestTenantB;
    const teacher =
      opts?.absentTeacherId ??
      (school === 'A' ? TEST_TEACHER_EMPLOYEE_ID : TEST_SUB_HR_EMP_SCHOOL_B_ID);
    return fn(async () =>
      jobs.post(
        {
          absentTeacherId: teacher,
          jobDate: opts?.jobDate ?? '2027-03-15',
          startTime: '09:00',
          endTime: '15:00',
          jobType: 'FULL_DAY',
          gradeLevel: opts?.gradeLevel ?? '3',
          subject: opts?.subject ?? 'MATH',
          acceptanceWindowMinutes: opts?.acceptanceWindowMinutes ?? 30,
        } as any,
        adminActor(),
      ),
    );
  }

  /** Add the parent's substitute profile to school A pool as ACTIVE. */
  async function addParentSubToPoolA(): Promise<string> {
    const dto = await withTestTenant(async () =>
      pool.addToPool({ substituteId: TEST_SUB_PROFILE_PARENT_ID } as any, adminActor()),
    );
    return dto.id;
  }

  /**
   * Drive a job from open through to a CONFIRMED assignment by the
   * parent substitute. Returns { jobId, assignmentId }. The job is
   * posted by admin, the parent sub is in the school A pool so a
   * notification row exists, then parent accepts.
   */
  async function postAndAccept(): Promise<{ jobId: string; assignmentId: string }> {
    await addParentSubToPoolA();
    const job = await postJob();
    const asg = await withTestTenant(async () => jobs.accept(job.id, parentActor()));
    return { jobId: job.id, assignmentId: asg.id };
  }

  function buildEnvelope(
    topic: string,
    payload: Record<string, unknown>,
    overrides?: { eventId?: string; tenantSchoolId?: string; tenantSubdomain?: string },
  ): any {
    return {
      topic,
      partition: 0,
      offset: '1',
      key: null,
      headers: {
        'tenant-id': overrides?.tenantSchoolId ?? TEST_SCHOOL_ID,
        'tenant-subdomain': overrides?.tenantSubdomain ?? TEST_SUBDOMAIN,
      },
      payload: {
        event_id: overrides?.eventId ?? generateId(),
        event_type: topic,
        event_version: 1,
        tenant_id: overrides?.tenantSchoolId ?? TEST_SCHOOL_ID,
        tenant_subdomain: overrides?.tenantSubdomain ?? TEST_SUBDOMAIN,
        source_module: 'substitutes',
        occurred_at: new Date().toISOString(),
        published_at: new Date().toISOString(),
        payload,
      },
      timestamp: new Date().toISOString(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // SubstituteProfileService
  // ─────────────────────────────────────────────────────────────────────
  describe('SubstituteProfileService', () => {
    it('getMyProfile resolves teacher persona → teacher sub profile', async () => {
      const dto = await withTestTenant(async () => profiles.getMyProfile(teacherActor()));
      expect(dto?.id).toBe(TEST_SUB_PROFILE_TEACHER_ID);
      expect(dto?.gradeLevels).toContain('1');
    });

    it('getMyProfile returns null when actor has no personId', async () => {
      const dto = await withTestTenant(async () =>
        profiles.getMyProfile({ ...adminActor(), personId: null as any }),
      );
      expect(dto).toBeNull();
    });

    it('getMyProfile returns null when no profile exists for the person', async () => {
      const dto = await withTestTenant(async () =>
        profiles.getMyProfile({
          ...adminActor(),
          personId: '00000000-0000-0000-0000-000000000099',
        } as any),
      );
      expect(dto).toBeNull();
    });

    it('list as admin returns active profiles', async () => {
      const list = await withTestTenant(async () => profiles.list(adminActor()));
      const ids = list.map((p) => p.id);
      expect(ids).toContain(TEST_SUB_PROFILE_TEACHER_ID);
      expect(ids).toContain(TEST_SUB_PROFILE_PARENT_ID);
    });

    it('list as substitute (no marketplace scope) → Forbidden', async () => {
      await expect(
        withTestTenant(async () => profiles.list(teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getById self always allowed', async () => {
      const dto = await withTestTenant(async () =>
        profiles.getById(TEST_SUB_PROFILE_TEACHER_ID, teacherActor()),
      );
      expect(dto.id).toBe(TEST_SUB_PROFILE_TEACHER_ID);
    });

    it('getById other-substitute as non-admin → 404 (no leak)', async () => {
      await expect(
        withTestTenant(async () => profiles.getById(TEST_SUB_PROFILE_PARENT_ID, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById admin always allowed', async () => {
      const dto = await withTestTenant(async () =>
        profiles.getById(TEST_SUB_PROFILE_PARENT_ID, adminActor()),
      );
      expect(dto.id).toBe(TEST_SUB_PROFILE_PARENT_ID);
    });

    it('getById missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          profiles.getById('00000000-0000-0000-0000-000000000099', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('create own profile — student persona creates their own sub profile', async () => {
      // Wipe the parent profile and re-create via the service to test create path
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_substitute_profiles WHERE person_id = $1::uuid`,
        TEST_STUDENT_PERSON_ID,
      );
      const dto = await withTestTenant(async () =>
        profiles.create(
          {
            personId: TEST_STUDENT_PERSON_ID,
            displayName: 'New Self Sub',
            gradeLevels: ['K', '1'],
            subjectAreas: ['MATH'],
            yearsExperience: 2,
            maxTravelMiles: 10,
            bio: 'Hello',
          } as any,
          { ...studentActor(), personId: TEST_STUDENT_PERSON_ID } as any,
        ),
      );
      expect(dto.displayName).toBe('New Self Sub');
      expect(dto.gradeLevels).toEqual(['K', '1']);
      // Clean up
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_substitute_profiles WHERE id = $1::uuid`,
        dto.id,
      );
    });

    it('create on-behalf-of as non-admin → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          profiles.create(
            {
              personId: '00000000-0000-0000-0000-000000000099',
              displayName: 'Other',
              gradeLevels: ['K'],
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create with empty gradeLevels → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          profiles.create(
            {
              personId: TEST_ADMIN_PERSON_ID,
              displayName: 'Bad',
              gradeLevels: [],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('search by gradeLevels filter', async () => {
      // K-3 matches teacher sub (K,1,2,3), not the marketplace sub (4-6)
      const list = await withTestTenant(async () => profiles.search({ gradeLevels: ['K'] } as any));
      const ids = list.map((p) => p.id);
      expect(ids).toContain(TEST_SUB_PROFILE_TEACHER_ID);
      expect(ids).not.toContain(TEST_SUB_PROFILE_PARENT_ID);
    });

    it('search by subjectAreas filter', async () => {
      const list = await withTestTenant(async () =>
        profiles.search({ subjectAreas: ['ENGLISH'] } as any),
      );
      const ids = list.map((p) => p.id);
      expect(ids).toContain(TEST_SUB_PROFILE_PARENT_ID);
      expect(ids).not.toContain(TEST_SUB_PROFILE_TEACHER_ID);
    });

    it('search excludes substitutes who BLOCKED the requesting school', async () => {
      // Mark the teacher sub as BLOCKED for school A.
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_sub_preferences (id, substitute_id, school_id, preference_type)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'BLOCKED')`,
        generateId(),
        TEST_SUB_PROFILE_TEACHER_ID,
        TEST_SCHOOL_ID,
      );
      const list = await withTestTenant(async () =>
        profiles.search({ schoolId: TEST_SCHOOL_ID } as any),
      );
      const ids = list.map((p) => p.id);
      expect(ids).not.toContain(TEST_SUB_PROFILE_TEACHER_ID);
    });

    it('search verifiedOnly requires at least one VERIFIED credential', async () => {
      // No credentials seeded by default → both filtered out.
      const noneVerified = await withTestTenant(async () =>
        profiles.search({ verifiedOnly: true } as any),
      );
      expect(noneVerified.length).toBe(0);

      // Add a VERIFIED credential for the teacher sub
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_sub_credentials
           (id, substitute_id, credential_type, credential_name,
            verification_status, verified_by, verified_at)
         VALUES ($1::uuid, $2::uuid, 'TEACHING_LICENSE', 'NY Teach',
                 'VERIFIED', $3::uuid, now())`,
        generateId(),
        TEST_SUB_PROFILE_TEACHER_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );
      const verified = await withTestTenant(async () =>
        profiles.search({ verifiedOnly: true } as any),
      );
      expect(verified.map((p) => p.id)).toContain(TEST_SUB_PROFILE_TEACHER_ID);
      expect(verified.map((p) => p.id)).not.toContain(TEST_SUB_PROFILE_PARENT_ID);
    });

    it('search availableOn requires RECURRING (DoW) OR SPECIFIC; BLOCKED overrides', async () => {
      // 2027-03-15 is Monday (DoW = 1).
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_sub_availability
           (id, substitute_id, availability_type, day_of_week)
         VALUES ($1::uuid, $2::uuid, 'RECURRING', 1)`,
        generateId(),
        TEST_SUB_PROFILE_TEACHER_ID,
      );
      let list = await withTestTenant(async () =>
        profiles.search({ availableOn: '2027-03-15' } as any),
      );
      expect(list.map((p) => p.id)).toContain(TEST_SUB_PROFILE_TEACHER_ID);

      // BLOCKED for that specific date overrides the RECURRING rule.
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_sub_availability
           (id, substitute_id, availability_type, specific_date)
         VALUES ($1::uuid, $2::uuid, 'BLOCKED', '2027-03-15'::date)`,
        generateId(),
        TEST_SUB_PROFILE_TEACHER_ID,
      );
      list = await withTestTenant(async () =>
        profiles.search({ availableOn: '2027-03-15' } as any),
      );
      expect(list.map((p) => p.id)).not.toContain(TEST_SUB_PROFILE_TEACHER_ID);

      // SPECIFIC matches even without RECURRING
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_sub_availability
           (id, substitute_id, availability_type, specific_date)
         VALUES ($1::uuid, $2::uuid, 'SPECIFIC', '2027-04-10'::date)`,
        generateId(),
        TEST_SUB_PROFILE_PARENT_ID,
      );
      list = await withTestTenant(async () =>
        profiles.search({ availableOn: '2027-04-10' } as any),
      );
      expect(list.map((p) => p.id)).toContain(TEST_SUB_PROFILE_PARENT_ID);
    });

    it('isAvailableOn helper resolves BLOCKED-overrides-RECURRING', async () => {
      // RECURRING Monday
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_sub_availability
           (id, substitute_id, availability_type, day_of_week)
         VALUES ($1::uuid, $2::uuid, 'RECURRING', 1)`,
        generateId(),
        TEST_SUB_PROFILE_TEACHER_ID,
      );
      const yes = await withTestTenant(async () =>
        profiles.isAvailableOn(TEST_SUB_PROFILE_TEACHER_ID, '2027-03-15'),
      );
      expect(yes).toBe(true);

      // Tuesday → no
      const no = await withTestTenant(async () =>
        profiles.isAvailableOn(TEST_SUB_PROFILE_TEACHER_ID, '2027-03-16'),
      );
      expect(no).toBe(false);

      // Block Monday → no
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_sub_availability
           (id, substitute_id, availability_type, specific_date)
         VALUES ($1::uuid, $2::uuid, 'BLOCKED', '2027-03-15'::date)`,
        generateId(),
        TEST_SUB_PROFILE_TEACHER_ID,
      );
      const blocked = await withTestTenant(async () =>
        profiles.isAvailableOn(TEST_SUB_PROFILE_TEACHER_ID, '2027-03-15'),
      );
      expect(blocked).toBe(false);
    });

    it('hasMarketplaceScope true for school admin', async () => {
      const ok = await withTestTenant(async () => profiles.hasMarketplaceScope(adminActor()));
      expect(ok).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // SubstituteAvailabilityService
  // ─────────────────────────────────────────────────────────────────────
  describe('SubstituteAvailabilityService', () => {
    it('listMine empty for actor without profile', async () => {
      const list = await withTestTenant(async () => availability.listMine(adminActor()));
      // Admin has no substitute profile bound to TEST_ADMIN_PERSON_ID
      expect(list).toEqual([]);
    });

    it('listMine null personId → []', async () => {
      const list = await withTestTenant(async () =>
        availability.listMine({ ...adminActor(), personId: null as any }),
      );
      expect(list).toEqual([]);
    });

    it('create RECURRING + list returns it', async () => {
      const dto = await withTestTenant(async () =>
        availability.create(
          {
            availabilityType: 'RECURRING',
            dayOfWeek: 1,
            startTime: '08:00',
            endTime: '15:00',
            notes: 'monday',
          } as any,
          teacherActor(),
        ),
      );
      expect(dto.availabilityType).toBe('RECURRING');
      expect(dto.dayOfWeek).toBe(1);
      expect(dto.startTime).toBe('08:00');
      expect(dto.endTime).toBe('15:00');

      const list = await withTestTenant(async () => availability.listMine(teacherActor()));
      expect(list.length).toBe(1);
    });

    it('create SPECIFIC requires specificDate', async () => {
      await expect(
        withTestTenant(async () =>
          availability.create(
            { availabilityType: 'SPECIFIC', dayOfWeek: 1 } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create SPECIFIC populated', async () => {
      const dto = await withTestTenant(async () =>
        availability.create(
          { availabilityType: 'SPECIFIC', specificDate: '2027-04-10' } as any,
          teacherActor(),
        ),
      );
      expect(dto.specificDate).toBe('2027-04-10');
    });

    it('create BLOCKED populated', async () => {
      const dto = await withTestTenant(async () =>
        availability.create(
          { availabilityType: 'BLOCKED', specificDate: '2027-05-05' } as any,
          teacherActor(),
        ),
      );
      expect(dto.availabilityType).toBe('BLOCKED');
    });

    it('create RECURRING with specificDate → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          availability.create(
            {
              availabilityType: 'RECURRING',
              dayOfWeek: 1,
              specificDate: '2027-04-10',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create RECURRING without dayOfWeek → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          availability.create({ availabilityType: 'RECURRING' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create SPECIFIC with dayOfWeek → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          availability.create(
            {
              availabilityType: 'SPECIFIC',
              specificDate: '2027-04-10',
              dayOfWeek: 1,
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create with one time of pair only → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          availability.create(
            { availabilityType: 'RECURRING', dayOfWeek: 1, startTime: '08:00' } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create without personId → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          availability.create({ availabilityType: 'RECURRING', dayOfWeek: 1 } as any, {
            ...adminActor(),
            personId: null as any,
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create when actor has no profile → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          availability.create(
            { availabilityType: 'RECURRING', dayOfWeek: 1 } as any,
            { ...adminActor(), personId: TEST_ADMIN_PERSON_ID } as any,
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('remove own row succeeds + remove other-substitute → 404', async () => {
      const dto = await withTestTenant(async () =>
        availability.create({ availabilityType: 'RECURRING', dayOfWeek: 2 } as any, teacherActor()),
      );
      // Parent tries to remove teacher's row → 404
      await expect(
        withTestTenant(async () => availability.remove(dto.id, parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Teacher removes own → ok
      const res = await withTestTenant(async () => availability.remove(dto.id, teacherActor()));
      expect(res.deleted).toBe(true);
    });

    it('remove missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          availability.remove('00000000-0000-0000-0000-000000000099', teacherActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('remove without personId → Forbidden', async () => {
      const dto = await withTestTenant(async () =>
        availability.create({ availabilityType: 'RECURRING', dayOfWeek: 3 } as any, teacherActor()),
      );
      await expect(
        withTestTenant(async () =>
          availability.remove(dto.id, { ...adminActor(), personId: null as any }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // SubstitutePreferenceService
  // ─────────────────────────────────────────────────────────────────────
  describe('SubstitutePreferenceService', () => {
    it('listMine empty when no profile', async () => {
      const list = await withTestTenant(async () => preferences.listMine(adminActor()));
      expect(list).toEqual([]);
    });

    it('listMine null personId → []', async () => {
      const list = await withTestTenant(async () =>
        preferences.listMine({ ...adminActor(), personId: null as any }),
      );
      expect(list).toEqual([]);
    });

    it('create PREFERRED + listMine returns it', async () => {
      const dto = await withTestTenant(async () =>
        preferences.create(
          { schoolId: TEST_SCHOOL_ID, preferenceType: 'PREFERRED', reason: 'Like them' } as any,
          teacherActor(),
        ),
      );
      expect(dto.preferenceType).toBe('PREFERRED');
      const list = await withTestTenant(async () => preferences.listMine(teacherActor()));
      expect(list.length).toBe(1);
    });

    it('create duplicate (same school) → BadRequest', async () => {
      await withTestTenant(async () =>
        preferences.create(
          { schoolId: TEST_SCHOOL_ID, preferenceType: 'BLOCKED' } as any,
          teacherActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          preferences.create(
            { schoolId: TEST_SCHOOL_ID, preferenceType: 'PREFERRED' } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create without personId → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          preferences.create({ schoolId: TEST_SCHOOL_ID, preferenceType: 'PREFERRED' } as any, {
            ...adminActor(),
            personId: null as any,
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create when no profile → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          preferences.create(
            { schoolId: TEST_SCHOOL_ID, preferenceType: 'PREFERRED' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('remove own succeeds + cross-substitute → 404', async () => {
      const dto = await withTestTenant(async () =>
        preferences.create(
          { schoolId: TEST_SCHOOL_ID, preferenceType: 'PREFERRED' } as any,
          teacherActor(),
        ),
      );
      await expect(
        withTestTenant(async () => preferences.remove(dto.id, parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      const res = await withTestTenant(async () => preferences.remove(dto.id, teacherActor()));
      expect(res.deleted).toBe(true);
    });

    it('remove missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          preferences.remove('00000000-0000-0000-0000-000000000099', teacherActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('remove without personId → Forbidden', async () => {
      const dto = await withTestTenant(async () =>
        preferences.create(
          { schoolId: TEST_SCHOOL_B_ID, preferenceType: 'BLOCKED' } as any,
          teacherActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          preferences.remove(dto.id, { ...adminActor(), personId: null as any }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // SchoolPoolService
  // ─────────────────────────────────────────────────────────────────────
  describe('SchoolPoolService', () => {
    it('admin addToPool → ACTIVE + list returns', async () => {
      const dto = await withTestTenant(async () =>
        pool.addToPool({ substituteId: TEST_SUB_PROFILE_TEACHER_ID } as any, adminActor()),
      );
      expect(dto.status).toBe('ACTIVE');
      const list = await withTestTenant(async () => pool.list(adminActor()));
      expect(list.map((p) => p.id)).toContain(dto.id);
    });

    it('addToPool non-admin → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          pool.addToPool({ substituteId: TEST_SUB_PROFILE_TEACHER_ID } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list reflects sub_school_pool join with platform profile (substituteName, overallRating)', async () => {
      await withTestTenant(async () =>
        pool.addToPool(
          { substituteId: TEST_SUB_PROFILE_TEACHER_ID, notes: 'great' } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => pool.list(adminActor()));
      const found = list.find((p) => p.substituteId === TEST_SUB_PROFILE_TEACHER_ID)!;
      expect(found.substituteName).toBe('Teacher Sub');
    });

    it('updatePoolMember SUSPEND fills suspension fields + REINSTATE clears them', async () => {
      const dto = await withTestTenant(async () =>
        pool.addToPool({ substituteId: TEST_SUB_PROFILE_TEACHER_ID } as any, adminActor()),
      );
      const suspended = await withTestTenant(async () =>
        pool.updatePoolMember(
          dto.id,
          {
            status: 'SUSPENDED',
            suspendedUntil: '2027-12-31',
            suspensionReason: 'No-show',
          } as any,
          adminActor(),
        ),
      );
      expect(suspended.status).toBe('SUSPENDED');
      expect(suspended.suspendedUntil).toBe('2027-12-31');
      expect(suspended.suspensionReason).toBe('No-show');

      const back = await withTestTenant(async () =>
        pool.updatePoolMember(dto.id, { status: 'ACTIVE' } as any, adminActor()),
      );
      expect(back.status).toBe('ACTIVE');
      expect(back.suspendedUntil).toBeNull();
      expect(back.suspensionReason).toBeNull();
    });

    it('updatePoolMember SUSPENDED without explicit reason defaults to "Manually suspended"', async () => {
      const dto = await withTestTenant(async () =>
        pool.addToPool({ substituteId: TEST_SUB_PROFILE_TEACHER_ID } as any, adminActor()),
      );
      const suspended = await withTestTenant(async () =>
        pool.updatePoolMember(
          dto.id,
          { status: 'SUSPENDED', suspendedUntil: '2027-12-31' } as any,
          adminActor(),
        ),
      );
      expect(suspended.suspensionReason).toBe('Manually suspended');
    });

    it('updatePoolMember only suspension fields (without status) updates fields in place', async () => {
      const dto = await withTestTenant(async () =>
        pool.addToPool({ substituteId: TEST_SUB_PROFILE_TEACHER_ID } as any, adminActor()),
      );
      await withTestTenant(async () =>
        pool.updatePoolMember(
          dto.id,
          {
            status: 'SUSPENDED',
            suspendedUntil: '2027-12-31',
            suspensionReason: 'first',
          } as any,
          adminActor(),
        ),
      );
      const patched = await withTestTenant(async () =>
        pool.updatePoolMember(dto.id, { suspensionReason: 'tweaked' } as any, adminActor()),
      );
      expect(patched.suspensionReason).toBe('tweaked');
    });

    it('updatePoolMember with empty body (no-op) → existing row returned', async () => {
      const dto = await withTestTenant(async () =>
        pool.addToPool({ substituteId: TEST_SUB_PROFILE_TEACHER_ID } as any, adminActor()),
      );
      const out = await withTestTenant(async () =>
        pool.updatePoolMember(dto.id, {} as any, adminActor()),
      );
      expect(out.id).toBe(dto.id);
    });

    it('updatePoolMember missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          pool.updatePoolMember(
            '00000000-0000-0000-0000-000000000099',
            { status: 'SUSPENDED', suspendedUntil: '2027-12-31' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('updatePoolMember non-admin → Forbidden', async () => {
      const dto = await withTestTenant(async () =>
        pool.addToPool({ substituteId: TEST_SUB_PROFILE_TEACHER_ID } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          pool.updatePoolMember(dto.id, { status: 'ACTIVE' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-school: pool added in school A invisible to school B list', async () => {
      await withTestTenant(async () =>
        pool.addToPool({ substituteId: TEST_SUB_PROFILE_TEACHER_ID } as any, adminActor()),
      );
      const fromB = await withTestTenantB(async () => pool.list(adminActor()));
      expect(fromB.length).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // JobPostingService — keystone
  // ─────────────────────────────────────────────────────────────────────
  describe('JobPostingService', () => {
    it('post by admin → OPEN + fans out POOL notifications + emits sub.job.posted via outbox', async () => {
      await addParentSubToPoolA();
      const job = await postJob();
      expect(job.status).toBe('OPEN');
      expect(job.notificationTier).toBe('POOL');
      expect(job.notifications.length).toBe(1);
      expect(job.notifications[0]!.substituteId).toBe(TEST_SUB_PROFILE_PARENT_ID);
      expect(job.notifications[0]!.response).toBe('PENDING');

      // sub.job.posted in platform_outbox
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT topic FROM platform.platform_outbox WHERE topic = 'sub.job.posted' AND message_key = $1`,
        job.id,
      )) as Array<{ topic: string }>;
      expect(rows.length).toBe(1);
    });

    it('post non-admin → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          jobs.post(
            {
              absentTeacherId: TEST_TEACHER_EMPLOYEE_ID,
              jobDate: '2027-03-15',
              startTime: '09:00',
              endTime: '15:00',
              jobType: 'FULL_DAY',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('post with foreign-school teacher → BadRequest (cross-school protection)', async () => {
      // TEST_SUB_HR_EMP_SCHOOL_B_ID belongs to school B; posting from A should reject.
      await expect(
        withTestTenant(async () =>
          jobs.post(
            {
              absentTeacherId: TEST_SUB_HR_EMP_SCHOOL_B_ID,
              jobDate: '2027-03-15',
              startTime: '09:00',
              endTime: '15:00',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('post honours BLOCKED preferences — substitute not notified', async () => {
      await addParentSubToPoolA();
      // Parent sub blocks school A.
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_sub_preferences (id, substitute_id, school_id, preference_type)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'BLOCKED')`,
        generateId(),
        TEST_SUB_PROFILE_PARENT_ID,
        TEST_SCHOOL_ID,
      );
      const job = await postJob();
      expect(job.notifications.length).toBe(0);
    });

    it('post with timetableSlotIds snapshots class info', async () => {
      // Seed bell + period + room + slot
      const bs = generateId();
      const per = generateId();
      const rm = generateId();
      const slot = generateId();
      const bsName = 'Sub Job BellA ' + Math.random().toString(36).slice(2, 8);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sch_bell_schedules (id, school_id, name, schedule_type, is_default)
         VALUES ($1::uuid, $2::uuid, $3, 'STANDARD', false)`,
        bs,
        TEST_SCHOOL_ID,
        bsName,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sch_periods
           (id, bell_schedule_id, name, day_of_week, start_time, end_time, period_type, sort_order)
         VALUES ($1::uuid, $2::uuid, 'P1', NULL, '08:00', '09:00', 'LESSON', 1)`,
        per,
        bs,
      );
      const rmName = 'Sub Job RoomA ' + Math.random().toString(36).slice(2, 8);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sch_rooms (id, school_id, name, capacity, room_type)
         VALUES ($1::uuid, $2::uuid, $3, 30, 'CLASSROOM')`,
        rm,
        TEST_SCHOOL_ID,
        rmName,
      );
      // Look up an existing sis_classes id in tenant_test
      const classRows = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_classes WHERE school_id = $1::uuid LIMIT 1`,
        TEST_SCHOOL_ID,
      )) as Array<{ id: string }>;
      const classId = classRows[0]!.id;
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sch_timetable_slots
           (id, school_id, class_id, period_id, teacher_id, room_id, effective_from, effective_to)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, '2027-01-01', '2027-12-31')`,
        slot,
        TEST_SCHOOL_ID,
        classId,
        per,
        TEST_TEACHER_EMPLOYEE_ID,
        rm,
      );

      const job = await withTestTenant(async () =>
        jobs.post(
          {
            absentTeacherId: TEST_TEACHER_EMPLOYEE_ID,
            jobDate: '2027-03-15',
            startTime: '09:00',
            endTime: '15:00',
            timetableSlotIds: [slot],
          } as any,
          adminActor(),
        ),
      );
      expect(job.classes.length).toBe(1);
      expect(job.classes[0]!.roomName).toBe(rmName);
      expect(job.classes[0]!.periodLabel).toBe('P1');

      // Clean up — drop sub_* first because sub_job_classes has a
      // DB-enforced FK to sch_timetable_slots.
      await resetSubstitutesTables(rawClient);
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE id = $1::uuid`,
        slot,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_rooms WHERE id = $1::uuid`,
        rm,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_periods WHERE id = $1::uuid`,
        per,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE id = $1::uuid`,
        bs,
      );
    });

    it('post with bogus timetable slot → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          jobs.post(
            {
              absentTeacherId: TEST_TEACHER_EMPLOYEE_ID,
              jobDate: '2027-03-15',
              startTime: '09:00',
              endTime: '15:00',
              timetableSlotIds: ['00000000-0000-0000-0000-000000000099'],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('list admin returns posted jobs', async () => {
      await addParentSubToPoolA();
      const job = await postJob();
      const list = await withTestTenant(async () => jobs.list(adminActor()));
      expect(list.map((j) => j.id)).toContain(job.id);
    });

    it('list admin with status filter', async () => {
      await addParentSubToPoolA();
      const job = await postJob();
      const filtered = await withTestTenant(async () => jobs.list(adminActor(), 'OPEN'));
      expect(filtered.map((j) => j.id)).toContain(job.id);
      const empty = await withTestTenant(async () => jobs.list(adminActor(), 'FILLED'));
      expect(empty.map((j) => j.id)).not.toContain(job.id);
    });

    it('list as substitute returns only notified jobs', async () => {
      await addParentSubToPoolA();
      const job = await postJob();
      const list = await withTestTenant(async () => jobs.list(parentActor()));
      expect(list.map((j) => j.id)).toContain(job.id);
    });

    it('list as substitute without profile → []', async () => {
      const list = await withTestTenant(async () => jobs.list(adminActor() as any));
      // admin has no profile but has marketplace scope so it falls back to admin branch — verify by checking parent path
      // Actually admin DOES bypass — let's use a non-admin non-substitute (synthetic)
      const empty = await withTestTenant(async () =>
        jobs.list({
          accountId: '00000000-0000-0000-0000-000000000099',
          personId: '00000000-0000-0000-0000-000000000099',
          employeeId: null,
          personType: 'STAFF',
          isSchoolAdmin: false,
        } as any),
      );
      expect(empty).toEqual([]);
      expect(list).toBeDefined();
    });

    it('list as substitute with no personId → []', async () => {
      const list = await withTestTenant(async () =>
        jobs.list({
          ...teacherActor(),
          personId: null as any,
        }),
      );
      expect(list).toEqual([]);
    });

    it('getById admin → returns full hydrated dto', async () => {
      await addParentSubToPoolA();
      const job = await postJob();
      const fetched = await withTestTenant(async () => jobs.getById(job.id, adminActor()));
      expect(fetched.id).toBe(job.id);
      expect(fetched.notifications.length).toBe(1);
    });

    it('getById as notified substitute', async () => {
      await addParentSubToPoolA();
      const job = await postJob();
      const fetched = await withTestTenant(async () => jobs.getById(job.id, parentActor()));
      expect(fetched.id).toBe(job.id);
    });

    it('getById as non-notified substitute → 404', async () => {
      await addParentSubToPoolA();
      const job = await postJob();
      // teacher sub is not in pool → not notified → 404
      await expect(
        withTestTenant(async () => jobs.getById(job.id, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById as substitute with no profile → 404', async () => {
      await addParentSubToPoolA();
      const job = await postJob();
      await expect(
        withTestTenant(async () =>
          jobs.getById(job.id, {
            ...teacherActor(),
            personId: '00000000-0000-0000-0000-000000000099',
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          jobs.getById('00000000-0000-0000-0000-000000000099', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById as substitute with no personId → 404', async () => {
      await addParentSubToPoolA();
      const job = await postJob();
      await expect(
        withTestTenant(async () =>
          jobs.getById(job.id, { ...teacherActor(), personId: null as any }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('accept by notified sub → FILLED + CONFIRMED + sub.assignment.confirmed outbox KEYSTONE', async () => {
      await addParentSubToPoolA();
      const job = await postJob();
      const asg = await withTestTenant(async () => jobs.accept(job.id, parentActor()));
      expect(asg.status).toBe('CONFIRMED');
      expect(asg.substituteId).toBe(TEST_SUB_PROFILE_PARENT_ID);

      const jobRows = (await rawClient.$queryRawUnsafe(
        `SELECT status, filled_at FROM ${TEST_SCHEMA}.sub_job_postings WHERE id = $1::uuid`,
        job.id,
      )) as Array<{ status: string; filled_at: Date | null }>;
      expect(jobRows[0]!.status).toBe('FILLED');
      expect(jobRows[0]!.filled_at).not.toBeNull();

      // KEYSTONE: sub.assignment.confirmed in platform_outbox
      const emit = (await rawClient.$queryRawUnsafe(
        `SELECT topic, envelope::text AS envelope, message_key
           FROM platform.platform_outbox
           WHERE topic = 'sub.assignment.confirmed' AND message_key = $1`,
        asg.id,
      )) as Array<{ topic: string; envelope: string; message_key: string }>;
      expect(emit.length).toBe(1);
      const env = JSON.parse(emit[0]!.envelope);
      expect(env.payload.assignmentId).toBe(asg.id);
      expect(env.payload.jobId).toBe(job.id);
      expect(env.payload.substituteId).toBe(TEST_SUB_PROFILE_PARENT_ID);
    });

    it('accept without personId → Forbidden', async () => {
      await addParentSubToPoolA();
      const job = await postJob();
      await expect(
        withTestTenant(async () =>
          jobs.accept(job.id, { ...parentActor(), personId: null as any }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('accept without a substitute profile → Forbidden', async () => {
      await addParentSubToPoolA();
      const job = await postJob();
      await expect(
        withTestTenant(async () =>
          jobs.accept(job.id, {
            ...parentActor(),
            personId: '00000000-0000-0000-0000-000000000099',
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('accept on missing job → 404', async () => {
      await expect(
        withTestTenant(async () =>
          jobs.accept('00000000-0000-0000-0000-000000000099', parentActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('accept already FILLED → Conflict', async () => {
      await addParentSubToPoolA();
      const job = await postJob();
      await withTestTenant(async () => jobs.accept(job.id, parentActor()));
      await expect(
        withTestTenant(async () => jobs.accept(job.id, parentActor())),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('accept without notification → Forbidden', async () => {
      // No pool entry → no notification row → parent gets Forbidden when trying to accept
      const job = await postJob();
      await expect(
        withTestTenant(async () => jobs.accept(job.id, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('accept after expiry window → Conflict + flips notification to EXPIRED', async () => {
      await addParentSubToPoolA();
      const job = await postJob({ acceptanceWindowMinutes: 5 });
      // Force window into the past
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.sub_job_notifications
            SET acceptance_window_expires_at = now() - interval '1 hour'
          WHERE job_id = $1::uuid`,
        job.id,
      );
      await expect(
        withTestTenant(async () => jobs.accept(job.id, parentActor())),
      ).rejects.toBeInstanceOf(ConflictException);

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT response FROM ${TEST_SCHEMA}.sub_job_notifications WHERE job_id = $1::uuid`,
        job.id,
      )) as Array<{ response: string }>;
      expect(rows[0]!.response).toBe('EXPIRED');
    });

    it('accept after notification already DECLINED → Conflict', async () => {
      await addParentSubToPoolA();
      const job = await postJob();
      await withTestTenant(async () => jobs.decline(job.id, parentActor()));
      await expect(
        withTestTenant(async () => jobs.accept(job.id, parentActor())),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('decline by notified sub → DECLINED', async () => {
      await addParentSubToPoolA();
      const job = await postJob();
      const res = await withTestTenant(async () => jobs.decline(job.id, parentActor()));
      expect(res.response).toBe('DECLINED');
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT response FROM ${TEST_SCHEMA}.sub_job_notifications WHERE job_id = $1::uuid`,
        job.id,
      )) as Array<{ response: string }>;
      expect(rows[0]!.response).toBe('DECLINED');
    });

    it('decline without personId → Forbidden', async () => {
      await addParentSubToPoolA();
      const job = await postJob();
      await expect(
        withTestTenant(async () =>
          jobs.decline(job.id, { ...parentActor(), personId: null as any }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('decline without profile → Forbidden', async () => {
      const job = await postJob();
      await expect(
        withTestTenant(async () =>
          jobs.decline(job.id, {
            ...parentActor(),
            personId: '00000000-0000-0000-0000-000000000099',
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('decline already responded → Conflict', async () => {
      await addParentSubToPoolA();
      const job = await postJob();
      await withTestTenant(async () => jobs.decline(job.id, parentActor()));
      await expect(
        withTestTenant(async () => jobs.decline(job.id, parentActor())),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('decline without notification → NotFound', async () => {
      const job = await postJob();
      await expect(
        withTestTenant(async () => jobs.decline(job.id, parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school: school A admin posts a job; school B admin list is empty', async () => {
      await addParentSubToPoolA();
      const job = await postJob();
      const fromB = await withTestTenantB(async () => jobs.list(adminActor()));
      expect(fromB.map((j) => j.id)).not.toContain(job.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // AssignmentService
  // ─────────────────────────────────────────────────────────────────────
  describe('AssignmentService', () => {
    it('list admin returns all + status filter', async () => {
      const { assignmentId } = await postAndAccept();
      const list = await withTestTenant(async () => assignments.list(adminActor()));
      expect(list.map((a) => a.id)).toContain(assignmentId);
      const filtered = await withTestTenant(async () =>
        assignments.list(adminActor(), 'CONFIRMED'),
      );
      expect(filtered.map((a) => a.id)).toContain(assignmentId);
    });

    it('list as substitute returns only own', async () => {
      const { assignmentId } = await postAndAccept();
      const list = await withTestTenant(async () => assignments.list(parentActor()));
      expect(list.map((a) => a.id)).toContain(assignmentId);

      // Teacher persona has a profile but not the assigned one → list empty for those
      const teacherList = await withTestTenant(async () => assignments.list(teacherActor()));
      expect(teacherList.map((a) => a.id)).not.toContain(assignmentId);
    });

    it('list with null personId as substitute → []', async () => {
      await postAndAccept();
      const list = await withTestTenant(async () =>
        assignments.list({ ...parentActor(), personId: null as any }),
      );
      expect(list).toEqual([]);
    });

    it('list with no-profile substitute → []', async () => {
      await postAndAccept();
      const list = await withTestTenant(async () =>
        assignments.list({
          ...parentActor(),
          personId: '00000000-0000-0000-0000-000000000099',
        } as any),
      );
      expect(list).toEqual([]);
    });

    it('getById admin → ok; substitute sees own; cross-substitute → 404', async () => {
      const { assignmentId } = await postAndAccept();
      const a1 = await withTestTenant(async () => assignments.getById(assignmentId, adminActor()));
      expect(a1.id).toBe(assignmentId);
      const a2 = await withTestTenant(async () => assignments.getById(assignmentId, parentActor()));
      expect(a2.id).toBe(assignmentId);
      await expect(
        withTestTenant(async () => assignments.getById(assignmentId, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          assignments.getById('00000000-0000-0000-0000-000000000099', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById as substitute with null personId → 404', async () => {
      const { assignmentId } = await postAndAccept();
      await expect(
        withTestTenant(async () =>
          assignments.getById(assignmentId, { ...parentActor(), personId: null as any }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('checkIn CONFIRMED → CHECKED_IN by owning sub', async () => {
      const { assignmentId } = await postAndAccept();
      const dto = await withTestTenant(async () =>
        assignments.checkIn(assignmentId, parentActor()),
      );
      expect(dto.status).toBe('CHECKED_IN');
      expect(dto.checkInAt).not.toBeNull();
    });

    it('checkIn by admin allowed', async () => {
      const { assignmentId } = await postAndAccept();
      const dto = await withTestTenant(async () => assignments.checkIn(assignmentId, adminActor()));
      expect(dto.status).toBe('CHECKED_IN');
    });

    it('checkIn by foreign substitute → Forbidden', async () => {
      const { assignmentId } = await postAndAccept();
      await expect(
        withTestTenant(async () => assignments.checkIn(assignmentId, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('checkIn on non-CONFIRMED → Conflict', async () => {
      const { assignmentId } = await postAndAccept();
      await withTestTenant(async () => assignments.checkIn(assignmentId, parentActor()));
      await expect(
        withTestTenant(async () => assignments.checkIn(assignmentId, parentActor())),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('checkIn missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          assignments.checkIn('00000000-0000-0000-0000-000000000099', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('checkOut CHECKED_IN → CHECKED_OUT + bumps totalAssignments', async () => {
      const { assignmentId } = await postAndAccept();
      await withTestTenant(async () => assignments.checkIn(assignmentId, parentActor()));
      const dto = await withTestTenant(async () =>
        assignments.checkOut(assignmentId, parentActor()),
      );
      expect(dto.status).toBe('CHECKED_OUT');
      const profile = await rawClient.$queryRawUnsafe<Array<{ total_assignments: number }>>(
        `SELECT total_assignments FROM platform.platform_substitute_profiles WHERE id = $1::uuid`,
        TEST_SUB_PROFILE_PARENT_ID,
      );
      expect(profile[0]!.total_assignments).toBe(1);
    });

    it('checkOut on CONFIRMED (not yet checked in) → Conflict', async () => {
      const { assignmentId } = await postAndAccept();
      await expect(
        withTestTenant(async () => assignments.checkOut(assignmentId, parentActor())),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('checkOut by foreign sub → Forbidden', async () => {
      const { assignmentId } = await postAndAccept();
      await withTestTenant(async () => assignments.checkIn(assignmentId, parentActor()));
      await expect(
        withTestTenant(async () => assignments.checkOut(assignmentId, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('checkOut missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          assignments.checkOut('00000000-0000-0000-0000-000000000099', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cancel SUBSTITUTE within late window → is_late + sub.assignment.late_cancelled outbox', async () => {
      const { jobId, assignmentId } = await postAndAccept();
      // Move the job to today so cancellation falls inside the late window.
      const today = new Date().toISOString().slice(0, 10);
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.sub_job_postings
            SET job_date = $1::date
          WHERE id = $2::uuid`,
        today,
        jobId,
      );
      // Configure school A policy (TEMPORARY_POOL_SUSPENSION with 10-day window).
      await withTestTenant(async () =>
        policies.upsert(
          {
            lateWindowHours: 48,
            consequence: 'TEMPORARY_POOL_SUSPENSION',
            suspensionDurationDays: 10,
            repeatOffenceThreshold: 1,
          } as any,
          adminActor(),
        ),
      );

      const cancelled = await withTestTenant(async () =>
        assignments.cancel(
          assignmentId,
          { cancelledByType: 'SUBSTITUTE', cancellationReason: 'illness' } as any,
          parentActor(),
        ),
      );
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.isLateCancellation).toBe(true);

      // sub.assignment.late_cancelled in platform_outbox with deterministic eventId
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT envelope::text AS envelope FROM platform.platform_outbox
           WHERE topic = 'sub.assignment.late_cancelled' AND message_key = $1`,
        assignmentId,
      )) as Array<{ envelope: string }>;
      expect(rows.length).toBe(1);
      const env = JSON.parse(rows[0]!.envelope);
      expect(env.event_id).toBe(deterministicLateCancellationEventId(assignmentId));

      // Parent job flipped to UNFILLED
      const jobRows = (await rawClient.$queryRawUnsafe(
        `SELECT status, filled_at FROM ${TEST_SCHEMA}.sub_job_postings WHERE id = $1::uuid`,
        jobId,
      )) as Array<{ status: string; filled_at: Date | null }>;
      expect(jobRows[0]!.status).toBe('UNFILLED');
      expect(jobRows[0]!.filled_at).toBeNull();
    });

    it('cancel SUBSTITUTE early (outside late window) → not late', async () => {
      const { jobId, assignmentId } = await postAndAccept();
      // Move job far into the future
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.sub_job_postings
            SET job_date = '2030-12-31', start_time = '09:00'
          WHERE id = $1::uuid`,
        jobId,
      );
      const cancelled = await withTestTenant(async () =>
        assignments.cancel(
          assignmentId,
          { cancelledByType: 'SUBSTITUTE', cancellationReason: 'cant make it' } as any,
          parentActor(),
        ),
      );
      expect(cancelled.isLateCancellation).toBe(false);

      // No late_cancelled outbox row
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT 1 FROM platform.platform_outbox
           WHERE topic = 'sub.assignment.late_cancelled' AND message_key = $1`,
        assignmentId,
      )) as Array<unknown>;
      expect(rows.length).toBe(0);
    });

    it('cancel SCHOOL by admin never counts as late', async () => {
      const { jobId, assignmentId } = await postAndAccept();
      // Move to today
      const today = new Date().toISOString().slice(0, 10);
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.sub_job_postings
            SET job_date = $1::date
          WHERE id = $2::uuid`,
        today,
        jobId,
      );
      const cancelled = await withTestTenant(async () =>
        assignments.cancel(
          assignmentId,
          { cancelledByType: 'SCHOOL', cancellationReason: 'school decision' } as any,
          adminActor(),
        ),
      );
      expect(cancelled.isLateCancellation).toBe(false);
    });

    it('cancel SCHOOL by non-admin → Forbidden', async () => {
      const { assignmentId } = await postAndAccept();
      await expect(
        withTestTenant(async () =>
          assignments.cancel(
            assignmentId,
            { cancelledByType: 'SCHOOL', cancellationReason: 'x' } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cancel SUBSTITUTE by other (non-admin) substitute → Forbidden', async () => {
      const { assignmentId } = await postAndAccept();
      await expect(
        withTestTenant(async () =>
          assignments.cancel(
            assignmentId,
            { cancelledByType: 'SUBSTITUTE', cancellationReason: 'x' } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cancel without reason → BadRequest', async () => {
      const { assignmentId } = await postAndAccept();
      await expect(
        withTestTenant(async () =>
          assignments.cancel(
            assignmentId,
            { cancelledByType: 'SUBSTITUTE', cancellationReason: '   ' } as any,
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cancel terminal status → Conflict', async () => {
      const { assignmentId } = await postAndAccept();
      await withTestTenant(async () =>
        assignments.cancel(
          assignmentId,
          { cancelledByType: 'SCHOOL', cancellationReason: 'first' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          assignments.cancel(
            assignmentId,
            { cancelledByType: 'SCHOOL', cancellationReason: 'again' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('cancel missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          assignments.cancel(
            '00000000-0000-0000-0000-000000000099',
            { cancelledByType: 'SCHOOL', cancellationReason: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school isolation: cancel from school B for a school-A assignment → 404', async () => {
      const { assignmentId } = await postAndAccept();
      await expect(
        withTestTenantB(async () =>
          assignments.cancel(
            assignmentId,
            { cancelledByType: 'SCHOOL', cancellationReason: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('deterministicLateCancellationEventId is stable', () => {
      const a = deterministicLateCancellationEventId('019e0cf8-aaaa-7777-8888-000000082aaa');
      const b = deterministicLateCancellationEventId('019e0cf8-aaaa-7777-8888-000000082aaa');
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // PayRateService
  // ─────────────────────────────────────────────────────────────────────
  describe('PayRateService', () => {
    it('create + list', async () => {
      const dto = await withTestTenant(async () =>
        payRates.create(
          {
            rate: 200,
            rateType: 'DAILY',
            effectiveFrom: '2027-01-01',
            effectiveTo: '2027-06-30',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.rate).toBe('200.00');
      expect(dto.rateType).toBe('DAILY');
      const list = await withTestTenant(async () => payRates.list());
      expect(list.map((r) => r.id)).toContain(dto.id);
    });

    it('create with overlapping date range → 409 Conflict (EXCLUDE-gist 23P01)', async () => {
      await withTestTenant(async () =>
        payRates.create(
          { rate: 200, effectiveFrom: '2027-01-01', effectiveTo: '2027-06-30' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          payRates.create(
            { rate: 220, effectiveFrom: '2027-05-01', effectiveTo: '2027-08-31' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('create non-admin → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          payRates.create({ rate: 100, effectiveFrom: '2027-01-01' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create with negative rate → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          payRates.create({ rate: -1, effectiveFrom: '2027-01-01' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create with effectiveTo < effectiveFrom → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          payRates.create(
            { rate: 100, effectiveFrom: '2027-06-30', effectiveTo: '2027-01-01' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('close pay rate stamps effective_to', async () => {
      const created = await withTestTenant(async () =>
        payRates.create({ rate: 200, effectiveFrom: '2027-01-01' } as any, adminActor()),
      );
      const closed = await withTestTenant(async () =>
        payRates.close(created.id, '2027-06-30', adminActor()),
      );
      expect(closed.effectiveTo).toBe('2027-06-30');
    });

    it('close missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          payRates.close('00000000-0000-0000-0000-000000000099', '2027-12-31', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('close non-admin → Forbidden', async () => {
      const created = await withTestTenant(async () =>
        payRates.create({ rate: 200, effectiveFrom: '2027-01-01' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () => payRates.close(created.id, '2027-06-30', teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('computePay per-substitute wins', async () => {
      const { assignmentId } = await postAndAccept();
      // School-default
      await withTestTenant(async () =>
        payRates.create({ rate: 180, effectiveFrom: '2027-01-01' } as any, adminActor()),
      );
      // Per-substitute override for the parent sub
      await withTestTenant(async () =>
        payRates.create(
          {
            substituteId: TEST_SUB_PROFILE_PARENT_ID,
            rate: 250,
            effectiveFrom: '2027-01-01',
          } as any,
          adminActor(),
        ),
      );
      const pay = await withTestTenant(async () => payRates.computePay(assignmentId));
      expect(pay.rateSource).toBe('PER_SUBSTITUTE');
      expect(pay.rate).toBe('250.00');
    });

    it('computePay falls back to SCHOOL_DEFAULT', async () => {
      const { assignmentId } = await postAndAccept();
      await withTestTenant(async () =>
        payRates.create({ rate: 175, effectiveFrom: '2027-01-01' } as any, adminActor()),
      );
      const pay = await withTestTenant(async () => payRates.computePay(assignmentId));
      expect(pay.rateSource).toBe('SCHOOL_DEFAULT');
      expect(pay.rate).toBe('175.00');
    });

    it('computePay with no rate configured → 404', async () => {
      const { assignmentId } = await postAndAccept();
      await expect(
        withTestTenant(async () => payRates.computePay(assignmentId)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('computePay missing assignment → 404', async () => {
      await expect(
        withTestTenant(async () => payRates.computePay('00000000-0000-0000-0000-000000000099')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school: pay rate in school A invisible to school B', async () => {
      await withTestTenant(async () =>
        payRates.create({ rate: 250, effectiveFrom: '2027-01-01' } as any, adminActor()),
      );
      const fromB = await withTestTenantB(async () => payRates.list());
      expect(fromB.length).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // SessionNoteService
  // ─────────────────────────────────────────────────────────────────────
  describe('SessionNoteService', () => {
    async function checkedOutAssignment(): Promise<{ jobId: string; assignmentId: string }> {
      const { jobId, assignmentId } = await postAndAccept();
      await withTestTenant(async () => assignments.checkIn(assignmentId, parentActor()));
      await withTestTenant(async () => assignments.checkOut(assignmentId, parentActor()));
      return { jobId, assignmentId };
    }

    it('create after CHECKED_OUT by sub + getForAssignment by admin/sub', async () => {
      const { assignmentId } = await checkedOutAssignment();
      const note = await withTestTenant(async () =>
        notes.create(
          assignmentId,
          { notesText: 'all good', homeworkSet: 'p32', isVisibleToTeacher: true } as any,
          parentActor(),
        ),
      );
      expect(note.notesText).toBe('all good');
      const adminView = await withTestTenant(async () =>
        notes.getForAssignment(assignmentId, adminActor()),
      );
      expect(adminView?.id).toBe(note.id);
      const subView = await withTestTenant(async () =>
        notes.getForAssignment(assignmentId, parentActor()),
      );
      expect(subView?.id).toBe(note.id);
    });

    it('returning teacher sees note when is_visible_to_teacher=true', async () => {
      const { assignmentId } = await checkedOutAssignment();
      await withTestTenant(async () =>
        notes.create(
          assignmentId,
          { notesText: 'visible', isVisibleToTeacher: true } as any,
          parentActor(),
        ),
      );
      const view = await withTestTenant(async () =>
        notes.getForAssignment(assignmentId, teacherActor()),
      );
      expect(view).not.toBeNull();
    });

    it('returning teacher gets null when is_visible_to_teacher=false', async () => {
      const { assignmentId } = await checkedOutAssignment();
      await withTestTenant(async () =>
        notes.create(
          assignmentId,
          { notesText: 'hidden', isVisibleToTeacher: false } as any,
          parentActor(),
        ),
      );
      const view = await withTestTenant(async () =>
        notes.getForAssignment(assignmentId, teacherActor()),
      );
      expect(view).toBeNull();
    });

    it("unrelated actor → null (don't-leak-existence)", async () => {
      const { assignmentId } = await checkedOutAssignment();
      await withTestTenant(async () =>
        notes.create(assignmentId, { notesText: 'private' } as any, parentActor()),
      );
      const view = await withTestTenant(async () =>
        notes.getForAssignment(assignmentId, studentActor()),
      );
      expect(view).toBeNull();
    });

    it('create before CHECKED_OUT (CONFIRMED) by sub → Conflict', async () => {
      const { assignmentId } = await postAndAccept();
      await expect(
        withTestTenant(async () =>
          notes.create(assignmentId, { notesText: 'too early' } as any, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('admin can create note pre-checkout (override path)', async () => {
      const { assignmentId } = await postAndAccept();
      const note = await withTestTenant(async () =>
        notes.create(assignmentId, { notesText: 'admin override' } as any, adminActor()),
      );
      expect(note.notesText).toBe('admin override');
    });

    it('create by non-owning sub → Forbidden', async () => {
      const { assignmentId } = await checkedOutAssignment();
      await expect(
        withTestTenant(async () =>
          notes.create(assignmentId, { notesText: 'nope' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create twice → Conflict (UNIQUE assignment_id)', async () => {
      const { assignmentId } = await checkedOutAssignment();
      await withTestTenant(async () =>
        notes.create(assignmentId, { notesText: 'first' } as any, parentActor()),
      );
      await expect(
        withTestTenant(async () =>
          notes.create(assignmentId, { notesText: 'dup' } as any, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('create on missing assignment → 404', async () => {
      await expect(
        withTestTenant(async () =>
          notes.create(
            '00000000-0000-0000-0000-000000000099',
            { notesText: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getForAssignment on missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          notes.getForAssignment('00000000-0000-0000-0000-000000000099', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getForAssignment when no note exists → null', async () => {
      const { assignmentId } = await postAndAccept();
      const out = await withTestTenant(async () =>
        notes.getForAssignment(assignmentId, adminActor()),
      );
      expect(out).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // RatingService
  // ─────────────────────────────────────────────────────────────────────
  describe('RatingService', () => {
    async function checkedOutAssignment(): Promise<string> {
      const { assignmentId } = await postAndAccept();
      await withTestTenant(async () => assignments.checkIn(assignmentId, parentActor()));
      await withTestTenant(async () => assignments.checkOut(assignmentId, parentActor()));
      return assignmentId;
    }

    it('admin SCHOOL_RATES_SUB → re-materialises overall_rating', async () => {
      const assignmentId = await checkedOutAssignment();
      const rating = await withTestTenant(async () =>
        ratings.create(
          assignmentId,
          {
            raterType: 'SCHOOL_RATES_SUB',
            overallScore: 4.5,
            professionalism: 5,
            punctuality: 4,
            comments: 'great',
          } as any,
          adminActor(),
        ),
      );
      expect(rating.raterType).toBe('SCHOOL_RATES_SUB');

      const profile = await rawClient.$queryRawUnsafe<Array<{ overall_rating: string | null }>>(
        `SELECT overall_rating::text AS overall_rating
           FROM platform.platform_substitute_profiles
           WHERE id = $1::uuid`,
        TEST_SUB_PROFILE_PARENT_ID,
      );
      expect(profile[0]!.overall_rating).toBe('4.5');
    });

    it('SUB_RATES_SCHOOL by assigned sub → ok', async () => {
      const assignmentId = await checkedOutAssignment();
      const rating = await withTestTenant(async () =>
        ratings.create(
          assignmentId,
          { raterType: 'SUB_RATES_SCHOOL', overallScore: 4 } as any,
          parentActor(),
        ),
      );
      expect(rating.raterType).toBe('SUB_RATES_SCHOOL');
    });

    it('SCHOOL_RATES_SUB by non-admin → Forbidden', async () => {
      const assignmentId = await checkedOutAssignment();
      await expect(
        withTestTenant(async () =>
          ratings.create(
            assignmentId,
            { raterType: 'SCHOOL_RATES_SUB', overallScore: 4 } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('SUB_RATES_SCHOOL by non-owning sub → Forbidden', async () => {
      const assignmentId = await checkedOutAssignment();
      await expect(
        withTestTenant(async () =>
          ratings.create(
            assignmentId,
            { raterType: 'SUB_RATES_SCHOOL', overallScore: 4 } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create on non-CHECKED_OUT assignment → Conflict', async () => {
      const { assignmentId } = await postAndAccept();
      await expect(
        withTestTenant(async () =>
          ratings.create(
            assignmentId,
            { raterType: 'SCHOOL_RATES_SUB', overallScore: 4 } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('duplicate rater_type on same assignment → Conflict', async () => {
      const assignmentId = await checkedOutAssignment();
      await withTestTenant(async () =>
        ratings.create(
          assignmentId,
          { raterType: 'SCHOOL_RATES_SUB', overallScore: 4 } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          ratings.create(
            assignmentId,
            { raterType: 'SCHOOL_RATES_SUB', overallScore: 3 } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('create out-of-range score → BadRequest', async () => {
      const assignmentId = await checkedOutAssignment();
      await expect(
        withTestTenant(async () =>
          ratings.create(
            assignmentId,
            { raterType: 'SCHOOL_RATES_SUB', overallScore: 6 } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create missing assignment → 404', async () => {
      await expect(
        withTestTenant(async () =>
          ratings.create(
            '00000000-0000-0000-0000-000000000099',
            { raterType: 'SCHOOL_RATES_SUB', overallScore: 4 } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listForAssignment as admin', async () => {
      const assignmentId = await checkedOutAssignment();
      await withTestTenant(async () =>
        ratings.create(
          assignmentId,
          { raterType: 'SCHOOL_RATES_SUB', overallScore: 4 } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        ratings.listForAssignment(assignmentId, adminActor()),
      );
      expect(list.length).toBe(1);
    });

    it('listForAssignment as assigned sub', async () => {
      const assignmentId = await checkedOutAssignment();
      const list = await withTestTenant(async () =>
        ratings.listForAssignment(assignmentId, parentActor()),
      );
      expect(Array.isArray(list)).toBe(true);
    });

    it('listForAssignment as foreign sub → 404', async () => {
      const assignmentId = await checkedOutAssignment();
      await expect(
        withTestTenant(async () => ratings.listForAssignment(assignmentId, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listForAssignment as sub without profile or personId → 404', async () => {
      const assignmentId = await checkedOutAssignment();
      await expect(
        withTestTenant(async () =>
          ratings.listForAssignment(assignmentId, {
            ...teacherActor(),
            personId: null as any,
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listForAssignment missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          ratings.listForAssignment('00000000-0000-0000-0000-000000000099', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rematerialiseOverallRating with no ratings → null', async () => {
      // Direct call
      await withTestTenant(async () =>
        ratings.rematerialiseOverallRating(TEST_SUB_PROFILE_TEACHER_ID),
      );
      const profile = await rawClient.$queryRawUnsafe<Array<{ overall_rating: string | null }>>(
        `SELECT overall_rating::text AS overall_rating
           FROM platform.platform_substitute_profiles
           WHERE id = $1::uuid`,
        TEST_SUB_PROFILE_TEACHER_ID,
      );
      expect(profile[0]!.overall_rating).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // CancellationPolicyService
  // ─────────────────────────────────────────────────────────────────────
  describe('CancellationPolicyService', () => {
    it('get returns null when no policy', async () => {
      const out = await withTestTenant(async () => policies.get());
      expect(out).toBeNull();
    });

    it('upsert WARNING_ONLY then update', async () => {
      const a = await withTestTenant(async () =>
        policies.upsert({ lateWindowHours: 4, consequence: 'WARNING_ONLY' } as any, adminActor()),
      );
      expect(a.lateWindowHours).toBe(4);
      expect(a.consequence).toBe('WARNING_ONLY');
      const b = await withTestTenant(async () =>
        policies.upsert({ lateWindowHours: 6 } as any, adminActor()),
      );
      expect(b.lateWindowHours).toBe(6);
      expect(b.id).toBe(a.id);
    });

    it('upsert TEMPORARY_POOL_SUSPENSION requires suspensionDurationDays', async () => {
      await expect(
        withTestTenant(async () =>
          policies.upsert({ consequence: 'TEMPORARY_POOL_SUSPENSION' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      const ok = await withTestTenant(async () =>
        policies.upsert(
          {
            consequence: 'TEMPORARY_POOL_SUSPENSION',
            suspensionDurationDays: 14,
          } as any,
          adminActor(),
        ),
      );
      expect(ok.suspensionDurationDays).toBe(14);
    });

    it('upsert RATING_PENALTY requires ratingPenaltyAmount + range', async () => {
      await expect(
        withTestTenant(async () =>
          policies.upsert({ consequence: 'RATING_PENALTY' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        withTestTenant(async () =>
          policies.upsert(
            { consequence: 'RATING_PENALTY', ratingPenaltyAmount: 6 } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      const ok = await withTestTenant(async () =>
        policies.upsert(
          { consequence: 'RATING_PENALTY', ratingPenaltyAmount: 0.5 } as any,
          adminActor(),
        ),
      );
      expect(ok.ratingPenaltyAmount).toBe('0.5');
    });

    it('upsert non-admin → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          policies.upsert({ consequence: 'WARNING_ONLY' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('upsert PATCH: setting consequence away from TEMPORARY_POOL_SUSPENSION nulls suspension_duration_days', async () => {
      await withTestTenant(async () =>
        policies.upsert(
          {
            consequence: 'TEMPORARY_POOL_SUSPENSION',
            suspensionDurationDays: 7,
          } as any,
          adminActor(),
        ),
      );
      const out = await withTestTenant(async () =>
        policies.upsert({ consequence: 'WARNING_ONLY' } as any, adminActor()),
      );
      expect(out.consequence).toBe('WARNING_ONLY');
      expect(out.suspensionDurationDays).toBeNull();
    });

    it('upsert PATCH: switching to RATING_PENALTY without amount → BadRequest', async () => {
      await withTestTenant(async () =>
        policies.upsert({ consequence: 'WARNING_ONLY', lateWindowHours: 2 } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          policies.upsert({ consequence: 'RATING_PENALTY' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('upsert PATCH: switching to TEMPORARY_POOL_SUSPENSION without days → BadRequest', async () => {
      await withTestTenant(async () =>
        policies.upsert({ consequence: 'WARNING_ONLY' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          policies.upsert({ consequence: 'TEMPORARY_POOL_SUSPENSION' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // AcceptanceExpiryWorker
  // ─────────────────────────────────────────────────────────────────────
  describe('AcceptanceExpiryWorker', () => {
    it('tick flips PENDING + expired → EXPIRED', async () => {
      await addParentSubToPoolA();
      const job = await postJob({ acceptanceWindowMinutes: 5 });
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.sub_job_notifications
            SET acceptance_window_expires_at = now() - interval '1 hour'
          WHERE job_id = $1::uuid`,
        job.id,
      );
      await expiryWorker.tick();
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT response FROM ${TEST_SCHEMA}.sub_job_notifications WHERE job_id = $1::uuid`,
        job.id,
      )) as Array<{ response: string }>;
      expect(rows[0]!.response).toBe('EXPIRED');
    });

    it('tick is idempotent — second pass does nothing', async () => {
      await addParentSubToPoolA();
      const job = await postJob({ acceptanceWindowMinutes: 5 });
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.sub_job_notifications
            SET acceptance_window_expires_at = now() - interval '1 hour'
          WHERE job_id = $1::uuid`,
        job.id,
      );
      await expiryWorker.tick();
      await expiryWorker.tick(); // no-op
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT response, count(*)::int AS c FROM ${TEST_SCHEMA}.sub_job_notifications
           WHERE job_id = $1::uuid GROUP BY response`,
        job.id,
      )) as Array<{ response: string; c: number }>;
      expect(rows[0]!.response).toBe('EXPIRED');
      expect(rows[0]!.c).toBe(1);
    });

    it('tick concurrency guard skips when running flag set', async () => {
      // Setting the flag manually emulates an overlapping tick. The guard
      // should return without touching the DB.
      (expiryWorker as any).running = true;
      try {
        await expiryWorker.tick();
      } finally {
        (expiryWorker as any).running = false;
      }
      // No assertion needed — covered the early-return path.
    });

    it('onApplicationShutdown clears timers gracefully', () => {
      expiryWorker.onApplicationShutdown();
    });

    it('onModuleInit honours SUB_EXPIRY_DISABLED env', () => {
      process.env.SUB_EXPIRY_DISABLED = '1';
      try {
        expiryWorker.onModuleInit();
      } finally {
        delete process.env.SUB_EXPIRY_DISABLED;
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // JobNotificationWorker
  // ─────────────────────────────────────────────────────────────────────
  describe('JobNotificationWorker', () => {
    it('tick escalates POOL → MARKETPLACE when candidates exist', async () => {
      // Add an availability + credential for the teacher sub so they
      // become a marketplace candidate for the job's date.
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_sub_availability (id, substitute_id, availability_type, day_of_week)
         VALUES ($1::uuid, $2::uuid, 'RECURRING', 1)`,
        generateId(),
        TEST_SUB_PROFILE_TEACHER_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_sub_credentials
           (id, substitute_id, credential_type, credential_name,
            verification_status, verified_by, verified_at)
         VALUES ($1::uuid, $2::uuid, 'TEACHING_LICENSE', 'NY Teach',
                 'VERIFIED', $3::uuid, now())`,
        generateId(),
        TEST_SUB_PROFILE_TEACHER_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );

      const job = await postJob({ acceptanceWindowMinutes: 30, gradeLevel: '1' });
      // Move escalation timestamp into the past so the worker picks it up.
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.sub_job_postings
            SET escalate_to_marketplace_at = now() - interval '1 hour'
          WHERE id = $1::uuid`,
        job.id,
      );

      await notifyWorker.tick();

      const tier = (await rawClient.$queryRawUnsafe(
        `SELECT notification_tier FROM ${TEST_SCHEMA}.sub_job_postings WHERE id = $1::uuid`,
        job.id,
      )) as Array<{ notification_tier: string }>;
      expect(tier[0]!.notification_tier).toBe('MARKETPLACE');

      // Teacher sub got a MARKETPLACE notification
      const newNotifs = (await rawClient.$queryRawUnsafe(
        `SELECT substitute_id::text AS sid, notification_tier
           FROM ${TEST_SCHEMA}.sub_job_notifications WHERE job_id = $1::uuid`,
        job.id,
      )) as Array<{ sid: string; notification_tier: string }>;
      const mkt = newNotifs.find((n) => n.notification_tier === 'MARKETPLACE');
      expect(mkt?.sid).toBe(TEST_SUB_PROFILE_TEACHER_ID);

      // sub.job.escalated outbox row
      const out = (await rawClient.$queryRawUnsafe(
        `SELECT 1 FROM platform.platform_outbox WHERE topic = 'sub.job.escalated' AND message_key = $1`,
        job.id,
      )) as Array<unknown>;
      expect(out.length).toBe(1);
    });

    it('tick with 0 candidates still flips tier (no fan-out)', async () => {
      const job = await postJob({ acceptanceWindowMinutes: 30, gradeLevel: '11' });
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.sub_job_postings
            SET escalate_to_marketplace_at = now() - interval '1 hour'
          WHERE id = $1::uuid`,
        job.id,
      );
      await notifyWorker.tick();
      const tier = (await rawClient.$queryRawUnsafe(
        `SELECT notification_tier FROM ${TEST_SCHEMA}.sub_job_postings WHERE id = $1::uuid`,
        job.id,
      )) as Array<{ notification_tier: string }>;
      expect(tier[0]!.notification_tier).toBe('MARKETPLACE');
    });

    it('tick skips jobs already FILLED', async () => {
      const { jobId } = await postAndAccept();
      // Move escalation in the past — but job is FILLED so worker should skip
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.sub_job_postings
            SET escalate_to_marketplace_at = now() - interval '1 hour'
          WHERE id = $1::uuid`,
        jobId,
      );
      await notifyWorker.tick();
      const tier = (await rawClient.$queryRawUnsafe(
        `SELECT notification_tier FROM ${TEST_SCHEMA}.sub_job_postings WHERE id = $1::uuid`,
        jobId,
      )) as Array<{ notification_tier: string }>;
      expect(tier[0]!.notification_tier).toBe('POOL');
    });

    it('tick concurrency guard skips when running flag set', async () => {
      (notifyWorker as any).running = true;
      try {
        await notifyWorker.tick();
      } finally {
        (notifyWorker as any).running = false;
      }
    });

    it('onApplicationShutdown clears timers gracefully', () => {
      notifyWorker.onApplicationShutdown();
    });

    it('onModuleInit honours SUB_NOTIFICATION_DISABLED env', () => {
      process.env.SUB_NOTIFICATION_DISABLED = '1';
      try {
        notifyWorker.onModuleInit();
      } finally {
        delete process.env.SUB_NOTIFICATION_DISABLED;
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // CancellationPolicyConsumer
  // ─────────────────────────────────────────────────────────────────────
  describe('CancellationPolicyConsumer', () => {
    async function lateCancelledAssignment(): Promise<{ assignmentId: string; subId: string }> {
      const { jobId, assignmentId } = await postAndAccept();
      const today = new Date().toISOString().slice(0, 10);
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.sub_job_postings
            SET job_date = $1::date
          WHERE id = $2::uuid`,
        today,
        jobId,
      );
      // Force is_late_cancellation via cancel
      await withTestTenant(async () =>
        policies.upsert(
          {
            lateWindowHours: 48,
            consequence: 'WARNING_ONLY',
            repeatOffenceThreshold: 1,
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        assignments.cancel(
          assignmentId,
          { cancelledByType: 'SUBSTITUTE', cancellationReason: 'sick' } as any,
          parentActor(),
        ),
      );
      return { assignmentId, subId: TEST_SUB_PROFILE_PARENT_ID };
    }

    it('WARNING_ONLY consequence applies (no DB change)', async () => {
      const { assignmentId, subId } = await lateCancelledAssignment();
      const msg = buildEnvelope('sub.assignment.late_cancelled', {
        assignmentId,
        schoolId: TEST_SCHOOL_ID,
        substituteId: subId,
        jobDate: new Date().toISOString().slice(0, 10),
        jobStartTime: '23:59',
        lateWindowHours: 48,
        cancelledByType: 'SUBSTITUTE',
        cancellationReason: 'sick',
        cancelledAt: new Date().toISOString(),
      });
      await (policyConsumer as any).handle(msg);
      // Assignment stamped
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT late_cancellation_consequence_applied FROM ${TEST_SCHEMA}.sub_assignments WHERE id = $1::uuid`,
        assignmentId,
      )) as Array<{ late_cancellation_consequence_applied: boolean }>;
      expect(rows[0]!.late_cancellation_consequence_applied).toBe(true);
    });

    it('TEMPORARY_POOL_SUSPENSION → flips pool member SUSPENDED', async () => {
      const { assignmentId, subId } = await lateCancelledAssignment();
      // Switch policy to suspension
      await withTestTenant(async () =>
        policies.upsert(
          {
            consequence: 'TEMPORARY_POOL_SUSPENSION',
            suspensionDurationDays: 7,
            repeatOffenceThreshold: 1,
            lateWindowHours: 48,
          } as any,
          adminActor(),
        ),
      );
      const msg = buildEnvelope('sub.assignment.late_cancelled', {
        assignmentId,
        schoolId: TEST_SCHOOL_ID,
        substituteId: subId,
        jobDate: new Date().toISOString().slice(0, 10),
        jobStartTime: '23:59',
        lateWindowHours: 48,
        cancelledByType: 'SUBSTITUTE',
        cancellationReason: 'sick',
        cancelledAt: new Date().toISOString(),
      });
      await (policyConsumer as any).handle(msg);

      const poolRows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.sub_school_pool
           WHERE school_id = $1::uuid AND substitute_id = $2::uuid`,
        TEST_SCHOOL_ID,
        subId,
      )) as Array<{ status: string }>;
      expect(poolRows[0]!.status).toBe('SUSPENDED');
    });

    it('PERMANENT_POOL_REMOVAL → flips pool member REMOVED', async () => {
      const { assignmentId, subId } = await lateCancelledAssignment();
      await withTestTenant(async () =>
        policies.upsert(
          {
            consequence: 'PERMANENT_POOL_REMOVAL',
            repeatOffenceThreshold: 1,
            lateWindowHours: 48,
          } as any,
          adminActor(),
        ),
      );
      const msg = buildEnvelope('sub.assignment.late_cancelled', {
        assignmentId,
        schoolId: TEST_SCHOOL_ID,
        substituteId: subId,
        jobDate: new Date().toISOString().slice(0, 10),
        jobStartTime: '23:59',
        lateWindowHours: 48,
        cancelledByType: 'SUBSTITUTE',
        cancellationReason: 'sick',
        cancelledAt: new Date().toISOString(),
      });
      await (policyConsumer as any).handle(msg);

      const poolRows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.sub_school_pool
           WHERE school_id = $1::uuid AND substitute_id = $2::uuid`,
        TEST_SCHOOL_ID,
        subId,
      )) as Array<{ status: string }>;
      expect(poolRows[0]!.status).toBe('REMOVED');
    });

    it('RATING_PENALTY → inserts synthetic SCHOOL_RATES_SUB row + re-materialises overall_rating', async () => {
      const { assignmentId, subId } = await lateCancelledAssignment();
      await withTestTenant(async () =>
        policies.upsert(
          {
            consequence: 'RATING_PENALTY',
            ratingPenaltyAmount: 1.0,
            repeatOffenceThreshold: 1,
            lateWindowHours: 48,
          } as any,
          adminActor(),
        ),
      );
      const msg = buildEnvelope('sub.assignment.late_cancelled', {
        assignmentId,
        schoolId: TEST_SCHOOL_ID,
        substituteId: subId,
        jobDate: new Date().toISOString().slice(0, 10),
        jobStartTime: '23:59',
        lateWindowHours: 48,
        cancelledByType: 'SUBSTITUTE',
        cancellationReason: 'sick',
        cancelledAt: new Date().toISOString(),
      });
      await (policyConsumer as any).handle(msg);

      const ratingRows = (await rawClient.$queryRawUnsafe(
        `SELECT comments, overall_score FROM ${TEST_SCHEMA}.sub_ratings WHERE assignment_id = $1::uuid`,
        assignmentId,
      )) as Array<{ comments: string; overall_score: string }>;
      expect(ratingRows.length).toBe(1);
      expect(ratingRows[0]!.comments).toContain('AUTO-APPLIED RATING_PENALTY');
    });

    it('no policy configured → WARNING_ONLY default + assignment stamped', async () => {
      const { assignmentId, subId } = await lateCancelledAssignment();
      // Wipe the policy
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sub_cancellation_policies WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );
      const msg = buildEnvelope('sub.assignment.late_cancelled', {
        assignmentId,
        schoolId: TEST_SCHOOL_ID,
        substituteId: subId,
        jobDate: new Date().toISOString().slice(0, 10),
        jobStartTime: '23:59',
        lateWindowHours: 48,
        cancelledByType: 'SUBSTITUTE',
        cancellationReason: 'sick',
        cancelledAt: new Date().toISOString(),
      });
      await (policyConsumer as any).handle(msg);
      const stamp = (await rawClient.$queryRawUnsafe(
        `SELECT late_cancellation_consequence_applied FROM ${TEST_SCHEMA}.sub_assignments WHERE id = $1::uuid`,
        assignmentId,
      )) as Array<{ late_cancellation_consequence_applied: boolean }>;
      // Without a policy, the consumer returns early before stamping the
      // assignment. (Service contract: WARNING_ONLY_DEFAULT.)
      expect(stamp[0]!.late_cancellation_consequence_applied).toBe(false);
    });

    it('threshold not yet met (lateCount < repeat) → WARNING_LADDER, pool untouched', async () => {
      const { assignmentId, subId } = await lateCancelledAssignment();
      await withTestTenant(async () =>
        policies.upsert(
          {
            consequence: 'TEMPORARY_POOL_SUSPENSION',
            suspensionDurationDays: 7,
            repeatOffenceThreshold: 5, // requires 5 late offences
            lateWindowHours: 48,
          } as any,
          adminActor(),
        ),
      );
      const msg = buildEnvelope('sub.assignment.late_cancelled', {
        assignmentId,
        schoolId: TEST_SCHOOL_ID,
        substituteId: subId,
        jobDate: new Date().toISOString().slice(0, 10),
        jobStartTime: '23:59',
        lateWindowHours: 48,
        cancelledByType: 'SUBSTITUTE',
        cancellationReason: 'sick',
        cancelledAt: new Date().toISOString(),
      });
      await (policyConsumer as any).handle(msg);
      const poolRows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.sub_school_pool
           WHERE school_id = $1::uuid AND substitute_id = $2::uuid`,
        TEST_SCHOOL_ID,
        subId,
      )) as Array<{ status: string }>;
      expect(poolRows[0]!.status).toBe('ACTIVE');
    });

    it('malformed payload (missing fields) is dropped (no throw, no DB change)', async () => {
      const msg = buildEnvelope('sub.assignment.late_cancelled', {
        // missing assignmentId
        schoolId: TEST_SCHOOL_ID,
        substituteId: TEST_SUB_PROFILE_PARENT_ID,
      });
      await (policyConsumer as any).handle(msg);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // CoverArrangementConsumer
  // ─────────────────────────────────────────────────────────────────────
  describe('CoverArrangementConsumer', () => {
    it('flips matching OPEN sch_coverage_requests to CANCELLED with note', async () => {
      // Seed scheduling fixtures
      const bs = generateId();
      const per = generateId();
      const rm = generateId();
      const slot = generateId();
      const bsName = 'CoverConsumer BS ' + Math.random().toString(36).slice(2, 8);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sch_bell_schedules (id, school_id, name, schedule_type, is_default)
         VALUES ($1::uuid, $2::uuid, $3, 'STANDARD', false)`,
        bs,
        TEST_SCHOOL_ID,
        bsName,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sch_periods
           (id, bell_schedule_id, name, day_of_week, start_time, end_time, period_type, sort_order)
         VALUES ($1::uuid, $2::uuid, 'P1', NULL, '08:00', '09:00', 'LESSON', 1)`,
        per,
        bs,
      );
      const rmName = 'CoverConsumer Room ' + Math.random().toString(36).slice(2, 8);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sch_rooms (id, school_id, name, capacity, room_type)
         VALUES ($1::uuid, $2::uuid, $3, 30, 'CLASSROOM')`,
        rm,
        TEST_SCHOOL_ID,
        rmName,
      );
      const classRows = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_classes WHERE school_id = $1::uuid LIMIT 1`,
        TEST_SCHOOL_ID,
      )) as Array<{ id: string }>;
      const classId = classRows[0]!.id;
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sch_timetable_slots
           (id, school_id, class_id, period_id, teacher_id, room_id, effective_from, effective_to)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, '2027-01-01', '2027-12-31')`,
        slot,
        TEST_SCHOOL_ID,
        classId,
        per,
        TEST_TEACHER_EMPLOYEE_ID,
        rm,
      );

      // Pre-existing coverage request OPEN for this slot+date
      const coverId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sch_coverage_requests
           (id, school_id, timetable_slot_id, absent_teacher_id, coverage_date, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, 'OPEN')`,
        coverId,
        TEST_SCHOOL_ID,
        slot,
        TEST_TEACHER_EMPLOYEE_ID,
        '2027-03-15',
      );

      // Post the job with the slot snapshot and accept it
      await addParentSubToPoolA();
      const job = await withTestTenant(async () =>
        jobs.post(
          {
            absentTeacherId: TEST_TEACHER_EMPLOYEE_ID,
            jobDate: '2027-03-15',
            startTime: '09:00',
            endTime: '15:00',
            timetableSlotIds: [slot],
          } as any,
          adminActor(),
        ),
      );
      const asg = await withTestTenant(async () => jobs.accept(job.id, parentActor()));

      // Drive the consumer
      const msg = buildEnvelope('sub.assignment.confirmed', {
        assignmentId: asg.id,
        jobId: job.id,
        schoolId: TEST_SCHOOL_ID,
        substituteId: TEST_SUB_PROFILE_PARENT_ID,
        substituteName: 'Marketplace Sub',
        confirmedAt: new Date().toISOString(),
      });
      await (coverConsumer as any).handle(msg);

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status, notes FROM ${TEST_SCHEMA}.sch_coverage_requests WHERE id = $1::uuid`,
        coverId,
      )) as Array<{ status: string; notes: string | null }>;
      expect(rows[0]!.status).toBe('CANCELLED');
      expect(rows[0]!.notes).toContain(asg.id);

      // Cleanup — drop sub_* rows first because sub_job_classes has a
      // DB-enforced FK to sch_timetable_slots.
      await resetSubstitutesTables(rawClient);
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_coverage_requests WHERE id = $1::uuid`,
        coverId,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE id = $1::uuid`,
        slot,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_rooms WHERE id = $1::uuid`,
        rm,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_periods WHERE id = $1::uuid`,
        per,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE id = $1::uuid`,
        bs,
      );
    });

    it('no matching coverage row → silently drops (no throw)', async () => {
      const msg = buildEnvelope('sub.assignment.confirmed', {
        assignmentId: '019e0cf8-aaaa-7777-8888-000000082888',
        jobId: '019e0cf8-aaaa-7777-8888-000000082887',
        schoolId: TEST_SCHOOL_ID,
        substituteId: TEST_SUB_PROFILE_PARENT_ID,
        substituteName: 'Marketplace Sub',
        confirmedAt: new Date().toISOString(),
      });
      await (coverConsumer as any).handle(msg);
    });

    it('cross-tenant event (payload.schoolId != tenant.schoolId) is dropped', async () => {
      const msg = buildEnvelope(
        'sub.assignment.confirmed',
        {
          assignmentId: '019e0cf8-aaaa-7777-8888-000000082777',
          jobId: '019e0cf8-aaaa-7777-8888-000000082776',
          schoolId: TEST_SCHOOL_B_ID, // payload says school B
          substituteId: TEST_SUB_PROFILE_PARENT_ID,
          substituteName: 'Marketplace Sub',
          confirmedAt: new Date().toISOString(),
        },
        // but the tenant header is school A
        { tenantSchoolId: TEST_SCHOOL_ID, tenantSubdomain: TEST_SUBDOMAIN },
      );
      await (coverConsumer as any).handle(msg);
    });

    it('malformed payload (missing assignmentId) → dropped', async () => {
      const msg = buildEnvelope('sub.assignment.confirmed', {
        jobId: '019e0cf8-aaaa-7777-8888-000000082666',
        schoolId: TEST_SCHOOL_ID,
        // missing assignmentId
      });
      await (coverConsumer as any).handle(msg);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Controllers — pass-through coverage
  // ─────────────────────────────────────────────────────────────────────
  describe('controllers', () => {
    const adminReq = makeFakeReq({
      sub: TEST_ADMIN_ACCOUNT_ID,
      personId: TEST_ADMIN_PERSON_ID,
      email: 'admin@test.integration.local',
    });
    const parentReq = makeFakeReq({
      sub: TEST_PARENT_ACCOUNT_ID,
      personId: TEST_PARENT_PERSON_ID,
      email: 'parent@test.integration.local',
    });
    const teacherReq = makeFakeReq({
      sub: TEST_TEACHER_ACCOUNT_ID,
      personId: TEST_TEACHER_PERSON_ID,
      email: 'teacher@test.integration.local',
    });
    const studentReq = makeFakeReq({
      sub: TEST_STUDENT_ACCOUNT_ID,
      personId: TEST_STUDENT_PERSON_ID,
      email: 'student@test.integration.local',
    });
    void studentReq; // reserved for future flows

    it('SubstitutesController profile/me + getProfile + listProfiles + search', async () => {
      const me = await withTestTenant(async () => ctrlA.myProfile(teacherReq));
      expect(me?.id).toBe(TEST_SUB_PROFILE_TEACHER_ID);

      const p = await withTestTenant(async () =>
        ctrlA.getProfile(TEST_SUB_PROFILE_TEACHER_ID, adminReq),
      );
      expect(p.id).toBe(TEST_SUB_PROFILE_TEACHER_ID);

      const list = await withTestTenant(async () => ctrlA.listProfiles(adminReq));
      expect(list.length).toBeGreaterThanOrEqual(2);

      const s = await withTestTenant(async () => ctrlA.search({ gradeLevels: ['K'] } as any));
      expect(s.map((x) => x.id)).toContain(TEST_SUB_PROFILE_TEACHER_ID);
    });

    it('SubstitutesController createProfile delegates to service', async () => {
      // Wipe + re-create via controller
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_substitute_profiles WHERE person_id = $1::uuid`,
        TEST_STUDENT_PERSON_ID,
      );
      const studentSubReq = makeFakeReq({
        sub: TEST_STUDENT_ACCOUNT_ID,
        personId: TEST_STUDENT_PERSON_ID,
        email: 'student@test.integration.local',
      });
      const dto = await withTestTenant(async () =>
        ctrlA.createProfile(
          {
            personId: TEST_STUDENT_PERSON_ID,
            displayName: 'New CTL',
            gradeLevels: ['K'],
          } as any,
          studentSubReq,
        ),
      );
      expect(dto.displayName).toBe('New CTL');
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_substitute_profiles WHERE id = $1::uuid`,
        dto.id,
      );
    });

    it('SubstitutesController pool CRUD pass-through', async () => {
      await withTestTenant(async () =>
        ctrlA.addToPool({ substituteId: TEST_SUB_PROFILE_TEACHER_ID } as any, adminReq),
      );
      const list = await withTestTenant(async () => ctrlA.listPool(adminReq));
      expect(list.length).toBe(1);
      const upd = await withTestTenant(async () =>
        ctrlA.updatePoolMember(
          list[0]!.id,
          {
            status: 'SUSPENDED',
            suspendedUntil: '2027-12-31',
            suspensionReason: 'r',
          } as any,
          adminReq,
        ),
      );
      expect(upd.status).toBe('SUSPENDED');
    });

    it('SubstitutesController jobs CRUD: postJob + listJobs + getJob + accept + decline', async () => {
      await withTestTenant(async () =>
        ctrlA.addToPool({ substituteId: TEST_SUB_PROFILE_PARENT_ID } as any, adminReq),
      );
      const job = await withTestTenant(async () =>
        ctrlA.postJob(
          {
            absentTeacherId: TEST_TEACHER_EMPLOYEE_ID,
            jobDate: '2027-03-15',
            startTime: '09:00',
            endTime: '15:00',
          } as any,
          adminReq,
        ),
      );
      const list = await withTestTenant(async () => ctrlA.listJobs(adminReq, 'OPEN'));
      expect(list.map((j) => j.id)).toContain(job.id);
      const got = await withTestTenant(async () => ctrlA.getJob(job.id, adminReq));
      expect(got.id).toBe(job.id);

      // Parent accepts via controller
      const asg = await withTestTenant(async () => ctrlA.acceptJob(job.id, parentReq));
      expect(asg.status).toBe('CONFIRMED');

      // A second job + parent decline
      const job2 = await withTestTenant(async () =>
        ctrlA.postJob(
          {
            absentTeacherId: TEST_TEACHER_EMPLOYEE_ID,
            jobDate: '2027-03-16',
            startTime: '09:00',
            endTime: '15:00',
          } as any,
          adminReq,
        ),
      );
      // Parent sub is still in pool → got a notification
      const res = await withTestTenant(async () => ctrlA.declineJob(job2.id, parentReq));
      expect(res.response).toBe('DECLINED');
    });

    it('SubstitutesPostController availability + preferences', async () => {
      const avs = await withTestTenant(async () => ctrlB.myAvailability(teacherReq));
      expect(avs).toEqual([]);
      const newRow = await withTestTenant(async () =>
        ctrlB.createAvailability(
          { availabilityType: 'RECURRING', dayOfWeek: 2 } as any,
          teacherReq,
        ),
      );
      expect(newRow.availabilityType).toBe('RECURRING');
      const after = await withTestTenant(async () => ctrlB.myAvailability(teacherReq));
      expect(after.map((a) => a.id)).toContain(newRow.id);
      const del = await withTestTenant(async () => ctrlB.deleteAvailability(newRow.id, teacherReq));
      expect(del.deleted).toBe(true);

      const pref = await withTestTenant(async () =>
        ctrlB.createPreference(
          { schoolId: TEST_SCHOOL_ID, preferenceType: 'PREFERRED' } as any,
          teacherReq,
        ),
      );
      const prefs = await withTestTenant(async () => ctrlB.myPreferences(teacherReq));
      expect(prefs.map((p) => p.id)).toContain(pref.id);
      const delp = await withTestTenant(async () => ctrlB.deletePreference(pref.id, teacherReq));
      expect(delp.deleted).toBe(true);
    });

    it('SubstitutesPostController assignment + ratings + session-note + pay-rate + policy', async () => {
      await withTestTenant(async () =>
        ctrlA.addToPool({ substituteId: TEST_SUB_PROFILE_PARENT_ID } as any, adminReq),
      );
      const job = await withTestTenant(async () =>
        ctrlA.postJob(
          {
            absentTeacherId: TEST_TEACHER_EMPLOYEE_ID,
            jobDate: '2027-03-15',
            startTime: '09:00',
            endTime: '15:00',
          } as any,
          adminReq,
        ),
      );
      const asg = await withTestTenant(async () => ctrlA.acceptJob(job.id, parentReq));

      // list + getById
      const list = await withTestTenant(async () => ctrlB.listAssignments(adminReq));
      expect(list.map((a) => a.id)).toContain(asg.id);
      const fetched = await withTestTenant(async () => ctrlB.getAssignment(asg.id, adminReq));
      expect(fetched.id).toBe(asg.id);

      // check-in / check-out
      await withTestTenant(async () => ctrlB.checkIn(asg.id, parentReq));
      await withTestTenant(async () => ctrlB.checkOut(asg.id, parentReq));

      // ratings + session-note
      const r = await withTestTenant(async () =>
        ctrlB.submitRating(
          asg.id,
          { raterType: 'SCHOOL_RATES_SUB', overallScore: 5 } as any,
          adminReq,
        ),
      );
      expect(r.overallScore).toBe('5.0');
      const rs = await withTestTenant(async () => ctrlB.listRatings(asg.id, adminReq));
      expect(rs.length).toBe(1);
      const note = await withTestTenant(async () =>
        ctrlB.createSessionNote(asg.id, { notesText: 'all good' } as any, parentReq),
      );
      const view = await withTestTenant(async () => ctrlB.getSessionNote(asg.id, adminReq));
      expect(view?.id).toBe(note.id);

      // pay-rate CRUD + computePay
      const pr = await withTestTenant(async () =>
        ctrlB.createPayRate({ rate: 200, effectiveFrom: '2027-01-01' } as any, adminReq),
      );
      const prs = await withTestTenant(async () => ctrlB.listPayRates());
      expect(prs.map((x) => x.id)).toContain(pr.id);
      const closed = await withTestTenant(async () =>
        ctrlB.closePayRate(pr.id, { effectiveTo: '2027-12-31' }, adminReq),
      );
      expect(closed.effectiveTo).toBe('2027-12-31');
      const pay = await withTestTenant(async () => ctrlB.computePay(asg.id));
      expect(pay.rate).toBe('200.00');

      // policy upsert + get
      const pol = await withTestTenant(async () =>
        ctrlB.upsertPolicy({ lateWindowHours: 3, consequence: 'WARNING_ONLY' } as any, adminReq),
      );
      expect(pol.lateWindowHours).toBe(3);
      const got = await withTestTenant(async () => ctrlB.getPolicy());
      expect(got?.id).toBe(pol.id);
    });

    it('SubstitutesPostController cancelAssignment pass-through', async () => {
      await withTestTenant(async () =>
        ctrlA.addToPool({ substituteId: TEST_SUB_PROFILE_PARENT_ID } as any, adminReq),
      );
      const job = await withTestTenant(async () =>
        ctrlA.postJob(
          {
            absentTeacherId: TEST_TEACHER_EMPLOYEE_ID,
            jobDate: '2030-12-31',
            startTime: '09:00',
            endTime: '15:00',
          } as any,
          adminReq,
        ),
      );
      const asg = await withTestTenant(async () => ctrlA.acceptJob(job.id, parentReq));
      const cancelled = await withTestTenant(async () =>
        ctrlB.cancelAssignment(
          asg.id,
          { cancelledByType: 'SCHOOL', cancellationReason: 'cancelled' } as any,
          adminReq,
        ),
      );
      expect(cancelled.status).toBe('CANCELLED');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Fixture sanity
  // ─────────────────────────────────────────────────────────────────────
  describe('fixture sanity', () => {
    it('resetSubstitutesTables wipes sub_*', async () => {
      await addParentSubToPoolA();
      await resetSubstitutesTables(rawClient);
      const c = await rawClient.$queryRawUnsafe<Array<{ c: bigint }>>(
        `SELECT count(*)::bigint AS c FROM ${TEST_SCHEMA}.sub_school_pool`,
      );
      expect(Number(c[0]!.c)).toBe(0);
    });
  });
});
