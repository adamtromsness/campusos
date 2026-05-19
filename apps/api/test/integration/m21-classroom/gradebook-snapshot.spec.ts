import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { GradebookSnapshotWorker } from '@modules/m21-classroom/grading/gradebook-snapshot-worker.service';
import { GradebookService } from '@modules/m21-classroom/grading/gradebook.service';
import { GradeService } from '@modules/m21-classroom/grading/grade.service';
import { AssignmentService } from '@modules/m21-classroom/assignments/assignment.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { IdempotencyService } from '@shared/kafka/idempotency.service';
import { KafkaConsumerService } from '@shared/kafka/kafka-consumer.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';
import type { ConsumedMessage } from '@shared/kafka/kafka-consumer.service';

import { makeRecordingKafka } from '../helpers/recording-kafka';
import {
  withTestTenant,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SUBDOMAIN,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  TEST_TEACHER_EMPLOYEE_ID,
} from '../helpers/actor';
import {
  TEST_SIS_CLASS_ID,
  TEST_SIS_TERM_ID,
} from '../fixtures/sis';
import {
  seedStudent,
  enrollStudent,
  assignTeacherToClass,
  cleanupSeededIds,
} from '../m20-sis/sis-helpers';

/**
 * Wave 4 — m21-classroom gradebook-snapshot DB-backed integration tests.
 *
 * Covers two surfaces:
 *
 * 1. GradebookSnapshotWorker — the Kafka consumer that recomputes
 *    cls_gradebook_snapshots on cls.grade.published / cls.grade.unpublished.
 *    Tests drive the private `handle()` method directly with a synthetic
 *    envelope, then call the public `flushAllForTest()` to force the
 *    30-second debounce timer to fire immediately, then assert the
 *    snapshot row landed with the expected weighted average + letter
 *    grade and that the idempotency claim was recorded after success.
 *
 * 2. GradebookService extra coverage — class/student gradebook with a
 *    real cls_gradebook_snapshots row in place, manager-tier reads,
 *    teacher class-scope filtering, and snapshot null when none exists.
 */
describe('integration:m21-classroom/gradebook-snapshot', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let assignmentService: AssignmentService;
  let gradeService: GradeService;
  let gradebookService: GradebookService;
  let idempotency: IdempotencyService;
  let worker: GradebookSnapshotWorker;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  let assignmentTypeId: string;
  let categoryHomeworkId: string;
  let categoryAssessmentsId: string;

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

  async function seedClassCategories(): Promise<{ hw: string; assess: string }> {
    // Wipe existing so weights stay clean per test.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.cls_assignment_categories WHERE class_id = $1::uuid`,
      TEST_SIS_CLASS_ID,
    );
    const hwId = generateId();
    const assessId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cls_assignment_categories (id, class_id, name, weight)
       VALUES ($1::uuid, $2::uuid, 'Homework', 40)`,
      hwId,
      TEST_SIS_CLASS_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cls_assignment_categories (id, class_id, name, weight)
       VALUES ($1::uuid, $2::uuid, 'Assessments', 60)`,
      assessId,
      TEST_SIS_CLASS_ID,
    );
    return { hw: hwId, assess: assessId };
  }

  async function createPublishedAssignment(
    title: string,
    categoryId: string,
    maxPoints = 100,
  ): Promise<string> {
    const a = await withTestTenant(async () =>
      assignmentService.create(
        TEST_SIS_CLASS_ID,
        {
          title,
          assignmentTypeId,
          categoryId,
          isPublished: true,
          maxPoints,
        } as any,
        adminActor(),
      ),
    );
    return a.id;
  }

  async function seedSubmission(assignmentId: string, studentSisId: string): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cls_submissions
         (id, assignment_id, student_id, status, submission_text, attachments, submitted_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'SUBMITTED', 'w', '[]'::jsonb, now())`,
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
    const kafka = makeRecordingKafka();
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
    // KafkaConsumerService is wired but the worker test path never reaches
    // a real broker — we drive handle() directly with synthetic messages.
    const consumer = new KafkaConsumerService(tenantPrisma);
    idempotency = new IdempotencyService(tenantPrisma);
    worker = new GradebookSnapshotWorker(consumer, idempotency, tenantPrisma);

    assignmentTypeId = await ensureAssignmentType();
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.cls_gradebook_snapshots`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_grades`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_submissions`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_assignments`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.cls_assignment_categories WHERE class_id = $1::uuid`,
      TEST_SIS_CLASS_ID,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_class_teachers`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_enrollments`);
    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
    });
    // Reset categories per test
    const cats = await seedClassCategories();
    categoryHomeworkId = cats.hw;
    categoryAssessmentsId = cats.assess;
  });

  async function trackedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  function makeEnvelopeMessage(opts: {
    topic: string;
    eventId?: string;
    classId: string;
    studentId: string;
    schoolId?: string;
    subdomain?: string;
  }): ConsumedMessage {
    return {
      topic: opts.topic,
      partition: 0,
      offset: '0',
      key: opts.classId + ':' + opts.studentId,
      headers: {
        'tenant-subdomain': opts.subdomain ?? TEST_SUBDOMAIN,
        // tenant-id header is fallback for envelope; the envelope also carries it
        'tenant-id': opts.schoolId ?? TEST_SCHOOL_ID,
      },
      payload: {
        event_id: opts.eventId ?? generateId(),
        event_type: opts.topic,
        tenant_id: opts.schoolId ?? TEST_SCHOOL_ID,
        occurred_at: new Date().toISOString(),
        published_at: new Date().toISOString(),
        source_module: 'classroom',
        payload: {
          gradeId: generateId(),
          assignmentId: generateId(),
          classId: opts.classId,
          studentId: opts.studentId,
          termId: TEST_SIS_TERM_ID,
        },
      },
      timestamp: String(Date.now()),
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // GradebookSnapshotWorker — recomputeSnapshot via handle + flushAllForTest
  // ────────────────────────────────────────────────────────────────────
  describe('GradebookSnapshotWorker.recomputeSnapshot via flush', () => {
    it('writes a cls_gradebook_snapshots row with weighted average + letter on first flush', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const hwA = await createPublishedAssignment('HW1', categoryHomeworkId, 100);
      const assess = await createPublishedAssignment('Quiz', categoryAssessmentsId, 100);
      // Insert published grades directly so we don't have to debounce
      // through the grade.service.publish path.
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cls_grades
           (id, assignment_id, student_id, teacher_id, grade_value,
            is_published, published_at, graded_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 80, true, now(), now())`,
        generateId(),
        hwA,
        student.studentId,
        TEST_TEACHER_EMPLOYEE_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cls_grades
           (id, assignment_id, student_id, teacher_id, grade_value,
            is_published, published_at, graded_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 90, true, now(), now())`,
        generateId(),
        assess,
        student.studentId,
        TEST_TEACHER_EMPLOYEE_ID,
      );

      // Drive handle directly with a synthetic published event
      const msg = makeEnvelopeMessage({
        topic: 'cls.grade.published',
        classId: TEST_SIS_CLASS_ID,
        studentId: student.studentId,
      });
      await (worker as any).handle(msg);
      // Force-flush the 30s debounce.
      await worker.flushAllForTest();

      const snap = await rawClient.$queryRawUnsafe<
        Array<{ current_average: string; letter_grade: string; assignments_graded: number; assignments_total: number }>
      >(
        `SELECT current_average::text AS current_average, letter_grade,
                assignments_graded, assignments_total
         FROM ${TEST_SCHEMA}.cls_gradebook_snapshots
         WHERE class_id = $1::uuid AND student_id = $2::uuid`,
        TEST_SIS_CLASS_ID,
        student.studentId,
      );
      expect(snap).toHaveLength(1);
      // Homework=80, weight=40 ; Assessments=90, weight=60
      // weighted sum = 80*40 + 90*60 = 3200 + 5400 = 8600 ; weight_total = 100
      // avg = 86, letter = B
      expect(Number(snap[0]!.current_average)).toBe(86);
      expect(snap[0]!.letter_grade).toBe('B');
      expect(Number(snap[0]!.assignments_graded)).toBe(2);
    });

    it('idempotency claim is recorded after the recompute succeeds (claim-after-success)', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const a = await createPublishedAssignment('OneHW', categoryHomeworkId, 100);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cls_grades
           (id, assignment_id, student_id, teacher_id, grade_value,
            is_published, published_at, graded_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 70, true, now(), now())`,
        generateId(),
        a,
        student.studentId,
        TEST_TEACHER_EMPLOYEE_ID,
      );

      const eventId = generateId();
      const msg = makeEnvelopeMessage({
        topic: 'cls.grade.published',
        eventId,
        classId: TEST_SIS_CLASS_ID,
        studentId: student.studentId,
      });
      await (worker as any).handle(msg);
      await worker.flushAllForTest();

      const claimed = await idempotency.isClaimed('gradebook-snapshot-worker', eventId);
      expect(claimed).toBe(true);
      // Cleanup the platform.platform_event_consumer_idempotency row
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_event_consumer_idempotency WHERE event_id = $1`,
        eventId,
      );
    });

    it('an already-claimed event-id is dropped on arrival — no recompute', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      // Pre-claim the event-id.
      const eventId = generateId();
      await idempotency.claim('gradebook-snapshot-worker', eventId, 'cls.grade.published');

      const msg = makeEnvelopeMessage({
        topic: 'cls.grade.published',
        eventId,
        classId: TEST_SIS_CLASS_ID,
        studentId: student.studentId,
      });
      await (worker as any).handle(msg);
      // No timer queued → flushAllForTest is a no-op.
      await worker.flushAllForTest();

      const snap = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cls_gradebook_snapshots
         WHERE class_id = $1::uuid AND student_id = $2::uuid`,
        TEST_SIS_CLASS_ID,
        student.studentId,
      );
      expect(snap[0]!.count).toBe(0);
      // Cleanup the pre-claim row
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_event_consumer_idempotency WHERE event_id = $1`,
        eventId,
      );
    });

    it('missing routing fields → message dropped with no flush', async () => {
      const msg = makeEnvelopeMessage({
        topic: 'cls.grade.published',
        classId: TEST_SIS_CLASS_ID,
        studentId: '00000000-0000-0000-0000-000000000099',
      });
      // Remove tenant-subdomain header AND the envelope tenant_id so
      // the routing-field check trips.
      msg.headers = {};
      (msg.payload as any).tenant_id = undefined;
      await (worker as any).handle(msg);
      await worker.flushAllForTest();

      const snap = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cls_gradebook_snapshots`,
      );
      expect(snap[0]!.count).toBe(0);
    });

    it('invalid payload (missing classId/studentId) → dropped, no flush', async () => {
      const msg = makeEnvelopeMessage({
        topic: 'cls.grade.published',
        classId: TEST_SIS_CLASS_ID,
        studentId: '00000000-0000-0000-0000-000000000099',
      });
      (msg.payload as any).payload = { foo: 'bar' };
      await (worker as any).handle(msg);
      await worker.flushAllForTest();
      const snap = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cls_gradebook_snapshots`,
      );
      expect(snap[0]!.count).toBe(0);
    });

    it('multiple events on the same (class,student) collapse into a single flush + recompute', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const a = await createPublishedAssignment('Solo', categoryHomeworkId, 100);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cls_grades
           (id, assignment_id, student_id, teacher_id, grade_value,
            is_published, published_at, graded_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 95, true, now(), now())`,
        generateId(),
        a,
        student.studentId,
        TEST_TEACHER_EMPLOYEE_ID,
      );
      const e1 = generateId();
      const e2 = generateId();
      const e3 = generateId();
      await (worker as any).handle(
        makeEnvelopeMessage({
          topic: 'cls.grade.published',
          eventId: e1,
          classId: TEST_SIS_CLASS_ID,
          studentId: student.studentId,
        }),
      );
      await (worker as any).handle(
        makeEnvelopeMessage({
          topic: 'cls.grade.published',
          eventId: e2,
          classId: TEST_SIS_CLASS_ID,
          studentId: student.studentId,
        }),
      );
      await (worker as any).handle(
        makeEnvelopeMessage({
          topic: 'cls.grade.published',
          eventId: e3,
          classId: TEST_SIS_CLASS_ID,
          studentId: student.studentId,
        }),
      );
      await worker.flushAllForTest();

      const snapRows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cls_gradebook_snapshots
         WHERE class_id = $1::uuid AND student_id = $2::uuid`,
        TEST_SIS_CLASS_ID,
        student.studentId,
      );
      expect(snapRows[0]!.count).toBe(1);

      // All three event-ids claimed in bulk after the single successful flush.
      const claims = await rawClient.$queryRawUnsafe<Array<{ event_id: string }>>(
        `SELECT event_id FROM platform.platform_event_consumer_idempotency
         WHERE consumer_group = $1 AND event_id IN ($2, $3, $4)`,
        'gradebook-snapshot-worker',
        e1,
        e2,
        e3,
      );
      expect(claims.length).toBe(3);

      // Cleanup
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_event_consumer_idempotency WHERE event_id IN ($1, $2, $3)`,
        e1,
        e2,
        e3,
      );
    });

    it('every grade unpublished → snapshot row is deleted by recompute', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      // Seed a snapshot directly so we have something to delete.
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cls_gradebook_snapshots
           (id, class_id, student_id, term_id, current_average, letter_grade,
            assignments_graded, assignments_total, last_grade_event_at, last_updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 80.00, 'B', 1, 1, now(), now())`,
        generateId(),
        TEST_SIS_CLASS_ID,
        student.studentId,
        TEST_SIS_TERM_ID,
      );

      // Drive an unpublished event — with NO published grades remaining,
      // recomputeSnapshot must DELETE the stale row.
      const msg = makeEnvelopeMessage({
        topic: 'cls.grade.unpublished',
        classId: TEST_SIS_CLASS_ID,
        studentId: student.studentId,
      });
      await (worker as any).handle(msg);
      await worker.flushAllForTest();

      const after = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cls_gradebook_snapshots
         WHERE class_id = $1::uuid AND student_id = $2::uuid`,
        TEST_SIS_CLASS_ID,
        student.studentId,
      );
      expect(after[0]!.count).toBe(0);

      // Cleanup claim
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_event_consumer_idempotency
         WHERE consumer_group = 'gradebook-snapshot-worker'`,
      );
    });

    it('in-window duplicate eventId is skipped (no timer reset)', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const eventId = generateId();
      await (worker as any).handle(
        makeEnvelopeMessage({
          topic: 'cls.grade.published',
          eventId,
          classId: TEST_SIS_CLASS_ID,
          studentId: student.studentId,
        }),
      );
      // Same eventId → debounce entry already has it, skip path.
      await (worker as any).handle(
        makeEnvelopeMessage({
          topic: 'cls.grade.published',
          eventId,
          classId: TEST_SIS_CLASS_ID,
          studentId: student.studentId,
        }),
      );
      await worker.flushAllForTest();
      const claimed = await idempotency.isClaimed('gradebook-snapshot-worker', eventId);
      expect(claimed).toBe(true);
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_event_consumer_idempotency WHERE event_id = $1`,
        eventId,
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // GradebookService — broader coverage with real snapshot rows
  // ────────────────────────────────────────────────────────────────────
  describe('GradebookService with snapshot rows', () => {
    it('getClassGradebook returns the snapshot for each roster member', async () => {
      const s1 = await trackedStudent({ firstName: 'A', lastName: '1' });
      const s2 = await trackedStudent({ firstName: 'B', lastName: '2' });
      await enrollStudent(rawClient, s1.studentId);
      await enrollStudent(rawClient, s2.studentId);

      // Hydrate a snapshot for s1 only.
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cls_gradebook_snapshots
           (id, class_id, student_id, term_id, current_average, letter_grade,
            assignments_graded, assignments_total, last_grade_event_at, last_updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 92.50, 'A', 5, 6, now(), now())`,
        generateId(),
        TEST_SIS_CLASS_ID,
        s1.studentId,
        TEST_SIS_TERM_ID,
      );

      const resp = await withTestTenant(async () =>
        gradebookService.getClassGradebook(TEST_SIS_CLASS_ID, undefined, adminActor()),
      );
      const s1Row = resp.rows.find((r) => r.student.id === s1.studentId)!;
      const s2Row = resp.rows.find((r) => r.student.id === s2.studentId)!;
      expect(s1Row.snapshot).not.toBeNull();
      expect(s1Row.snapshot!.currentAverage).toBe(92.5);
      expect(s1Row.snapshot!.letterGrade).toBe('A');
      expect(s2Row.snapshot).toBeNull();
    });

    it('getClassGradebook with requestedTermId not found → NotFoundException', async () => {
      const { NotFoundException } = await import('@nestjs/common');
      await expect(
        withTestTenant(async () =>
          gradebookService.getClassGradebook(
            TEST_SIS_CLASS_ID,
            '00000000-0000-0000-0000-000000000000',
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getStudentGradebook returns snapshot per class for the student', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cls_gradebook_snapshots
           (id, class_id, student_id, term_id, current_average, letter_grade,
            assignments_graded, assignments_total, last_grade_event_at, last_updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 75.00, 'C', 2, 5, now(), now())`,
        generateId(),
        TEST_SIS_CLASS_ID,
        student.studentId,
        TEST_SIS_TERM_ID,
      );

      const resp = await withTestTenant(async () =>
        gradebookService.getStudentGradebook(student.studentId, undefined, adminActor()),
      );
      expect(resp.rows).toHaveLength(1);
      expect(resp.rows[0]!.snapshot).not.toBeNull();
      expect(resp.rows[0]!.snapshot!.currentAverage).toBe(75);
      expect(resp.rows[0]!.snapshot!.letterGrade).toBe('C');
    });

    it('getStudentClassGrades returns assignments + grade detail when student is enrolled', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const a = await createPublishedAssignment('Visible HW', categoryHomeworkId);
      await seedSubmission(a, student.studentId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cls_grades
           (id, assignment_id, student_id, teacher_id, grade_value,
            is_published, published_at, graded_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 88, true, now(), now())`,
        generateId(),
        a,
        student.studentId,
        TEST_TEACHER_EMPLOYEE_ID,
      );

      const resp = await withTestTenant(async () =>
        gradebookService.getStudentClassGrades(student.studentId, TEST_SIS_CLASS_ID, adminActor()),
      );
      expect(resp.student.id).toBe(student.studentId);
      expect(resp.assignments).toHaveLength(1);
      expect(resp.assignments[0]!.grade).not.toBeNull();
      expect(resp.assignments[0]!.grade!.gradeValue).toBe(88);
      expect(resp.assignments[0]!.grade!.percentage).toBe(88);
    });

    it('getStudentClassGrades for non-enrolled student → NotFoundException', async () => {
      const { NotFoundException } = await import('@nestjs/common');
      const student = await trackedStudent();
      // no enrollment
      await expect(
        withTestTenant(async () =>
          gradebookService.getStudentClassGrades(
            student.studentId,
            TEST_SIS_CLASS_ID,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('teacher gradebook for a student filters to classes the teacher actually teaches', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      // No sis_class_teachers row → teacher cannot see the student
      // gradebook at all → NotFoundException.
      const { NotFoundException } = await import('@nestjs/common');
      await expect(
        withTestTenant(async () =>
          gradebookService.getStudentGradebook(student.studentId, undefined, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      // After assignment, teacher can see — but only the class they teach.
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, TEST_TEACHER_EMPLOYEE_ID);
      const resp = await withTestTenant(async () =>
        gradebookService.getStudentGradebook(student.studentId, undefined, teacherActor()),
      );
      expect(resp.rows.map((r) => r.class.id)).toEqual([TEST_SIS_CLASS_ID]);
    });
  });
});
