import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { AssignmentController } from '@modules/m21-classroom/assignments/assignment.controller';
import { AssignmentService } from '@modules/m21-classroom/assignments/assignment.service';
import { CategoryController } from '@modules/m21-classroom/assignments/category.controller';
import { CategoryService } from '@modules/m21-classroom/assignments/category.service';
import { RubricController } from '@modules/m21-classroom/assignments/rubric.controller';
import { RubricService } from '@modules/m21-classroom/assignments/rubric.service';
import { SubmissionController } from '@modules/m21-classroom/assignments/submission.controller';
import { SubmissionService } from '@modules/m21-classroom/assignments/submission.service';
import { FormativeAssessmentController } from '@modules/m21-classroom/assignments/formative-assessment.controller';
import { FormativeAssessmentService } from '@modules/m21-classroom/assignments/formative-assessment.service';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import { makeRecordingKafka } from '../helpers/recording-kafka';
import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import {
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_STUDENT_PERSON_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { TEST_SIS_CLASS_ID } from '../fixtures/sis';
import { seedStudent, enrollStudent, cleanupSeededIds } from '../m20-sis/sis-helpers';

/**
 * Wave 4 — m21-classroom assignments-area controllers DB-backed integration.
 *
 * Tests the HTTP-style entry points of AssignmentController, CategoryController,
 * RubricController, SubmissionController, FormativeAssessmentController by
 * constructing each controller with real services and invoking methods with a
 * synthetic AuthedRequest. The underlying service contracts are already
 * exercised by the assignment-lifecycle + formative-assessment specs — the value
 * here is bumping controllers from 0 % to ≥80 % so the m21-classroom module
 * lands the Wave 4 target.
 */
describe('integration:m21-classroom/assignments-controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let actorContext: ActorContextService;
  let kafka: ReturnType<typeof makeRecordingKafka>;

  let assignmentService: AssignmentService;
  let categoryService: CategoryService;
  let rubricService: RubricService;
  let submissionService: SubmissionService;
  let formativeService: FormativeAssessmentService;

  let assignmentController: AssignmentController;
  let categoryController: CategoryController;
  let rubricController: RubricController;
  let submissionController: SubmissionController;
  let formativeController: FormativeAssessmentController;

  let assignmentTypeId: string;

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
    categoryService = new CategoryService(tenantPrisma, assignmentService);
    rubricService = new RubricService(tenantPrisma);
    submissionService = new SubmissionService(
      tenantPrisma,
      assignmentService,
      kafka as unknown as KafkaProducerService,
    );
    formativeService = new FormativeAssessmentService(tenantPrisma);

    assignmentController = new AssignmentController(assignmentService, actorContext);
    categoryController = new CategoryController(categoryService, actorContext);
    rubricController = new RubricController(rubricService, actorContext);
    submissionController = new SubmissionController(submissionService, actorContext);
    formativeController = new FormativeAssessmentController(formativeService, actorContext);

    // Seed admin permission cache so isSchoolAdmin resolves true.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, ARRAY['sch-001:admin','tch-001:read','tch-001:write','tch-002:read','tch-002:write','tch-003:write','tch-008:write','tch-009:write','tch-010:write','tch-013:write','att-005:write']::text[], now(), 'test')
       ON CONFLICT (account_id, scope_id) DO UPDATE SET permission_codes = EXCLUDED.permission_codes`,
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
    );

    assignmentTypeId = await ensureAssignmentType();
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
    // Wipe per-test classroom state. Children before parents.
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_rubric_scores`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_grades`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_submissions`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_formative_responses`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_formative_assessments`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_assignments`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_assignment_categories`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_rubric_criteria`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_rubrics`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_class_teachers`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_enrollments`);
    // Pre-clean any leaked rows tied to the static STUDENT actor person id
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students
       WHERE platform_student_id IN (
         SELECT id FROM platform.platform_students WHERE person_id = $1::uuid)`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE person_id = $1::uuid`,
      TEST_STUDENT_PERSON_ID,
    );
    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
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
  // AssignmentController
  // ────────────────────────────────────────────────────────────────────
  describe('AssignmentController', () => {
    it('listTypes returns assignment types', async () => {
      const types = await withTestTenant(async () => assignmentController.listTypes());
      expect(Array.isArray(types)).toBe(true);
      expect(types.length).toBeGreaterThan(0);
      expect(types[0]!.name).toBeDefined();
    });

    it('create + getOne + update + listForClass + remove (admin)', async () => {
      const created = await withTestTenant(async () =>
        assignmentController.create(
          TEST_SIS_CLASS_ID,
          { title: 'Ctrl HW', assignmentTypeId, isPublished: true } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.title).toBe('Ctrl HW');
      expect(created.isPublished).toBe(true);

      const fetched = await withTestTenant(async () =>
        assignmentController.getOne(created.id, fakeAdminReq()),
      );
      expect(fetched.id).toBe(created.id);

      const updated = await withTestTenant(async () =>
        assignmentController.update(
          created.id,
          { title: 'Renamed HW', maxPoints: 50 } as any,
          fakeAdminReq(),
        ),
      );
      expect(updated.title).toBe('Renamed HW');
      expect(updated.maxPoints).toBe(50);

      const list = await withTestTenant(async () =>
        assignmentController.listForClass(TEST_SIS_CLASS_ID, {} as any, fakeAdminReq()),
      );
      expect(list.map((a) => a.id)).toContain(created.id);

      await withTestTenant(async () =>
        assignmentController.remove(created.id, fakeAdminReq()),
      );
      const listAfter = await withTestTenant(async () =>
        assignmentController.listForClass(TEST_SIS_CLASS_ID, {} as any, fakeAdminReq()),
      );
      expect(listAfter.map((a) => a.id)).not.toContain(created.id);
    });

    it('listForClass with includeUnpublished=true sees drafts', async () => {
      const draft = await withTestTenant(async () =>
        assignmentController.create(
          TEST_SIS_CLASS_ID,
          { title: 'Draft', assignmentTypeId } as any,
          fakeAdminReq(),
        ),
      );

      const list = await withTestTenant(async () =>
        assignmentController.listForClass(
          TEST_SIS_CLASS_ID,
          { includeUnpublished: true } as any,
          fakeAdminReq(),
        ),
      );
      expect(list.map((a) => a.id)).toContain(draft.id);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // CategoryController
  // ────────────────────────────────────────────────────────────────────
  describe('CategoryController', () => {
    it('list + upsert categories', async () => {
      const before = await withTestTenant(async () =>
        categoryController.list(TEST_SIS_CLASS_ID, fakeAdminReq()),
      );
      expect(Array.isArray(before)).toBe(true);

      const upserted = await withTestTenant(async () =>
        categoryController.upsert(
          TEST_SIS_CLASS_ID,
          {
            categories: [
              { name: 'Homework', weight: 40 },
              { name: 'Tests', weight: 60 },
            ],
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(upserted.length).toBe(2);
      expect(upserted.find((c) => c.name === 'Homework')!.weight).toBe(40);

      const after = await withTestTenant(async () =>
        categoryController.list(TEST_SIS_CLASS_ID, fakeAdminReq()),
      );
      expect(after.length).toBe(2);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // RubricController
  // ────────────────────────────────────────────────────────────────────
  describe('RubricController', () => {
    it('create + getById + list + update + clone + delete', async () => {
      const created = await withTestTenant(async () =>
        rubricController.create(
          {
            title: 'Ctrl Rubric',
            isTemplate: true,
            criteria: [
              {
                criterionName: 'Accuracy',
                weight: 100,
                maxPoints: 10,
                sortOrder: 0,
              },
            ],
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.title).toBe('Ctrl Rubric');
      expect(created.criteria?.length).toBe(1);

      const fetched = await withTestTenant(async () => rubricController.getById(created.id));
      expect(fetched.id).toBe(created.id);

      const list = await withTestTenant(async () =>
        rubricController.list('templates', fakeAdminReq()),
      );
      expect(list.map((r) => r.id)).toContain(created.id);

      const listAll = await withTestTenant(async () =>
        rubricController.list(undefined, fakeAdminReq()),
      );
      expect(listAll.map((r) => r.id)).toContain(created.id);

      const updated = await withTestTenant(async () =>
        rubricController.update(
          created.id,
          { title: 'Renamed Rubric' } as any,
          fakeAdminReq(),
        ),
      );
      expect(updated.title).toBe('Renamed Rubric');

      const cloned = await withTestTenant(async () =>
        rubricController.clone(created.id, { title: 'Cloned Rubric' } as any, fakeAdminReq()),
      );
      expect(cloned.title).toBe('Cloned Rubric');
      expect(cloned.id).not.toBe(created.id);

      await withTestTenant(async () => rubricController.delete(cloned.id, fakeAdminReq()));
      await withTestTenant(async () => rubricController.delete(created.id, fakeAdminReq()));
    });

    it('upsertScore + listScoresForSubmission', async () => {
      const rubric = await withTestTenant(async () =>
        rubricController.create(
          {
            title: 'Scoring Rubric',
            criteria: [
              { criterionName: 'Quality', weight: 100, maxPoints: 10, sortOrder: 0 },
            ],
          } as any,
          fakeAdminReq(),
        ),
      );

      // Need an actual submission to score against — seed an assignment +
      // submission.
      const a = await withTestTenant(async () =>
        assignmentController.create(
          TEST_SIS_CLASS_ID,
          { title: 'A', assignmentTypeId, isPublished: true } as any,
          fakeAdminReq(),
        ),
      );
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const subId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cls_submissions
           (id, assignment_id, student_id, status, submission_text, attachments, submitted_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'SUBMITTED', 'work', '[]'::jsonb, now())`,
        subId,
        a.id,
        student.studentId,
      );

      const score = await withTestTenant(async () =>
        rubricController.upsertScore(
          {
            submissionId: subId,
            criterionId: rubric.criteria![0]!.id,
            pointsAwarded: 8,
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(score.pointsAwarded).toBe(8);

      const scores = await withTestTenant(async () =>
        rubricController.listScoresForSubmission(subId),
      );
      expect(scores.length).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // SubmissionController
  // ────────────────────────────────────────────────────────────────────
  describe('SubmissionController', () => {
    it('submit (student) + listForAssignment (admin) + getById', async () => {
      // Seed sis_students for the STUDENT actor persona.
      const psId = generateId();
      const sid = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
         VALUES ($1::uuid, $2::uuid, 'Self', 'Sub', true)`,
        psId,
        TEST_STUDENT_PERSON_ID,
      );
      platformStudentIds.push(psId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_students
           (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5', 'ENROLLED')`,
        sid,
        psId,
        TEST_SCHOOL_ID,
        'SUB-CTRL-' + Math.random().toString(36).slice(2, 8),
      );
      studentIds.push(sid);
      await enrollStudent(rawClient, sid);

      const assignment = await withTestTenant(async () =>
        assignmentController.create(
          TEST_SIS_CLASS_ID,
          { title: 'Submit me', assignmentTypeId, isPublished: true } as any,
          fakeAdminReq(),
        ),
      );

      // The STUDENT persona must submit — synthesise their req object.
      const studentReq = {
        user: {
          sub: '019e0cf8-aaaa-7777-8888-000000000041',
          personId: TEST_STUDENT_PERSON_ID,
          email: 'student@test.integration.local',
          displayName: 'Student',
          sessionId: 's',
        },
      };

      const sub = await withTestTenant(
        async () =>
          submissionController.submit(
            assignment.id,
            { submissionText: 'Done' } as any,
            studentReq as any,
          ),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(sub.assignmentId).toBe(assignment.id);

      const list = await withTestTenant(async () =>
        submissionController.listForAssignment(assignment.id, fakeAdminReq()),
      );
      expect(list.assignmentId).toBe(assignment.id);

      const fetched = await withTestTenant(async () =>
        submissionController.getById(sub.id, fakeAdminReq()),
      );
      expect(fetched.id).toBe(sub.id);

      const mine = await withTestTenant(
        async () => submissionController.listMine(assignment.id, studentReq as any),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(mine?.id).toBe(sub.id);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // FormativeAssessmentController
  // ────────────────────────────────────────────────────────────────────
  describe('FormativeAssessmentController', () => {
    it('create + listForClass + getById + update + activate + close', async () => {
      const created = await withTestTenant(async () =>
        formativeController.create(
          {
            classId: TEST_SIS_CLASS_ID,
            title: 'Exit Ticket',
            assessmentType: 'EXIT_TICKET',
            questions: [
              {
                questionId: 'q1',
                prompt: 'What did you learn today?',
                responseType: 'TEXT',
              },
            ],
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.title).toBe('Exit Ticket');
      expect(created.isActive).toBe(false);

      const list = await withTestTenant(async () =>
        formativeController.listForClass(TEST_SIS_CLASS_ID, fakeAdminReq()),
      );
      expect(list.map((a) => a.id)).toContain(created.id);

      const fetched = await withTestTenant(async () => formativeController.getById(created.id));
      expect(fetched.id).toBe(created.id);

      const updated = await withTestTenant(async () =>
        formativeController.update(
          created.id,
          { title: 'Renamed Exit Ticket' } as any,
          fakeAdminReq(),
        ),
      );
      expect(updated.title).toBe('Renamed Exit Ticket');

      const activated = await withTestTenant(async () =>
        formativeController.activate(created.id, fakeAdminReq()),
      );
      expect(activated.isActive).toBe(true);

      const closed = await withTestTenant(async () =>
        formativeController.close(created.id, fakeAdminReq()),
      );
      expect(closed.isActive).toBe(false);
    });

    it('respond (student) + getResults (admin)', async () => {
      // Seed STUDENT persona + enrolment
      const psId = generateId();
      const sid = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
         VALUES ($1::uuid, $2::uuid, 'Self', 'Form', true)`,
        psId,
        TEST_STUDENT_PERSON_ID,
      );
      platformStudentIds.push(psId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_students
           (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5', 'ENROLLED')`,
        sid,
        psId,
        TEST_SCHOOL_ID,
        'FORM-CTRL-' + Math.random().toString(36).slice(2, 8),
      );
      studentIds.push(sid);
      await enrollStudent(rawClient, sid);

      const assessment = await withTestTenant(async () =>
        formativeController.create(
          {
            classId: TEST_SIS_CLASS_ID,
            title: 'Poll',
            assessmentType: 'POLL',
            questions: [
              { questionId: 'q1', prompt: 'Favorite color?', responseType: 'TEXT' },
            ],
          } as any,
          fakeAdminReq(),
        ),
      );
      await withTestTenant(async () => formativeController.activate(assessment.id, fakeAdminReq()));

      const studentReq = {
        user: {
          sub: '019e0cf8-aaaa-7777-8888-000000000041',
          personId: TEST_STUDENT_PERSON_ID,
          email: 'student@test.integration.local',
          displayName: 'Student',
          sessionId: 's',
        },
      };

      const resp = await withTestTenant(
        async () =>
          formativeController.respond(
            assessment.id,
            { responses: { q1: 'Blue' } } as any,
            studentReq as any,
          ),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(resp.assessmentId).toBe(assessment.id);

      const results = await withTestTenant(async () =>
        formativeController.getResults(assessment.id, fakeAdminReq()),
      );
      expect(results.totalResponses).toBe(1);
    });
  });
});
