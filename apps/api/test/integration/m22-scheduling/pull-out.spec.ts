import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { PullOutService } from '@modules/m22-scheduling/pull-out.service';
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
import { TEST_SIS_CLASS_ID } from '../fixtures/sis';
import { seedStudent, cleanupSeededIds } from '../m20-sis/sis-helpers';

/**
 * m22-scheduling pull-out interventions integration tests. Covers
 * PullOutService (393 lines).
 */
describe('integration:m22-scheduling/pull-out', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let pullOutService: PullOutService;

  let bellScheduleId: string;
  let periodId: string;
  let roomId: string;
  let slotId: string;

  const seededStudentIds: string[] = [];
  const seededPlatformStudentIds: string[] = [];
  const seededPersonIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    pullOutService = new PullOutService(tenantPrisma);

    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_pull_out_interventions WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rooms WHERE name LIKE 'PullOut Test%' AND school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_periods WHERE bell_schedule_id IN (SELECT id FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE name LIKE 'PullOut Test%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE name LIKE 'PullOut Test%'`,
    );

    bellScheduleId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_bell_schedules
         (id, school_id, name, schedule_type, is_default)
       VALUES ($1::uuid, $2::uuid, $3, 'STANDARD', false)`,
      bellScheduleId,
      TEST_SCHOOL_ID,
      'PullOut Test Schedule ' + Math.random().toString(36).slice(2, 6),
    );

    periodId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_periods
         (id, bell_schedule_id, name, day_of_week, start_time, end_time, period_type, sort_order)
       VALUES ($1::uuid, $2::uuid, 'P1', NULL, '08:00', '09:00', 'LESSON', 1)`,
      periodId,
      bellScheduleId,
    );

    roomId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_rooms (id, school_id, name, capacity, room_type)
       VALUES ($1::uuid, $2::uuid, 'PullOut Test Room', 30, 'CLASSROOM')`,
      roomId,
      TEST_SCHOOL_ID,
    );

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
      `DELETE FROM ${TEST_SCHEMA}.sch_pull_out_interventions WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    if (seededStudentIds.length > 0) {
      await cleanupSeededIds(rawClient, {
        studentIds: seededStudentIds,
        platformStudentIds: seededPlatformStudentIds,
        personIds: seededPersonIds,
      });
    }
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE id = $1::uuid`,
      slotId,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rooms WHERE id = $1::uuid`,
      roomId,
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
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_pull_out_interventions WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // PullOutService.create
  // ────────────────────────────────────────────────────────────────────
  describe('create', () => {
    it('admin creates a WEEKLY intervention', async () => {
      const stu = await seedStudent(rawClient);
      seededStudentIds.push(stu.studentId);
      seededPlatformStudentIds.push(stu.platformStudentId);
      seededPersonIds.push(stu.personId);
      const dto = await withTestTenant(async () =>
        pullOutService.create(
          {
            studentId: stu.studentId,
            regularSlotId: slotId,
            interventionName: 'Reading Lab',
            startDate: '2027-03-15',
            endDate: '2027-04-15',
            frequency: 'WEEKLY',
            daysOfWeek: [1, 3],
          } as any,
          adminActor(),
        ),
      );
      expect(dto.studentId).toBe(stu.studentId);
      expect(dto.frequency).toBe('WEEKLY');
      expect(dto.daysOfWeek).toEqual([1, 3]);
      expect(typeof dto.attendancePremarked).toBe('number');
    });

    it('non-admin → ForbiddenException', async () => {
      const stu = await seedStudent(rawClient);
      seededStudentIds.push(stu.studentId);
      seededPlatformStudentIds.push(stu.platformStudentId);
      seededPersonIds.push(stu.personId);
      await expect(
        withTestTenant(async () =>
          pullOutService.create(
            {
              studentId: stu.studentId,
              regularSlotId: slotId,
              interventionName: 'X',
              startDate: '2027-03-15',
              frequency: 'WEEKLY',
              daysOfWeek: [1],
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('CUSTOM frequency without daysOfWeek → BadRequest', async () => {
      const stu = await seedStudent(rawClient);
      seededStudentIds.push(stu.studentId);
      seededPlatformStudentIds.push(stu.platformStudentId);
      seededPersonIds.push(stu.personId);
      await expect(
        withTestTenant(async () =>
          pullOutService.create(
            {
              studentId: stu.studentId,
              regularSlotId: slotId,
              interventionName: 'X',
              startDate: '2027-03-15',
              frequency: 'CUSTOM',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cross-school studentId → BadRequest', async () => {
      const stuB = await seedStudent(rawClient, { schoolId: TEST_SCHOOL_B_ID });
      seededStudentIds.push(stuB.studentId);
      seededPlatformStudentIds.push(stuB.platformStudentId);
      seededPersonIds.push(stuB.personId);
      await expect(
        withTestTenant(async () =>
          pullOutService.create(
            {
              studentId: stuB.studentId,
              regularSlotId: slotId,
              interventionName: 'X',
              startDate: '2027-03-15',
              frequency: 'WEEKLY',
              daysOfWeek: [1],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('unknown slot → BadRequest', async () => {
      const stu = await seedStudent(rawClient);
      seededStudentIds.push(stu.studentId);
      seededPlatformStudentIds.push(stu.platformStudentId);
      seededPersonIds.push(stu.personId);
      await expect(
        withTestTenant(async () =>
          pullOutService.create(
            {
              studentId: stu.studentId,
              regularSlotId: '00000000-0000-0000-0000-000000000000',
              interventionName: 'X',
              startDate: '2027-03-15',
              frequency: 'WEEKLY',
              daysOfWeek: [1],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cross-school provider → BadRequest', async () => {
      const stu = await seedStudent(rawClient);
      seededStudentIds.push(stu.studentId);
      seededPlatformStudentIds.push(stu.platformStudentId);
      seededPersonIds.push(stu.personId);

      // Create a B-school employee for provider
      const foreignPersonId = generateId();
      const foreignEmpId = generateId();
      const foreignAccountId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'F', 'P', 'STAFF', true)`,
        foreignPersonId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_users (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
         VALUES ($1::uuid, $2::uuid, $3, 'F P', 'ACTIVE', 'HUMAN', false)`,
        foreignAccountId,
        foreignPersonId,
        'fp-' + foreignEmpId + '@test.local',
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hr_employees
           (id, person_id, account_id, school_id, employee_number, employment_type, employment_status, hire_date)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'FULL_TIME', 'ACTIVE', '2024-01-01')`,
        foreignEmpId,
        foreignPersonId,
        foreignAccountId,
        TEST_SCHOOL_B_ID,
        'FP-' + Math.random().toString(36).slice(2, 6),
      );

      try {
        await expect(
          withTestTenant(async () =>
            pullOutService.create(
              {
                studentId: stu.studentId,
                regularSlotId: slotId,
                interventionName: 'X',
                interventionProvider: foreignEmpId,
                startDate: '2027-03-15',
                frequency: 'WEEKLY',
                daysOfWeek: [1],
              } as any,
              adminActor(),
            ),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      } finally {
        await rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.hr_employees WHERE id = $1::uuid`,
          foreignEmpId,
        );
        await rawClient.$executeRawUnsafe(
          `DELETE FROM platform.platform_users WHERE id = $1::uuid`,
          foreignAccountId,
        );
        await rawClient.$executeRawUnsafe(
          `DELETE FROM platform.iam_person WHERE id = $1::uuid`,
          foreignPersonId,
        );
      }
    });

    it('DAILY frequency creates intervention without daysOfWeek', async () => {
      const stu = await seedStudent(rawClient);
      seededStudentIds.push(stu.studentId);
      seededPlatformStudentIds.push(stu.platformStudentId);
      seededPersonIds.push(stu.personId);
      const dto = await withTestTenant(async () =>
        pullOutService.create(
          {
            studentId: stu.studentId,
            regularSlotId: slotId,
            interventionName: 'Daily Speech',
            startDate: '2027-03-15',
            endDate: '2027-03-19',
            frequency: 'DAILY',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.frequency).toBe('DAILY');
      expect(dto.daysOfWeek).toBeNull();
    });

    it('CUSTOM frequency with valid daysOfWeek creates', async () => {
      const stu = await seedStudent(rawClient);
      seededStudentIds.push(stu.studentId);
      seededPlatformStudentIds.push(stu.platformStudentId);
      seededPersonIds.push(stu.personId);
      const dto = await withTestTenant(async () =>
        pullOutService.create(
          {
            studentId: stu.studentId,
            regularSlotId: slotId,
            interventionName: 'Custom',
            startDate: '2027-03-15',
            endDate: '2027-04-15',
            frequency: 'CUSTOM',
            daysOfWeek: [2, 4],
          } as any,
          adminActor(),
        ),
      );
      expect(dto.frequency).toBe('CUSTOM');
      expect(dto.daysOfWeek).toEqual([2, 4]);
    });

    it('FORTNIGHTLY frequency creates', async () => {
      const stu = await seedStudent(rawClient);
      seededStudentIds.push(stu.studentId);
      seededPlatformStudentIds.push(stu.platformStudentId);
      seededPersonIds.push(stu.personId);
      const dto = await withTestTenant(async () =>
        pullOutService.create(
          {
            studentId: stu.studentId,
            regularSlotId: slotId,
            interventionName: 'Fortnightly',
            startDate: '2027-03-15',
            endDate: '2027-05-15',
            frequency: 'FORTNIGHTLY',
            daysOfWeek: [3],
          } as any,
          adminActor(),
        ),
      );
      expect(dto.frequency).toBe('FORTNIGHTLY');
    });
  });

  describe('list / getById', () => {
    it('list returns interventions for current school only', async () => {
      const stu = await seedStudent(rawClient);
      seededStudentIds.push(stu.studentId);
      seededPlatformStudentIds.push(stu.platformStudentId);
      seededPersonIds.push(stu.personId);
      const dto = await withTestTenant(async () =>
        pullOutService.create(
          {
            studentId: stu.studentId,
            regularSlotId: slotId,
            interventionName: 'List test',
            startDate: '2027-03-15',
            frequency: 'WEEKLY',
            daysOfWeek: [1],
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => pullOutService.list());
      expect(list.map((r) => r.id)).toContain(dto.id);

      const filtered = await withTestTenant(async () => pullOutService.list(stu.studentId));
      expect(filtered.map((r) => r.id)).toContain(dto.id);
    });

    it('cross-school isolation: B-school admin cannot see A-school intervention', async () => {
      const stu = await seedStudent(rawClient);
      seededStudentIds.push(stu.studentId);
      seededPlatformStudentIds.push(stu.platformStudentId);
      seededPersonIds.push(stu.personId);
      const dto = await withTestTenant(async () =>
        pullOutService.create(
          {
            studentId: stu.studentId,
            regularSlotId: slotId,
            interventionName: 'iso',
            startDate: '2027-03-15',
            frequency: 'WEEKLY',
            daysOfWeek: [1],
          } as any,
          adminActor(),
        ),
      );
      const bList = await withTestTenantB(async () => pullOutService.list());
      expect(bList.map((r) => r.id)).not.toContain(dto.id);
    });

    it('getById unknown → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => pullOutService.getById('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById in foreign tenant → NotFoundException', async () => {
      const stu = await seedStudent(rawClient);
      seededStudentIds.push(stu.studentId);
      seededPlatformStudentIds.push(stu.platformStudentId);
      seededPersonIds.push(stu.personId);
      const dto = await withTestTenant(async () =>
        pullOutService.create(
          {
            studentId: stu.studentId,
            regularSlotId: slotId,
            interventionName: 'iso2',
            startDate: '2027-03-15',
            frequency: 'WEEKLY',
            daysOfWeek: [1],
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenantB(async () => pullOutService.getById(dto.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('patch', () => {
    it('admin patches endDate, notes', async () => {
      const stu = await seedStudent(rawClient);
      seededStudentIds.push(stu.studentId);
      seededPlatformStudentIds.push(stu.platformStudentId);
      seededPersonIds.push(stu.personId);
      const dto = await withTestTenant(async () =>
        pullOutService.create(
          {
            studentId: stu.studentId,
            regularSlotId: slotId,
            interventionName: 'Patch test',
            startDate: '2027-03-15',
            frequency: 'WEEKLY',
            daysOfWeek: [1],
          } as any,
          adminActor(),
        ),
      );
      const upd = await withTestTenant(async () =>
        pullOutService.patch(
          dto.id,
          { endDate: '2027-06-15', notes: 'extended' } as any,
          adminActor(),
        ),
      );
      expect(upd.endDate).toBe('2027-06-15');
      expect(upd.notes).toBe('extended');
    });

    it('patch with frequency CUSTOM + daysOfWeek', async () => {
      const stu = await seedStudent(rawClient);
      seededStudentIds.push(stu.studentId);
      seededPlatformStudentIds.push(stu.platformStudentId);
      seededPersonIds.push(stu.personId);
      const dto = await withTestTenant(async () =>
        pullOutService.create(
          {
            studentId: stu.studentId,
            regularSlotId: slotId,
            interventionName: 'Patch2',
            startDate: '2027-03-15',
            frequency: 'WEEKLY',
            daysOfWeek: [1],
          } as any,
          adminActor(),
        ),
      );
      const upd = await withTestTenant(async () =>
        pullOutService.patch(
          dto.id,
          { frequency: 'CUSTOM', daysOfWeek: [2, 4] } as any,
          adminActor(),
        ),
      );
      expect(upd.frequency).toBe('CUSTOM');
      expect(upd.daysOfWeek).toEqual([2, 4]);
    });

    it('patch with no fields → returns existing', async () => {
      const stu = await seedStudent(rawClient);
      seededStudentIds.push(stu.studentId);
      seededPlatformStudentIds.push(stu.platformStudentId);
      seededPersonIds.push(stu.personId);
      const dto = await withTestTenant(async () =>
        pullOutService.create(
          {
            studentId: stu.studentId,
            regularSlotId: slotId,
            interventionName: 'Patch3',
            startDate: '2027-03-15',
            frequency: 'WEEKLY',
            daysOfWeek: [1],
          } as any,
          adminActor(),
        ),
      );
      const same = await withTestTenant(async () =>
        pullOutService.patch(dto.id, {} as any, adminActor()),
      );
      expect(same.id).toBe(dto.id);
    });

    it('non-admin patch → ForbiddenException', async () => {
      const stu = await seedStudent(rawClient);
      seededStudentIds.push(stu.studentId);
      seededPlatformStudentIds.push(stu.platformStudentId);
      seededPersonIds.push(stu.personId);
      const dto = await withTestTenant(async () =>
        pullOutService.create(
          {
            studentId: stu.studentId,
            regularSlotId: slotId,
            interventionName: 'PatchX',
            startDate: '2027-03-15',
            frequency: 'WEEKLY',
            daysOfWeek: [1],
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          pullOutService.patch(dto.id, { notes: 'no' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch foreign-tenant intervention → NotFoundException', async () => {
      const stu = await seedStudent(rawClient);
      seededStudentIds.push(stu.studentId);
      seededPlatformStudentIds.push(stu.platformStudentId);
      seededPersonIds.push(stu.personId);
      const dto = await withTestTenant(async () =>
        pullOutService.create(
          {
            studentId: stu.studentId,
            regularSlotId: slotId,
            interventionName: 'cross-tenant',
            startDate: '2027-03-15',
            frequency: 'WEEKLY',
            daysOfWeek: [1],
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenantB(async () =>
          pullOutService.patch(dto.id, { notes: 'no' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
