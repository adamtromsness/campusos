import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { RotationService } from '@modules/m22-scheduling/rotation.service';
import { RoomChangeRequestService } from '@modules/m22-scheduling/room-change-request.service';
import { CoTeachingService } from '@modules/m22-scheduling/coteaching.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  TEST_TEACHER_EMPLOYEE_ID,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import { TEST_SIS_ACADEMIC_YEAR_ID, TEST_SIS_CLASS_ID } from '../fixtures/sis';

/**
 * m22-scheduling rotations / room-change-requests / co-teaching tests.
 * Covers:
 *   - RotationService (381 lines)
 *   - RoomChangeRequestService (286 lines)
 *   - CoTeachingService (277 lines)
 */
describe('integration:m22-scheduling/rotations', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let rotationService: RotationService;
  let roomChangeService: RoomChangeRequestService;
  let coteachingService: CoTeachingService;

  // Stable infrastructure
  let bellScheduleId: string;
  let periodId: string;
  let roomAId: string;
  let roomBId: string;
  let slotId: string;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    rotationService = new RotationService(tenantPrisma);
    roomChangeService = new RoomChangeRequestService(tenantPrisma);
    coteachingService = new CoTeachingService(tenantPrisma);

    // Wipe.
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sch_coteaching_arrangements`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_room_change_requests WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rotation_calendar WHERE rotation_cycle_id IN (SELECT id FROM ${TEST_SCHEMA}.sch_rotation_cycles WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rotation_cycles WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rooms WHERE name LIKE 'Rot Test%' AND school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_periods WHERE bell_schedule_id IN (SELECT id FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE name LIKE 'Rot Test%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE name LIKE 'Rot Test%'`,
    );

    bellScheduleId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_bell_schedules
         (id, school_id, name, schedule_type, is_default)
       VALUES ($1::uuid, $2::uuid, $3, 'STANDARD', false)`,
      bellScheduleId,
      TEST_SCHOOL_ID,
      'Rot Test Schedule ' + Math.random().toString(36).slice(2, 6),
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
         ($1::uuid, $3::uuid, 'Rot Test Room A', 30, 'CLASSROOM'),
         ($2::uuid, $3::uuid, 'Rot Test Room B', 30, 'CLASSROOM')`,
      roomAId,
      roomBId,
      TEST_SCHOOL_ID,
    );

    slotId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_timetable_slots
         (id, school_id, class_id, period_id, teacher_id, room_id, effective_from, effective_to)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, '2027-01-10', '2027-06-30')`,
      slotId,
      TEST_SCHOOL_ID,
      TEST_SIS_CLASS_ID,
      periodId,
      TEST_TEACHER_EMPLOYEE_ID,
      roomAId,
    );
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sch_coteaching_arrangements`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_room_change_requests WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rotation_calendar WHERE rotation_cycle_id IN (SELECT id FROM ${TEST_SCHEMA}.sch_rotation_cycles WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rotation_cycles WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE id = $1::uuid`,
      slotId,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rooms WHERE id IN ($1::uuid, $2::uuid)`,
      roomAId,
      roomBId,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_periods WHERE id = $1::uuid`,
      periodId,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE id = $1::uuid`,
      bellScheduleId,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sch_coteaching_arrangements`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_room_change_requests WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rotation_calendar WHERE rotation_cycle_id IN (SELECT id FROM ${TEST_SCHEMA}.sch_rotation_cycles WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rotation_cycles WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // RotationService
  // ────────────────────────────────────────────────────────────────────
  describe('RotationService.createCycle', () => {
    it('admin creates a cycle', async () => {
      const dto = await withTestTenant(async () =>
        rotationService.createCycle(
          {
            name: 'AB Week',
            cycleLength: 2,
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.name).toBe('AB Week');
      expect(dto.cycleLength).toBe(2);
      expect(dto.isActive).toBe(true);
    });

    it('non-admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          rotationService.createCycle({ name: 'X', cycleLength: 2 } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('duplicate name → ConflictException', async () => {
      await withTestTenant(async () =>
        rotationService.createCycle({ name: 'Cycle A', cycleLength: 6 } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          rotationService.createCycle({ name: 'Cycle A', cycleLength: 6 } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('listCycles only returns current-school cycles', async () => {
      const a = await withTestTenant(async () =>
        rotationService.createCycle({ name: 'A', cycleLength: 2 } as any, adminActor()),
      );
      const b = await withTestTenantB(async () =>
        rotationService.createCycle({ name: 'B', cycleLength: 2 } as any, adminActor()),
      );
      const aList = await withTestTenant(async () => rotationService.listCycles());
      expect(aList.map((c) => c.id)).toContain(a.id);
      expect(aList.map((c) => c.id)).not.toContain(b.id);
    });

    it('getCycle unknown → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          rotationService.getCycle('00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('RotationService.updateCycle', () => {
    it('admin updates name + isActive', async () => {
      const dto = await withTestTenant(async () =>
        rotationService.createCycle({ name: 'Orig', cycleLength: 2 } as any, adminActor()),
      );
      const upd = await withTestTenant(async () =>
        rotationService.updateCycle(
          dto.id,
          { name: 'New Name', isActive: false } as any,
          adminActor(),
        ),
      );
      expect(upd.name).toBe('New Name');
      expect(upd.isActive).toBe(false);
    });

    it('updateCycle with no fields → returns existing', async () => {
      const dto = await withTestTenant(async () =>
        rotationService.createCycle({ name: 'NoOp', cycleLength: 2 } as any, adminActor()),
      );
      const got = await withTestTenant(async () =>
        rotationService.updateCycle(dto.id, {} as any, adminActor()),
      );
      expect(got.id).toBe(dto.id);
    });

    it('updateCycle non-admin → ForbiddenException', async () => {
      const dto = await withTestTenant(async () =>
        rotationService.createCycle({ name: 'Cyc', cycleLength: 2 } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          rotationService.updateCycle(dto.id, { name: 'X' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('updateCycle unknown → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          rotationService.updateCycle(
            '00000000-0000-0000-0000-000000000000',
            { name: 'X' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('RotationService.calendar', () => {
    it('upsert and list calendar entries', async () => {
      const cycle = await withTestTenant(async () =>
        rotationService.createCycle({ name: 'C2', cycleLength: 2 } as any, adminActor()),
      );
      const entry = await withTestTenant(async () =>
        rotationService.upsertCalendarEntry(
          cycle.id,
          { calendarDate: '2027-03-15', rotationDay: 1 } as any,
          adminActor(),
        ),
      );
      expect(entry.rotationDay).toBe(1);

      // Upsert again — should change rotationDay.
      const updated = await withTestTenant(async () =>
        rotationService.upsertCalendarEntry(
          cycle.id,
          { calendarDate: '2027-03-15', rotationDay: 2, notes: 'flipped' } as any,
          adminActor(),
        ),
      );
      expect(updated.rotationDay).toBe(2);
      expect(updated.notes).toBe('flipped');

      const list = await withTestTenant(async () =>
        rotationService.listCalendar(cycle.id, '2027-03-01', '2027-03-31'),
      );
      expect(list.length).toBe(1);
    });

    it('upsertCalendarEntry with rotationDay > cycleLength → BadRequest', async () => {
      const cycle = await withTestTenant(async () =>
        rotationService.createCycle({ name: 'C3', cycleLength: 2 } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          rotationService.upsertCalendarEntry(
            cycle.id,
            { calendarDate: '2027-03-15', rotationDay: 5 } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-admin upsertCalendarEntry → ForbiddenException', async () => {
      const cycle = await withTestTenant(async () =>
        rotationService.createCycle({ name: 'C4', cycleLength: 2 } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          rotationService.upsertCalendarEntry(
            cycle.id,
            { calendarDate: '2027-03-15', rotationDay: 1 } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('deleteCalendarEntry succeeds then 404', async () => {
      const cycle = await withTestTenant(async () =>
        rotationService.createCycle({ name: 'C5', cycleLength: 2 } as any, adminActor()),
      );
      await withTestTenant(async () =>
        rotationService.upsertCalendarEntry(
          cycle.id,
          { calendarDate: '2027-03-15', rotationDay: 1 } as any,
          adminActor(),
        ),
      );
      const res = await withTestTenant(async () =>
        rotationService.deleteCalendarEntry(cycle.id, '2027-03-15', adminActor()),
      );
      expect(res.deleted).toBe(true);
      await expect(
        withTestTenant(async () =>
          rotationService.deleteCalendarEntry(cycle.id, '2027-03-15', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('generateCalendar populates Mon-Fri across range with round-robin', async () => {
      const cycle = await withTestTenant(async () =>
        rotationService.createCycle({ name: 'Gen Cycle', cycleLength: 2 } as any, adminActor()),
      );
      const result = await withTestTenant(async () =>
        rotationService.generateCalendar(
          cycle.id,
          {
            startDate: '2027-03-15', // Mon
            endDate: '2027-03-19', // Fri
            closureDates: [],
          } as any,
          adminActor(),
        ),
      );
      expect(result.created).toBe(5);
      expect(result.updated).toBe(0);
      expect(result.closed).toBe(0);

      // Idempotent re-run — should report 5 updated.
      const result2 = await withTestTenant(async () =>
        rotationService.generateCalendar(
          cycle.id,
          {
            startDate: '2027-03-15',
            endDate: '2027-03-19',
            closureDates: [],
          } as any,
          adminActor(),
        ),
      );
      expect(result2.updated).toBe(5);
    });

    it('generateCalendar with closure dates marks isSchoolDay=false', async () => {
      const cycle = await withTestTenant(async () =>
        rotationService.createCycle({ name: 'Gen Closure', cycleLength: 2 } as any, adminActor()),
      );
      const result = await withTestTenant(async () =>
        rotationService.generateCalendar(
          cycle.id,
          {
            startDate: '2027-03-15', // Mon
            endDate: '2027-03-17', // Wed
            closureDates: ['2027-03-16'],
          } as any,
          adminActor(),
        ),
      );
      expect(result.closed).toBe(1);
      expect(result.created).toBe(2);
    });

    it('generateCalendar endDate before startDate → BadRequest', async () => {
      const cycle = await withTestTenant(async () =>
        rotationService.createCycle({ name: 'Gen Bad', cycleLength: 2 } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          rotationService.generateCalendar(
            cycle.id,
            { startDate: '2027-03-19', endDate: '2027-03-15' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lookupRotationDay returns row for known date', async () => {
      const cycle = await withTestTenant(async () =>
        rotationService.createCycle(
          { name: 'Lookup', cycleLength: 2, isActive: true } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        rotationService.upsertCalendarEntry(
          cycle.id,
          { calendarDate: '2027-03-15', rotationDay: 1 } as any,
          adminActor(),
        ),
      );
      const lookup = await withTestTenant(async () =>
        rotationService.lookupRotationDay('2027-03-15'),
      );
      expect(lookup.rotationDay).toBe(1);
    });

    it('lookupRotationDay unknown → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => rotationService.lookupRotationDay('2099-01-01')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // RoomChangeRequestService
  // ────────────────────────────────────────────────────────────────────
  describe('RoomChangeRequestService.create', () => {
    it('teacher (slot owner) submits a request', async () => {
      const dto = await withTestTenant(async () =>
        roomChangeService.create(
          {
            timetableSlotId: slotId,
            requestedRoomId: roomBId,
            requestDate: '2027-03-15',
            reason: 'Need lab equipment',
          } as any,
          teacherActor(),
        ),
      );
      expect(dto.status).toBe('PENDING');
      expect(dto.currentRoomId).toBe(roomAId);
      expect(dto.requestedRoomId).toBe(roomBId);
      expect(dto.reason).toBe('Need lab equipment');
    });

    it('teacher who is not the slot owner → ForbiddenException', async () => {
      // Create a slot owned by admin's employee
      const slot2Id = generateId();
      const period2Id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sch_periods
           (id, bell_schedule_id, name, day_of_week, start_time, end_time, period_type, sort_order)
         VALUES ($1::uuid, $2::uuid, 'P2', 1, '10:00', '11:00', 'LESSON', 5)`,
        period2Id,
        bellScheduleId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sch_timetable_slots
           (id, school_id, class_id, period_id, teacher_id, room_id, effective_from, effective_to)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, '2027-01-10', '2027-06-30')`,
        slot2Id,
        TEST_SCHOOL_ID,
        TEST_SIS_CLASS_ID,
        period2Id,
        TEST_ADMIN_EMPLOYEE_ID,
        roomAId,
      );
      try {
        await expect(
          withTestTenant(async () =>
            roomChangeService.create(
              {
                timetableSlotId: slot2Id,
                requestDate: '2027-03-15',
                reason: 'x',
              } as any,
              teacherActor(),
            ),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      } finally {
        await rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE id = $1::uuid`,
          slot2Id,
        );
        await rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.sch_periods WHERE id = $1::uuid`,
          period2Id,
        );
      }
    });

    it('unknown slot → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          roomChangeService.create(
            {
              timetableSlotId: '00000000-0000-0000-0000-000000000000',
              requestDate: '2027-03-15',
              reason: 'x',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-employee actor → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          roomChangeService.create(
            {
              timetableSlotId: slotId,
              requestDate: '2027-03-15',
              reason: 'x',
            } as any,
            {
              accountId: '00000000-0000-0000-0000-000000000999',
              personId: '00000000-0000-0000-0000-000000000888',
              employeeId: null,
              personType: 'STUDENT',
              isSchoolAdmin: false,
            } as any,
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('RoomChangeRequestService.approve / reject', () => {
    it('admin approves a PENDING request', async () => {
      const req = await withTestTenant(async () =>
        roomChangeService.create(
          {
            timetableSlotId: slotId,
            requestedRoomId: roomBId,
            requestDate: '2027-03-15',
            reason: 'x',
          } as any,
          teacherActor(),
        ),
      );
      const approved = await withTestTenant(async () =>
        roomChangeService.approve(req.id, { reviewNotes: 'ok' } as any, adminActor()),
      );
      expect(approved.status).toBe('APPROVED');
      expect(approved.reviewNotes).toBe('ok');
    });

    it('approve without approvedRoomId on null-room request → BadRequest', async () => {
      const req = await withTestTenant(async () =>
        roomChangeService.create(
          {
            timetableSlotId: slotId,
            requestDate: '2027-03-15',
            reason: 'any room',
          } as any,
          teacherActor(),
        ),
      );
      await expect(
        withTestTenant(async () => roomChangeService.approve(req.id, {} as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('approve with approvedRoomId on null-room request succeeds', async () => {
      const req = await withTestTenant(async () =>
        roomChangeService.create(
          {
            timetableSlotId: slotId,
            requestDate: '2027-03-15',
            reason: 'any room',
          } as any,
          teacherActor(),
        ),
      );
      const approved = await withTestTenant(async () =>
        roomChangeService.approve(req.id, { approvedRoomId: roomBId } as any, adminActor()),
      );
      expect(approved.status).toBe('APPROVED');
      expect(approved.requestedRoomId).toBe(roomBId);
    });

    it('approve non-PENDING → BadRequest', async () => {
      const req = await withTestTenant(async () =>
        roomChangeService.create(
          {
            timetableSlotId: slotId,
            requestedRoomId: roomBId,
            requestDate: '2027-03-15',
            reason: 'x',
          } as any,
          teacherActor(),
        ),
      );
      await withTestTenant(async () => roomChangeService.approve(req.id, {} as any, adminActor()));
      await expect(
        withTestTenant(async () => roomChangeService.approve(req.id, {} as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('approve unknown → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          roomChangeService.approve(
            '00000000-0000-0000-0000-000000000000',
            {} as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin approve → ForbiddenException', async () => {
      const req = await withTestTenant(async () =>
        roomChangeService.create(
          {
            timetableSlotId: slotId,
            requestedRoomId: roomBId,
            requestDate: '2027-03-15',
            reason: 'x',
          } as any,
          teacherActor(),
        ),
      );
      await expect(
        withTestTenant(async () => roomChangeService.approve(req.id, {} as any, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin rejects a PENDING request', async () => {
      const req = await withTestTenant(async () =>
        roomChangeService.create(
          {
            timetableSlotId: slotId,
            requestedRoomId: roomBId,
            requestDate: '2027-03-15',
            reason: 'x',
          } as any,
          teacherActor(),
        ),
      );
      const rejected = await withTestTenant(async () =>
        roomChangeService.reject(req.id, { reviewNotes: 'denied' } as any, adminActor()),
      );
      expect(rejected.status).toBe('REJECTED');
      expect(rejected.reviewNotes).toBe('denied');
    });

    it('reject non-PENDING → BadRequest', async () => {
      const req = await withTestTenant(async () =>
        roomChangeService.create(
          {
            timetableSlotId: slotId,
            requestedRoomId: roomBId,
            requestDate: '2027-03-15',
            reason: 'x',
          } as any,
          teacherActor(),
        ),
      );
      await withTestTenant(async () => roomChangeService.reject(req.id, {} as any, adminActor()));
      await expect(
        withTestTenant(async () => roomChangeService.reject(req.id, {} as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('RoomChangeRequestService.list', () => {
    it('admin sees all requests; teacher sees only own', async () => {
      const mine = await withTestTenant(async () =>
        roomChangeService.create(
          {
            timetableSlotId: slotId,
            requestedRoomId: roomBId,
            requestDate: '2027-03-15',
            reason: 'x',
          } as any,
          teacherActor(),
        ),
      );

      const adminList = await withTestTenant(async () =>
        roomChangeService.list({} as any, adminActor()),
      );
      expect(adminList.map((r) => r.id)).toContain(mine.id);

      const teacherList = await withTestTenant(async () =>
        roomChangeService.list({} as any, teacherActor()),
      );
      expect(teacherList.map((r) => r.id)).toContain(mine.id);
    });

    it('non-admin without employeeId → []', async () => {
      const result = await withTestTenant(async () =>
        roomChangeService.list(
          {} as any,
          {
            accountId: '00000000-0000-0000-0000-000000000999',
            personId: '00000000-0000-0000-0000-000000000888',
            employeeId: null,
            personType: 'STAFF',
            isSchoolAdmin: false,
          } as any,
        ),
      );
      expect(result).toEqual([]);
    });

    it('getById uninvolved teacher → 404', async () => {
      const dto = await withTestTenant(async () =>
        roomChangeService.create(
          {
            timetableSlotId: slotId,
            requestedRoomId: roomBId,
            requestDate: '2027-03-15',
            reason: 'x',
          } as any,
          teacherActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          roomChangeService.getById(dto.id, {
            accountId: '00000000-0000-0000-0000-000000000999',
            personId: '00000000-0000-0000-0000-000000000888',
            employeeId: TEST_ADMIN_EMPLOYEE_ID,
            personType: 'STAFF',
            isSchoolAdmin: false,
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // CoTeachingService
  // ────────────────────────────────────────────────────────────────────
  describe('CoTeachingService.create', () => {
    it('admin creates a co-teaching arrangement', async () => {
      const dto = await withTestTenant(async () =>
        coteachingService.create(
          {
            timetableSlotId: slotId,
            primaryTeacherId: TEST_TEACHER_EMPLOYEE_ID,
            secondaryTeacherId: TEST_ADMIN_EMPLOYEE_ID,
            teachingModel: 'TEAM_TEACHING',
            effectiveFrom: '2027-01-15',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.primaryTeacherId).toBe(TEST_TEACHER_EMPLOYEE_ID);
      expect(dto.secondaryTeacherId).toBe(TEST_ADMIN_EMPLOYEE_ID);
      expect(dto.teachingModel).toBe('TEAM_TEACHING');
    });

    it('non-admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          coteachingService.create(
            {
              timetableSlotId: slotId,
              primaryTeacherId: TEST_TEACHER_EMPLOYEE_ID,
              secondaryTeacherId: TEST_ADMIN_EMPLOYEE_ID,
              teachingModel: 'TEAM_TEACHING',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('primary === secondary → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          coteachingService.create(
            {
              timetableSlotId: slotId,
              primaryTeacherId: TEST_TEACHER_EMPLOYEE_ID,
              secondaryTeacherId: TEST_TEACHER_EMPLOYEE_ID,
              teachingModel: 'TEAM_TEACHING',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('unknown slot → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          coteachingService.create(
            {
              timetableSlotId: '00000000-0000-0000-0000-000000000000',
              primaryTeacherId: TEST_TEACHER_EMPLOYEE_ID,
              secondaryTeacherId: TEST_ADMIN_EMPLOYEE_ID,
              teachingModel: 'TEAM_TEACHING',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('duplicate (slot, secondary) → ConflictException', async () => {
      await withTestTenant(async () =>
        coteachingService.create(
          {
            timetableSlotId: slotId,
            primaryTeacherId: TEST_TEACHER_EMPLOYEE_ID,
            secondaryTeacherId: TEST_ADMIN_EMPLOYEE_ID,
            teachingModel: 'TEAM_TEACHING',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          coteachingService.create(
            {
              timetableSlotId: slotId,
              primaryTeacherId: TEST_TEACHER_EMPLOYEE_ID,
              secondaryTeacherId: TEST_ADMIN_EMPLOYEE_ID,
              teachingModel: 'PARALLEL_TEACHING',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('CoTeachingService.list / patch / remove', () => {
    it('list returns current-school arrangements only', async () => {
      const dto = await withTestTenant(async () =>
        coteachingService.create(
          {
            timetableSlotId: slotId,
            primaryTeacherId: TEST_TEACHER_EMPLOYEE_ID,
            secondaryTeacherId: TEST_ADMIN_EMPLOYEE_ID,
            teachingModel: 'TEAM_TEACHING',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => coteachingService.list());
      expect(list.map((r) => r.id)).toContain(dto.id);
    });

    it('list with slotId filter', async () => {
      const dto = await withTestTenant(async () =>
        coteachingService.create(
          {
            timetableSlotId: slotId,
            primaryTeacherId: TEST_TEACHER_EMPLOYEE_ID,
            secondaryTeacherId: TEST_ADMIN_EMPLOYEE_ID,
            teachingModel: 'TEAM_TEACHING',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => coteachingService.list(slotId));
      expect(list.length).toBe(1);
      expect(list[0]!.id).toBe(dto.id);
    });

    it('patch updates fields', async () => {
      const dto = await withTestTenant(async () =>
        coteachingService.create(
          {
            timetableSlotId: slotId,
            primaryTeacherId: TEST_TEACHER_EMPLOYEE_ID,
            secondaryTeacherId: TEST_ADMIN_EMPLOYEE_ID,
            teachingModel: 'TEAM_TEACHING',
          } as any,
          adminActor(),
        ),
      );
      const upd = await withTestTenant(async () =>
        coteachingService.patch(
          dto.id,
          { teachingModel: 'PARALLEL_TEACHING', notes: 'updated' } as any,
          adminActor(),
        ),
      );
      expect(upd.teachingModel).toBe('PARALLEL_TEACHING');
      expect(upd.notes).toBe('updated');
    });

    it('patch with no fields returns existing', async () => {
      const dto = await withTestTenant(async () =>
        coteachingService.create(
          {
            timetableSlotId: slotId,
            primaryTeacherId: TEST_TEACHER_EMPLOYEE_ID,
            secondaryTeacherId: TEST_ADMIN_EMPLOYEE_ID,
            teachingModel: 'TEAM_TEACHING',
          } as any,
          adminActor(),
        ),
      );
      const got = await withTestTenant(async () =>
        coteachingService.patch(dto.id, {} as any, adminActor()),
      );
      expect(got.id).toBe(dto.id);
    });

    it('non-admin patch → ForbiddenException', async () => {
      const dto = await withTestTenant(async () =>
        coteachingService.create(
          {
            timetableSlotId: slotId,
            primaryTeacherId: TEST_TEACHER_EMPLOYEE_ID,
            secondaryTeacherId: TEST_ADMIN_EMPLOYEE_ID,
            teachingModel: 'TEAM_TEACHING',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          coteachingService.patch(
            dto.id,
            { teachingModel: 'PARALLEL_TEACHING' } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('remove deletes the arrangement', async () => {
      const dto = await withTestTenant(async () =>
        coteachingService.create(
          {
            timetableSlotId: slotId,
            primaryTeacherId: TEST_TEACHER_EMPLOYEE_ID,
            secondaryTeacherId: TEST_ADMIN_EMPLOYEE_ID,
            teachingModel: 'TEAM_TEACHING',
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => coteachingService.remove(dto.id, adminActor()));
      await expect(
        withTestTenant(async () => coteachingService.getById(dto.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin remove → ForbiddenException', async () => {
      const dto = await withTestTenant(async () =>
        coteachingService.create(
          {
            timetableSlotId: slotId,
            primaryTeacherId: TEST_TEACHER_EMPLOYEE_ID,
            secondaryTeacherId: TEST_ADMIN_EMPLOYEE_ID,
            teachingModel: 'TEAM_TEACHING',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => coteachingService.remove(dto.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getById unknown → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          coteachingService.getById('00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('hasActiveCoTeachingFor returns true for paired secondary', async () => {
      await withTestTenant(async () =>
        coteachingService.create(
          {
            timetableSlotId: slotId,
            primaryTeacherId: TEST_TEACHER_EMPLOYEE_ID,
            secondaryTeacherId: TEST_ADMIN_EMPLOYEE_ID,
            teachingModel: 'TEAM_TEACHING',
          } as any,
          adminActor(),
        ),
      );
      const hit = await withTestTenant(async () =>
        coteachingService.hasActiveCoTeachingFor(slotId, TEST_ADMIN_EMPLOYEE_ID),
      );
      expect(hit).toBe(true);
      const miss = await withTestTenant(async () =>
        coteachingService.hasActiveCoTeachingFor(slotId, TEST_TEACHER_EMPLOYEE_ID),
      );
      expect(miss).toBe(false);
    });
  });
});
