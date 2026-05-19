import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { RoomController } from '@modules/m22-scheduling/room.controller';
import { RoomBookingController } from '@modules/m22-scheduling/room-booking.controller';
import { RoomChangeRequestController } from '@modules/m22-scheduling/room-change-request.controller';
import { TimetableController } from '@modules/m22-scheduling/timetable.controller';
import { RoomService } from '@modules/m22-scheduling/room.service';
import { RoomBookingService } from '@modules/m22-scheduling/room-booking.service';
import { RoomChangeRequestService } from '@modules/m22-scheduling/room-change-request.service';
import { TimetableService } from '@modules/m22-scheduling/timetable.service';
import { StudentService } from '@modules/m20-sis/students/student.service';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';
import { makeRecordingKafka } from '../helpers/recording-kafka';

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
import { TEST_SIS_CLASS_ID } from '../fixtures/sis';

/**
 * Controller-layer integration tests for m22-scheduling — rooms,
 * room bookings, room change requests, and timetable controllers.
 * Each controller is constructed with the real service tree and
 * invoked with a synthetic AuthedRequest carrying the test admin's
 * identity. The IAM cache is seeded so resolveActor returns
 * isSchoolAdmin=true.
 */
describe('integration:m22-scheduling/controllers-rooms', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let actorContext: ActorContextService;
  let kafka: ReturnType<typeof makeRecordingKafka>;

  let roomService: RoomService;
  let bookingService: RoomBookingService;
  let changeReqService: RoomChangeRequestService;
  let timetableService: TimetableService;
  let studentService: StudentService;

  let roomController: RoomController;
  let bookingController: RoomBookingController;
  let changeReqController: RoomChangeRequestController;
  let timetableController: TimetableController;

  // Stable infra
  let bellScheduleId: string;
  let periodId: string;
  let roomAId: string;
  let roomBId: string;

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
    kafka = makeRecordingKafka();

    roomService = new RoomService(tenantPrisma);
    bookingService = new RoomBookingService(tenantPrisma);
    changeReqService = new RoomChangeRequestService(tenantPrisma);
    studentService = new StudentService(tenantPrisma);
    timetableService = new TimetableService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
      studentService,
    );

    roomController = new RoomController(roomService, actorContext);
    bookingController = new RoomBookingController(bookingService, actorContext);
    changeReqController = new RoomChangeRequestController(changeReqService, actorContext);
    timetableController = new TimetableController(timetableService, actorContext);

    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, ARRAY['sch-001:admin','sch-001:write','sch-001:read','sch-005:admin','sch-005:write','sch-005:read']::text[], now(), 'test')
       ON CONFLICT (account_id, scope_id) DO UPDATE SET permission_codes = EXCLUDED.permission_codes`,
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
    );

    // Pre-wipe.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_room_change_requests WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_room_bookings WHERE room_id IN (SELECT id FROM ${TEST_SCHEMA}.sch_rooms WHERE name LIKE 'Ctrl Room%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rooms WHERE name LIKE 'Ctrl Room%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_periods WHERE bell_schedule_id IN (SELECT id FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE name LIKE 'Ctrl Rooms%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE name LIKE 'Ctrl Rooms%'`,
    );

    // Build infra
    bellScheduleId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_bell_schedules
         (id, school_id, name, schedule_type, is_default)
       VALUES ($1::uuid, $2::uuid, $3, 'STANDARD', false)`,
      bellScheduleId,
      TEST_SCHOOL_ID,
      'Ctrl Rooms Schedule ' + Math.random().toString(36).slice(2, 6),
    );

    periodId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_periods
         (id, bell_schedule_id, name, day_of_week, start_time, end_time, period_type, sort_order)
       VALUES ($1::uuid, $2::uuid, 'P1', 0, '08:00', '09:00', 'LESSON', 1)`,
      periodId,
      bellScheduleId,
    );

    roomAId = generateId();
    roomBId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_rooms (id, school_id, name, capacity, room_type)
       VALUES
         ($1::uuid, $3::uuid, 'Ctrl Room A', 30, 'CLASSROOM'),
         ($2::uuid, $3::uuid, 'Ctrl Room B', 30, 'CLASSROOM')`,
      roomAId,
      roomBId,
      TEST_SCHOOL_ID,
    );
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_room_change_requests WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_room_bookings WHERE room_id IN ($1::uuid, $2::uuid)`,
      roomAId,
      roomBId,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rooms WHERE id IN ($1::uuid, $2::uuid)`,
      roomAId,
      roomBId,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rooms WHERE name LIKE 'Ctrl Room%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_periods WHERE id = $1::uuid`,
      periodId,
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
      `DELETE FROM ${TEST_SCHEMA}.sch_room_change_requests WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_room_bookings WHERE room_id IN ($1::uuid, $2::uuid)`,
      roomAId,
      roomBId,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // RoomController
  // ──────────────────────────────────────────────────────────────────
  describe('RoomController', () => {
    it('create + list + getById + update', async () => {
      const created = await withTestTenant(async () =>
        roomController.create(
          { name: 'Ctrl Room New', capacity: 25, roomType: 'LAB' } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.name).toBe('Ctrl Room New');

      const list = await withTestTenant(async () => roomController.list({} as any));
      expect(list.map((r) => r.id)).toContain(created.id);

      const detail = await withTestTenant(async () => roomController.getById(created.id));
      expect(detail.id).toBe(created.id);

      const updated = await withTestTenant(async () =>
        roomController.update(
          created.id,
          { name: 'Ctrl Room Renamed', isActive: false } as any,
          fakeAdminReq(),
        ),
      );
      expect(updated.name).toBe('Ctrl Room Renamed');
      expect(updated.isActive).toBe(false);

      // Cleanup new room
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_rooms WHERE id = $1::uuid`,
        created.id,
      );
    });

    it('list with includeInactive', async () => {
      const list = await withTestTenant(async () =>
        roomController.list({ includeInactive: true } as any),
      );
      expect(Array.isArray(list)).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // RoomBookingController
  // ──────────────────────────────────────────────────────────────────
  describe('RoomBookingController', () => {
    it('create + list + getById + cancel', async () => {
      const created = await withTestTenant(async () =>
        bookingController.create(
          {
            roomId: roomAId,
            bookingPurpose: 'Ctrl booking',
            startAt: '2027-07-01T10:00:00.000Z',
            endAt: '2027-07-01T11:00:00.000Z',
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.status).toBe('CONFIRMED');

      const list = await withTestTenant(async () =>
        bookingController.list({ roomId: roomAId } as any),
      );
      expect(list.map((b) => b.id)).toContain(created.id);

      const detail = await withTestTenant(async () => bookingController.getById(created.id));
      expect(detail.id).toBe(created.id);

      const cancelled = await withTestTenant(async () =>
        bookingController.cancel(
          created.id,
          { cancelledReason: 'no longer needed' } as any,
          fakeAdminReq(),
        ),
      );
      expect(cancelled.status).toBe('CANCELLED');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // RoomChangeRequestController
  // ──────────────────────────────────────────────────────────────────
  describe('RoomChangeRequestController', () => {
    let slotId: string;

    beforeEach(async () => {
      slotId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sch_timetable_slots
           (id, school_id, class_id, period_id, teacher_id, room_id, effective_from, effective_to)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, '2027-01-10', '2027-06-10')`,
        slotId,
        TEST_SCHOOL_ID,
        TEST_SIS_CLASS_ID,
        periodId,
        TEST_TEACHER_EMPLOYEE_ID,
        roomAId,
      );
    });

    it('create + list + getById', async () => {
      const created = await withTestTenant(async () =>
        changeReqController.create(
          {
            timetableSlotId: slotId,
            requestedRoomId: roomBId,
            requestDate: '2027-03-01',
            reason: 'Needs projector',
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.status).toBe('PENDING');
      expect(created.requestedRoomId).toBe(roomBId);

      const list = await withTestTenant(async () =>
        changeReqController.list({} as any, fakeAdminReq()),
      );
      expect(list.map((r) => r.id)).toContain(created.id);

      const detail = await withTestTenant(async () =>
        changeReqController.getById(created.id, fakeAdminReq()),
      );
      expect(detail.id).toBe(created.id);
    });

    it('approve flow', async () => {
      const created = await withTestTenant(async () =>
        changeReqController.create(
          {
            timetableSlotId: slotId,
            requestedRoomId: roomBId,
            requestDate: '2027-03-02',
            reason: 'Approve me',
          } as any,
          fakeAdminReq(),
        ),
      );
      const approved = await withTestTenant(async () =>
        changeReqController.approve(
          created.id,
          { approvedRoomId: roomBId, reviewNotes: 'OK' } as any,
          fakeAdminReq(),
        ),
      );
      expect(approved.status).toBe('APPROVED');
    });

    it('reject flow', async () => {
      const created = await withTestTenant(async () =>
        changeReqController.create(
          {
            timetableSlotId: slotId,
            requestedRoomId: roomBId,
            requestDate: '2027-03-03',
            reason: 'Reject me',
          } as any,
          fakeAdminReq(),
        ),
      );
      const rejected = await withTestTenant(async () =>
        changeReqController.reject(
          created.id,
          { reviewNotes: 'No' } as any,
          fakeAdminReq(),
        ),
      );
      expect(rejected.status).toBe('REJECTED');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // TimetableController
  // ──────────────────────────────────────────────────────────────────
  describe('TimetableController', () => {
    it('create + list + listForTeacher + listForClass + listForRoom + update + delete', async () => {
      const created = await withTestTenant(async () =>
        timetableController.create(
          {
            classId: TEST_SIS_CLASS_ID,
            periodId,
            teacherId: TEST_TEACHER_EMPLOYEE_ID,
            roomId: roomAId,
            effectiveFrom: '2027-01-10',
            effectiveTo: '2027-06-10',
            notes: 'controller test',
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.classId).toBe(TEST_SIS_CLASS_ID);

      const list = await withTestTenant(async () =>
        timetableController.list({ classId: TEST_SIS_CLASS_ID } as any),
      );
      expect(list.map((s) => s.id)).toContain(created.id);

      const forTeacher = await withTestTenant(async () =>
        timetableController.forTeacher(TEST_TEACHER_EMPLOYEE_ID),
      );
      expect(Array.isArray(forTeacher)).toBe(true);

      const forClass = await withTestTenant(async () =>
        timetableController.forClass(TEST_SIS_CLASS_ID),
      );
      expect(Array.isArray(forClass)).toBe(true);

      const forRoom = await withTestTenant(async () =>
        timetableController.forRoom(roomAId),
      );
      expect(Array.isArray(forRoom)).toBe(true);

      const updated = await withTestTenant(async () =>
        timetableController.update(
          created.id,
          { notes: 'updated note' } as any,
          fakeAdminReq(),
        ),
      );
      expect(updated.notes).toBe('updated note');

      const deleted = await withTestTenant(async () =>
        timetableController.delete(created.id, fakeAdminReq()),
      );
      expect(deleted.deleted).toBe(true);
    });
  });
});
