import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ClassService } from '@modules/m20-sis/students/class.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import { TEST_TEACHER_EMPLOYEE_ID, TEST_ADMIN_EMPLOYEE_ID } from '../helpers/actor';
import {
  TEST_SIS_CLASS_ID,
  TEST_SIS_CLASS_B_ID,
  TEST_SIS_COURSE_ID,
  TEST_SIS_TERM_ID,
  TEST_SIS_ACADEMIC_YEAR_ID,
  TEST_SIS_DEPARTMENT_ID,
} from '../fixtures/sis';
import {
  seedStudent,
  assignTeacherToClass,
  enrollStudent,
  cleanupSeededIds,
} from './sis-helpers';

/**
 * Wave 4 — m20-sis ClassService DB-backed integration.
 *
 * Contracts:
 *   - list() returns school-scoped classes; filters by term/course/year/gradeLevel
 *   - getById returns full class DTO; cross-school class → 404
 *   - listForTeacherEmployee narrows to assigned classes only
 *   - getRoster returns active enrollments only; unknown id → 404
 *   - todayAttendance summary derives NOT_STARTED / IN_PROGRESS / SUBMITTED
 *   - Cross-school: school A admin cannot list/get/roster school B's classes
 *     (REGRESSION — class.service used to lack the school predicate)
 */
describe('integration:m20-sis/class-service', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let service: ClassService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  // Extra class ids used by some tests
  const extraClassIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    service = new ClassService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.sis_attendance_records CASCADE`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_class_teachers`);
    // Remove any extra classes seeded by the previous test
    if (extraClassIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_classes WHERE id = ANY($1::uuid[])`,
        extraClassIds.splice(0),
      );
    }
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

  // ============================================================
  // list
  // ============================================================
  describe('list', () => {
    it('returns the fixture class for the test school', async () => {
      const list = await withTestTenant(async () => service.list({}));
      const ids = list.map((c) => c.id);
      expect(ids).toContain(TEST_SIS_CLASS_ID);
    });

    it('does not return school B classes when called under school A context', async () => {
      const list = await withTestTenant(async () => service.list({}));
      expect(list.map((c) => c.id)).not.toContain(TEST_SIS_CLASS_B_ID);
    });

    it('school B context returns school B class', async () => {
      const list = await withTestTenantB(async () => service.list({}));
      expect(list.map((c) => c.id)).toContain(TEST_SIS_CLASS_B_ID);
      expect(list.map((c) => c.id)).not.toContain(TEST_SIS_CLASS_ID);
    });

    it('filter by termId narrows results', async () => {
      const list = await withTestTenant(async () => service.list({ termId: TEST_SIS_TERM_ID }));
      expect(list.map((c) => c.id)).toContain(TEST_SIS_CLASS_ID);

      const empty = await withTestTenant(async () =>
        service.list({ termId: '00000000-0000-0000-0000-000000000000' }),
      );
      expect(empty).toHaveLength(0);
    });

    it('filter by courseId narrows results', async () => {
      const list = await withTestTenant(async () =>
        service.list({ courseId: TEST_SIS_COURSE_ID }),
      );
      expect(list.map((c) => c.id)).toContain(TEST_SIS_CLASS_ID);
    });

    it('filter by academicYearId narrows results', async () => {
      const list = await withTestTenant(async () =>
        service.list({ academicYearId: TEST_SIS_ACADEMIC_YEAR_ID }),
      );
      expect(list.map((c) => c.id)).toContain(TEST_SIS_CLASS_ID);
    });

    it('filter by gradeLevel narrows results', async () => {
      const list = await withTestTenant(async () => service.list({ gradeLevel: '5' }));
      expect(list.map((c) => c.id)).toContain(TEST_SIS_CLASS_ID);
      const empty = await withTestTenant(async () => service.list({ gradeLevel: '12' }));
      // The default fixture is grade 5; '12' returns 0
      expect(empty.map((c) => c.id)).not.toContain(TEST_SIS_CLASS_ID);
    });

    it('list returns enrollmentCount accurately', async () => {
      const s = await trackedStudent();
      await enrollStudent(rawClient, s.studentId);
      const list = await withTestTenant(async () => service.list({}));
      const cls = list.find((c) => c.id === TEST_SIS_CLASS_ID);
      expect(cls).toBeDefined();
      expect(cls!.enrollmentCount).toBeGreaterThanOrEqual(1);
    });

    it('list populates teachers when assigned', async () => {
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID);
      const list = await withTestTenant(async () => service.list({}));
      const cls = list.find((c) => c.id === TEST_SIS_CLASS_ID);
      expect(cls).toBeDefined();
      expect(cls!.teachers.length).toBeGreaterThanOrEqual(1);
      expect(cls!.teachers[0]!.isPrimaryTeacher).toBe(true);
    });

    it('todayAttendance defaults to NOT_STARTED when no records', async () => {
      const list = await withTestTenant(async () => service.list({}));
      const cls = list.find((c) => c.id === TEST_SIS_CLASS_ID);
      expect(cls!.todayAttendance?.status).toBe('NOT_STARTED');
      expect(cls!.todayAttendance?.totalRecorded).toBe(0);
    });

    it('todayAttendance status flips to SUBMITTED when every row is CONFIRMED', async () => {
      const today = new Date().toISOString().slice(0, 10);
      // school_year boundary: today (2026-05-18) falls inside 2025-08-01 → 2026-08-01
      const schoolYear = today >= '2026-08-01' ? '2026-08-01' : '2025-08-01';
      const s = await trackedStudent();
      await enrollStudent(rawClient, s.studentId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_attendance_records
           (id, school_id, school_year, student_id, class_id, date, period, status, confirmation_status)
         VALUES ($1::uuid, $2::uuid, $3::date, $4::uuid, $5::uuid, $6::date, 'AM', 'PRESENT', 'CONFIRMED')`,
        generateId(),
        TEST_SCHOOL_ID,
        schoolYear,
        s.studentId,
        TEST_SIS_CLASS_ID,
        today,
      );
      const list = await withTestTenant(async () => service.list({}));
      const cls = list.find((c) => c.id === TEST_SIS_CLASS_ID);
      expect(cls!.todayAttendance?.status).toBe('SUBMITTED');
      expect(cls!.todayAttendance?.totalRecorded).toBe(1);
      expect(cls!.todayAttendance?.present).toBe(1);
    });

    it('todayAttendance is IN_PROGRESS when one row is still PRE_POPULATED', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const schoolYear = today >= '2026-08-01' ? '2026-08-01' : '2025-08-01';
      const s1 = await trackedStudent();
      const s2 = await trackedStudent();
      await enrollStudent(rawClient, s1.studentId);
      await enrollStudent(rawClient, s2.studentId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_attendance_records
           (id, school_id, school_year, student_id, class_id, date, period, status, confirmation_status)
         VALUES ($1::uuid, $2::uuid, $3::date, $4::uuid, $5::uuid, $6::date, 'AM', 'PRESENT', 'CONFIRMED')`,
        generateId(),
        TEST_SCHOOL_ID,
        schoolYear,
        s1.studentId,
        TEST_SIS_CLASS_ID,
        today,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_attendance_records
           (id, school_id, school_year, student_id, class_id, date, period, status, confirmation_status)
         VALUES ($1::uuid, $2::uuid, $3::date, $4::uuid, $5::uuid, $6::date, 'AM', 'PRESENT', 'PRE_POPULATED')`,
        generateId(),
        TEST_SCHOOL_ID,
        schoolYear,
        s2.studentId,
        TEST_SIS_CLASS_ID,
        today,
      );
      const list = await withTestTenant(async () => service.list({}));
      const cls = list.find((c) => c.id === TEST_SIS_CLASS_ID);
      expect(cls!.todayAttendance?.status).toBe('IN_PROGRESS');
      expect(cls!.todayAttendance?.totalRecorded).toBe(2);
    });
  });

  // ============================================================
  // getById
  // ============================================================
  describe('getById', () => {
    it('admin gets the fixture class', async () => {
      const dto = await withTestTenant(async () => service.getById(TEST_SIS_CLASS_ID));
      expect(dto.id).toBe(TEST_SIS_CLASS_ID);
      expect(dto.course.code).toBe('SIS-101');
      expect(dto.term).not.toBeNull();
      expect(dto.term!.id).toBe(TEST_SIS_TERM_ID);
    });

    it('unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.getById('00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('Cross-school class id from school A context → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => service.getById(TEST_SIS_CLASS_B_ID)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('school B context resolves school B class', async () => {
      const dto = await withTestTenantB(async () => service.getById(TEST_SIS_CLASS_B_ID));
      expect(dto.id).toBe(TEST_SIS_CLASS_B_ID);
    });

    it('term-less class returns null term in DTO', async () => {
      // TEST_SIS_CLASS_B_ID has term_id NULL — verify dto.term is null.
      const dto = await withTestTenantB(async () => service.getById(TEST_SIS_CLASS_B_ID));
      expect(dto.term).toBeNull();
    });
  });

  // ============================================================
  // listForTeacherEmployee
  // ============================================================
  describe('listForTeacherEmployee', () => {
    it('returns only classes the teacher is assigned to', async () => {
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID);
      const list = await withTestTenant(async () =>
        service.listForTeacherEmployee(TEST_TEACHER_EMPLOYEE_ID),
      );
      const ids = list.map((c) => c.id);
      expect(ids).toContain(TEST_SIS_CLASS_ID);
    });

    it('returns empty list when teacher has no assignments', async () => {
      const list = await withTestTenant(async () =>
        service.listForTeacherEmployee(TEST_ADMIN_EMPLOYEE_ID),
      );
      expect(list).toHaveLength(0);
    });

    it('cross-school: teacher assigned to school B class is invisible from school A', async () => {
      // Assign the teacher employee to TEST_SIS_CLASS_B_ID via raw SQL —
      // tenant_test schema is shared but the school predicate baked into the
      // SELECT should filter out cross-school assignments.
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_B_ID, TEST_TEACHER_EMPLOYEE_ID);
      const list = await withTestTenant(async () =>
        service.listForTeacherEmployee(TEST_TEACHER_EMPLOYEE_ID),
      );
      const ids = list.map((c) => c.id);
      expect(ids).not.toContain(TEST_SIS_CLASS_B_ID);
    });

    it('today attendance summary is enriched on returned classes', async () => {
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID);
      const list = await withTestTenant(async () =>
        service.listForTeacherEmployee(TEST_TEACHER_EMPLOYEE_ID),
      );
      const cls = list.find((c) => c.id === TEST_SIS_CLASS_ID);
      expect(cls?.todayAttendance).toBeDefined();
      expect(cls?.todayAttendance?.status).toBe('NOT_STARTED');
    });
  });

  // ============================================================
  // getRoster
  // ============================================================
  describe('getRoster', () => {
    it('returns active enrollments with student names', async () => {
      const s = await trackedStudent({ firstName: 'Roster', lastName: 'One' });
      await enrollStudent(rawClient, s.studentId);
      const roster = await withTestTenant(async () => service.getRoster(TEST_SIS_CLASS_ID));
      const sids = roster.map((r) => r.studentId);
      expect(sids).toContain(s.studentId);
      const entry = roster.find((r) => r.studentId === s.studentId)!;
      expect(entry.firstName).toBe('Roster');
      expect(entry.lastName).toBe('One');
      expect(entry.fullName).toBe('Roster One');
      expect(entry.enrollmentStatus).toBe('ACTIVE');
    });

    it('excludes dropped enrollments', async () => {
      const s = await trackedStudent();
      const enrId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_enrollments (id, student_id, class_id, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'DROPPED')`,
        enrId,
        s.studentId,
        TEST_SIS_CLASS_ID,
      );
      const roster = await withTestTenant(async () => service.getRoster(TEST_SIS_CLASS_ID));
      expect(roster.map((r) => r.studentId)).not.toContain(s.studentId);
    });

    it('unknown class id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.getRoster('00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('Cross-school class id from school A context → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => service.getRoster(TEST_SIS_CLASS_B_ID)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('roster ordering is by last_name then first_name', async () => {
      const s1 = await trackedStudent({ firstName: 'Bob', lastName: 'Anderson' });
      const s2 = await trackedStudent({ firstName: 'Anne', lastName: 'Brown' });
      await enrollStudent(rawClient, s1.studentId);
      await enrollStudent(rawClient, s2.studentId);
      const roster = await withTestTenant(async () => service.getRoster(TEST_SIS_CLASS_ID));
      const idx1 = roster.findIndex((r) => r.studentId === s1.studentId);
      const idx2 = roster.findIndex((r) => r.studentId === s2.studentId);
      expect(idx1).toBeGreaterThanOrEqual(0);
      expect(idx2).toBeGreaterThanOrEqual(0);
      expect(idx1).toBeLessThan(idx2); // Anderson < Brown
    });
  });

  // ============================================================
  // School-scope regression (REVIEW-WAVE4 — class.service added school predicate)
  // ============================================================
  describe('school-scope regression', () => {
    it('list under school A context excludes a freshly-seeded school B class', async () => {
      // Seed a new class in school B
      const newClassId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_classes
           (id, school_id, course_id, academic_year_id, term_id, section_code, max_enrollment)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, NULL, 'C-B', 30)`,
        newClassId,
        TEST_SCHOOL_B_ID,
        TEST_SIS_COURSE_ID, // course belongs to school A but the SELECT joins course_id only
        TEST_SIS_ACADEMIC_YEAR_ID, // ditto
      );
      extraClassIds.push(newClassId);
      // School A context should not see this class
      const listA = await withTestTenant(async () => service.list({}));
      expect(listA.map((c) => c.id)).not.toContain(newClassId);
      // Direct getById from school A also fails
      await expect(
        withTestTenant(async () => service.getById(newClassId)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
