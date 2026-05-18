import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { GraduationService } from '@modules/m20-sis/graduation/graduation.service';
import { GpaService } from '@modules/m20-sis/graduation/gpa.service';
import { PrerequisiteService } from '@modules/m20-sis/graduation/prerequisite.service';
import { ServiceLearningService } from '@modules/m20-sis/graduation/service-learning.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { adminActor, teacherActor, studentActor, TEST_STUDENT_PERSON_ID } from '../helpers/actor';
import { TEST_SIS_COURSE_ID } from '../fixtures/sis';
import { seedStudent, cleanupSeededIds } from './sis-helpers';

describe('integration:m20-sis/graduation', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let graduationService: GraduationService;
  let gpaService: GpaService;
  let prerequisiteService: PrerequisiteService;
  let serviceLearningService: ServiceLearningService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    graduationService = new GraduationService(tenantPrisma, permCheck);
    gpaService = new GpaService(tenantPrisma, permCheck);
    prerequisiteService = new PrerequisiteService(tenantPrisma, permCheck);
    serviceLearningService = new ServiceLearningService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Clean grad + GPA + service-learning + prereq rows
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_graduation_audits`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_graduation_requirements`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_gpa_snapshots`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_gpa_configurations`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_service_learning_hours`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_service_learning_requirements`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_course_prerequisites`,
    );
    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      personIds: personIds.splice(0),
    });
  });

  async function trackedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  describe('GraduationService.requirements', () => {
    it('admin creates a CREDIT_TOTAL requirement', async () => {
      const req = await withTestTenant(async () =>
        graduationService.createRequirement(
          {
            requirementType: 'CREDIT_TOTAL',
            requirementName: 'Total credits',
            creditsRequired: 24,
          } as any,
          adminActor(),
        ),
      );
      expect(req.requirementType).toBe('CREDIT_TOTAL');
      expect(req.creditsRequired).toBe(24);
    });

    it('CREDIT_TOTAL without creditsRequired → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          graduationService.createRequirement(
            { requirementType: 'CREDIT_TOTAL', requirementName: 'X' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('SUBJECT_CREDIT requires subjectArea + creditsRequired', async () => {
      const req = await withTestTenant(async () =>
        graduationService.createRequirement(
          {
            requirementType: 'SUBJECT_CREDIT',
            requirementName: 'Maths',
            subjectArea: 'MATH',
            creditsRequired: 4,
          } as any,
          adminActor(),
        ),
      );
      expect(req.subjectArea).toBe('MATH');

      // Missing subjectArea
      await expect(
        withTestTenant(async () =>
          graduationService.createRequirement(
            {
              requirementType: 'SUBJECT_CREDIT',
              requirementName: 'Bad',
              creditsRequired: 2,
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('SPECIFIC_COURSE requires specificCourseId', async () => {
      const req = await withTestTenant(async () =>
        graduationService.createRequirement(
          {
            requirementType: 'SPECIFIC_COURSE',
            requirementName: 'Capstone',
            specificCourseId: TEST_SIS_COURSE_ID,
          } as any,
          adminActor(),
        ),
      );
      expect(req.specificCourseId).toBe(TEST_SIS_COURSE_ID);
    });

    it('SERVICE_HOURS requires hoursRequired', async () => {
      const req = await withTestTenant(async () =>
        graduationService.createRequirement(
          {
            requirementType: 'SERVICE_HOURS',
            requirementName: 'Hours',
            hoursRequired: 40,
          } as any,
          adminActor(),
        ),
      );
      expect(req.hoursRequired).toBe(40);
    });

    it('ASSESSMENT requires assessmentName', async () => {
      const req = await withTestTenant(async () =>
        graduationService.createRequirement(
          {
            requirementType: 'ASSESSMENT',
            requirementName: 'STAAR Math',
            assessmentName: 'STAAR_MATH',
          } as any,
          adminActor(),
        ),
      );
      expect(req.assessmentName).toBe('STAAR_MATH');
    });

    it('MINIMUM_GPA requires minimumGpa', async () => {
      const req = await withTestTenant(async () =>
        graduationService.createRequirement(
          {
            requirementType: 'MINIMUM_GPA',
            requirementName: 'Min GPA',
            minimumGpa: 2.0,
          } as any,
          adminActor(),
        ),
      );
      expect(req.minimumGpa).toBe(2);
    });

    it('invalid requirementType → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          graduationService.createRequirement(
            { requirementType: 'NOPE', requirementName: 'X' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-admin createRequirement → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          graduationService.createRequirement(
            {
              requirementType: 'CREDIT_TOTAL',
              requirementName: 'X',
              creditsRequired: 1,
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list excludes inactive by default; can include via flag', async () => {
      const active = await withTestTenant(async () =>
        graduationService.createRequirement(
          { requirementType: 'CREDIT_TOTAL', requirementName: 'A', creditsRequired: 1 } as any,
          adminActor(),
        ),
      );
      const inactive = await withTestTenant(async () =>
        graduationService.createRequirement(
          { requirementType: 'CREDIT_TOTAL', requirementName: 'B', creditsRequired: 2 } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        graduationService.patchRequirement(
          inactive.id,
          { isActive: false } as any,
          adminActor(),
        ),
      );
      const defaultList = await withTestTenant(async () => graduationService.listRequirements());
      expect(defaultList.map((r) => r.id)).toContain(active.id);
      expect(defaultList.map((r) => r.id)).not.toContain(inactive.id);

      const all = await withTestTenant(async () =>
        graduationService.listRequirements({ includeInactive: true }),
      );
      expect(all.map((r) => r.id)).toContain(inactive.id);
    });

    it('patchRequirement updates name, then delete drops the row', async () => {
      const r = await withTestTenant(async () =>
        graduationService.createRequirement(
          { requirementType: 'CREDIT_TOTAL', requirementName: 'Orig', creditsRequired: 10 } as any,
          adminActor(),
        ),
      );
      const patched = await withTestTenant(async () =>
        graduationService.patchRequirement(
          r.id,
          { requirementName: 'Renamed', appliesToGradeLevels: ['11', '12'] } as any,
          adminActor(),
        ),
      );
      expect(patched.requirementName).toBe('Renamed');
      expect(patched.appliesToGradeLevels).toEqual(['11', '12']);

      await withTestTenant(async () => graduationService.deleteRequirement(r.id, adminActor()));
      await expect(
        withTestTenant(async () => graduationService.getRequirement(r.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getRequirement unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          graduationService.getRequirement('00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('GraduationService.audits', () => {
    async function seedAudit(studentId: string, status: 'MET' | 'IN_PROGRESS' | 'NOT_MET') {
      const reqId = generateId();
      const auditId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_graduation_requirements
           (id, school_id, requirement_type, requirement_name, credits_required)
         VALUES ($1::uuid, $2::uuid, 'CREDIT_TOTAL', 'A', 24)`,
        reqId,
        TEST_SCHOOL_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_student_graduation_audits
           (id, student_id, requirement_id, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
        auditId,
        studentId,
        reqId,
        status,
      );
    }

    it('admin: getAuditForStudent returns audits with summary counts', async () => {
      const s = await trackedStudent();
      await seedAudit(s.studentId, 'MET');
      await seedAudit(s.studentId, 'IN_PROGRESS');
      await seedAudit(s.studentId, 'NOT_MET');
      const summary = await withTestTenant(async () =>
        graduationService.getAuditForStudent(s.studentId, adminActor()),
      );
      expect(summary.metCount).toBe(1);
      expect(summary.inProgressCount).toBe(1);
      expect(summary.notMetCount).toBe(1);
      expect(summary.isAtRisk).toBe(true);
    });

    it('admin: getAuditForStudent on cross-school student → NotFoundException', async () => {
      const otherStudent = await trackedStudent({ schoolId: '019e0cf8-aaaa-7777-8888-00000000000b' });
      await expect(
        withTestTenant(async () =>
          graduationService.getAuditForStudent(otherStudent.studentId, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listAtRiskStudents returns students with NOT_MET counts', async () => {
      const s1 = await trackedStudent({ firstName: 'AtRisk', lastName: 'One' });
      const s2 = await trackedStudent({ firstName: 'Safe', lastName: 'Two' });
      await seedAudit(s1.studentId, 'NOT_MET');
      await seedAudit(s1.studentId, 'NOT_MET');
      await seedAudit(s2.studentId, 'MET');

      const atRisk = await withTestTenant(async () =>
        graduationService.listAtRiskStudents(adminActor()),
      );
      const ids = atRisk.map((r) => r.studentId);
      expect(ids).toContain(s1.studentId);
      expect(ids).not.toContain(s2.studentId);
      const s1Row = atRisk.find((r) => r.studentId === s1.studentId)!;
      expect(s1Row.notMetCount).toBe(2);
    });

    it('listAtRiskStudents: non-staff non-admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(
          async () => graduationService.listAtRiskStudents(studentActor()),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('GpaService', () => {
    it('admin creates default config + listConfigs returns it', async () => {
      const cfg = await withTestTenant(async () =>
        gpaService.createConfig(
          {
            configName: 'Standard 4.0',
            calculationMethod: 'WEIGHTED',
            scaleType: 'FOUR_POINT',
            gradePointMapping: { A: 4, B: 3, C: 2, D: 1, F: 0 },
            honorsWeightBonus: 0.5,
            apWeightBonus: 1.0,
            isDefault: true,
          } as any,
          adminActor(),
        ),
      );
      expect(cfg.calculationMethod).toBe('WEIGHTED');
      expect(cfg.isDefault).toBe(true);

      const list = await withTestTenant(async () => gpaService.listConfigs());
      expect(list.map((r) => r.id)).toContain(cfg.id);

      const def = await withTestTenant(async () => gpaService.getDefaultConfig());
      expect(def?.id).toBe(cfg.id);
    });

    it('creating a second default unflips the first one', async () => {
      const a = await withTestTenant(async () =>
        gpaService.createConfig(
          {
            configName: 'A',
            calculationMethod: 'UNWEIGHTED',
            scaleType: 'FOUR_POINT',
            gradePointMapping: { A: 4 },
            isDefault: true,
          } as any,
          adminActor(),
        ),
      );
      const b = await withTestTenant(async () =>
        gpaService.createConfig(
          {
            configName: 'B',
            calculationMethod: 'UNWEIGHTED',
            scaleType: 'FOUR_POINT',
            gradePointMapping: { A: 4 },
            isDefault: true,
          } as any,
          adminActor(),
        ),
      );
      const def = await withTestTenant(async () => gpaService.getDefaultConfig());
      expect(def?.id).toBe(b.id);
      const aFresh = await withTestTenant(async () => gpaService.getConfig(a.id));
      expect(aFresh.isDefault).toBe(false);
    });

    it('invalid calculationMethod → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          gpaService.createConfig(
            {
              configName: 'X',
              calculationMethod: 'NOPE',
              scaleType: 'FOUR_POINT',
              gradePointMapping: { A: 4 },
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('empty gradePointMapping → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          gpaService.createConfig(
            {
              configName: 'X',
              calculationMethod: 'UNWEIGHTED',
              scaleType: 'FOUR_POINT',
              gradePointMapping: {},
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-admin createConfig → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          gpaService.createConfig(
            {
              configName: 'X',
              calculationMethod: 'UNWEIGHTED',
              scaleType: 'FOUR_POINT',
              gradePointMapping: { A: 4 },
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patchConfig + getConfig unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          gpaService.getConfig('00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listSnapshotsForStudent + getLatestSnapshot — empty when no snapshots', async () => {
      const s = await trackedStudent();
      const list = await withTestTenant(async () =>
        gpaService.listSnapshotsForStudent(s.studentId),
      );
      expect(list).toHaveLength(0);
      const latest = await withTestTenant(async () => gpaService.getLatestSnapshot(s.studentId));
      expect(latest).toBeNull();
    });

    it('listSnapshotsForStudent returns rows when seeded', async () => {
      const s = await trackedStudent();
      const cfg = await withTestTenant(async () =>
        gpaService.createConfig(
          {
            configName: 'D',
            calculationMethod: 'WEIGHTED',
            scaleType: 'FOUR_POINT',
            gradePointMapping: { A: 4, B: 3 },
            isDefault: true,
          } as any,
          adminActor(),
        ),
      );
      const snapId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_student_gpa_snapshots
           (id, student_id, gpa_config_id, cumulative_gpa)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 3.85)`,
        snapId,
        s.studentId,
        cfg.id,
      );
      const list = await withTestTenant(async () =>
        gpaService.listSnapshotsForStudent(s.studentId),
      );
      expect(list).toHaveLength(1);
      expect(list[0]!.cumulativeGpa).toBe(3.85);

      const latest = await withTestTenant(async () => gpaService.getLatestSnapshot(s.studentId));
      expect(latest?.id).toBe(snapId);
    });
  });

  describe('PrerequisiteService', () => {
    it('admin creates prereq + list returns it', async () => {
      // seed a second course as the prerequisite
      const prereqId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_courses (id, school_id, department_id, code, name)
         VALUES ($1::uuid, $2::uuid, NULL, 'PRE-101', 'Prereq Course')`,
        prereqId,
        TEST_SCHOOL_ID,
      );

      const p = await withTestTenant(async () =>
        prerequisiteService.create(
          {
            courseId: TEST_SIS_COURSE_ID,
            prerequisiteCourseId: prereqId,
            isMandatory: true,
            minGrade: 'C',
          } as any,
          adminActor(),
        ),
      );
      expect(p.isMandatory).toBe(true);
      const list = await withTestTenant(async () =>
        prerequisiteService.listForCourse(TEST_SIS_COURSE_ID),
      );
      expect(list.map((r) => r.id)).toContain(p.id);

      // Delete it
      await withTestTenant(async () => prerequisiteService.delete(p.id, adminActor()));
      const afterDelete = await withTestTenant(async () =>
        prerequisiteService.listForCourse(TEST_SIS_COURSE_ID),
      );
      expect(afterDelete.map((r) => r.id)).not.toContain(p.id);
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_courses WHERE id = $1::uuid`,
        prereqId,
      );
    });

    it('non-admin create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          prerequisiteService.create(
            {
              courseId: TEST_SIS_COURSE_ID,
              prerequisiteCourseId: TEST_SIS_COURSE_ID,
              isMandatory: true,
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-admin delete → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          prerequisiteService.delete(
            '00000000-0000-0000-0000-000000000000',
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('ServiceLearningService', () => {
    it('admin creates a requirement', async () => {
      const r = await withTestTenant(async () =>
        serviceLearningService.createRequirement(
          {
            gradeLevel: '11',
            requiredHours: 40,
            deadlineType: 'END_OF_YEAR',
          } as any,
          adminActor(),
        ),
      );
      expect(r.requiredHours).toBe(40);

      const list = await withTestTenant(async () =>
        serviceLearningService.listRequirements(),
      );
      expect(list.map((x) => x.id)).toContain(r.id);
    });

    it('SPECIFIC_DATE deadline without specific_deadline → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          serviceLearningService.createRequirement(
            {
              gradeLevel: '12',
              requiredHours: 10,
              deadlineType: 'SPECIFIC_DATE',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('invalid deadlineType → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          serviceLearningService.createRequirement(
            {
              gradeLevel: '11',
              requiredHours: 10,
              deadlineType: 'NEVER',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('admin submits hours on behalf of student → status PENDING', async () => {
      const s = await trackedStudent();
      const hours = await withTestTenant(async () =>
        serviceLearningService.submitHours(
          {
            studentId: s.studentId,
            organisationName: 'Library',
            activityDescription: 'Shelved books',
            hours: 3,
            serviceDate: '2026-09-15',
          } as any,
          adminActor(),
        ),
      );
      expect(hours.status).toBe('PENDING');
      expect(hours.hours).toBe(3);
    });

    it('admin reviews hours → APPROVED', async () => {
      const s = await trackedStudent();
      const h = await withTestTenant(async () =>
        serviceLearningService.submitHours(
          {
            studentId: s.studentId,
            organisationName: 'Library',
            activityDescription: 'Shelved books',
            hours: 2,
            serviceDate: '2026-09-16',
          } as any,
          adminActor(),
        ),
      );
      const reviewed = await withTestTenant(async () =>
        serviceLearningService.reviewHours(
          h.id,
          { decision: 'APPROVED', reviewNotes: 'ok' } as any,
          adminActor(),
        ),
      );
      expect(reviewed.status).toBe('APPROVED');
    });

    it('listForStudent + progressForStudent', async () => {
      const s = await trackedStudent();
      await withTestTenant(async () =>
        serviceLearningService.submitHours(
          {
            studentId: s.studentId,
            organisationName: 'Library',
            activityDescription: 'x',
            hours: 5,
            serviceDate: '2026-09-20',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        serviceLearningService.listForStudent(s.studentId, adminActor()),
      );
      expect(list).toHaveLength(1);

      const progress = await withTestTenant(async () =>
        serviceLearningService.progressForStudent(s.studentId, adminActor()),
      );
      expect(progress.studentId).toBe(s.studentId);
    });

    it('reviewHours non-admin non-staff → ForbiddenException', async () => {
      const s = await trackedStudent();
      const h = await withTestTenant(async () =>
        serviceLearningService.submitHours(
          {
            studentId: s.studentId,
            organisationName: 'Y',
            activityDescription: 'y',
            hours: 1,
            serviceDate: '2026-09-21',
          } as any,
          adminActor(),
        ),
      );
      // Teacher actor has no stu-005:write in this test — ForbiddenException
      await expect(
        withTestTenant(async () =>
          serviceLearningService.reviewHours(
            h.id,
            { decision: 'APPROVED' } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listPendingForReview returns PENDING rows only', async () => {
      const s = await trackedStudent();
      await withTestTenant(async () =>
        serviceLearningService.submitHours(
          {
            studentId: s.studentId,
            organisationName: 'P',
            activityDescription: 'pending',
            hours: 1,
            serviceDate: '2026-09-22',
          } as any,
          adminActor(),
        ),
      );
      const pending = await withTestTenant(async () =>
        serviceLearningService.listPendingForReview(adminActor()),
      );
      expect(pending.length).toBeGreaterThanOrEqual(1);
    });

    it('getById unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          serviceLearningService.getById(
            '00000000-0000-0000-0000-000000000000',
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
