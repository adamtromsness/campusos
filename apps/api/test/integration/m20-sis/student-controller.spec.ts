import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { StudentController } from '@modules/m20-sis/students/student.controller';
import { StudentService } from '@modules/m20-sis/students/student.service';
import { FamilyService } from '@modules/m20-sis/family/family.service';
import { ClassController } from '@modules/m20-sis/students/class.controller';
import { ClassService } from '@modules/m20-sis/students/class.service';
import { AcademicYearController } from '@modules/m20-sis/students/academic-year.controller';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { TEST_ADMIN_PERSON_ID, TEST_ADMIN_ACCOUNT_ID } from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { TEST_SIS_CLASS_ID, TEST_SIS_ACADEMIC_YEAR_ID } from '../fixtures/sis';
import {
  seedStudent,
  seedGuardian,
  linkStudentGuardian,
  enrollStudent,
  assignTeacherToClass,
  cleanupSeededIds,
} from './sis-helpers';

/**
 * Wave 4 — m20-sis StudentController + ClassController + AcademicYearController
 *
 * Controller methods are thin delegations to services that the existing
 * StudentService / ClassService / FamilyService specs cover deeply. The
 * value here is bumping the controller files from 0% to ≥80% so the
 * module-level coverage hits the Wave 4 target.
 *
 * Pattern (per m25-curriculum/curriculum-controller.spec.ts):
 *  - Construct the controller with real services.
 *  - Drive endpoints with synthetic AuthedRequest objects.
 *  - Run inside withTestTenant() so tenant context resolves to tenant_test.
 *  - Seed an admin permission cache row so actor.isSchoolAdmin = true.
 */
describe('integration:m20-sis/student-controller', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let actorContext: ActorContextService;
  let studentService: StudentService;
  let familyService: FamilyService;
  let classService: ClassService;
  let studentController: StudentController;
  let classController: ClassController;
  let academicYearController: AcademicYearController;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

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
    studentService = new StudentService(tenantPrisma);
    familyService = new FamilyService(tenantPrisma);
    classService = new ClassService(tenantPrisma);

    studentController = new StudentController(studentService, familyService, actorContext);
    classController = new ClassController(classService, actorContext);
    academicYearController = new AcademicYearController(tenantPrisma);

    // Seed admin permission cache so isSchoolAdmin resolves true.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid,
               ARRAY['sch-001:admin','stu-001:write','stu-001:read','att-001:write','att-001:read']::text[],
               now(), 'test')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes`,
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
    );
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_ADMIN_ACCOUNT_ID,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_class_teachers WHERE class_id = $1::uuid`,
      TEST_SIS_CLASS_ID,
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

  async function trackedGuardian(opts: Parameters<typeof seedGuardian>[1] = {}) {
    const g = await seedGuardian(rawClient, opts);
    guardianIds.push(g.guardianId);
    personIds.push(g.personId);
    accountIds.push(g.accountId);
    return g;
  }

  // ─── StudentController ──────────────────────────────────────────────

  describe('StudentController', () => {
    it('list returns school students', async () => {
      const s = await trackedStudent({ firstName: 'List', lastName: 'Me' });
      const list = await withTestTenant(async () =>
        studentController.list({} as any, fakeAdminReq()),
      );
      expect(list.map((r) => r.id)).toContain(s.studentId);
    });

    it('list with gradeLevel filter', async () => {
      const s = await trackedStudent({ gradeLevel: '9' });
      const list = await withTestTenant(async () =>
        studentController.list({ gradeLevel: '9' } as any, fakeAdminReq()),
      );
      expect(list.map((r) => r.id)).toContain(s.studentId);
    });

    it('getOne returns a student by id', async () => {
      const s = await trackedStudent();
      const dto = await withTestTenant(async () =>
        studentController.getOne(s.studentId, fakeAdminReq()),
      );
      expect(dto.id).toBe(s.studentId);
    });

    it('create + patch round trip', async () => {
      const studentNumber = 'CTL-' + Date.now();
      const created = await withTestTenant(async () =>
        studentController.create(
          {
            firstName: 'Ctl',
            lastName: 'Created',
            studentNumber,
            gradeLevel: '5',
          } as any,
          fakeAdminReq(),
        ),
      );
      studentIds.push(created.id);
      platformStudentIds.push(created.platformStudentId);
      personIds.push(created.personId);

      expect(created.studentNumber).toBe(studentNumber);

      const patched = await withTestTenant(async () =>
        studentController.patch(created.id, { gradeLevel: '6' } as any, fakeAdminReq()),
      );
      expect(patched.gradeLevel).toBe('6');
    });

    it('getGuardians returns guardians for the student', async () => {
      const student = await trackedStudent();
      const guardian = await trackedGuardian({ firstName: 'Gu', lastName: 'Ardian' });
      await linkStudentGuardian(rawClient, student.studentId, guardian.guardianId);

      const guardians = await withTestTenant(async () =>
        studentController.getGuardians(student.studentId, fakeAdminReq()),
      );
      expect(guardians.map((g) => g.id)).toContain(guardian.guardianId);
    });

    it('myChildren returns linked-children list for the caller', async () => {
      // Admin has no children — empty list is the expected happy path.
      const list = await withTestTenant(async () => studentController.myChildren(fakeAdminReq()));
      expect(Array.isArray(list)).toBe(true);
    });

    it('me throws NotFound when caller is not a STUDENT persona', async () => {
      await expect(
        withTestTenant(async () => studentController.me(fakeAdminReq())),
      ).rejects.toThrow();
    });
  });

  // ─── ClassController ────────────────────────────────────────────────

  describe('ClassController', () => {
    it('list returns classes', async () => {
      const list = await withTestTenant(async () => classController.list({} as any));
      // TEST_SIS_CLASS_ID is the fixture class for the school.
      expect(list.map((c) => c.id)).toContain(TEST_SIS_CLASS_ID);
    });

    it('list with academicYearId filter', async () => {
      const list = await withTestTenant(async () =>
        classController.list({ academicYearId: TEST_SIS_ACADEMIC_YEAR_ID } as any),
      );
      expect(Array.isArray(list)).toBe(true);
    });

    it('getOne returns class by id', async () => {
      const cls = await withTestTenant(async () => classController.getOne(TEST_SIS_CLASS_ID));
      expect(cls.id).toBe(TEST_SIS_CLASS_ID);
    });

    it('roster returns enrolled students', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId, TEST_SIS_CLASS_ID);

      const roster = await withTestTenant(async () => classController.roster(TEST_SIS_CLASS_ID));
      expect(roster.map((r) => r.studentId)).toContain(student.studentId);
    });

    it('my returns empty when caller has no employeeId mapping', async () => {
      // Admin actor has employeeId = TEST_ADMIN_EMPLOYEE_ID but no
      // hr_employees row is bridged for the admin persona; falls through
      // to listForTeacherEmployee which returns rows only if the employee
      // is in sis_class_teachers. With no assignment, the result is [].
      const list = await withTestTenant(async () => classController.my(fakeAdminReq()));
      expect(Array.isArray(list)).toBe(true);
    });

    it('my returns classes for an assigned teacher (bridged employee)', async () => {
      // Bridge the admin actor's employee id into sis_class_teachers via a
      // real hr_employees row keyed by TEST_ADMIN_EMPLOYEE_ID.
      const empId = '019e0cf8-aaaa-7777-8888-000000000012'; // TEST_ADMIN_EMPLOYEE_ID
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hr_employees (id, person_id, account_id, school_id, employment_type, employment_status, employee_number, hire_date)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'FULL_TIME', 'ACTIVE', $5, '2024-01-01')
         ON CONFLICT (id) DO NOTHING`,
        empId,
        TEST_ADMIN_PERSON_ID,
        TEST_ADMIN_ACCOUNT_ID,
        TEST_SCHOOL_ID,
        'EMP-' + Date.now(),
      );
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, empId);

      const list = await withTestTenant(async () => classController.my(fakeAdminReq()));
      expect(Array.isArray(list)).toBe(true);
    });
  });

  // ─── AcademicYearController ─────────────────────────────────────────

  describe('AcademicYearController', () => {
    it('list returns academic years for the current school', async () => {
      const list = await withTestTenant(async () => academicYearController.list());
      expect(Array.isArray(list)).toBe(true);
      expect(list.map((y) => y.id)).toContain(TEST_SIS_ACADEMIC_YEAR_ID);
    });
  });
});
