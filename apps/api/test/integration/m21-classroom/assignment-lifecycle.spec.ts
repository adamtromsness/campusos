import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { AssignmentService } from '@modules/m21-classroom/assignments/assignment.service';
import { SubmissionService } from '@modules/m21-classroom/assignments/submission.service';
import { RubricService } from '@modules/m21-classroom/assignments/rubric.service';
import { CategoryService } from '@modules/m21-classroom/assignments/category.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_STUDENT_PERSON_ID,
  TEST_TEACHER_EMPLOYEE_ID,
} from '../helpers/actor';
import { TEST_SIS_CLASS_ID, TEST_SIS_CLASS_B_ID } from '../fixtures/sis';
import {
  seedStudent,
  enrollStudent,
  assignTeacherToClass,
  cleanupSeededIds,
} from '../m20-sis/sis-helpers';

/**
 * Wave 4 — m21-classroom assignment-lifecycle DB-backed integration tests.
 *
 * Services covered:
 *   - AssignmentService — create/list/get/update/softDelete + auth gates
 *   - SubmissionService — student submit, re-submit (idempotent), teacher
 *     list, student own view, visibility filters
 *   - RubricService — CRUD + criteria + score upsert + clone
 *   - CategoryService — per-class category list/upsert
 *
 * Contracts verified:
 *   - Class write gate: admin bypasses, teacher must be in
 *     sis_class_teachers (else 403), non-staff personas → 403.
 *   - School scope: cls_assignments.assignment_type_id must belong to
 *     the same school as the class (else 400).
 *   - is_published gates: drafts are invisible to students/parents;
 *     teacher manager can list with includeUnpublished=true.
 *   - cls.assignment.posted Kafka emit on publish (create or update).
 *   - SubmissionService.submit upsert keyed by (assignment_id, student_id)
 *     — no duplicate row, but submitted_at + status reset; emits
 *     cls.submission.submitted on both create + resubmit paths.
 *   - RubricService creator-only update/delete (admin bypasses).
 *   - CategoryService weights-sum-to-100 invariant.
 */
describe('integration:m21-classroom/assignment-lifecycle', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: ReturnType<typeof makeRecordingKafka>;

  let assignmentService: AssignmentService;
  let submissionService: SubmissionService;
  let rubricService: RubricService;
  let categoryService: CategoryService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  let assignmentTypeId: string;
  let foreignAssignmentTypeId: string;

  /**
   * Idempotent helper — re-use one Homework assignment type per school.
   * Cleanup wipes school-scoped state but leaves the type row in place
   * so successive specs can re-use it.
   */
  async function ensureAssignmentType(schoolId: string): Promise<string> {
    const existing = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.cls_assignment_types WHERE school_id = $1::uuid LIMIT 1`,
      schoolId,
    );
    if (existing.length > 0) return existing[0]!.id;
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cls_assignment_types (id, school_id, name, weight_in_category, category)
       VALUES ($1::uuid, $2::uuid, 'Homework', 100.00, 'HOMEWORK')`,
      id,
      schoolId,
    );
    return id;
  }

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    kafka = makeRecordingKafka();
    assignmentService = new AssignmentService(tenantPrisma, kafka as unknown as KafkaProducerService);
    submissionService = new SubmissionService(
      tenantPrisma,
      assignmentService,
      kafka as unknown as KafkaProducerService,
    );
    rubricService = new RubricService(tenantPrisma);
    categoryService = new CategoryService(tenantPrisma, assignmentService);

    assignmentTypeId = await ensureAssignmentType(TEST_SCHOOL_ID);
    foreignAssignmentTypeId = await ensureAssignmentType(
      '019e0cf8-aaaa-7777-8888-00000000000b' /* TEST_SCHOOL_B_ID */,
    );
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    (kafka as unknown as RecordingKafkaProducer).reset();
    // Wipe per-test classroom state. Order matters — children before
    // parents to honour FK CASCADE / RESTRICT contracts.
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_rubric_scores`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_standard_grade_evidence`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_standard_grades`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_student_observations`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_grades`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_submissions`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_assignments`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_assignment_categories`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_rubric_criteria`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_rubrics`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_class_teachers`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_enrollments`);
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

  /**
   * Seed a sis_students row pointing at the static STUDENT actor's
   * iam_person so the SubmissionService can resolve the calling
   * student's sis_students.id from actor.personId.
   */
  async function ensureStudentActorSisRow(): Promise<string> {
    const psId = generateId();
    const sid = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
         VALUES ($1::uuid, $2::uuid, 'Self', 'Lifecycle', true)`,
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
      'AL-SELF-' + Math.random().toString(36).slice(2, 8),
    );
    studentIds.push(sid);
    return sid;
  }

  // ────────────────────────────────────────────────────────────────────
  // AssignmentService.create — auth gate + emit
  // ────────────────────────────────────────────────────────────────────
  describe('AssignmentService.create', () => {
    it('admin creates a published assignment → row inserted, cls.assignment.posted emitted', async () => {
      const dto = await withTestTenant(async () =>
        assignmentService.create(
          TEST_SIS_CLASS_ID,
          {
            title: 'Reading log',
            assignmentTypeId,
            isPublished: true,
            maxPoints: 50,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.title).toBe('Reading log');
      expect(dto.isPublished).toBe(true);
      expect(dto.maxPoints).toBe(50);
      expect(dto.classId).toBe(TEST_SIS_CLASS_ID);

      const row = await rawClient.$queryRawUnsafe<Array<{ id: string; is_published: boolean }>>(
        `SELECT id::text, is_published FROM ${TEST_SCHEMA}.cls_assignments WHERE id = $1::uuid`,
        dto.id,
      );
      expect(row).toHaveLength(1);
      expect(row[0]!.is_published).toBe(true);

      const posted = (kafka as unknown as RecordingKafkaProducer).callsForTopic(
        'cls.assignment.posted',
      );
      expect(posted).toHaveLength(1);
      expect(posted[0]!.key).toBe(dto.id);
      expect(posted[0]!.payload).toMatchObject({
        assignmentId: dto.id,
        classId: TEST_SIS_CLASS_ID,
        title: 'Reading log',
        isPublished: true,
      });
    });

    it('admin creates a draft → no Kafka emit; row exists with is_published=false', async () => {
      const dto = await withTestTenant(async () =>
        assignmentService.create(
          TEST_SIS_CLASS_ID,
          { title: 'Draft pop quiz', assignmentTypeId } as any,
          adminActor(),
        ),
      );
      expect(dto.isPublished).toBe(false);
      const posted = (kafka as unknown as RecordingKafkaProducer).callsForTopic(
        'cls.assignment.posted',
      );
      expect(posted).toHaveLength(0);
    });

    it('class teacher creates assignment → succeeds', async () => {
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, TEST_TEACHER_EMPLOYEE_ID);
      const dto = await withTestTenant(async () =>
        assignmentService.create(
          TEST_SIS_CLASS_ID,
          { title: 'Teacher-authored', assignmentTypeId, isPublished: true } as any,
          teacherActor(),
        ),
      );
      expect(dto.title).toBe('Teacher-authored');
    });

    it('teacher NOT assigned to the class → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          assignmentService.create(
            TEST_SIS_CLASS_ID,
            { title: 'Nope', assignmentTypeId } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-employee caller (student persona) → ForbiddenException', async () => {
      await expect(
        withTestTenant(
          async () =>
            assignmentService.create(
              TEST_SIS_CLASS_ID,
              { title: 'Self assigned', assignmentTypeId } as any,
              studentActor(),
            ),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('assignment_type_id from a different school → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          assignmentService.create(
            TEST_SIS_CLASS_ID,
            { title: 'Wrong school type', assignmentTypeId: foreignAssignmentTypeId } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('admin write on a phantom class_id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          assignmentService.create(
            '00000000-0000-0000-0000-000000000000',
            { title: 'Ghost class', assignmentTypeId } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // AssignmentService.list / getById — visibility filters
  // ────────────────────────────────────────────────────────────────────
  describe('AssignmentService.list / getById', () => {
    it('students see only published, non-deleted assignments', async () => {
      const sid = await ensureStudentActorSisRow();
      await enrollStudent(rawClient, sid);

      const pub = await withTestTenant(async () =>
        assignmentService.create(
          TEST_SIS_CLASS_ID,
          { title: 'Published HW', assignmentTypeId, isPublished: true } as any,
          adminActor(),
        ),
      );
      const draft = await withTestTenant(async () =>
        assignmentService.create(
          TEST_SIS_CLASS_ID,
          { title: 'Draft HW', assignmentTypeId } as any,
          adminActor(),
        ),
      );

      const list = await withTestTenant(
        async () => assignmentService.list(TEST_SIS_CLASS_ID, {} as any, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      const ids = list.map((r) => r.id);
      expect(ids).toContain(pub.id);
      expect(ids).not.toContain(draft.id);
    });

    it('admin with includeUnpublished=true sees drafts too', async () => {
      const pub = await withTestTenant(async () =>
        assignmentService.create(
          TEST_SIS_CLASS_ID,
          { title: 'Pub', assignmentTypeId, isPublished: true } as any,
          adminActor(),
        ),
      );
      const draft = await withTestTenant(async () =>
        assignmentService.create(
          TEST_SIS_CLASS_ID,
          { title: 'Draft', assignmentTypeId } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        assignmentService.list(
          TEST_SIS_CLASS_ID,
          { includeUnpublished: true } as any,
          adminActor(),
        ),
      );
      const ids = list.map((r) => r.id);
      expect(ids).toContain(pub.id);
      expect(ids).toContain(draft.id);
    });

    it('student includeUnpublished=true is ignored — drafts still hidden', async () => {
      const sid = await ensureStudentActorSisRow();
      await enrollStudent(rawClient, sid);
      const draft = await withTestTenant(async () =>
        assignmentService.create(
          TEST_SIS_CLASS_ID,
          { title: 'Sneaky', assignmentTypeId } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(
        async () =>
          assignmentService.list(
            TEST_SIS_CLASS_ID,
            { includeUnpublished: true } as any,
            studentActor(),
          ),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(list.map((r) => r.id)).not.toContain(draft.id);
    });

    it('non-member (student not enrolled) → NotFoundException on list', async () => {
      await expect(
        withTestTenant(
          async () =>
            assignmentService.list(TEST_SIS_CLASS_ID, {} as any, studentActor()),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById for a draft as a student → NotFoundException', async () => {
      const sid = await ensureStudentActorSisRow();
      await enrollStudent(rawClient, sid);
      const draft = await withTestTenant(async () =>
        assignmentService.create(
          TEST_SIS_CLASS_ID,
          { title: 'Hidden', assignmentTypeId } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(
          async () => assignmentService.getById(draft.id, studentActor()),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('soft-deleted assignment hidden from list AND getById (even for admin)', async () => {
      const a = await withTestTenant(async () =>
        assignmentService.create(
          TEST_SIS_CLASS_ID,
          { title: 'Bye', assignmentTypeId, isPublished: true } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => assignmentService.softDelete(a.id, adminActor()));
      await expect(
        withTestTenant(async () => assignmentService.getById(a.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      const list = await withTestTenant(async () =>
        assignmentService.list(TEST_SIS_CLASS_ID, { includeUnpublished: true } as any, adminActor()),
      );
      expect(list.map((r) => r.id)).not.toContain(a.id);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // AssignmentService.update — emits + cross-class isolation
  // ────────────────────────────────────────────────────────────────────
  describe('AssignmentService.update', () => {
    it('publishing a draft via update emits cls.assignment.posted', async () => {
      const a = await withTestTenant(async () =>
        assignmentService.create(
          TEST_SIS_CLASS_ID,
          { title: 'Draft to publish', assignmentTypeId } as any,
          adminActor(),
        ),
      );
      (kafka as unknown as RecordingKafkaProducer).reset();
      const updated = await withTestTenant(async () =>
        assignmentService.update(a.id, { isPublished: true } as any, adminActor()),
      );
      expect(updated.isPublished).toBe(true);
      const posted = (kafka as unknown as RecordingKafkaProducer).callsForTopic(
        'cls.assignment.posted',
      );
      expect(posted).toHaveLength(1);
      expect(posted[0]!.key).toBe(a.id);
    });

    it('empty patch → BadRequestException (no fields to update)', async () => {
      const a = await withTestTenant(async () =>
        assignmentService.create(
          TEST_SIS_CLASS_ID,
          { title: 'patchable', assignmentTypeId, isPublished: true } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => assignmentService.update(a.id, {} as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('teacher not assigned to the class → ForbiddenException on update', async () => {
      const a = await withTestTenant(async () =>
        assignmentService.create(
          TEST_SIS_CLASS_ID,
          { title: 'Off-limits', assignmentTypeId, isPublished: true } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          assignmentService.update(a.id, { title: 'Hacked' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // SubmissionService — submit / re-submit / list
  // ────────────────────────────────────────────────────────────────────
  describe('SubmissionService.submit', () => {
    async function publishedAssignment(title = 'Sub me'): Promise<string> {
      const a = await withTestTenant(async () =>
        assignmentService.create(
          TEST_SIS_CLASS_ID,
          { title, assignmentTypeId, isPublished: true } as any,
          adminActor(),
        ),
      );
      return a.id;
    }

    it('student submits a published assignment → row inserted, cls.submission.submitted emitted', async () => {
      const sid = await ensureStudentActorSisRow();
      await enrollStudent(rawClient, sid);
      const aid = await publishedAssignment();
      (kafka as unknown as RecordingKafkaProducer).reset();

      const dto = await withTestTenant(
        async () =>
          submissionService.submit(
            aid,
            { submissionText: 'my answer' } as any,
            studentActor(),
          ),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(dto.status).toBe('SUBMITTED');
      expect(dto.submissionText).toBe('my answer');
      expect(dto.student.id).toBe(sid);

      const rows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text FROM ${TEST_SCHEMA}.cls_submissions WHERE assignment_id = $1::uuid AND student_id = $2::uuid`,
        aid,
        sid,
      );
      expect(rows).toHaveLength(1);

      const emits = (kafka as unknown as RecordingKafkaProducer).callsForTopic(
        'cls.submission.submitted',
      );
      expect(emits).toHaveLength(1);
      expect(emits[0]!.payload).toMatchObject({
        assignmentId: aid,
        classId: TEST_SIS_CLASS_ID,
        studentId: sid,
      });
    });

    it('re-submit by same student → upserts (no duplicate row), status reset to SUBMITTED', async () => {
      const sid = await ensureStudentActorSisRow();
      await enrollStudent(rawClient, sid);
      const aid = await publishedAssignment();

      await withTestTenant(
        async () => submissionService.submit(aid, { submissionText: 'v1' } as any, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      const second = await withTestTenant(
        async () => submissionService.submit(aid, { submissionText: 'v2' } as any, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(second.submissionText).toBe('v2');
      expect(second.status).toBe('SUBMITTED');

      const rows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cls_submissions WHERE assignment_id = $1::uuid AND student_id = $2::uuid`,
        aid,
        sid,
      );
      expect(rows[0]!.count).toBe(1);
    });

    it('student not enrolled → ForbiddenException', async () => {
      await ensureStudentActorSisRow(); // sis_students row, no enrollment
      const aid = await publishedAssignment();
      await expect(
        withTestTenant(
          async () =>
            submissionService.submit(aid, { submissionText: 'x' } as any, studentActor()),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-STUDENT actor (admin) → ForbiddenException', async () => {
      const aid = await publishedAssignment();
      await expect(
        withTestTenant(async () =>
          submissionService.submit(aid, { submissionText: 'x' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('submission for a draft (unpublished) assignment → NotFoundException', async () => {
      const sid = await ensureStudentActorSisRow();
      await enrollStudent(rawClient, sid);
      const draft = await withTestTenant(async () =>
        assignmentService.create(
          TEST_SIS_CLASS_ID,
          { title: 'Draft sub', assignmentTypeId } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(
          async () =>
            submissionService.submit(draft.id, { submissionText: 'x' } as any, studentActor()),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listForAssignment (manager view) returns full roster + submission status', async () => {
      const sid = await ensureStudentActorSisRow();
      await enrollStudent(rawClient, sid);
      const other = await trackedStudent({ firstName: 'Peer', lastName: 'Z' });
      await enrollStudent(rawClient, other.studentId);
      const aid = await publishedAssignment('Roster check');

      // Only the actor-student submits; peer remains NOT_STARTED.
      await withTestTenant(
        async () => submissionService.submit(aid, { submissionText: 'mine' } as any, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );

      const resp = await withTestTenant(async () =>
        submissionService.listForAssignment(aid, adminActor()),
      );
      expect(resp.assignmentId).toBe(aid);
      expect(resp.rosterSize).toBe(2);
      expect(resp.submittedCount).toBe(1);
      const statuses = resp.submissions.map((s) => s.status).sort();
      expect(statuses).toEqual(['NOT_STARTED', 'SUBMITTED']);
    });

    it('listMineForAssignment returns null before submit, the submission after', async () => {
      const sid = await ensureStudentActorSisRow();
      await enrollStudent(rawClient, sid);
      const aid = await publishedAssignment('mine view');

      const before = await withTestTenant(
        async () => submissionService.listMineForAssignment(aid, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(before).toBeNull();

      await withTestTenant(
        async () => submissionService.submit(aid, { submissionText: 'mine!' } as any, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      const after = await withTestTenant(
        async () => submissionService.listMineForAssignment(aid, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(after?.submissionText).toBe('mine!');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // RubricService
  // ────────────────────────────────────────────────────────────────────
  describe('RubricService', () => {
    it('admin creates rubric with criteria → row + criteria rows; getById round-trips', async () => {
      const dto = await withTestTenant(async () =>
        rubricService.create(
          {
            title: 'Essay rubric',
            description: 'demo',
            isTemplate: true,
            criteria: [
              {
                criterionName: 'Thesis',
                weight: 50,
                maxPoints: 10,
                sortOrder: 0,
              },
              {
                criterionName: 'Evidence',
                weight: 50,
                maxPoints: 10,
                sortOrder: 1,
              },
            ],
          } as any,
          adminActor(),
        ),
      );
      expect(dto.title).toBe('Essay rubric');
      expect(dto.criteria).toHaveLength(2);
      expect(dto.weightWarning).toBeNull(); // 50+50 = 100
      expect(dto.totalPoints).toBe(20);

      const fetched = await withTestTenant(async () => rubricService.getById(dto.id));
      expect(fetched.criteria).toHaveLength(2);
    });

    it('rubric with criteria weights summing to less than 100 → weightWarning set', async () => {
      const dto = await withTestTenant(async () =>
        rubricService.create(
          {
            title: 'Lopsided',
            criteria: [
              { criterionName: 'Only', weight: 60, maxPoints: 10, sortOrder: 0 },
            ],
          } as any,
          adminActor(),
        ),
      );
      expect(dto.weightTotal).toBe(60);
      expect(dto.weightWarning).not.toBeNull();
    });

    it('non-employee caller (student) → ForbiddenException', async () => {
      await expect(
        withTestTenant(
          async () =>
            rubricService.create(
              {
                title: 'Nope',
                criteria: [
                  { criterionName: 'X', weight: 100, maxPoints: 10, sortOrder: 0 },
                ],
              } as any,
              studentActor(),
            ),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-creator teacher cannot update someone else\'s rubric → ForbiddenException', async () => {
      const created = await withTestTenant(async () =>
        rubricService.create(
          {
            title: 'admin-owned',
            criteria: [
              { criterionName: 'A', weight: 100, maxPoints: 10, sortOrder: 0 },
            ],
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          rubricService.update(created.id, { title: 'stolen' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin updates any rubric → succeeds; criteria array fully replaces', async () => {
      const created = await withTestTenant(async () =>
        rubricService.create(
          {
            title: 'will replace',
            criteria: [
              { criterionName: 'Original', weight: 100, maxPoints: 10, sortOrder: 0 },
            ],
          } as any,
          adminActor(),
        ),
      );
      const updated = await withTestTenant(async () =>
        rubricService.update(
          created.id,
          {
            title: 'replaced',
            criteria: [
              { criterionName: 'NewA', weight: 40, maxPoints: 4, sortOrder: 0 },
              { criterionName: 'NewB', weight: 60, maxPoints: 6, sortOrder: 1 },
            ],
          } as any,
          adminActor(),
        ),
      );
      expect(updated.title).toBe('replaced');
      expect(updated.criteria.map((c) => c.criterionName).sort()).toEqual(['NewA', 'NewB']);
      expect(updated.totalPoints).toBe(10);
    });

    it('admin clones a rubric → new id, copied criteria, is_template=false', async () => {
      const src = await withTestTenant(async () =>
        rubricService.create(
          {
            title: 'Source',
            isTemplate: true,
            criteria: [
              { criterionName: 'C1', weight: 100, maxPoints: 5, sortOrder: 0 },
            ],
          } as any,
          adminActor(),
        ),
      );
      const cloned = await withTestTenant(async () =>
        rubricService.clone(src.id, {} as any, adminActor()),
      );
      expect(cloned.id).not.toBe(src.id);
      expect(cloned.title).toBe('Source (copy)');
      expect(cloned.isTemplate).toBe(false);
      expect(cloned.criteria).toHaveLength(1);
      expect(cloned.criteria[0]!.criterionName).toBe('C1');
    });

    it('admin deletes a rubric → row gone', async () => {
      const r = await withTestTenant(async () =>
        rubricService.create(
          {
            title: 'goodbye',
            criteria: [
              { criterionName: 'X', weight: 100, maxPoints: 1, sortOrder: 0 },
            ],
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => rubricService.delete(r.id, adminActor()));
      const rows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text FROM ${TEST_SCHEMA}.cls_rubrics WHERE id = $1::uuid`,
        r.id,
      );
      expect(rows).toHaveLength(0);
    });

    it('upsertScore inserts; second call with same (submission,criterion,scorer) updates in place', async () => {
      // Need a submission + rubric criterion to score.
      const sid = await ensureStudentActorSisRow();
      await enrollStudent(rawClient, sid);
      const aid = await (async () => {
        const a = await withTestTenant(async () =>
          assignmentService.create(
            TEST_SIS_CLASS_ID,
            { title: 'For scoring', assignmentTypeId, isPublished: true } as any,
            adminActor(),
          ),
        );
        return a.id;
      })();
      const submission = await withTestTenant(
        async () => submissionService.submit(aid, { submissionText: 'work' } as any, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      const rubric = await withTestTenant(async () =>
        rubricService.create(
          {
            title: 'Scorable',
            criteria: [
              { criterionName: 'Quality', weight: 100, maxPoints: 10, sortOrder: 0 },
            ],
          } as any,
          adminActor(),
        ),
      );
      const criterionId = rubric.criteria[0]!.id;

      const first = await withTestTenant(async () =>
        rubricService.upsertScore(
          {
            submissionId: submission.id,
            criterionId,
            pointsAwarded: 6,
            feedback: 'okay',
          } as any,
          adminActor(),
        ),
      );
      expect(first.pointsAwarded).toBe(6);

      const second = await withTestTenant(async () =>
        rubricService.upsertScore(
          {
            submissionId: submission.id,
            criterionId,
            pointsAwarded: 9,
            feedback: 'better',
          } as any,
          adminActor(),
        ),
      );
      expect(second.pointsAwarded).toBe(9);
      expect(second.feedback).toBe('better');

      const cnt = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cls_rubric_scores
         WHERE submission_id = $1::uuid AND criterion_id = $2::uuid`,
        submission.id,
        criterionId,
      );
      expect(cnt[0]!.count).toBe(1);
    });

    it('upsertScore pointsAwarded > criterion.max_points → BadRequestException', async () => {
      // Reuse the submission seed pattern
      const sid = await ensureStudentActorSisRow();
      await enrollStudent(rawClient, sid);
      const a = await withTestTenant(async () =>
        assignmentService.create(
          TEST_SIS_CLASS_ID,
          { title: 'Overshoot', assignmentTypeId, isPublished: true } as any,
          adminActor(),
        ),
      );
      const submission = await withTestTenant(
        async () => submissionService.submit(a.id, { submissionText: 'w' } as any, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      const rubric = await withTestTenant(async () =>
        rubricService.create(
          {
            title: 'Bound',
            criteria: [
              { criterionName: 'Capped', weight: 100, maxPoints: 5, sortOrder: 0 },
            ],
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          rubricService.upsertScore(
            {
              submissionId: submission.id,
              criterionId: rubric.criteria[0]!.id,
              pointsAwarded: 99,
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // CategoryService
  // ────────────────────────────────────────────────────────────────────
  describe('CategoryService', () => {
    it('upsert creates the three-category sheet then list returns them sorted', async () => {
      const created = await withTestTenant(async () =>
        categoryService.upsert(
          TEST_SIS_CLASS_ID,
          {
            categories: [
              { name: 'Homework', weight: 30, sortOrder: 1 },
              { name: 'Assessments', weight: 50, sortOrder: 2 },
              { name: 'Participation', weight: 20, sortOrder: 3 },
            ],
          } as any,
          adminActor(),
        ),
      );
      expect(created).toHaveLength(3);
      const names = created.map((c) => c.name);
      expect(names).toEqual(['Homework', 'Assessments', 'Participation']);

      const listed = await withTestTenant(async () =>
        categoryService.list(TEST_SIS_CLASS_ID, adminActor()),
      );
      expect(listed.map((c) => c.name)).toEqual(['Homework', 'Assessments', 'Participation']);
    });

    it('weights not summing to 100 → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          categoryService.upsert(
            TEST_SIS_CLASS_ID,
            { categories: [{ name: 'Half', weight: 50 }] } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('duplicate name in request body → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          categoryService.upsert(
            TEST_SIS_CLASS_ID,
            {
              categories: [
                { name: 'Dup', weight: 50 },
                { name: 'Dup', weight: 50 },
              ],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('second upsert preserves existing ids when name matches', async () => {
      const first = await withTestTenant(async () =>
        categoryService.upsert(
          TEST_SIS_CLASS_ID,
          { categories: [{ name: 'Homework', weight: 100, sortOrder: 0 }] } as any,
          adminActor(),
        ),
      );
      const second = await withTestTenant(async () =>
        categoryService.upsert(
          TEST_SIS_CLASS_ID,
          { categories: [{ name: 'Homework', weight: 100, sortOrder: 5 }] } as any,
          adminActor(),
        ),
      );
      expect(second[0]!.id).toBe(first[0]!.id);
      expect(second[0]!.sortOrder).toBe(5);
    });

    it('deleting a category still referenced by an assignment → ConflictException', async () => {
      // 1. Create a category list with two entries.
      const cats = await withTestTenant(async () =>
        categoryService.upsert(
          TEST_SIS_CLASS_ID,
          {
            categories: [
              { name: 'Homework', weight: 50 },
              { name: 'Assessments', weight: 50 },
            ],
          } as any,
          adminActor(),
        ),
      );
      const homework = cats.find((c) => c.name === 'Homework')!;

      // 2. Create an assignment that uses Homework.
      await withTestTenant(async () =>
        assignmentService.create(
          TEST_SIS_CLASS_ID,
          {
            title: 'Refs cat',
            assignmentTypeId,
            categoryId: homework.id,
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );

      // 3. Re-upsert dropping Homework — should 409.
      await expect(
        withTestTenant(async () =>
          categoryService.upsert(
            TEST_SIS_CLASS_ID,
            { categories: [{ name: 'Assessments', weight: 100 }] } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('non-employee caller → ForbiddenException on upsert', async () => {
      await expect(
        withTestTenant(
          async () =>
            categoryService.upsert(
              TEST_SIS_CLASS_ID,
              { categories: [{ name: 'Solo', weight: 100 }] } as any,
              studentActor(),
            ),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // School-scope on assignment type validation
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school assignment type scope', () => {
    it('a School B assignment type cannot be used on a School A class → BadRequest', async () => {
      // foreignAssignmentTypeId is seeded against TEST_SCHOOL_B_ID by the
      // beforeAll bootstrap. The class lives in School A, so the service's
      // school-scope JOIN against sis_classes rejects the type.
      await expect(
        withTestTenant(async () =>
          assignmentService.create(
            TEST_SIS_CLASS_ID,
            {
              title: 'School B type on A class',
              assignmentTypeId: foreignAssignmentTypeId,
              isPublished: true,
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // Suppress unused import warning — kept for parity with other m21 fixtures.
  void TEST_SIS_CLASS_B_ID;
  void withTestTenantB;
});
