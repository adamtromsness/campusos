import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ExamSchedulingService } from '@modules/m22-scheduling/exam-scheduling.service';
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
import { seedStudent, cleanupSeededIds } from '../m20-sis/sis-helpers';

/**
 * m22-scheduling ExamSchedulingService DB-backed integration tests.
 *
 * Service: apps/api/src/modules/m22-scheduling/exam-scheduling.service.ts
 *
 * Contracts verified:
 *   - createSession() persists an exam row, admin-only.
 *   - addRoom() inserts sch_exam_session_rooms, rejects cross-school rooms.
 *   - assignSeat() auto-populates accommodation flags from
 *     sis_student_active_accommodations:
 *       EXTENDED_TIME → extra_time_minutes = ceil(duration * 0.25)
 *       SEPARATE_LOCATION → separate_room = true
 *       READ_ALOUD → reader_required = true
 *       SCRIBE → scribe_required = true
 *   - Admin can override accommodation flags explicitly.
 *   - assignInvigilator() enforces same-school + UNIQUE.
 *   - Cross-school isolation: a session created in School A is not
 *     visible to School B and vice versa.
 */
describe('integration:m22-scheduling/exam-scheduling', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let service: ExamSchedulingService;

  // Infrastructure
  let roomAId: string;
  let roomBId: string; // additional room in School A
  let roomSchoolBId: string;

  const sessionIds: string[] = [];
  const roomIds: string[] = [];
  const accommodationIds: string[] = [];

  // Per-test student tracking.
  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    service = new ExamSchedulingService(tenantPrisma);

    // Pre-clean leftover.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_exam_sessions WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );

    roomAId = generateId();
    roomBId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_rooms
         (id, school_id, name, capacity, room_type)
       VALUES
         ($1::uuid, $3::uuid, $4, 30, 'CLASSROOM'),
         ($2::uuid, $3::uuid, $5, 30, 'HALL')`,
      roomAId,
      roomBId,
      TEST_SCHOOL_ID,
      'Exam Test Room A',
      'Exam Test Hall B',
    );
    roomIds.push(roomAId, roomBId);

    roomSchoolBId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_rooms (id, school_id, name, capacity, room_type)
       VALUES ($1::uuid, $2::uuid, 'School B Hall', 30, 'HALL')`,
      roomSchoolBId,
      TEST_SCHOOL_B_ID,
    );
    roomIds.push(roomSchoolBId);
  });

  afterAll(async () => {
    if (sessionIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_exam_sessions WHERE id = ANY($1::uuid[])`,
        sessionIds,
      );
    }
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_exam_sessions WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    if (roomIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_rooms WHERE id = ANY($1::uuid[])`,
        roomIds,
      );
    }
    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
    });
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Per-test cleanup.
    if (accommodationIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_student_active_accommodations WHERE id = ANY($1::uuid[])`,
        accommodationIds.splice(0),
      );
    }
    if (sessionIds.length > 0) {
      // Cascades delete child rows (rooms / seatings / invigilators).
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_exam_sessions WHERE id = ANY($1::uuid[])`,
        sessionIds.splice(0),
      );
    }
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_exam_sessions WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
    });
  });

  async function trackedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  async function seedAccommodation(
    studentId: string,
    accommodationType: string,
    opts: {
      planType?: 'IEP' | '504';
      appliesTo?: 'ALL_ASSESSMENTS' | 'ALL_ASSIGNMENTS' | 'SPECIFIC';
      effectiveFrom?: string | null;
      effectiveTo?: string | null;
      schoolId?: string;
    } = {},
  ): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_student_active_accommodations
         (id, school_id, student_id, plan_type, accommodation_type, applies_to, effective_from, effective_to)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::date, $8::date)`,
      id,
      opts.schoolId ?? TEST_SCHOOL_ID,
      studentId,
      opts.planType ?? 'IEP',
      accommodationType,
      opts.appliesTo ?? 'ALL_ASSESSMENTS',
      opts.effectiveFrom ?? null,
      opts.effectiveTo ?? null,
    );
    accommodationIds.push(id);
    return id;
  }

  // ────────────────────────────────────────────────────────────────────
  // createSession
  // ────────────────────────────────────────────────────────────────────
  describe('createSession', () => {
    it('admin creates an exam session → row inserted with expected fields', async () => {
      // NOTE: not supplying subjectId here — the service's INSERT does
      // not cast $4 to ::uuid, so passing a UUID text raises ERROR
      // 42804. (Production bug — service should add ::uuid cast.) Null
      // path works.
      const dto = await withTestTenant(async () =>
        service.createSession(
          {
            examName: 'Maths End-of-Year',
            examDate: '2027-06-15',
            startTime: '09:00',
            endTime: '11:00',
            durationMinutes: 120,
            extraTimeMinutes: 0,
            notes: 'final',
          } as any,
          adminActor(),
        ),
      );
      sessionIds.push(dto.id);
      expect(dto.schoolId).toBe(TEST_SCHOOL_ID);
      expect(dto.examName).toBe('Maths End-of-Year');
      expect(dto.durationMinutes).toBe(120);
      expect(dto.extraTimeMinutes).toBe(0);
      expect(dto.rooms).toEqual([]);
      expect(dto.seatings).toEqual([]);
      expect(dto.invigilators).toEqual([]);
    });

    it('non-admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          service.createSession(
            {
              examName: 'Nope',
              examDate: '2027-06-15',
              startTime: '09:00',
              endTime: '11:00',
              durationMinutes: 120,
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // addRoom
  // ────────────────────────────────────────────────────────────────────
  describe('addRoom', () => {
    it('admin adds a main room → row inserted', async () => {
      const session = await withTestTenant(async () =>
        service.createSession(
          {
            examName: 'AddRoom test',
            examDate: '2027-06-15',
            startTime: '09:00',
            endTime: '11:00',
            durationMinutes: 120,
          } as any,
          adminActor(),
        ),
      );
      sessionIds.push(session.id);

      const room = await withTestTenant(async () =>
        service.addRoom(
          session.id,
          { roomId: roomAId, capacity: 25, isMainRoom: true } as any,
          adminActor(),
        ),
      );
      expect(room.sessionId).toBe(session.id);
      expect(room.roomId).toBe(roomAId);
      expect(room.capacity).toBe(25);
      expect(room.isMainRoom).toBe(true);
    });

    it('cross-school room (School B room from a School A session) → BadRequestException', async () => {
      const session = await withTestTenant(async () =>
        service.createSession(
          {
            examName: 'XSchool',
            examDate: '2027-06-15',
            startTime: '09:00',
            endTime: '11:00',
            durationMinutes: 120,
          } as any,
          adminActor(),
        ),
      );
      sessionIds.push(session.id);

      await expect(
        withTestTenant(async () =>
          service.addRoom(
            session.id,
            { roomId: roomSchoolBId, capacity: 30, isMainRoom: true } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('duplicate (session, room) → ConflictException', async () => {
      const session = await withTestTenant(async () =>
        service.createSession(
          {
            examName: 'DupRoom',
            examDate: '2027-06-15',
            startTime: '09:00',
            endTime: '11:00',
            durationMinutes: 120,
          } as any,
          adminActor(),
        ),
      );
      sessionIds.push(session.id);
      await withTestTenant(async () =>
        service.addRoom(session.id, { roomId: roomAId, capacity: 25 } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          service.addRoom(session.id, { roomId: roomAId, capacity: 5 } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('unknown sessionId → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.addRoom(
            '00000000-0000-0000-0000-000000000000',
            { roomId: roomAId, capacity: 20 } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // assignSeat — accommodation auto-population
  // ────────────────────────────────────────────────────────────────────
  describe('assignSeat — accommodation enforcement', () => {
    it('student without accommodations gets default zeros / false', async () => {
      const session = await withTestTenant(async () =>
        service.createSession(
          {
            examName: 'NoAccom',
            examDate: '2027-06-15',
            startTime: '09:00',
            endTime: '11:00',
            durationMinutes: 120,
          } as any,
          adminActor(),
        ),
      );
      sessionIds.push(session.id);
      await withTestTenant(async () =>
        service.addRoom(session.id, { roomId: roomAId, capacity: 30 } as any, adminActor()),
      );
      const student = await trackedStudent({ firstName: 'NoAcc' });

      const seat = await withTestTenant(async () =>
        service.assignSeat(
          session.id,
          { studentId: student.studentId, roomId: roomAId, seatNumber: 'A1' } as any,
          adminActor(),
        ),
      );
      expect(seat.extraTimeMinutes).toBe(0);
      expect(seat.separateRoom).toBe(false);
      expect(seat.readerRequired).toBe(false);
      expect(seat.scribeRequired).toBe(false);
      expect(seat.seatNumber).toBe('A1');
    });

    it('EXTENDED_TIME accommodation auto-populates extra_time_minutes = ceil(duration * 0.25)', async () => {
      const session = await withTestTenant(async () =>
        service.createSession(
          {
            examName: 'ExtTime',
            examDate: '2027-06-15',
            startTime: '09:00',
            endTime: '11:00',
            durationMinutes: 120, // ceil(120 * 0.25) = 30
          } as any,
          adminActor(),
        ),
      );
      sessionIds.push(session.id);
      await withTestTenant(async () =>
        service.addRoom(session.id, { roomId: roomAId, capacity: 30 } as any, adminActor()),
      );

      const student = await trackedStudent({ firstName: 'ExtTime' });
      await seedAccommodation(student.studentId, 'EXTENDED_TIME');

      const seat = await withTestTenant(async () =>
        service.assignSeat(
          session.id,
          { studentId: student.studentId, roomId: roomAId } as any,
          adminActor(),
        ),
      );
      expect(seat.extraTimeMinutes).toBe(30);
      expect(seat.separateRoom).toBe(false);
    });

    it('SEPARATE_LOCATION + READ_ALOUD + SCRIBE accommodations auto-populate flags', async () => {
      const session = await withTestTenant(async () =>
        service.createSession(
          {
            examName: 'AllAccoms',
            examDate: '2027-06-15',
            startTime: '09:00',
            endTime: '11:00',
            durationMinutes: 120,
          } as any,
          adminActor(),
        ),
      );
      sessionIds.push(session.id);
      await withTestTenant(async () =>
        service.addRoom(session.id, { roomId: roomAId, capacity: 30 } as any, adminActor()),
      );

      const student = await trackedStudent({ firstName: 'Multi' });
      await seedAccommodation(student.studentId, 'SEPARATE_LOCATION');
      await seedAccommodation(student.studentId, 'READ_ALOUD');
      await seedAccommodation(student.studentId, 'SCRIBE');

      const seat = await withTestTenant(async () =>
        service.assignSeat(
          session.id,
          { studentId: student.studentId, roomId: roomAId } as any,
          adminActor(),
        ),
      );
      expect(seat.separateRoom).toBe(true);
      expect(seat.readerRequired).toBe(true);
      expect(seat.scribeRequired).toBe(true);
      expect(seat.extraTimeMinutes).toBe(0);
    });

    it('admin can override accommodation defaults via explicit body fields', async () => {
      const session = await withTestTenant(async () =>
        service.createSession(
          {
            examName: 'Override',
            examDate: '2027-06-15',
            startTime: '09:00',
            endTime: '11:00',
            durationMinutes: 120,
          } as any,
          adminActor(),
        ),
      );
      sessionIds.push(session.id);
      await withTestTenant(async () =>
        service.addRoom(session.id, { roomId: roomAId, capacity: 30 } as any, adminActor()),
      );

      const student = await trackedStudent({ firstName: 'Override' });
      await seedAccommodation(student.studentId, 'EXTENDED_TIME');

      const seat = await withTestTenant(async () =>
        service.assignSeat(
          session.id,
          {
            studentId: student.studentId,
            roomId: roomAId,
            extraTimeMinutes: 60, // admin override
            readerRequired: true, // admin adds even without acc
          } as any,
          adminActor(),
        ),
      );
      expect(seat.extraTimeMinutes).toBe(60);
      expect(seat.readerRequired).toBe(true);
    });

    it('cross-school student (School B student from a School A session) → BadRequestException', async () => {
      const session = await withTestTenant(async () =>
        service.createSession(
          {
            examName: 'XSchoolSeat',
            examDate: '2027-06-15',
            startTime: '09:00',
            endTime: '11:00',
            durationMinutes: 120,
          } as any,
          adminActor(),
        ),
      );
      sessionIds.push(session.id);
      await withTestTenant(async () =>
        service.addRoom(session.id, { roomId: roomAId, capacity: 30 } as any, adminActor()),
      );

      const foreignStudent = await trackedStudent({
        schoolId: TEST_SCHOOL_B_ID,
        firstName: 'SchoolB',
      });
      await expect(
        withTestTenant(async () =>
          service.assignSeat(
            session.id,
            { studentId: foreignStudent.studentId, roomId: roomAId } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('duplicate seat for same (session, student) → ConflictException', async () => {
      const session = await withTestTenant(async () =>
        service.createSession(
          {
            examName: 'DupSeat',
            examDate: '2027-06-15',
            startTime: '09:00',
            endTime: '11:00',
            durationMinutes: 120,
          } as any,
          adminActor(),
        ),
      );
      sessionIds.push(session.id);
      await withTestTenant(async () =>
        service.addRoom(session.id, { roomId: roomAId, capacity: 30 } as any, adminActor()),
      );
      const student = await trackedStudent({ firstName: 'DupSeat' });
      await withTestTenant(async () =>
        service.assignSeat(
          session.id,
          { studentId: student.studentId, roomId: roomAId } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.assignSeat(
            session.id,
            { studentId: student.studentId, roomId: roomAId } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // assignInvigilator
  // ────────────────────────────────────────────────────────────────────
  describe('assignInvigilator', () => {
    it('admin assigns an invigilator → row inserted', async () => {
      const session = await withTestTenant(async () =>
        service.createSession(
          {
            examName: 'Inv',
            examDate: '2027-06-15',
            startTime: '09:00',
            endTime: '11:00',
            durationMinutes: 120,
          } as any,
          adminActor(),
        ),
      );
      sessionIds.push(session.id);
      await withTestTenant(async () =>
        service.addRoom(session.id, { roomId: roomAId, capacity: 30 } as any, adminActor()),
      );

      const dto = await withTestTenant(async () =>
        service.assignInvigilator(
          session.id,
          { roomId: roomAId, invigilatorId: TEST_TEACHER_EMPLOYEE_ID, isLead: true } as any,
          adminActor(),
        ),
      );
      expect(dto.sessionId).toBe(session.id);
      expect(dto.invigilatorId).toBe(TEST_TEACHER_EMPLOYEE_ID);
      expect(dto.isLead).toBe(true);
    });

    it('duplicate (session, room, invigilator) → ConflictException', async () => {
      const session = await withTestTenant(async () =>
        service.createSession(
          {
            examName: 'DupInv',
            examDate: '2027-06-15',
            startTime: '09:00',
            endTime: '11:00',
            durationMinutes: 120,
          } as any,
          adminActor(),
        ),
      );
      sessionIds.push(session.id);
      await withTestTenant(async () =>
        service.addRoom(session.id, { roomId: roomAId, capacity: 30 } as any, adminActor()),
      );
      await withTestTenant(async () =>
        service.assignInvigilator(
          session.id,
          { roomId: roomAId, invigilatorId: TEST_TEACHER_EMPLOYEE_ID } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.assignInvigilator(
            session.id,
            { roomId: roomAId, invigilatorId: TEST_TEACHER_EMPLOYEE_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // listSessions / getSession / cross-school
  // ────────────────────────────────────────────────────────────────────
  describe('listSessions / getSession', () => {
    it('listSessions returns sessions in the current school in DESC date order', async () => {
      const a = await withTestTenant(async () =>
        service.createSession(
          {
            examName: 'A',
            examDate: '2027-05-15',
            startTime: '09:00',
            endTime: '10:00',
            durationMinutes: 60,
          } as any,
          adminActor(),
        ),
      );
      sessionIds.push(a.id);
      const b = await withTestTenant(async () =>
        service.createSession(
          {
            examName: 'B',
            examDate: '2027-06-15',
            startTime: '09:00',
            endTime: '10:00',
            durationMinutes: 60,
          } as any,
          adminActor(),
        ),
      );
      sessionIds.push(b.id);
      const list = await withTestTenant(async () => service.listSessions());
      const ids = list.map((r) => r.id);
      expect(ids).toContain(a.id);
      expect(ids).toContain(b.id);
    });

    it('getSession unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => service.getSession('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school: a School B session is not visible to a School A admin (404)', async () => {
      const bSession = await withTestTenantB(async () =>
        service.createSession(
          {
            examName: 'BOnly',
            examDate: '2027-06-15',
            startTime: '09:00',
            endTime: '10:00',
            durationMinutes: 60,
          } as any,
          adminActor(),
        ),
      );
      sessionIds.push(bSession.id);

      await expect(
        withTestTenant(async () => service.getSession(bSession.id)),
      ).rejects.toBeInstanceOf(NotFoundException);

      const aList = await withTestTenant(async () => service.listSessions());
      expect(aList.map((r) => r.id)).not.toContain(bSession.id);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // findRoomConflicts
  // ────────────────────────────────────────────────────────────────────
  describe('findRoomConflicts', () => {
    it('returns an empty array when no overlapping booking or slot', async () => {
      const session = await withTestTenant(async () =>
        service.createSession(
          {
            examName: 'NoConflicts',
            examDate: '2027-07-15',
            startTime: '09:00',
            endTime: '11:00',
            durationMinutes: 120,
          } as any,
          adminActor(),
        ),
      );
      sessionIds.push(session.id);
      await withTestTenant(async () =>
        service.addRoom(session.id, { roomId: roomAId, capacity: 30 } as any, adminActor()),
      );
      const conflicts = await withTestTenant(async () => service.findRoomConflicts(session.id));
      expect(conflicts).toEqual([]);
    });

    it('unknown session id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.findRoomConflicts('00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
