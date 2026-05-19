import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import {
  SchedulingCandidateController,
  SchedulingConstraintsController,
  SchedulingGenerateController,
  SchedulingRequestController,
} from '@modules/m22-scheduling/schedule-generation.controller';
import {
  CoTeachingController,
  CoverArrangementController,
  CrossSchoolStaffController,
  ExamSchedulingController,
  PullOutController,
} from '@modules/m22-scheduling/scheduling-advanced-b.controller';
import { ScheduleGenerationService } from '@modules/m22-scheduling/schedule-generation.service';
import { ExamSchedulingService } from '@modules/m22-scheduling/exam-scheduling.service';
import { CoTeachingService } from '@modules/m22-scheduling/coteaching.service';
import { PullOutService } from '@modules/m22-scheduling/pull-out.service';
import { CrossSchoolStaffService } from '@modules/m22-scheduling/cross-school-staff.service';
import { CoverArrangementService } from '@modules/m22-scheduling/cover-arrangement.service';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_TEACHER_EMPLOYEE_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { TEST_SIS_ACADEMIC_YEAR_ID, TEST_SIS_CLASS_ID } from '../fixtures/sis';

/**
 * Controller-layer integration tests for m22-scheduling — the
 * schedule-generation and scheduling-advanced-b controllers.
 *
 * Covers:
 *   - SchedulingConstraintsController
 *   - SchedulingRequestController
 *   - SchedulingGenerateController
 *   - SchedulingCandidateController
 *   - ExamSchedulingController
 *   - CoTeachingController
 *   - PullOutController
 *   - CrossSchoolStaffController
 *   - CoverArrangementController
 *
 * Each controller is constructed with the real service tree and
 * invoked with a synthetic AuthedRequest. The IAM cache is seeded so
 * resolveActor returns isSchoolAdmin=true.
 */
describe('integration:m22-scheduling/controllers-advanced', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let actorContext: ActorContextService;
  let outbox: OutboxService;

  // Services
  let scheduleGenService: ScheduleGenerationService;
  let examService: ExamSchedulingService;
  let coTeachingService: CoTeachingService;
  let pullOutService: PullOutService;
  let crossSchoolService: CrossSchoolStaffService;
  let coverArrangementService: CoverArrangementService;

  // Controllers
  let constraintsController: SchedulingConstraintsController;
  let requestController: SchedulingRequestController;
  let generateController: SchedulingGenerateController;
  let candidateController: SchedulingCandidateController;
  let examController: ExamSchedulingController;
  let coTeachingController: CoTeachingController;
  let pullOutController: PullOutController;
  let crossSchoolController: CrossSchoolStaffController;
  let coverArrangementController: CoverArrangementController;

  // Stable infra
  let bellScheduleId: string;
  let periodId: string;
  let roomId: string;
  let slotId: string;

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

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    actorContext = new ActorContextService(rawClient, permCheck, tenantPrisma);
    outbox = new OutboxService();

    scheduleGenService = new ScheduleGenerationService(tenantPrisma, outbox);
    examService = new ExamSchedulingService(tenantPrisma);
    coTeachingService = new CoTeachingService(tenantPrisma);
    pullOutService = new PullOutService(tenantPrisma);
    crossSchoolService = new CrossSchoolStaffService(tenantPrisma);
    coverArrangementService = new CoverArrangementService(tenantPrisma);

    constraintsController = new SchedulingConstraintsController(scheduleGenService, actorContext);
    requestController = new SchedulingRequestController(scheduleGenService);
    generateController = new SchedulingGenerateController(scheduleGenService, actorContext);
    candidateController = new SchedulingCandidateController(scheduleGenService, actorContext);
    examController = new ExamSchedulingController(examService, actorContext);
    coTeachingController = new CoTeachingController(coTeachingService, actorContext);
    pullOutController = new PullOutController(pullOutService, actorContext);
    crossSchoolController = new CrossSchoolStaffController(crossSchoolService, actorContext);
    coverArrangementController = new CoverArrangementController(
      coverArrangementService,
      actorContext,
    );

    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, ARRAY['sch-001:admin','sch-001:write','sch-001:read','sch-004:admin','sch-004:write','sch-004:read']::text[], now(), 'test')
       ON CONFLICT (account_id, scope_id) DO UPDATE SET permission_codes = EXCLUDED.permission_codes`,
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
    );

    // Pre-wipe.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE source_module = 'scheduling' AND tenant_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_cover_arrangements WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_cross_school_staff_assignments`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_pull_out_interventions WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_coteaching_arrangements`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_exam_sessions WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_activation_log WHERE candidate_id IN (
         SELECT c.id FROM ${TEST_SCHEMA}.sch_scheduling_candidates c
         JOIN ${TEST_SCHEMA}.sch_scheduling_requests r ON r.id = c.request_id
         WHERE r.school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_candidate_slots WHERE candidate_id IN (
         SELECT c.id FROM ${TEST_SCHEMA}.sch_scheduling_candidates c
         JOIN ${TEST_SCHEMA}.sch_scheduling_requests r ON r.id = c.request_id
         WHERE r.school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_candidates WHERE request_id IN (
         SELECT id FROM ${TEST_SCHEMA}.sch_scheduling_requests WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_requests WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_constraints WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rooms WHERE name LIKE 'Ctrl Adv%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_periods WHERE bell_schedule_id IN (SELECT id FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE name LIKE 'Ctrl Adv%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE name LIKE 'Ctrl Adv%'`,
    );

    bellScheduleId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_bell_schedules
         (id, school_id, name, schedule_type, is_default)
       VALUES ($1::uuid, $2::uuid, $3, 'STANDARD', false)`,
      bellScheduleId,
      TEST_SCHOOL_ID,
      'Ctrl Adv Schedule ' + Math.random().toString(36).slice(2, 6),
    );

    // Need enough LESSON periods + rooms so the inline solver can build candidates.
    const periodIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const pid = generateId();
      periodIds.push(pid);
      const startH = 8 + i;
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sch_periods
           (id, bell_schedule_id, name, day_of_week, start_time, end_time, period_type, sort_order)
         VALUES ($1::uuid, $2::uuid, $3, NULL, $4::time, $5::time, 'LESSON', $6::int)`,
        pid,
        bellScheduleId,
        'P' + (i + 1),
        String(startH).padStart(2, '0') + ':00',
        String(startH).padStart(2, '0') + ':45',
        i + 1,
      );
    }
    periodId = periodIds[0]!;

    // Rooms
    roomId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_rooms (id, school_id, name, capacity, room_type)
       VALUES ($1::uuid, $2::uuid, 'Ctrl Adv Room', 30, 'CLASSROOM')`,
      roomId,
      TEST_SCHOOL_ID,
    );
    for (let i = 1; i < 6; i++) {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sch_rooms (id, school_id, name, capacity, room_type)
         VALUES ($1::uuid, $2::uuid, $3, 30, 'CLASSROOM')`,
        generateId(),
        TEST_SCHOOL_ID,
        'Ctrl Adv Room ' + i,
      );
    }

    // Timetable slot used by co-teaching + pull-out controllers
    slotId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_timetable_slots
         (id, school_id, class_id, period_id, teacher_id, room_id, effective_from, effective_to)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, '2027-01-01', '2027-12-31')`,
      slotId,
      TEST_SCHOOL_ID,
      TEST_SIS_CLASS_ID,
      periodId,
      TEST_TEACHER_EMPLOYEE_ID,
      roomId,
    );
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE source_module = 'scheduling' AND tenant_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_cover_arrangements WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_cross_school_staff_assignments`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_pull_out_interventions WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_coteaching_arrangements`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_exam_sessions WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_activation_log WHERE candidate_id IN (
         SELECT c.id FROM ${TEST_SCHEMA}.sch_scheduling_candidates c
         JOIN ${TEST_SCHEMA}.sch_scheduling_requests r ON r.id = c.request_id
         WHERE r.school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_candidate_slots WHERE candidate_id IN (
         SELECT c.id FROM ${TEST_SCHEMA}.sch_scheduling_candidates c
         JOIN ${TEST_SCHEMA}.sch_scheduling_requests r ON r.id = c.request_id
         WHERE r.school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_candidates WHERE request_id IN (
         SELECT id FROM ${TEST_SCHEMA}.sch_scheduling_requests WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_requests WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_constraints WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rooms WHERE name LIKE 'Ctrl Adv%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_periods WHERE bell_schedule_id = $1::uuid`,
      bellScheduleId,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE id = $1::uuid`,
      bellScheduleId,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid AND scope_id = $2::uuid`,
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE source_module = 'scheduling' AND tenant_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_cover_arrangements WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_cross_school_staff_assignments`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_pull_out_interventions WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_coteaching_arrangements`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_exam_sessions WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_activation_log WHERE candidate_id IN (
         SELECT c.id FROM ${TEST_SCHEMA}.sch_scheduling_candidates c
         JOIN ${TEST_SCHEMA}.sch_scheduling_requests r ON r.id = c.request_id
         WHERE r.school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_candidate_slots WHERE candidate_id IN (
         SELECT c.id FROM ${TEST_SCHEMA}.sch_scheduling_candidates c
         JOIN ${TEST_SCHEMA}.sch_scheduling_requests r ON r.id = c.request_id
         WHERE r.school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_candidates WHERE request_id IN (
         SELECT id FROM ${TEST_SCHEMA}.sch_scheduling_requests WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_requests WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_constraints WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // SchedulingConstraints / Request / Generate / Candidate
  // ──────────────────────────────────────────────────────────────────
  describe('Scheduling generation controllers', () => {
    it('constraints: create + list', async () => {
      const created = await withTestTenant(async () =>
        constraintsController.create(
          {
            name: 'Ctrl Constraint ' + Math.random().toString(36).slice(2, 6),
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            hardConstraints: [{ code: 'H1', name: 'no double-book' }],
            softConstraints: [{ code: 'S1', name: 'avoid consecutive', weight: 1 }],
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.name).toContain('Ctrl Constraint');

      const list = await withTestTenant(async () => constraintsController.list());
      expect(list.map((c) => c.id)).toContain(created.id);
    });

    it('generate + request list + request get + candidate flow', async () => {
      const constraint = await withTestTenant(async () =>
        constraintsController.create(
          {
            name: 'Ctrl Constraint Gen ' + Math.random().toString(36).slice(2, 6),
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            hardConstraints: [],
            softConstraints: [],
          } as any,
          fakeAdminReq(),
        ),
      );
      const req = await withTestTenant(async () =>
        generateController.submit(
          { constraintId: constraint.id, sectionCount: 50 } as any,
          fakeAdminReq(),
        ),
      );
      expect(req.status).toBe('COMPLETED');
      expect(req.candidates?.length).toBe(2);

      const list = await withTestTenant(async () => requestController.list());
      expect(list.map((r) => r.id)).toContain(req.id);

      const detail = await withTestTenant(async () => requestController.get(req.id));
      expect(detail.id).toBe(req.id);

      const cleanCandidate = req.candidates!.find((c) => c.totalClashes === 0)!;
      const dirtyCandidate = req.candidates!.find((c) => c.totalClashes > 0)!;

      // Candidate read methods
      const got = await withTestTenant(async () =>
        candidateController.get(cleanCandidate.id),
      );
      expect(got.id).toBe(cleanCandidate.id);

      const slots = await withTestTenant(async () =>
        candidateController.slots(cleanCandidate.id),
      );
      expect(Array.isArray(slots)).toBe(true);

      // Reject the dirty
      const rejected = await withTestTenant(async () =>
        candidateController.reject(
          dirtyCandidate.id,
          { reviewNotes: 'too messy' } as any,
          fakeAdminReq(),
        ),
      );
      expect(rejected.reviewStatus).toBe('REJECTED');

      // Approve the clean one
      const approved = await withTestTenant(async () =>
        candidateController.approve(
          cleanCandidate.id,
          { reviewNotes: 'clean' } as any,
          fakeAdminReq(),
        ),
      );
      expect(approved.reviewStatus).toBe('APPROVED');

      // Activate the approved candidate
      const activation = await withTestTenant(async () =>
        candidateController.activate(cleanCandidate.id, fakeAdminReq()),
      );
      expect(activation).toBeTruthy();

      const activations = await withTestTenant(async () =>
        candidateController.activations(cleanCandidate.id),
      );
      expect(Array.isArray(activations)).toBe(true);
    });

    it('candidate resolveClash flow', async () => {
      const constraint = await withTestTenant(async () =>
        constraintsController.create(
          {
            name: 'Ctrl Constraint Clash ' + Math.random().toString(36).slice(2, 6),
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            hardConstraints: [],
            softConstraints: [],
          } as any,
          fakeAdminReq(),
        ),
      );
      const req = await withTestTenant(async () =>
        generateController.submit(
          { constraintId: constraint.id, sectionCount: 50 } as any,
          fakeAdminReq(),
        ),
      );
      const dirty = req.candidates!.find((c) => c.totalClashes > 0)!;
      const slots = await withTestTenant(async () =>
        candidateController.slots(dirty.id),
      );
      const flagged = slots.find((s) => s.hasClash === true)!;

      const resolved = await withTestTenant(async () =>
        candidateController.resolveClash(
          dirty.id,
          { slotId: flagged.id } as any,
          fakeAdminReq(),
        ),
      );
      expect(resolved.hasClash).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Exam scheduling
  // ──────────────────────────────────────────────────────────────────
  describe('ExamSchedulingController', () => {
    it('create + list + getOne + addRoom + conflicts + invigilator', async () => {
      const session = await withTestTenant(async () =>
        examController.create(
          {
            examName: 'Ctrl Exam ' + Math.random().toString(36).slice(2, 6),
            examDate: '2027-06-15',
            startTime: '09:00',
            endTime: '11:00',
            durationMinutes: 120,
            extraTimeMinutes: 0,
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(session.examName).toContain('Ctrl Exam');

      const list = await withTestTenant(async () => examController.list());
      expect(list.map((s) => s.id)).toContain(session.id);

      const detail = await withTestTenant(async () => examController.getOne(session.id));
      expect(detail.id).toBe(session.id);

      const examRoom = await withTestTenant(async () =>
        examController.addRoom(
          session.id,
          { roomId, capacity: 25, isMainRoom: true } as any,
          fakeAdminReq(),
        ),
      );
      expect(examRoom.roomId).toBe(roomId);

      const conflicts = await withTestTenant(async () => examController.conflicts(session.id));
      expect(Array.isArray(conflicts)).toBe(true);

      const invig = await withTestTenant(async () =>
        examController.invigilator(
          session.id,
          {
            roomId,
            invigilatorId: TEST_TEACHER_EMPLOYEE_ID,
            isLead: true,
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(invig).toBeTruthy();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Co-teaching
  // ──────────────────────────────────────────────────────────────────
  describe('CoTeachingController', () => {
    it('create + list + getOne + patch + remove', async () => {
      const arr = await withTestTenant(async () =>
        coTeachingController.create(
          {
            timetableSlotId: slotId,
            primaryTeacherId: TEST_TEACHER_EMPLOYEE_ID,
            secondaryTeacherId: TEST_ADMIN_EMPLOYEE_ID,
            teachingModel: 'TEAM_TEACHING',
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(arr.primaryTeacherId).toBe(TEST_TEACHER_EMPLOYEE_ID);

      const list = await withTestTenant(async () =>
        coTeachingController.list(slotId),
      );
      expect(list.map((c) => c.id)).toContain(arr.id);

      const detail = await withTestTenant(async () =>
        coTeachingController.getOne(arr.id),
      );
      expect(detail.id).toBe(arr.id);

      const patched = await withTestTenant(async () =>
        coTeachingController.patch(
          arr.id,
          { teachingModel: 'STATION_ROTATION' } as any,
          fakeAdminReq(),
        ),
      );
      expect(patched.teachingModel).toBe('STATION_ROTATION');

      const result = await withTestTenant(async () =>
        coTeachingController.remove(arr.id, fakeAdminReq()),
      );
      expect(result.ok).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Cross-school staff
  // ──────────────────────────────────────────────────────────────────
  describe('CrossSchoolStaffController', () => {
    it('create + list + getOne + patch', async () => {
      const created = await withTestTenant(async () =>
        crossSchoolController.create(
          {
            visitingSchoolId: TEST_SCHOOL_B_ID,
            personId: TEST_ADMIN_PERSON_ID,
            homeEmployeeId: TEST_ADMIN_EMPLOYEE_ID,
            roleAtVisitingSchool: 'Visiting Lecturer',
            effectiveFrom: '2027-09-01',
            effectiveTo: '2027-12-01',
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.visitingSchoolId).toBe(TEST_SCHOOL_B_ID);

      const list = await withTestTenant(async () => crossSchoolController.list());
      expect(list.map((c) => c.id)).toContain(created.id);

      const detail = await withTestTenant(async () =>
        crossSchoolController.getOne(created.id),
      );
      expect(detail.id).toBe(created.id);

      const patched = await withTestTenant(async () =>
        crossSchoolController.patch(
          created.id,
          { notes: 'updated note' } as any,
          fakeAdminReq(),
        ),
      );
      expect(patched.notes).toBe('updated note');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Cover arrangement (controller)
  // ──────────────────────────────────────────────────────────────────
  describe('CoverArrangementController', () => {
    it('create + board + getOne + patchStatus + addClass', async () => {
      const created = await withTestTenant(async () =>
        coverArrangementController.create(
          {
            absentTeacherId: TEST_TEACHER_EMPLOYEE_ID,
            coverDate: '2027-04-20',
            coverType: 'INTERNAL_COVER',
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.status).toBe('PLANNED');

      const board = await withTestTenant(async () =>
        coverArrangementController.board('2027-04-20'),
      );
      expect(board.map((c) => c.id)).toContain(created.id);

      const detail = await withTestTenant(async () =>
        coverArrangementController.getOne(created.id),
      );
      expect(detail.id).toBe(created.id);

      const klass = await withTestTenant(async () =>
        coverArrangementController.addClass(
          created.id,
          {
            affectedClassId: TEST_SIS_CLASS_ID,
            affectedSlotId: slotId,
            disposition: 'COVERED_BY_SUB',
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(klass.affectedClassId).toBe(TEST_SIS_CLASS_ID);

      const updated = await withTestTenant(async () =>
        coverArrangementController.patchStatus(
          created.id,
          { status: 'ACTIVE' } as any,
          fakeAdminReq(),
        ),
      );
      expect(updated.status).toBe('ACTIVE');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Pull-out
  // ──────────────────────────────────────────────────────────────────
  describe('PullOutController', () => {
    it('list returns array (default no-arg)', async () => {
      const list = await withTestTenant(async () => pullOutController.list(undefined));
      expect(Array.isArray(list)).toBe(true);
    });
  });
});
