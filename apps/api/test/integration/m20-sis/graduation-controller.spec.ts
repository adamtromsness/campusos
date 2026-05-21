import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { SisGraduationController } from '@modules/m20-sis/graduation/sis-graduation.controller';
import { GraduationService } from '@modules/m20-sis/graduation/graduation.service';
import { GraduationAuditWorker } from '@modules/m20-sis/graduation/graduation-audit.worker';
import { GpaService } from '@modules/m20-sis/graduation/gpa.service';
import { GpaWorker } from '@modules/m20-sis/graduation/gpa.worker';
import { ServiceLearningService } from '@modules/m20-sis/graduation/service-learning.service';
import { PrerequisiteService } from '@modules/m20-sis/graduation/prerequisite.service';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { TEST_ADMIN_PERSON_ID, TEST_ADMIN_ACCOUNT_ID } from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { TEST_SIS_COURSE_ID } from '../fixtures/sis';
import { seedStudent, cleanupSeededIds } from './sis-helpers';

/**
 * Wave 4 — m20-sis SisGraduationController.
 *
 * Drives every controller endpoint at least once. Service-level contracts
 * remain covered by graduation.spec / graduation-workers.spec.
 */
describe('integration:m20-sis/graduation-controller', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let actorContext: ActorContextService;
  let outbox: OutboxService;
  let graduationService: GraduationService;
  let gpaService: GpaService;
  let serviceLearningService: ServiceLearningService;
  let prereqService: PrerequisiteService;
  let auditWorker: GraduationAuditWorker;
  let gpaWorker: GpaWorker;
  let controller: SisGraduationController;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];

  // Track ids created via controller calls (not seed helpers) so we can
  // clean them up between tests.
  const localCleanupSecondaryCourseIds: string[] = [];

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
    outbox = new OutboxService();

    graduationService = new GraduationService(tenantPrisma, permCheck);
    gpaService = new GpaService(tenantPrisma, permCheck);
    serviceLearningService = new ServiceLearningService(tenantPrisma, permCheck);
    prereqService = new PrerequisiteService(tenantPrisma, permCheck);
    auditWorker = new GraduationAuditWorker(tenantPrisma, outbox, gpaService);
    gpaWorker = new GpaWorker(tenantPrisma, gpaService);

    controller = new SisGraduationController(
      graduationService,
      auditWorker,
      gpaService,
      gpaWorker,
      serviceLearningService,
      prereqService,
      actorContext,
    );

    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid,
               ARRAY['sch-001:admin','stu-005:read','stu-005:write','stu-005:admin']::text[],
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
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_student_graduation_audits`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_graduation_requirements`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_student_gpa_snapshots`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_gpa_configurations`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_service_learning_hours`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_service_learning_requirements`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_course_prerequisites`);
    if (localCleanupSecondaryCourseIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_courses WHERE id = ANY($1::uuid[])`,
        localCleanupSecondaryCourseIds.splice(0),
      );
    }
    // Also nuke any orphan PR-* courses leftover from earlier interrupted runs.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_courses WHERE code LIKE 'PR-%'`,
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

  async function seedSecondaryCourse(): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_courses (id, school_id, code, name, credit_hours, grade_level)
       VALUES ($1::uuid, $2::uuid, $3, 'Pre-Req Course', 1.0, '8')`,
      id,
      TEST_SCHOOL_ID,
      'PR-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    );
    localCleanupSecondaryCourseIds.push(id);
    return id;
  }

  // ─── Graduation Requirements ────────────────────────────────────────

  describe('graduation requirements', () => {
    it('create + list + get + patch + delete', async () => {
      const created = await withTestTenant(async () =>
        controller.createRequirement(
          {
            requirementType: 'CREDIT_TOTAL',
            requirementName: 'Total credits',
            creditsRequired: 24,
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.creditsRequired).toBe(24);

      const list = await withTestTenant(async () => controller.listRequirements(undefined));
      expect(list.map((r) => r.id)).toContain(created.id);

      const listInactive = await withTestTenant(async () => controller.listRequirements('true'));
      expect(Array.isArray(listInactive)).toBe(true);

      const single = await withTestTenant(async () => controller.getRequirement(created.id));
      expect(single.id).toBe(created.id);

      const patched = await withTestTenant(async () =>
        controller.patchRequirement(
          created.id,
          { requirementName: 'Renamed' } as any,
          fakeAdminReq(),
        ),
      );
      expect(patched.requirementName).toBe('Renamed');

      const deleted = await withTestTenant(async () =>
        controller.deleteRequirement(created.id, fakeAdminReq()),
      );
      expect(deleted.deleted).toBe(true);
    });
  });

  // ─── Graduation Audits ──────────────────────────────────────────────

  describe('graduation audits', () => {
    it('getStudentAudit + listAtRisk + runAudit + runAuditForStudent', async () => {
      const student = await trackedStudent();
      // Seed a CREDIT_TOTAL requirement so audits have something to compute.
      await withTestTenant(async () =>
        controller.createRequirement(
          {
            requirementType: 'CREDIT_TOTAL',
            requirementName: 'Total',
            creditsRequired: 24,
          } as any,
          fakeAdminReq(),
        ),
      );

      const audit = await withTestTenant(async () =>
        controller.getStudentAudit(student.studentId, fakeAdminReq()),
      );
      expect(audit.studentId).toBe(student.studentId);

      const atRisk = await withTestTenant(async () => controller.listAtRisk(fakeAdminReq()));
      expect(Array.isArray(atRisk)).toBe(true);

      const summary = await withTestTenant(async () => controller.runAudit());
      expect(typeof summary).toBe('object');

      const single = await withTestTenant(async () =>
        controller.runAuditForStudent(student.studentId),
      );
      expect(typeof single.auditsUpserted).toBe('number');
    });
  });

  // ─── Service Learning ───────────────────────────────────────────────

  describe('service learning', () => {
    it('requirements + hours submit + list + review + per-student', async () => {
      const created = await withTestTenant(async () =>
        controller.createServiceLearningRequirement(
          { gradeLevel: '12', requiredHours: 40, deadlineType: 'BEFORE_GRADUATION' } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.requiredHours).toBe(40);

      const list = await withTestTenant(async () => controller.listServiceLearningRequirements());
      expect(list.map((r) => r.id)).toContain(created.id);

      const student = await trackedStudent({ gradeLevel: '12' });
      const submitted = await withTestTenant(async () =>
        controller.submitServiceLearningHours(
          {
            studentId: student.studentId,
            organisationName: 'Local Food Bank',
            activityDescription: 'Stocking shelves',
            hours: 4,
            serviceDate: '2026-08-15',
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(submitted.studentId).toBe(student.studentId);

      const pending = await withTestTenant(async () =>
        controller.listPendingServiceLearningHours(fakeAdminReq()),
      );
      expect(pending.map((r) => r.id)).toContain(submitted.id);

      const reviewed = await withTestTenant(async () =>
        controller.reviewServiceLearningHours(
          submitted.id,
          { decision: 'APPROVED' } as any,
          fakeAdminReq(),
        ),
      );
      expect(reviewed.status).toBe('APPROVED');

      const perStudent = await withTestTenant(async () =>
        controller.listStudentServiceLearning(student.studentId, fakeAdminReq()),
      );
      expect(perStudent.map((r) => r.id)).toContain(submitted.id);

      const progress = await withTestTenant(async () =>
        controller.studentServiceLearningProgress(student.studentId, fakeAdminReq()),
      );
      expect(progress.studentId).toBe(student.studentId);
    });
  });

  // ─── GPA configurations + run ───────────────────────────────────────

  describe('gpa configurations + worker', () => {
    it('create + list + patch GPA configuration; getStudentGpa; run worker', async () => {
      const created = await withTestTenant(async () =>
        controller.createGpaConfig(
          {
            configName: 'CTL ' + Date.now(),
            calculationMethod: 'UNWEIGHTED',
            scaleType: 'FOUR_POINT',
            gradePointMapping: { A: 4, B: 3, C: 2, D: 1, F: 0 },
            isDefault: true,
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.configName).toMatch(/^CTL /);

      const list = await withTestTenant(async () => controller.listGpaConfigs());
      expect(list.map((c) => c.id)).toContain(created.id);

      const patched = await withTestTenant(async () =>
        controller.patchGpaConfig(created.id, { configName: 'CTL Renamed' } as any, fakeAdminReq()),
      );
      expect(patched.configName).toBe('CTL Renamed');

      const student = await trackedStudent({ gradeLevel: '11' });
      const snapshots = await withTestTenant(async () =>
        controller.getStudentGpa(student.studentId),
      );
      expect(Array.isArray(snapshots)).toBe(true);

      const summary = await withTestTenant(async () =>
        controller.runGpa(undefined, undefined, undefined),
      );
      expect(typeof summary).toBe('object');

      const perStudent = await withTestTenant(async () =>
        controller.runGpaForStudent(student.studentId, undefined, undefined, undefined),
      );
      expect(typeof perStudent).toBe('object');
    });
  });

  // ─── Course Prerequisites ───────────────────────────────────────────

  describe('course prerequisites', () => {
    it('create + list + delete + validate registration', async () => {
      const prereqCourseId = await seedSecondaryCourse();

      const created = await withTestTenant(async () =>
        controller.createPrerequisite(
          {
            courseId: TEST_SIS_COURSE_ID,
            prerequisiteCourseId: prereqCourseId,
            isMandatory: true,
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.courseId).toBe(TEST_SIS_COURSE_ID);

      const list = await withTestTenant(async () =>
        controller.listPrerequisitesForCourse(TEST_SIS_COURSE_ID),
      );
      expect(list.map((p) => p.id)).toContain(created.id);

      const student = await trackedStudent();
      const validate = await withTestTenant(async () =>
        controller.validateCourseRegistration({
          studentId: student.studentId,
          courseId: TEST_SIS_COURSE_ID,
        } as any),
      );
      expect(typeof validate.ok).toBe('boolean');

      const deleted = await withTestTenant(async () =>
        controller.deletePrerequisite(created.id, fakeAdminReq()),
      );
      expect(deleted.deleted).toBe(true);
    });
  });
});
