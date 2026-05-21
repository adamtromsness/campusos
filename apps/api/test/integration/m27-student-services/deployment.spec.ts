import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { DeploymentService } from '@modules/m27-student-services/wellbeing/deployment.service';
import { SurveyTemplateService } from '@modules/m27-student-services/wellbeing/survey-template.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  officerActor,
  studentActor,
  parentActor,
  teacherActor,
  TEST_OFFICER_ACCOUNT_ID,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_OFFICER_EMPLOYEE_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { TEST_ACADEMIC_YEAR_ID } from '../fixtures/finance';

describe('integration:m27-student-services/deployment', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let templates: SurveyTemplateService;
  let service: DeploymentService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    templates = new SurveyTemplateService(tenantPrisma, permCheck);
    service = new DeploymentService(tenantPrisma, permCheck, templates);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Clean check-ins (FK to deployments + students).
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_checkins WHERE deployment_id IN
         (SELECT id FROM ${TEST_SCHEMA}.svc_wellbeing_deployments WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_deployments WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_questions WHERE template_id IN
         (SELECT id FROM ${TEST_SCHEMA}.svc_wellbeing_survey_templates WHERE name LIKE 'DEP-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_survey_templates WHERE name LIKE 'DEP-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_caseloads WHERE student_id IN
         (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'DEP-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_enrollments WHERE class_id IN
         (SELECT id FROM ${TEST_SCHEMA}.sis_classes WHERE section_code LIKE 'DEP-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_classes WHERE section_code LIKE 'DEP-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_courses WHERE code LIKE 'DEP-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'DEP-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE first_name LIKE 'DEP-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE first_name LIKE 'DEP-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_OFFICER_ACCOUNT_ID,
    );
  });

  async function grantOfficer(codes: string[]): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_OFFICER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      codes,
    );
  }

  async function seedTemplate(): Promise<string> {
    const t = await withTestTenant(async () =>
      templates.create(
        {
          name: 'DEP-Tpl-' + generateId().slice(-6),
          description: 'Deployment test template',
          frequencyRecommendation: 'WEEKLY',
          questions: [
            {
              questionText: 'How safe do you feel?',
              questionType: 'SCALE_1_5',
              domain: 'SAFETY',
              sortOrder: 0,
            },
          ],
        },
        adminActor(),
      ),
    );
    return t.id;
  }

  async function seedStudent(schoolId: string = TEST_SCHOOL_ID): Promise<string> {
    const personId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    const suffix = generateId().slice(-8);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'DEP-Stu', $2, 'STUDENT', true)`,
      personId,
      'Stu-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'DEP-Stu', $3, true)`,
      platformStudentId,
      personId,
      'Stu-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students
         (id, school_id, platform_student_id, student_number, grade_level, enrollment_status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '8', 'ENROLLED')`,
      studentId,
      schoolId,
      platformStudentId,
      'DEP-' + suffix,
    );
    return studentId;
  }

  async function seedCaseload(studentId: string, counselorId: string): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.svc_caseloads
         (id, school_id, counselor_id, student_id, academic_year_id, primary_concern,
          is_primary_counselor, status, opened_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'ACADEMIC',
               true, 'ACTIVE', now()::date)`,
      generateId(),
      TEST_SCHOOL_ID,
      counselorId,
      studentId,
      TEST_ACADEMIC_YEAR_ID,
    );
  }

  async function seedClassWithEnrolledStudents(studentIds: string[]): Promise<string> {
    const courseId = generateId();
    const classId = generateId();
    const suffix = generateId().slice(-4);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_courses (id, school_id, name, code, grade_level)
       VALUES ($1::uuid, $2::uuid, $3, $4, '8')`,
      courseId,
      TEST_SCHOOL_ID,
      'DEP Course ' + suffix,
      'DEP-' + suffix,
    );
    const yearRows = (await rawClient.$queryRawUnsafe(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_academic_years
         WHERE id = $1::uuid LIMIT 1`,
      TEST_ACADEMIC_YEAR_ID,
    )) as Array<{ id: string }>;
    const yearId = yearRows[0]!.id;
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_classes (id, school_id, course_id, academic_year_id, section_code)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5)`,
      classId,
      TEST_SCHOOL_ID,
      courseId,
      yearId,
      'DEP-' + suffix,
    );
    for (const sid of studentIds) {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_enrollments (id, student_id, class_id, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'ACTIVE')`,
        generateId(),
        sid,
        classId,
      );
    }
    return classId;
  }

  function futureIso(deltaMs: number): string {
    return new Date(Date.now() + deltaMs).toISOString();
  }

  // ─── create ─────────────────────────────────────────────────────

  describe('create', () => {
    it('admin creates a CASELOAD deployment in SCHEDULED status', async () => {
      const templateId = await seedTemplate();
      const r = await withTestTenant(async () =>
        service.create(
          {
            templateId,
            deployAt: futureIso(1000),
            expiresAt: futureIso(7 * 24 * 60 * 60 * 1000),
            targetType: 'CASELOAD',
          },
          adminActor(),
        ),
      );
      expect(r.status).toBe('SCHEDULED');
      expect(r.targetType).toBe('CASELOAD');
      expect(r.targetIds).toBeNull();
      expect(r.deployedById).toBe(TEST_ADMIN_EMPLOYEE_ID);
      expect(r.templateName).toContain('DEP-');
    });

    it('counsellor with cou-004:write creates CASELOAD deployment', async () => {
      await grantOfficer(['cou-004:write']);
      const templateId = await seedTemplate();
      const r = await withTestTenant(async () =>
        service.create(
          {
            templateId,
            deployAt: futureIso(1000),
            targetType: 'CASELOAD',
          },
          officerActor(),
        ),
      );
      expect(r.deployedById).toBe(TEST_OFFICER_EMPLOYEE_ID);
    });

    it('counsellor cannot create SCHOOL-wide deployment (admin-only)', async () => {
      await grantOfficer(['cou-004:write']);
      const templateId = await seedTemplate();
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              templateId,
              deployAt: futureIso(1000),
              targetType: 'SCHOOL',
            },
            officerActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin can create SCHOOL deployment (no targetIds)', async () => {
      const templateId = await seedTemplate();
      const r = await withTestTenant(async () =>
        service.create(
          {
            templateId,
            deployAt: futureIso(1000),
            targetType: 'SCHOOL',
          },
          adminActor(),
        ),
      );
      expect(r.targetType).toBe('SCHOOL');
      expect(r.targetIds).toBeNull();
    });

    it('non-counsellor (teacher/student/parent) → Forbidden', async () => {
      const templateId = await seedTemplate();
      await expect(
        withTestTenant(async () =>
          service.create(
            { templateId, deployAt: futureIso(1000), targetType: 'CASELOAD' },
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          service.create(
            { templateId, deployAt: futureIso(1000), targetType: 'CASELOAD' },
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          service.create(
            { templateId, deployAt: futureIso(1000), targetType: 'CASELOAD' },
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('actor without employeeId → Forbidden ("must have an employee record")', async () => {
      const templateId = await seedTemplate();
      const studentNoEmployee = {
        ...studentActor(),
        // promote scope so the counsellor gate passes; the employee check fires next
        isSchoolAdmin: true,
      };
      await expect(
        withTestTenant(async () =>
          service.create(
            { templateId, deployAt: futureIso(1000), targetType: 'CASELOAD' },
            studentNoEmployee,
          ),
        ),
      ).rejects.toThrow(/employee record/);
    });

    it('CLASS targeting requires non-empty targetIds → BadRequest when missing', async () => {
      const templateId = await seedTemplate();
      await expect(
        withTestTenant(async () =>
          service.create(
            { templateId, deployAt: futureIso(1000), targetType: 'CLASS' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('CUSTOM_LIST targeting requires non-empty targetIds → BadRequest when missing', async () => {
      const templateId = await seedTemplate();
      await expect(
        withTestTenant(async () =>
          service.create(
            { templateId, deployAt: futureIso(1000), targetType: 'CUSTOM_LIST' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('YEAR_GROUP targeting requires non-empty targetIds → BadRequest when missing', async () => {
      const templateId = await seedTemplate();
      await expect(
        withTestTenant(async () =>
          service.create(
            { templateId, deployAt: futureIso(1000), targetType: 'YEAR_GROUP' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('CASELOAD targeting must NOT carry targetIds → BadRequest', async () => {
      const templateId = await seedTemplate();
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              templateId,
              deployAt: futureIso(1000),
              targetType: 'CASELOAD',
              targetIds: [generateId()],
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('SCHOOL targeting must NOT carry targetIds → BadRequest', async () => {
      const templateId = await seedTemplate();
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              templateId,
              deployAt: futureIso(1000),
              targetType: 'SCHOOL',
              targetIds: [generateId()],
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('CUSTOM_LIST with at least one non-existent student → BadRequest with missing ids inlined', async () => {
      const templateId = await seedTemplate();
      const realStudent = await seedStudent();
      const ghostId = generateId();
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              templateId,
              deployAt: futureIso(1000),
              targetType: 'CUSTOM_LIST',
              targetIds: [realStudent, ghostId],
            },
            adminActor(),
          ),
        ),
      ).rejects.toThrow(new RegExp(ghostId));
    });

    it('CLASS with at least one non-existent class id → BadRequest with missing ids inlined', async () => {
      const templateId = await seedTemplate();
      const ghostClassId = generateId();
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              templateId,
              deployAt: futureIso(1000),
              targetType: 'CLASS',
              targetIds: [ghostClassId],
            },
            adminActor(),
          ),
        ),
      ).rejects.toThrow(new RegExp(ghostClassId));
    });

    it('expiresAt <= deployAt → BadRequest', async () => {
      const templateId = await seedTemplate();
      const deployAt = futureIso(1000);
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              templateId,
              deployAt,
              expiresAt: deployAt, // equal — violates > deployAt
              targetType: 'CASELOAD',
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-existent template → NotFound (via loadActiveOrFail)', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              templateId: generateId(),
              deployAt: futureIso(1000),
              targetType: 'CASELOAD',
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('CUSTOM_LIST with valid student ids succeeds', async () => {
      const templateId = await seedTemplate();
      const studentId = await seedStudent();
      const r = await withTestTenant(async () =>
        service.create(
          {
            templateId,
            deployAt: futureIso(1000),
            targetType: 'CUSTOM_LIST',
            targetIds: [studentId],
          },
          adminActor(),
        ),
      );
      expect(r.targetIds).toEqual([studentId]);
    });

    it('CLASS with valid class id succeeds', async () => {
      const templateId = await seedTemplate();
      const studentId = await seedStudent();
      const classId = await seedClassWithEnrolledStudents([studentId]);
      const r = await withTestTenant(async () =>
        service.create(
          {
            templateId,
            deployAt: futureIso(1000),
            targetType: 'CLASS',
            targetIds: [classId],
          },
          adminActor(),
        ),
      );
      expect(r.targetIds).toEqual([classId]);
    });
  });

  // ─── list + getById ─────────────────────────────────────────────

  describe('list + getById visibility', () => {
    async function seedDeployment(actor = adminActor()): Promise<string> {
      const templateId = await seedTemplate();
      const r = await withTestTenant(async () =>
        service.create({ templateId, deployAt: futureIso(1000), targetType: 'CASELOAD' }, actor),
      );
      return r.id;
    }

    it('admin sees deployments created by anyone in the tenant', async () => {
      await grantOfficer(['cou-004:write']);
      const officerDeploymentId = await seedDeployment(officerActor());
      const list = await withTestTenant(async () => service.list({}, adminActor()));
      expect(list.find((d) => d.id === officerDeploymentId)).toBeDefined();
    });

    it('counsellor only sees own deployments', async () => {
      await grantOfficer(['cou-004:write']);
      const ownId = await seedDeployment(officerActor());
      const otherId = await seedDeployment(adminActor());
      const list = await withTestTenant(async () => service.list({}, officerActor()));
      expect(list.find((d) => d.id === ownId)).toBeDefined();
      expect(list.find((d) => d.id === otherId)).toBeUndefined();
    });

    it('student/parent see no rows (AND FALSE visibility)', async () => {
      await seedDeployment(adminActor());
      const sList = await withTestTenant(async () => service.list({}, studentActor()));
      expect(sList).toHaveLength(0);
      const pList = await withTestTenant(async () => service.list({}, parentActor()));
      expect(pList).toHaveLength(0);
    });

    it('list filters by status', async () => {
      const id = await seedDeployment(adminActor());
      const scheduled = await withTestTenant(async () =>
        service.list({ status: 'SCHEDULED' }, adminActor()),
      );
      expect(scheduled.find((d) => d.id === id)).toBeDefined();
      const completed = await withTestTenant(async () =>
        service.list({ status: 'COMPLETED' }, adminActor()),
      );
      expect(completed.find((d) => d.id === id)).toBeUndefined();
    });

    it('list filters by templateId', async () => {
      const tA = await seedTemplate();
      const tB = await seedTemplate();
      const a = await withTestTenant(async () =>
        service.create(
          { templateId: tA, deployAt: futureIso(1000), targetType: 'CASELOAD' },
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        service.create(
          { templateId: tB, deployAt: futureIso(1000), targetType: 'CASELOAD' },
          adminActor(),
        ),
      );
      const filtered = await withTestTenant(async () =>
        service.list({ templateId: tA }, adminActor()),
      );
      expect(filtered.every((d) => d.templateId === tA)).toBe(true);
      expect(filtered.find((d) => d.id === a.id)).toBeDefined();
    });

    it('list respects custom limit (capped at 200)', async () => {
      await seedDeployment(adminActor());
      const r = await withTestTenant(async () => service.list({ limit: 1 }, adminActor()));
      expect(r.length).toBeLessThanOrEqual(1);
      // limit > 200 → clamped
      const big = await withTestTenant(async () => service.list({ limit: 9999 }, adminActor()));
      expect(big.length).toBeLessThanOrEqual(200);
    });

    it('getById returns deployment for admin', async () => {
      const id = await seedDeployment(adminActor());
      const got = await withTestTenant(async () => service.getById(id, adminActor()));
      expect(got.id).toBe(id);
    });

    it('getById hides another counsellor’s deployment from officer → NotFound', async () => {
      await grantOfficer(['cou-004:write']);
      const adminId = await seedDeployment(adminActor());
      await expect(
        withTestTenant(async () => service.getById(adminId, officerActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.getById(generateId(), adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── activate KEYSTONE ──────────────────────────────────────────

  describe('activate', () => {
    it('CASELOAD: resolves caseload students + flips SCHEDULED → ACTIVE + creates check-ins', async () => {
      await grantOfficer(['cou-004:write']);
      const templateId = await seedTemplate();
      const s1 = await seedStudent();
      const s2 = await seedStudent();
      await seedCaseload(s1, TEST_OFFICER_EMPLOYEE_ID);
      await seedCaseload(s2, TEST_OFFICER_EMPLOYEE_ID);
      const dep = await withTestTenant(async () =>
        service.create(
          { templateId, deployAt: futureIso(1000), targetType: 'CASELOAD' },
          officerActor(),
        ),
      );
      const r = await withTestTenant(async () => service.activate(dep.id, officerActor()));
      expect(r.checkinsCreated).toBe(2);
      expect(r.deployment.status).toBe('ACTIVE');
      expect(r.deployment.totalTargeted).toBe(2);

      const checkins = (await rawClient.$queryRawUnsafe(
        `SELECT student_id::text AS sid, assigned_counselor_id::text AS aid
           FROM ${TEST_SCHEMA}.svc_wellbeing_checkins WHERE deployment_id = $1::uuid`,
        dep.id,
      )) as Array<{ sid: string; aid: string }>;
      expect(checkins).toHaveLength(2);
      expect(checkins.every((c) => c.aid === TEST_OFFICER_EMPLOYEE_ID)).toBe(true);
      expect(checkins.map((c) => c.sid).sort()).toEqual([s1, s2].sort());
    });

    it('CLASS: resolves enrollments + flips status + creates check-ins', async () => {
      const templateId = await seedTemplate();
      const s1 = await seedStudent();
      const s2 = await seedStudent();
      const classId = await seedClassWithEnrolledStudents([s1, s2]);
      const dep = await withTestTenant(async () =>
        service.create(
          {
            templateId,
            deployAt: futureIso(1000),
            targetType: 'CLASS',
            targetIds: [classId],
          },
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () => service.activate(dep.id, adminActor()));
      expect(r.checkinsCreated).toBe(2);
      expect(r.deployment.totalTargeted).toBe(2);
    });

    it('CUSTOM_LIST: resolves supplied student ids', async () => {
      const templateId = await seedTemplate();
      const s1 = await seedStudent();
      const dep = await withTestTenant(async () =>
        service.create(
          {
            templateId,
            deployAt: futureIso(1000),
            targetType: 'CUSTOM_LIST',
            targetIds: [s1],
          },
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () => service.activate(dep.id, adminActor()));
      expect(r.checkinsCreated).toBe(1);
    });

    it('YEAR_GROUP: returns "deferred" BadRequest at activate', async () => {
      const templateId = await seedTemplate();
      // create a row directly so we can attempt activate on a YEAR_GROUP row.
      // Service blocks YEAR_GROUP at create via requiresIds (needs ids),
      // so insert a row directly bypassing the service-level shape gate.
      const ghostStudent = await seedStudent();
      const depId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.svc_wellbeing_deployments
           (id, school_id, template_id, deployed_by, deploy_at, target_type, target_ids, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, now() + interval '1 minute', 'YEAR_GROUP',
                 ARRAY[$5::uuid], 'SCHEDULED')`,
        depId,
        TEST_SCHOOL_ID,
        templateId,
        TEST_ADMIN_EMPLOYEE_ID,
        ghostStudent,
      );
      await expect(
        withTestTenant(async () => service.activate(depId, adminActor())),
      ).rejects.toThrow(/YEAR_GROUP.*deferred/);
    });

    it('CASELOAD with empty caseload → BadRequest ("0 students")', async () => {
      const templateId = await seedTemplate();
      const dep = await withTestTenant(async () =>
        service.create(
          { templateId, deployAt: futureIso(1000), targetType: 'CASELOAD' },
          adminActor(),
        ),
      );
      // Admin's caseload is empty → resolveAudience returns 0
      await expect(
        withTestTenant(async () => service.activate(dep.id, adminActor())),
      ).rejects.toThrow(/0 students/);
    });

    it('activate twice → second call BadRequest (only SCHEDULED can activate)', async () => {
      const templateId = await seedTemplate();
      const s1 = await seedStudent();
      const dep = await withTestTenant(async () =>
        service.create(
          {
            templateId,
            deployAt: futureIso(1000),
            targetType: 'CUSTOM_LIST',
            targetIds: [s1],
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () => service.activate(dep.id, adminActor()));
      await expect(
        withTestTenant(async () => service.activate(dep.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-existent deployment → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.activate(generateId(), adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-counsellor activate → Forbidden', async () => {
      const templateId = await seedTemplate();
      const dep = await withTestTenant(async () =>
        service.create(
          { templateId, deployAt: futureIso(1000), targetType: 'CASELOAD' },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => service.activate(dep.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('counsellor activating SCHOOL-targeted row → Forbidden (belt-and-braces)', async () => {
      await grantOfficer(['cou-004:write']);
      const templateId = await seedTemplate();
      // Admin first creates SCHOOL row.
      const dep = await withTestTenant(async () =>
        service.create(
          { templateId, deployAt: futureIso(1000), targetType: 'SCHOOL' },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => service.activate(dep.id, officerActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('CLASS targeting where class no longer exists (deleted post-create) → BadRequest', async () => {
      const templateId = await seedTemplate();
      const s1 = await seedStudent();
      const classId = await seedClassWithEnrolledStudents([s1]);
      const dep = await withTestTenant(async () =>
        service.create(
          {
            templateId,
            deployAt: futureIso(1000),
            targetType: 'CLASS',
            targetIds: [classId],
          },
          adminActor(),
        ),
      );
      // Remove the enrollments + class to simulate post-create deletion.
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_enrollments WHERE class_id = $1::uuid`,
        classId,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_classes WHERE id = $1::uuid`,
        classId,
      );
      await expect(
        withTestTenant(async () => service.activate(dep.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── complete + cancel state machine ────────────────────────────

  describe('complete', () => {
    it('ACTIVE → COMPLETED', async () => {
      const templateId = await seedTemplate();
      const s1 = await seedStudent();
      const dep = await withTestTenant(async () =>
        service.create(
          {
            templateId,
            deployAt: futureIso(1000),
            targetType: 'CUSTOM_LIST',
            targetIds: [s1],
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () => service.activate(dep.id, adminActor()));
      const completed = await withTestTenant(async () => service.complete(dep.id, adminActor()));
      expect(completed.status).toBe('COMPLETED');
    });

    it('SCHEDULED → complete is BadRequest (only ACTIVE can complete)', async () => {
      const templateId = await seedTemplate();
      const dep = await withTestTenant(async () =>
        service.create(
          { templateId, deployAt: futureIso(1000), targetType: 'CASELOAD' },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => service.complete(dep.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('complete by non-counsellor → Forbidden', async () => {
      const templateId = await seedTemplate();
      const dep = await withTestTenant(async () =>
        service.create(
          { templateId, deployAt: futureIso(1000), targetType: 'CASELOAD' },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => service.complete(dep.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('complete missing deployment → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.complete(generateId(), adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('cancel', () => {
    it('SCHEDULED → CANCELLED', async () => {
      const templateId = await seedTemplate();
      const dep = await withTestTenant(async () =>
        service.create(
          { templateId, deployAt: futureIso(1000), targetType: 'CASELOAD' },
          adminActor(),
        ),
      );
      const cancelled = await withTestTenant(async () => service.cancel(dep.id, adminActor()));
      expect(cancelled.status).toBe('CANCELLED');
    });

    it('ACTIVE → CANCELLED', async () => {
      const templateId = await seedTemplate();
      const s1 = await seedStudent();
      const dep = await withTestTenant(async () =>
        service.create(
          {
            templateId,
            deployAt: futureIso(1000),
            targetType: 'CUSTOM_LIST',
            targetIds: [s1],
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () => service.activate(dep.id, adminActor()));
      const cancelled = await withTestTenant(async () => service.cancel(dep.id, adminActor()));
      expect(cancelled.status).toBe('CANCELLED');
    });

    it('COMPLETED → cancel BadRequest (terminal state)', async () => {
      const templateId = await seedTemplate();
      const s1 = await seedStudent();
      const dep = await withTestTenant(async () =>
        service.create(
          {
            templateId,
            deployAt: futureIso(1000),
            targetType: 'CUSTOM_LIST',
            targetIds: [s1],
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () => service.activate(dep.id, adminActor()));
      await withTestTenant(async () => service.complete(dep.id, adminActor()));
      await expect(
        withTestTenant(async () => service.cancel(dep.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cancel by non-counsellor → Forbidden', async () => {
      const templateId = await seedTemplate();
      const dep = await withTestTenant(async () =>
        service.create(
          { templateId, deployAt: futureIso(1000), targetType: 'CASELOAD' },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => service.cancel(dep.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cancel missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.cancel(generateId(), adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── cross-school isolation ─────────────────────────────────────

  describe('cross-school isolation', () => {
    it('School A deployment is invisible from School B', async () => {
      const templateId = await seedTemplate();
      const aId = (
        await withTestTenant(async () =>
          service.create(
            { templateId, deployAt: futureIso(1000), targetType: 'CASELOAD' },
            adminActor(),
          ),
        )
      ).id;

      // School B sees nothing for this id
      await expect(
        withTestTenantB(async () => service.getById(aId, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);

      const bList = await withTestTenantB(async () => service.list({}, adminActor()));
      expect(bList.find((d) => d.id === aId)).toBeUndefined();
    });

    it('School A actor cannot activate a School B deployment', async () => {
      // Seed a template + deployment under School B.
      const templateB = await withTestTenantB(async () =>
        templates.create(
          {
            name: 'DEP-Tpl-B-' + generateId().slice(-6),
            description: 'B template',
            frequencyRecommendation: 'MONTHLY',
            questions: [
              {
                questionText: 'Q?',
                questionType: 'SCALE_1_5',
                domain: 'SAFETY',
                sortOrder: 0,
              },
            ],
          },
          adminActor(),
        ),
      );
      const bStu = await seedStudent(TEST_SCHOOL_B_ID);
      const bDep = await withTestTenantB(async () =>
        service.create(
          {
            templateId: templateB.id,
            deployAt: futureIso(1000),
            targetType: 'CUSTOM_LIST',
            targetIds: [bStu],
          },
          adminActor(),
        ),
      );
      // School A activate of School B id → NotFound (school filter strips row).
      await expect(
        withTestTenant(async () => service.activate(bDep.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
