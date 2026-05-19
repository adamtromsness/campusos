import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { BellScheduleService } from '@modules/m22-scheduling/bell-schedule.service';
import { DayOverrideService } from '@modules/m22-scheduling/day-override.service';
import { SubjectChoiceService } from '@modules/m22-scheduling/subject-choice.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
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
  studentActor,
  parentActor,
  TEST_STUDENT_PERSON_ID,
  TEST_PARENT_PERSON_ID,
  TEST_TEACHER_ACCOUNT_ID,
} from '../helpers/actor';
import {
  TEST_SIS_ACADEMIC_YEAR_ID,
  TEST_SIS_COURSE_ID,
  TEST_SIS_ACADEMIC_YEAR_B_ID,
  TEST_SIS_COURSE_B_ID,
} from '../fixtures/sis';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { seedStudent, cleanupSeededIds } from '../m20-sis/sis-helpers';

/**
 * m22-scheduling bell-schedules / day-overrides / subject-choices
 * integration tests. Covers:
 *   - BellScheduleService (305 lines)
 *   - DayOverrideService (149 lines)
 *   - SubjectChoiceService (104 lines)
 */
describe('integration:m22-scheduling/bell-schedules', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let bellService: BellScheduleService;
  let dayOverrideService: DayOverrideService;
  let subjectChoiceService: SubjectChoiceService;
  let permissionCheck: PermissionCheckService;

  const scheduleIds: string[] = [];
  const overrideIds: string[] = [];
  const windowIds: string[] = [];
  const choiceIds: string[] = [];
  const seededStudentIds: string[] = [];
  const seededPlatformStudentIds: string[] = [];
  const seededPersonIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permissionCheck = new PermissionCheckService(rawClient);
    bellService = new BellScheduleService(tenantPrisma);
    dayOverrideService = new DayOverrideService(tenantPrisma);
    subjectChoiceService = new SubjectChoiceService(tenantPrisma, permissionCheck);

    // Wipe everything we own up-front.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_student_subject_choices`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_subject_choice_windows WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_calendar_day_overrides WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_periods WHERE bell_schedule_id IN (SELECT id FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  afterAll(async () => {
    // Cleanup choices first (FK to students), then windows, overrides, periods, schedules.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_student_subject_choices`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_subject_choice_windows WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_calendar_day_overrides WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_periods WHERE bell_schedule_id IN (SELECT id FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE school_id IN ($1::uuid, $2::uuid)`,
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

    // Clear out IAM cache rows used to grant sch-001:admin.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache
       WHERE account_id IN ($1::uuid, $2::uuid) AND scope_id = $3::uuid`,
      TEST_TEACHER_ACCOUNT_ID,
      TEST_TEACHER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
    );

    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Per-test wipe — surgical, only our school's rows.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_student_subject_choices`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_subject_choice_windows WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_calendar_day_overrides WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_periods WHERE bell_schedule_id IN (SELECT id FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    scheduleIds.length = 0;
    overrideIds.length = 0;
    windowIds.length = 0;
    choiceIds.length = 0;
  });

  // ────────────────────────────────────────────────────────────────────
  // BellScheduleService
  // ────────────────────────────────────────────────────────────────────
  describe('BellScheduleService.create', () => {
    it('admin creates a bell schedule', async () => {
      const dto = await withTestTenant(async () =>
        bellService.create({ name: 'BS A', scheduleType: 'STANDARD' } as any, adminActor()),
      );
      scheduleIds.push(dto.id);
      expect(dto.name).toBe('BS A');
      expect(dto.scheduleType).toBe('STANDARD');
      expect(dto.isDefault).toBe(false);
      expect(dto.periods).toEqual([]);
    });

    it('non-admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          bellService.create({ name: 'BS X', scheduleType: 'STANDARD' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('isDefault=true clears any existing default in the same school', async () => {
      const first = await withTestTenant(async () =>
        bellService.create(
          { name: 'BS first', scheduleType: 'STANDARD', isDefault: true } as any,
          adminActor(),
        ),
      );
      scheduleIds.push(first.id);
      expect(first.isDefault).toBe(true);

      const second = await withTestTenant(async () =>
        bellService.create(
          { name: 'BS second', scheduleType: 'STANDARD', isDefault: true } as any,
          adminActor(),
        ),
      );
      scheduleIds.push(second.id);
      expect(second.isDefault).toBe(true);

      const refreshed = await withTestTenant(async () => bellService.getById(first.id));
      expect(refreshed.isDefault).toBe(false);
    });
  });

  describe('BellScheduleService.update / setDefault', () => {
    it('update name + scheduleType applied', async () => {
      const dto = await withTestTenant(async () =>
        bellService.create({ name: 'BS up', scheduleType: 'STANDARD' } as any, adminActor()),
      );
      scheduleIds.push(dto.id);
      const upd = await withTestTenant(async () =>
        bellService.update(
          dto.id,
          { name: 'BS up2', scheduleType: 'ASSEMBLY' } as any,
          adminActor(),
        ),
      );
      expect(upd.name).toBe('BS up2');
      expect(upd.scheduleType).toBe('ASSEMBLY');
    });

    it('update with no fields returns existing', async () => {
      const dto = await withTestTenant(async () =>
        bellService.create({ name: 'BS noop', scheduleType: 'STANDARD' } as any, adminActor()),
      );
      scheduleIds.push(dto.id);
      const noop = await withTestTenant(async () =>
        bellService.update(dto.id, {} as any, adminActor()),
      );
      expect(noop.id).toBe(dto.id);
    });

    it('non-admin update → ForbiddenException', async () => {
      const dto = await withTestTenant(async () =>
        bellService.create({ name: 'BS up3', scheduleType: 'STANDARD' } as any, adminActor()),
      );
      scheduleIds.push(dto.id);
      await expect(
        withTestTenant(async () =>
          bellService.update(dto.id, { name: 'X' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('setDefault flips the default flag atomically', async () => {
      const a = await withTestTenant(async () =>
        bellService.create(
          { name: 'BS sd-a', scheduleType: 'STANDARD', isDefault: true } as any,
          adminActor(),
        ),
      );
      scheduleIds.push(a.id);
      const b = await withTestTenant(async () =>
        bellService.create({ name: 'BS sd-b', scheduleType: 'STANDARD' } as any, adminActor()),
      );
      scheduleIds.push(b.id);

      const updated = await withTestTenant(async () => bellService.setDefault(b.id, adminActor()));
      expect(updated.isDefault).toBe(true);

      const aAfter = await withTestTenant(async () => bellService.getById(a.id));
      expect(aAfter.isDefault).toBe(false);
    });

    it('setDefault non-admin → ForbiddenException', async () => {
      const dto = await withTestTenant(async () =>
        bellService.create({ name: 'BS sd-x', scheduleType: 'STANDARD' } as any, adminActor()),
      );
      scheduleIds.push(dto.id);
      await expect(
        withTestTenant(async () => bellService.setDefault(dto.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('setDefault unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          bellService.setDefault('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById unknown → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          bellService.getById('00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('BellScheduleService.upsertPeriods', () => {
    it('admin replaces periods atomically', async () => {
      const dto = await withTestTenant(async () =>
        bellService.create({ name: 'BS pp', scheduleType: 'STANDARD' } as any, adminActor()),
      );
      scheduleIds.push(dto.id);
      const updated = await withTestTenant(async () =>
        bellService.upsertPeriods(
          dto.id,
          {
            periods: [
              { name: 'P1', dayOfWeek: 0, startTime: '08:00', endTime: '09:00', periodType: 'LESSON', sortOrder: 1 },
              { name: 'P2', dayOfWeek: 0, startTime: '09:05', endTime: '10:05', periodType: 'LESSON', sortOrder: 2 },
            ],
          } as any,
          adminActor(),
        ),
      );
      expect(updated.periods).toHaveLength(2);
      expect(updated.periods[0]!.name).toBe('P1');
      expect(updated.periods[1]!.name).toBe('P2');
    });

    it('empty periods list → BadRequestException', async () => {
      const dto = await withTestTenant(async () =>
        bellService.create({ name: 'BS pp2', scheduleType: 'STANDARD' } as any, adminActor()),
      );
      scheduleIds.push(dto.id);
      await expect(
        withTestTenant(async () =>
          bellService.upsertPeriods(dto.id, { periods: [] } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-admin upsertPeriods → ForbiddenException', async () => {
      const dto = await withTestTenant(async () =>
        bellService.create({ name: 'BS pp3', scheduleType: 'STANDARD' } as any, adminActor()),
      );
      scheduleIds.push(dto.id);
      await expect(
        withTestTenant(async () =>
          bellService.upsertPeriods(
            dto.id,
            {
              periods: [
                { name: 'P1', startTime: '08:00', endTime: '09:00', periodType: 'LESSON' },
              ],
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('start >= end period → BadRequestException', async () => {
      const dto = await withTestTenant(async () =>
        bellService.create({ name: 'BS pp4', scheduleType: 'STANDARD' } as any, adminActor()),
      );
      scheduleIds.push(dto.id);
      await expect(
        withTestTenant(async () =>
          bellService.upsertPeriods(
            dto.id,
            {
              periods: [
                { name: 'P1', startTime: '10:00', endTime: '09:00', periodType: 'LESSON' },
              ],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // DayOverrideService
  // ────────────────────────────────────────────────────────────────────
  describe('DayOverrideService', () => {
    it('admin creates a day override', async () => {
      const dto = await withTestTenant(async () =>
        dayOverrideService.create(
          { overrideDate: '2027-12-25', isSchoolDay: false, reason: 'Holiday' } as any,
          adminActor(),
        ),
      );
      overrideIds.push(dto.id);
      expect(dto.overrideDate).toBe('2027-12-25');
      expect(dto.isSchoolDay).toBe(false);
      expect(dto.reason).toBe('Holiday');
    });

    it('non-admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          dayOverrideService.create(
            { overrideDate: '2027-12-25', isSchoolDay: false } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('duplicate (school, date) → ConflictException', async () => {
      await withTestTenant(async () =>
        dayOverrideService.create(
          { overrideDate: '2027-01-01', isSchoolDay: false } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          dayOverrideService.create(
            { overrideDate: '2027-01-01', isSchoolDay: false } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('getByDate unknown → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => dayOverrideService.getByDate('2025-01-01')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('deleteByDate succeeds for admin, 404 thereafter', async () => {
      await withTestTenant(async () =>
        dayOverrideService.create(
          { overrideDate: '2027-02-02', isSchoolDay: true } as any,
          adminActor(),
        ),
      );
      const res = await withTestTenant(async () =>
        dayOverrideService.deleteByDate('2027-02-02', adminActor()),
      );
      expect(res.deleted).toBe(true);
      await expect(
        withTestTenant(async () =>
          dayOverrideService.deleteByDate('2027-02-02', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('deleteByDate non-admin → ForbiddenException', async () => {
      await withTestTenant(async () =>
        dayOverrideService.create(
          { overrideDate: '2027-03-03', isSchoolDay: true } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          dayOverrideService.deleteByDate('2027-03-03', teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list filters by date range', async () => {
      await withTestTenant(async () =>
        dayOverrideService.create(
          { overrideDate: '2027-06-01', isSchoolDay: true } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        dayOverrideService.create(
          { overrideDate: '2027-06-15', isSchoolDay: true } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        dayOverrideService.create(
          { overrideDate: '2027-07-01', isSchoolDay: true } as any,
          adminActor(),
        ),
      );
      const filtered = await withTestTenant(async () =>
        dayOverrideService.list({ fromDate: '2027-06-01', toDate: '2027-06-30' } as any),
      );
      const dates = filtered.map((r) => r.overrideDate);
      expect(dates).toContain('2027-06-01');
      expect(dates).toContain('2027-06-15');
      expect(dates).not.toContain('2027-07-01');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // SubjectChoiceService
  // ────────────────────────────────────────────────────────────────────
  describe('SubjectChoiceService.windows', () => {
    it('admin creates a window', async () => {
      const dto = await withTestTenant(async () =>
        subjectChoiceService.createWindow(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            name: 'Fall window',
            opensAt: '2027-08-01T00:00:00Z',
            closesAt: '2027-09-01T00:00:00Z',
            isActive: true,
          } as any,
          adminActor(),
        ),
      );
      windowIds.push(dto.id);
      expect(dto.name).toBe('Fall window');
      expect(dto.isActive).toBe(true);
    });

    it('window with closesAt <= opensAt → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          subjectChoiceService.createWindow(
            {
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              opensAt: '2027-09-01T00:00:00Z',
              closesAt: '2027-08-01T00:00:00Z',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-admin createWindow → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          subjectChoiceService.createWindow(
            {
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              opensAt: '2027-08-01T00:00:00Z',
              closesAt: '2027-09-01T00:00:00Z',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listWindows returns only current-school windows', async () => {
      // Create one in each school
      const a = await withTestTenant(async () =>
        subjectChoiceService.createWindow(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            opensAt: '2027-08-01T00:00:00Z',
            closesAt: '2027-09-01T00:00:00Z',
          } as any,
          adminActor(),
        ),
      );
      windowIds.push(a.id);
      const b = await withTestTenantB(async () =>
        subjectChoiceService.createWindow(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_B_ID,
            opensAt: '2027-08-01T00:00:00Z',
            closesAt: '2027-09-01T00:00:00Z',
          } as any,
          adminActor(),
        ),
      );
      windowIds.push(b.id);

      const aList = await withTestTenant(async () => subjectChoiceService.listWindows());
      expect(aList.map((w) => w.id)).toContain(a.id);
      expect(aList.map((w) => w.id)).not.toContain(b.id);
    });
  });

  describe('SubjectChoiceService.submit + list', () => {
    it('admin submits on behalf of a student in this school', async () => {
      const stu = await seedStudent(rawClient);
      seededStudentIds.push(stu.studentId);
      seededPlatformStudentIds.push(stu.platformStudentId);
      seededPersonIds.push(stu.personId);

      const dto = await withTestTenant(async () =>
        subjectChoiceService.submit(
          {
            studentId: stu.studentId,
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            courseId: TEST_SIS_COURSE_ID,
            preferenceRank: 1,
            isRequired: true,
          } as any,
          adminActor(),
        ),
      );
      choiceIds.push(dto.id);
      expect(dto.studentId).toBe(stu.studentId);
      expect(dto.preferenceRank).toBe(1);
      expect(dto.isRequired).toBe(true);
    });

    it('admin submitting cross-school studentId → BadRequestException', async () => {
      // Seed a student in school B
      const stuB = await seedStudent(rawClient, { schoolId: TEST_SCHOOL_B_ID });
      seededStudentIds.push(stuB.studentId);
      seededPlatformStudentIds.push(stuB.platformStudentId);
      seededPersonIds.push(stuB.personId);
      await expect(
        withTestTenant(async () =>
          subjectChoiceService.submit(
            {
              studentId: stuB.studentId,
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              courseId: TEST_SIS_COURSE_ID,
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-admin non-student non-guardian (teacher) → ForbiddenException', async () => {
      const stu = await seedStudent(rawClient);
      seededStudentIds.push(stu.studentId);
      seededPlatformStudentIds.push(stu.platformStudentId);
      seededPersonIds.push(stu.personId);
      await expect(
        withTestTenant(async () =>
          subjectChoiceService.submit(
            {
              studentId: stu.studentId,
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              courseId: TEST_SIS_COURSE_ID,
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('student submitting on themselves with an open window succeeds', async () => {
      // Need a STUDENT actor whose iam_person resolves to a sis_students row.
      const studentPersonId = TEST_STUDENT_PERSON_ID;
      // UNIQUE(person_id) on platform_students — look for an existing
      // projection first so the second pass in this describe doesn't crash.
      const existing = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM platform.platform_students WHERE person_id = $1::uuid LIMIT 1`,
        studentPersonId,
      );
      let platformStudentId: string;
      if (existing.length > 0) {
        platformStudentId = existing[0]!.id;
      } else {
        platformStudentId = generateId();
        await rawClient.$executeRawUnsafe(
          `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
           VALUES ($1::uuid, $2::uuid, 'Integration', 'Student', true)`,
          platformStudentId,
          studentPersonId,
        );
        seededPlatformStudentIds.push(platformStudentId);
      }
      const studentId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_students
           (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '10', 'ENROLLED')`,
        studentId,
        platformStudentId,
        TEST_SCHOOL_ID,
        'STU-' + Math.random().toString(36).slice(2, 9).toUpperCase(),
      );
      seededStudentIds.push(studentId);

      // Open window
      const w = await withTestTenant(async () =>
        subjectChoiceService.createWindow(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            opensAt: '2020-01-01T00:00:00Z',
            closesAt: '2099-01-01T00:00:00Z',
          } as any,
          adminActor(),
        ),
      );
      windowIds.push(w.id);

      try {
        const dto = await withTestTenant(async () =>
          subjectChoiceService.submit(
            {
              studentId,
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              courseId: TEST_SIS_COURSE_ID,
            } as any,
            studentActor(),
          ),
        );
        choiceIds.push(dto.id);
        expect(dto.studentId).toBe(studentId);
      } finally {
        // Cleanup
      }
    });

    it('student submitting for someone else → ForbiddenException', async () => {
      const stu = await seedStudent(rawClient);
      seededStudentIds.push(stu.studentId);
      seededPlatformStudentIds.push(stu.platformStudentId);
      seededPersonIds.push(stu.personId);
      // Open window so it doesn't fail with "no window".
      const w = await withTestTenant(async () =>
        subjectChoiceService.createWindow(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            opensAt: '2020-01-01T00:00:00Z',
            closesAt: '2099-01-01T00:00:00Z',
          } as any,
          adminActor(),
        ),
      );
      windowIds.push(w.id);

      await expect(
        withTestTenant(async () =>
          subjectChoiceService.submit(
            {
              studentId: stu.studentId,
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              courseId: TEST_SIS_COURSE_ID,
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('student submitting without an open window → BadRequestException', async () => {
      // No window created.
      // Reuse the existing sis_students row that the previous test created
      // for TEST_STUDENT_PERSON_ID. UNIQUE(person_id) on platform_students
      // and UNIQUE(platform_student_id) on sis_students mean we cannot
      // create a second projection — the prior test's row is durable across
      // this describe block.
      const existingRows = await rawClient.$queryRawUnsafe<
        Array<{ id: string }>
      >(
        `SELECT s.id::text AS id FROM ${TEST_SCHEMA}.sis_students s
           JOIN platform.platform_students ps ON ps.id = s.platform_student_id
         WHERE ps.person_id = $1::uuid AND s.school_id = $2::uuid LIMIT 1`,
        TEST_STUDENT_PERSON_ID,
        TEST_SCHOOL_ID,
      );
      let studentId: string;
      if (existingRows.length > 0) {
        studentId = existingRows[0]!.id;
      } else {
        const platformStudentId = generateId();
        await rawClient.$executeRawUnsafe(
          `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
           VALUES ($1::uuid, $2::uuid, 'Integration', 'Student', true)`,
          platformStudentId,
          TEST_STUDENT_PERSON_ID,
        );
        seededPlatformStudentIds.push(platformStudentId);
        studentId = generateId();
        await rawClient.$executeRawUnsafe(
          `INSERT INTO ${TEST_SCHEMA}.sis_students
             (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '10', 'ENROLLED')`,
          studentId,
          platformStudentId,
          TEST_SCHOOL_ID,
          'STU-' + Math.random().toString(36).slice(2, 9).toUpperCase(),
        );
        seededStudentIds.push(studentId);
      }

      await expect(
        withTestTenant(async () =>
          subjectChoiceService.submit(
            {
              studentId,
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              courseId: TEST_SIS_COURSE_ID,
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('duplicate submission (student, year, course) → ConflictException', async () => {
      const stu = await seedStudent(rawClient);
      seededStudentIds.push(stu.studentId);
      seededPlatformStudentIds.push(stu.platformStudentId);
      seededPersonIds.push(stu.personId);
      await withTestTenant(async () =>
        subjectChoiceService.submit(
          {
            studentId: stu.studentId,
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            courseId: TEST_SIS_COURSE_ID,
            preferenceRank: 1,
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          subjectChoiceService.submit(
            {
              studentId: stu.studentId,
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              courseId: TEST_SIS_COURSE_ID,
              preferenceRank: 2,
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('admin demand matrix returns aggregated counts', async () => {
      const stu = await seedStudent(rawClient);
      seededStudentIds.push(stu.studentId);
      seededPlatformStudentIds.push(stu.platformStudentId);
      seededPersonIds.push(stu.personId);
      await withTestTenant(async () =>
        subjectChoiceService.submit(
          {
            studentId: stu.studentId,
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            courseId: TEST_SIS_COURSE_ID,
            preferenceRank: 1,
            isRequired: true,
          } as any,
          adminActor(),
        ),
      );
      const matrix = await withTestTenant(async () =>
        subjectChoiceService.demand(TEST_SIS_ACADEMIC_YEAR_ID, adminActor()),
      );
      const row = matrix.find((r) => r.courseId === TEST_SIS_COURSE_ID);
      expect(row).toBeDefined();
      expect(row!.totalStudents).toBeGreaterThanOrEqual(1);
      expect(row!.rankedFirstCount).toBeGreaterThanOrEqual(1);
      expect(row!.requiredCount).toBeGreaterThanOrEqual(1);
    });

    it('non-admin demand → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          subjectChoiceService.demand(TEST_SIS_ACADEMIC_YEAR_ID, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list as non-admin non-student non-guardian returns []', async () => {
      const stu = await seedStudent(rawClient);
      seededStudentIds.push(stu.studentId);
      seededPlatformStudentIds.push(stu.platformStudentId);
      seededPersonIds.push(stu.personId);
      await withTestTenant(async () =>
        subjectChoiceService.submit(
          {
            studentId: stu.studentId,
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            courseId: TEST_SIS_COURSE_ID,
          } as any,
          adminActor(),
        ),
      );
      const result = await withTestTenant(async () =>
        subjectChoiceService.list(teacherActor(), {}),
      );
      expect(result).toEqual([]);
    });

    it('list as admin returns all rows in this school', async () => {
      const stu = await seedStudent(rawClient);
      seededStudentIds.push(stu.studentId);
      seededPlatformStudentIds.push(stu.platformStudentId);
      seededPersonIds.push(stu.personId);
      await withTestTenant(async () =>
        subjectChoiceService.submit(
          {
            studentId: stu.studentId,
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            courseId: TEST_SIS_COURSE_ID,
          } as any,
          adminActor(),
        ),
      );
      const result = await withTestTenant(async () =>
        subjectChoiceService.list(adminActor(), {}),
      );
      expect(result.length).toBeGreaterThanOrEqual(1);
    });
  });
});
