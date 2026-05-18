import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { TimetableService } from '@modules/m22-scheduling/timetable.service';
import { StudentService } from '@modules/m20-sis/students/student.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import {
  makeRecordingKafka,
  RecordingKafkaProducer,
} from '../helpers/recording-kafka';
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
import { TEST_SIS_CLASS_ID, TEST_SIS_CLASS_B_ID } from '../fixtures/sis';

/**
 * m22-scheduling TimetableService DB-backed integration tests.
 *
 * Service: apps/api/src/modules/m22-scheduling/timetable.service.ts
 *
 * Contracts verified:
 *   - create() inserts sch_timetable_slots, emits sch.timetable.updated
 *     (action=created), admin-only.
 *   - Teacher / room EXCLUSION constraints (btree_gist daterange overlap)
 *     translate to ConflictException with a helpful message.
 *   - UNIQUE(class_id, period_id, effective_from) — duplicate slot
 *     declined.
 *   - update() patches teacher / room / dates / notes; admin-only;
 *     emits sch.timetable.updated (action=updated).
 *   - delete() emits sch.timetable.updated (action=deleted).
 *   - list() filters by class / teacher / room / date.
 *   - Cross-school isolation: A's slots invisible to B and vice versa.
 */
describe('integration:m22-scheduling/timetable', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: ReturnType<typeof makeRecordingKafka>;
  let service: TimetableService;
  let studentService: StudentService;

  // Things we own and clean up between tests. Bell schedules + periods
  // are reused across many tests so we maintain them at top-level.
  const slotIds: string[] = [];
  const roomIds: string[] = [];
  const periodIds: string[] = [];
  const bellScheduleIds: string[] = [];

  // Stable test infrastructure created in beforeAll. Keeps each test's
  // setup small.
  let defaultBellScheduleId: string;
  let p1Id: string;
  let p2Id: string;
  let p3Id: string;
  let roomAId: string;
  let roomBId: string;
  let roomBSchoolBId: string;
  let p1BId: string;
  let bellScheduleBId: string;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    kafka = makeRecordingKafka();
    studentService = new StudentService(tenantPrisma);
    service = new TimetableService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
      studentService,
    );

    // Wipe any residual timetable rows from prior test runs that target
    // our shared infrastructure school. We don't blow away sis_classes
    // (those are fixtures).
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );

    // School A bell schedule + 3 periods + 2 rooms.
    defaultBellScheduleId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_bell_schedules
         (id, school_id, name, schedule_type, is_default)
       VALUES ($1::uuid, $2::uuid, $3, 'STANDARD', false)`,
      defaultBellScheduleId,
      TEST_SCHOOL_ID,
      'Integration Test Schedule ' + Math.random().toString(36).slice(2, 6),
    );
    bellScheduleIds.push(defaultBellScheduleId);

    p1Id = generateId();
    p2Id = generateId();
    p3Id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_periods
         (id, bell_schedule_id, name, day_of_week, start_time, end_time, period_type, sort_order)
       VALUES
         ($1::uuid, $4::uuid, 'P1', 0, '08:00', '09:00', 'LESSON', 1),
         ($2::uuid, $4::uuid, 'P2', 0, '09:05', '10:05', 'LESSON', 2),
         ($3::uuid, $4::uuid, 'P3', 0, '10:10', '11:10', 'LESSON', 3)`,
      p1Id,
      p2Id,
      p3Id,
      defaultBellScheduleId,
    );
    periodIds.push(p1Id, p2Id, p3Id);

    roomAId = generateId();
    roomBId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_rooms
         (id, school_id, name, capacity, room_type)
       VALUES
         ($1::uuid, $3::uuid, $4, 30, 'CLASSROOM'),
         ($2::uuid, $3::uuid, $5, 30, 'CLASSROOM')`,
      roomAId,
      roomBId,
      TEST_SCHOOL_ID,
      'Timetable Test Room A',
      'Timetable Test Room B',
    );
    roomIds.push(roomAId, roomBId);

    // School B bell schedule + 1 period + 1 room for cross-school tests.
    bellScheduleBId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_bell_schedules
         (id, school_id, name, schedule_type, is_default)
       VALUES ($1::uuid, $2::uuid, $3, 'STANDARD', false)`,
      bellScheduleBId,
      TEST_SCHOOL_B_ID,
      'Integration Test Schedule B ' + Math.random().toString(36).slice(2, 6),
    );
    bellScheduleIds.push(bellScheduleBId);

    p1BId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_periods
         (id, bell_schedule_id, name, day_of_week, start_time, end_time, period_type, sort_order)
       VALUES ($1::uuid, $2::uuid, 'P1', 0, '08:00', '09:00', 'LESSON', 1)`,
      p1BId,
      bellScheduleBId,
    );
    periodIds.push(p1BId);

    roomBSchoolBId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_rooms
         (id, school_id, name, capacity, room_type)
       VALUES ($1::uuid, $2::uuid, 'School B Room', 30, 'CLASSROOM')`,
      roomBSchoolBId,
      TEST_SCHOOL_B_ID,
    );
    roomIds.push(roomBSchoolBId);
  });

  afterAll(async () => {
    // Surgical cleanup of all infrastructure rows we created.
    if (slotIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE id = ANY($1::uuid[])`,
        slotIds,
      );
    }
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    if (periodIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_periods WHERE id = ANY($1::uuid[])`,
        periodIds,
      );
    }
    if (bellScheduleIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE id = ANY($1::uuid[])`,
        bellScheduleIds,
      );
    }
    if (roomIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_rooms WHERE id = ANY($1::uuid[])`,
        roomIds,
      );
    }
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    (kafka as unknown as RecordingKafkaProducer).reset();
    // Per-test wipe of slots. Bell schedules + periods + rooms stay.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    slotIds.length = 0;
  });

  // ────────────────────────────────────────────────────────────────────
  // create — CRUD, emits
  // ────────────────────────────────────────────────────────────────────
  describe('create', () => {
    it('admin creates a slot → row inserted, sch.timetable.updated emitted', async () => {
      const dto = await withTestTenant(async () =>
        service.create(
          {
            classId: TEST_SIS_CLASS_ID,
            periodId: p1Id,
            teacherId: TEST_TEACHER_EMPLOYEE_ID,
            roomId: roomAId,
            effectiveFrom: '2027-01-10',
            effectiveTo: '2027-06-10',
            notes: 'first slot',
          } as any,
          adminActor(),
        ),
      );
      slotIds.push(dto.id);
      expect(dto.classId).toBe(TEST_SIS_CLASS_ID);
      expect(dto.periodId).toBe(p1Id);
      expect(dto.teacherId).toBe(TEST_TEACHER_EMPLOYEE_ID);
      expect(dto.roomId).toBe(roomAId);
      expect(dto.notes).toBe('first slot');

      const recorded = kafka as unknown as RecordingKafkaProducer;
      const emits = recorded.calls.filter((c) => c.topic === 'sch.timetable.updated');
      expect(emits).toHaveLength(1);
      expect(emits[0]!.key).toBe(dto.id);
      expect(emits[0]!.sourceModule).toBe('scheduling');
      expect(emits[0]!.payload).toMatchObject({ slotId: dto.id, action: 'created' });
    });

    it('non-admin (teacher) → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              classId: TEST_SIS_CLASS_ID,
              periodId: p1Id,
              roomId: roomAId,
              effectiveFrom: '2027-01-10',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('effectiveTo before effectiveFrom → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              classId: TEST_SIS_CLASS_ID,
              periodId: p1Id,
              roomId: roomAId,
              effectiveFrom: '2027-06-10',
              effectiveTo: '2027-01-10',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('foreign-key miss (bad classId) → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              classId: '00000000-0000-0000-0000-000000000099',
              periodId: p1Id,
              roomId: roomAId,
              effectiveFrom: '2027-01-10',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // EXCLUSION constraints — btree_gist daterange overlap
  // ────────────────────────────────────────────────────────────────────
  describe('EXCLUSION constraint enforcement', () => {
    it('two slots for the same teacher + period with overlapping date ranges → ConflictException', async () => {
      const a = await withTestTenant(async () =>
        service.create(
          {
            classId: TEST_SIS_CLASS_ID,
            periodId: p1Id,
            teacherId: TEST_TEACHER_EMPLOYEE_ID,
            roomId: roomAId,
            effectiveFrom: '2027-01-10',
            effectiveTo: '2027-06-10',
          } as any,
          adminActor(),
        ),
      );
      slotIds.push(a.id);

      // Same teacher + same period, overlapping date range, different
      // class + room → must be rejected by the teacher EXCLUSION
      // constraint. We need a different class so the UNIQUE on
      // (class_id, period_id, effective_from) does not fire first.
      // Reuse TEST_SIS_CLASS_B_ID with a fresh date so the predicate
      // hits the teacher EXCLUSION cleanly.
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              classId: TEST_SIS_CLASS_ID,
              periodId: p1Id,
              teacherId: TEST_TEACHER_EMPLOYEE_ID,
              roomId: roomBId,
              effectiveFrom: '2027-03-01',
              effectiveTo: '2027-08-01',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('two slots for the same room + period with overlapping date ranges → ConflictException', async () => {
      const a = await withTestTenant(async () =>
        service.create(
          {
            classId: TEST_SIS_CLASS_ID,
            periodId: p2Id,
            teacherId: TEST_TEACHER_EMPLOYEE_ID,
            roomId: roomAId,
            effectiveFrom: '2027-01-10',
            effectiveTo: '2027-06-10',
          } as any,
          adminActor(),
        ),
      );
      slotIds.push(a.id);

      // Different teacher (admin's employee) → no teacher conflict. Same
      // room + period + overlapping date range → must be rejected by
      // the room EXCLUSION constraint.
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              classId: TEST_SIS_CLASS_ID,
              periodId: p2Id,
              teacherId: TEST_ADMIN_EMPLOYEE_ID,
              roomId: roomAId,
              effectiveFrom: '2027-03-01',
              effectiveTo: '2027-08-01',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('non-overlapping date ranges on same teacher + period → both succeed', async () => {
      const a = await withTestTenant(async () =>
        service.create(
          {
            classId: TEST_SIS_CLASS_ID,
            periodId: p3Id,
            teacherId: TEST_TEACHER_EMPLOYEE_ID,
            roomId: roomAId,
            effectiveFrom: '2026-08-01',
            effectiveTo: '2026-12-31',
          } as any,
          adminActor(),
        ),
      );
      slotIds.push(a.id);
      const b = await withTestTenant(async () =>
        service.create(
          {
            classId: TEST_SIS_CLASS_ID,
            periodId: p3Id,
            teacherId: TEST_TEACHER_EMPLOYEE_ID,
            roomId: roomAId,
            effectiveFrom: '2027-01-15',
            effectiveTo: '2027-06-01',
          } as any,
          adminActor(),
        ),
      );
      slotIds.push(b.id);
      expect(a.id).not.toBe(b.id);
    });

    // PRODUCTION BUG: TimetableService.translateConflict reads the
    // Prisma error's `e.code` (which is always 'P2010' for raw query
    // errors) before falling back to `e.meta.code` (which carries the
    // SQL state '23505'). The OR short-circuits on 'P2010' so the
    // 23505 branch never fires and the raw PrismaClientKnownRequestError
    // propagates instead of being translated to ConflictException.
    // The constraint name regex check on `e.message` doesn't match
    // either because Prisma's wrapper message includes the key tuple
    // but not the constraint identifier. Fix: prefer `e.meta?.code`
    // before `e.code` in the var-code expression.
    it('UNIQUE(class, period, effective_from) duplicate → ConflictException', async () => {
      const a = await withTestTenant(async () =>
        service.create(
          {
            classId: TEST_SIS_CLASS_ID,
            periodId: p1Id,
            roomId: roomAId,
            // No teacher to avoid teacher-EXCLUSION collision tripping
            // before the UNIQUE.
            teacherId: null,
            effectiveFrom: '2027-09-01',
            effectiveTo: '2027-12-31',
          } as any,
          adminActor(),
        ),
      );
      slotIds.push(a.id);
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              classId: TEST_SIS_CLASS_ID,
              periodId: p1Id,
              roomId: roomBId,
              teacherId: null,
              effectiveFrom: '2027-09-01',
              effectiveTo: '2028-06-30',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // update — admin-only patch + emit
  // ────────────────────────────────────────────────────────────────────
  describe('update', () => {
    it('admin updates teacher / room / notes → fields applied, emit fires', async () => {
      const dto = await withTestTenant(async () =>
        service.create(
          {
            classId: TEST_SIS_CLASS_ID,
            periodId: p1Id,
            teacherId: TEST_TEACHER_EMPLOYEE_ID,
            roomId: roomAId,
            effectiveFrom: '2027-01-10',
          } as any,
          adminActor(),
        ),
      );
      slotIds.push(dto.id);
      (kafka as unknown as RecordingKafkaProducer).reset();

      const updated = await withTestTenant(async () =>
        service.update(
          dto.id,
          { roomId: roomBId, notes: 'patched' } as any,
          adminActor(),
        ),
      );
      expect(updated.roomId).toBe(roomBId);
      expect(updated.notes).toBe('patched');

      const recorded = kafka as unknown as RecordingKafkaProducer;
      const emits = recorded.calls.filter((c) => c.topic === 'sch.timetable.updated');
      expect(emits).toHaveLength(1);
      expect(emits[0]!.payload).toMatchObject({ slotId: dto.id, action: 'updated' });
    });

    it('non-admin update → ForbiddenException', async () => {
      const dto = await withTestTenant(async () =>
        service.create(
          {
            classId: TEST_SIS_CLASS_ID,
            periodId: p1Id,
            teacherId: TEST_TEACHER_EMPLOYEE_ID,
            roomId: roomAId,
            effectiveFrom: '2027-01-10',
          } as any,
          adminActor(),
        ),
      );
      slotIds.push(dto.id);
      await expect(
        withTestTenant(async () =>
          service.update(dto.id, { notes: 'nope' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('unknown id update → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.update(
            '00000000-0000-0000-0000-000000000000',
            { notes: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // delete — admin-only + emit
  // ────────────────────────────────────────────────────────────────────
  describe('delete', () => {
    it('admin deletes a slot → row gone, sch.timetable.updated action=deleted emitted', async () => {
      const dto = await withTestTenant(async () =>
        service.create(
          {
            classId: TEST_SIS_CLASS_ID,
            periodId: p1Id,
            teacherId: TEST_TEACHER_EMPLOYEE_ID,
            roomId: roomAId,
            effectiveFrom: '2027-01-10',
          } as any,
          adminActor(),
        ),
      );
      slotIds.push(dto.id);
      (kafka as unknown as RecordingKafkaProducer).reset();
      const result = await withTestTenant(async () => service.delete(dto.id, adminActor()));
      expect(result.deleted).toBe(true);

      const remaining = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE id = $1::uuid`,
        dto.id,
      );
      expect(remaining[0]!.count).toBe(0);

      const recorded = kafka as unknown as RecordingKafkaProducer;
      const emits = recorded.calls.filter((c) => c.topic === 'sch.timetable.updated');
      expect(emits).toHaveLength(1);
      expect(emits[0]!.payload).toMatchObject({ slotId: dto.id, action: 'deleted' });
    });

    it('non-admin delete → ForbiddenException', async () => {
      const dto = await withTestTenant(async () =>
        service.create(
          {
            classId: TEST_SIS_CLASS_ID,
            periodId: p1Id,
            roomId: roomAId,
            effectiveFrom: '2027-01-10',
          } as any,
          adminActor(),
        ),
      );
      slotIds.push(dto.id);
      await expect(
        withTestTenant(async () => service.delete(dto.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // list / getById / filters
  // ────────────────────────────────────────────────────────────────────
  describe('list / getById', () => {
    it('list with classId filter returns only that class', async () => {
      const a = await withTestTenant(async () =>
        service.create(
          {
            classId: TEST_SIS_CLASS_ID,
            periodId: p1Id,
            teacherId: TEST_TEACHER_EMPLOYEE_ID,
            roomId: roomAId,
            effectiveFrom: '2027-01-10',
          } as any,
          adminActor(),
        ),
      );
      slotIds.push(a.id);
      const list = await withTestTenant(async () =>
        service.list({ classId: TEST_SIS_CLASS_ID } as any),
      );
      expect(list.map((r) => r.id)).toContain(a.id);
    });

    it('list with onDate returns only slots active on that date', async () => {
      const old = await withTestTenant(async () =>
        service.create(
          {
            classId: TEST_SIS_CLASS_ID,
            periodId: p2Id,
            teacherId: TEST_TEACHER_EMPLOYEE_ID,
            roomId: roomAId,
            effectiveFrom: '2026-08-01',
            effectiveTo: '2026-12-31',
          } as any,
          adminActor(),
        ),
      );
      slotIds.push(old.id);
      const current = await withTestTenant(async () =>
        service.create(
          {
            classId: TEST_SIS_CLASS_ID,
            periodId: p3Id,
            teacherId: TEST_TEACHER_EMPLOYEE_ID,
            roomId: roomAId,
            effectiveFrom: '2027-01-15',
            effectiveTo: '2027-06-01',
          } as any,
          adminActor(),
        ),
      );
      slotIds.push(current.id);

      const activeOnDate = await withTestTenant(async () =>
        service.list({ onDate: '2027-03-15' } as any),
      );
      const ids = activeOnDate.map((r) => r.id);
      expect(ids).toContain(current.id);
      expect(ids).not.toContain(old.id);
    });

    it('getById unknown → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.getById('00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // cross-school isolation
  //
  // PRODUCTION BUG: TimetableService.list() does not filter by
  // school_id — its WHERE clause only constrains class / teacher /
  // room / on-date. A School A admin issuing `list({})` sees rows
  // owned by every school in the tenant_test schema. Same surface
  // affects listForTeacher / listForClass / listForRoom (they delegate
  // to list). Skipping the failing assertion until the service is
  // patched to add
  //   AND s.school_id = $N::uuid
  // to the WHERE clause.
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('a School B slot does not appear in a School A admin list', async () => {
      // Create a slot in School B context.
      const bSlot = await withTestTenantB(async () =>
        service.create(
          {
            classId: TEST_SIS_CLASS_B_ID,
            periodId: p1BId,
            roomId: roomBSchoolBId,
            effectiveFrom: '2027-01-10',
          } as any,
          adminActor(),
        ),
      );
      slotIds.push(bSlot.id);

      const aList = await withTestTenant(async () => service.list({} as any));
      expect(aList.map((r) => r.id)).not.toContain(bSlot.id);

      const bList = await withTestTenantB(async () => service.list({} as any));
      expect(bList.map((r) => r.id)).toContain(bSlot.id);
    });
  });
});
