import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { GradeController } from '@modules/m21-classroom/grading/grade.controller';
import { GradebookController } from '@modules/m21-classroom/grading/gradebook.controller';
import { ObservationController } from '@modules/m21-classroom/grading/observation.controller';
import { StandardGradeController } from '@modules/m21-classroom/grading/standard-grade.controller';
import { GradeService } from '@modules/m21-classroom/grading/grade.service';
import { GradebookService } from '@modules/m21-classroom/grading/gradebook.service';
import { ObservationService } from '@modules/m21-classroom/grading/observation.service';
import { StandardGradeService } from '@modules/m21-classroom/grading/standard-grade.service';
import { AssignmentService } from '@modules/m21-classroom/assignments/assignment.service';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import { makeRecordingKafka } from '../helpers/recording-kafka';
import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import {
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_ADMIN_PERSON_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { TEST_SIS_CLASS_ID } from '../fixtures/sis';
import { seedStudent, enrollStudent, cleanupSeededIds } from '../m20-sis/sis-helpers';

/**
 * Wave 4 — m21-classroom grading-area controllers DB-backed integration.
 *
 * Tests the HTTP-style entry points of GradeController, GradebookController,
 * ObservationController, StandardGradeController. The underlying service
 * contracts are already exercised by grading.spec.ts — this lifts the
 * controllers from 0 % to ≥80 % so the m21-classroom module lands the Wave 4
 * coverage target.
 */
describe('integration:m21-classroom/grading-controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let actorContext: ActorContextService;
  let kafka: ReturnType<typeof makeRecordingKafka>;

  let assignmentService: AssignmentService;
  let gradeService: GradeService;
  let gradebookService: GradebookService;
  let observationService: ObservationService;
  let standardGradeService: StandardGradeService;

  let gradeController: GradeController;
  let gradebookController: GradebookController;
  let observationController: ObservationController;
  let standardGradeController: StandardGradeController;

  let assignmentTypeId: string;
  let curFrameworkId: string;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const standardIds: string[] = [];

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

  async function ensureAssignmentType(): Promise<string> {
    const existing = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.cls_assignment_types WHERE school_id = $1::uuid LIMIT 1`,
      TEST_SCHOOL_ID,
    );
    if (existing.length > 0) return existing[0]!.id;
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cls_assignment_types (id, school_id, name, weight_in_category, category)
       VALUES ($1::uuid, $2::uuid, 'Homework', 100.00, 'HOMEWORK')`,
      id,
      TEST_SCHOOL_ID,
    );
    return id;
  }

  async function ensureCurFramework(): Promise<string> {
    const existing = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.cur_standards_frameworks WHERE school_id = $1::uuid LIMIT 1`,
      TEST_SCHOOL_ID,
    );
    if (existing.length > 0) return existing[0]!.id;
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cur_standards_frameworks (id, school_id, name, version, is_active, created_by)
       VALUES ($1::uuid, $2::uuid, 'Ctrl Framework', '1.0', true, $3::uuid)`,
      id,
      TEST_SCHOOL_ID,
      TEST_ADMIN_PERSON_ID,
    );
    return id;
  }

  async function seedCurStandard(): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cur_standards (id, framework_id, code, description)
       VALUES ($1::uuid, $2::uuid, $3, $4)`,
      id,
      curFrameworkId,
      'CTRL-' + Math.random().toString(36).slice(2, 8),
      'A controller-test standard',
    );
    standardIds.push(id);
    return id;
  }

  async function makePublishedAssignment(): Promise<string> {
    const a = await withTestTenant(async () =>
      assignmentService.create(
        TEST_SIS_CLASS_ID,
        {
          title: 'Quiz',
          assignmentTypeId,
          isPublished: true,
          maxPoints: 100,
        } as any,
        {
          accountId: TEST_ADMIN_ACCOUNT_ID,
          personId: TEST_ADMIN_PERSON_ID,
          employeeId: TEST_ADMIN_EMPLOYEE_ID,
          personType: 'STAFF',
          isSchoolAdmin: true,
        } as any,
      ),
    );
    return a.id;
  }

  async function makeSubmission(assignmentId: string, studentSisId: string): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cls_submissions
         (id, assignment_id, student_id, status, submission_text, attachments, submitted_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'SUBMITTED', 'work', '[]'::jsonb, now())`,
      id,
      assignmentId,
      studentSisId,
    );
    return id;
  }

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    actorContext = new ActorContextService(rawClient, permCheck, tenantPrisma);
    kafka = makeRecordingKafka();

    assignmentService = new AssignmentService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
    );
    gradeService = new GradeService(
      tenantPrisma,
      assignmentService,
      kafka as unknown as KafkaProducerService,
    );
    gradebookService = new GradebookService(tenantPrisma, assignmentService);
    observationService = new ObservationService(tenantPrisma);
    standardGradeService = new StandardGradeService(tenantPrisma);

    gradeController = new GradeController(gradeService, actorContext);
    gradebookController = new GradebookController(gradebookService, actorContext);
    observationController = new ObservationController(observationService, actorContext);
    standardGradeController = new StandardGradeController(standardGradeService, actorContext);

    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, ARRAY['sch-001:admin','tch-001:read','tch-001:write','tch-002:read','tch-002:write','tch-003:read','tch-003:write','tch-008:write','tch-009:write']::text[], now(), 'test')
       ON CONFLICT (account_id, scope_id) DO UPDATE SET permission_codes = EXCLUDED.permission_codes`,
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
    );

    // hr_employees row for admin is seeded by globalSetup's
    // ensureEmployeeFixtures — no per-spec seed/teardown needed. The row
    // provides actor.employeeId for GradeService / ObservationService /
    // StandardGradeService gates.

    assignmentTypeId = await ensureAssignmentType();
    curFrameworkId = await ensureCurFramework();
  });

  afterAll(async () => {
    if (standardIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cur_standards WHERE id = ANY($1::uuid[])`,
        standardIds,
      );
    }
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_ADMIN_ACCOUNT_ID,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_standard_grade_evidence`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_standard_grades`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_student_observations`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_gradebook_snapshots`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_grades`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_submissions`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_assignments`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_class_teachers`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_enrollments`);
    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      personIds: personIds.splice(0),
    });
  });

  async function trackedStudent() {
    const s = await seedStudent(rawClient);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  // ────────────────────────────────────────────────────────────────────
  // GradeController
  // ────────────────────────────────────────────────────────────────────
  describe('GradeController', () => {
    it('gradeSubmission + publish + unpublish + publishAll', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const aid = await makePublishedAssignment();
      const subId = await makeSubmission(aid, student.studentId);

      const graded = await withTestTenant(async () =>
        gradeController.gradeSubmission(
          subId,
          { gradeValue: 85, publish: false } as any,
          fakeAdminReq(),
        ),
      );
      expect(graded.gradeValue).toBe(85);
      expect(graded.isPublished).toBe(false);

      const published = await withTestTenant(async () =>
        gradeController.publish(graded.id, fakeAdminReq()),
      );
      expect(published.isPublished).toBe(true);

      const unpublished = await withTestTenant(async () =>
        gradeController.unpublish(graded.id, fakeAdminReq()),
      );
      expect(unpublished.isPublished).toBe(false);

      const publishAll = await withTestTenant(async () =>
        gradeController.publishAll(TEST_SIS_CLASS_ID, { assignmentId: aid } as any, fakeAdminReq()),
      );
      expect(publishAll.publishedCount).toBeGreaterThanOrEqual(1);
    });

    it('batchGrade', async () => {
      const s1 = await trackedStudent();
      const s2 = await trackedStudent();
      await enrollStudent(rawClient, s1.studentId);
      await enrollStudent(rawClient, s2.studentId);
      const aid = await makePublishedAssignment();

      const resp = await withTestTenant(async () =>
        gradeController.batchGrade(
          TEST_SIS_CLASS_ID,
          {
            assignmentId: aid,
            publish: true,
            entries: [
              { studentId: s1.studentId, gradeValue: 80 },
              { studentId: s2.studentId, gradeValue: 95 },
            ],
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(resp.processedCount).toBe(2);
      expect(resp.publishedCount).toBe(2);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // GradebookController
  // ────────────────────────────────────────────────────────────────────
  describe('GradebookController', () => {
    it('getClassGradebook + getStudentGradebook + getStudentClassGrades', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);

      const classGb = await withTestTenant(async () =>
        gradebookController.getClassGradebook(TEST_SIS_CLASS_ID, {} as any, fakeAdminReq()),
      );
      expect(classGb.class.id).toBe(TEST_SIS_CLASS_ID);
      expect(Array.isArray(classGb.rows)).toBe(true);

      const studentGb = await withTestTenant(async () =>
        gradebookController.getStudentGradebook(student.studentId, {} as any, fakeAdminReq()),
      );
      expect(studentGb.student.id).toBe(student.studentId);

      const classGrades = await withTestTenant(async () =>
        gradebookController.getStudentClassGrades(
          student.studentId,
          TEST_SIS_CLASS_ID,
          fakeAdminReq(),
        ),
      );
      expect(classGrades).toBeDefined();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // ObservationController
  // ────────────────────────────────────────────────────────────────────
  describe('ObservationController', () => {
    it('create + listForStudent + getById + update + delete', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);

      const created = await withTestTenant(async () =>
        observationController.create(
          {
            classId: TEST_SIS_CLASS_ID,
            studentId: student.studentId,
            noteText: 'Did great work today',
            noteType: 'COMMENDATION',
            isSharedWithParent: false,
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.noteType).toBe('COMMENDATION');
      expect(created.studentId).toBe(student.studentId);

      const list = await withTestTenant(async () =>
        observationController.listForStudent(student.studentId, fakeAdminReq()),
      );
      expect(list.map((o) => o.id)).toContain(created.id);

      const fetched = await withTestTenant(async () =>
        observationController.getById(created.id, fakeAdminReq()),
      );
      expect(fetched.id).toBe(created.id);

      const updated = await withTestTenant(async () =>
        observationController.update(
          created.id,
          { noteText: 'Updated note' } as any,
          fakeAdminReq(),
        ),
      );
      expect(updated.noteText).toBe('Updated note');

      await withTestTenant(async () => observationController.delete(created.id, fakeAdminReq()));
      const listAfter = await withTestTenant(async () =>
        observationController.listForStudent(student.studentId, fakeAdminReq()),
      );
      expect(listAfter.map((o) => o.id)).not.toContain(created.id);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // StandardGradeController
  // ────────────────────────────────────────────────────────────────────
  describe('StandardGradeController', () => {
    it('upsert + getById + listForStudent + update + addEvidence + classReport', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const standardId = await seedCurStandard();

      const created = await withTestTenant(async () =>
        standardGradeController.upsert(
          {
            studentId: student.studentId,
            standardId,
            classId: TEST_SIS_CLASS_ID,
            proficiencyLevel: 'MEETING',
            notes: 'Initial rating',
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.proficiencyLevel).toBe('MEETING');
      expect(created.studentId).toBe(student.studentId);

      const list = await withTestTenant(async () =>
        standardGradeController.listForStudent(student.studentId),
      );
      expect(list.map((g) => g.id)).toContain(created.id);

      const fetched = await withTestTenant(async () => standardGradeController.getById(created.id));
      expect(fetched.id).toBe(created.id);

      const updated = await withTestTenant(async () =>
        standardGradeController.update(
          created.id,
          { proficiencyLevel: 'EXCEEDING' } as any,
          fakeAdminReq(),
        ),
      );
      expect(updated.proficiencyLevel).toBe('EXCEEDING');

      const evidence = await withTestTenant(async () =>
        standardGradeController.addEvidence(
          created.id,
          { evidenceType: 'TEACHER_NOTE', description: 'In-class observation' } as any,
          fakeAdminReq(),
        ),
      );
      expect(evidence.evidenceType).toBe('TEACHER_NOTE');

      const report = await withTestTenant(async () =>
        standardGradeController.classReport(TEST_SIS_CLASS_ID, fakeAdminReq()),
      );
      expect(report.classId).toBe(TEST_SIS_CLASS_ID);
    });
  });
});
