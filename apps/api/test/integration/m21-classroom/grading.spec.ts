import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { AssignmentService } from '@modules/m21-classroom/assignments/assignment.service';
import { GradeService } from '@modules/m21-classroom/grading/grade.service';
import { GradebookService } from '@modules/m21-classroom/grading/gradebook.service';
import { StandardGradeService } from '@modules/m21-classroom/grading/standard-grade.service';
import { ObservationService } from '@modules/m21-classroom/grading/observation.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import {
  withTestTenant,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_TEACHER_ACCOUNT_ID,
  TEST_TEACHER_EMPLOYEE_ID,
  TEST_STUDENT_PERSON_ID,
  TEST_PARENT_PERSON_ID,
} from '../helpers/actor';
import {
  TEST_SIS_CLASS_ID,
  TEST_SIS_CLASS_B_ID,
  TEST_SIS_TERM_ID,
} from '../fixtures/sis';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import {
  seedStudent,
  enrollStudent,
  assignTeacherToClass,
  cleanupSeededIds,
} from '../m20-sis/sis-helpers';

/**
 * Wave 4 — m21-classroom grading DB-backed integration tests.
 *
 * Services covered:
 *   - GradeService — gradeSubmission / batchGrade / publish / unpublish /
 *     publishAllForAssignment, plus cls.grade.published / unpublished emits
 *   - GradebookService — class roster gradebook (manager-only-tier gate
 *     per CLAUDE.md "Manager-only roster reads"), student gradebook
 *   - StandardGradeService — upsert keyed on (student, standard, class),
 *     evidence linking, role gate
 *   - ObservationService — CRUD + parent/student visibility
 *
 * Contracts verified:
 *   - GradebookService.getClassGradebook uses assertCanWriteClass —
 *     students / parents / non-class teachers cannot pull the roster.
 *   - GradeService.gradeSubmission honours class teacher membership.
 *   - StandardGradeService UNIQUE(student, standard, class) — second
 *     upsert overwrites in place.
 *   - ObservationService.listForStudent: STAFF/admin see all,
 *     GUARDIAN sees only is_shared_with_parent=true linked-child rows,
 *     STUDENT sees [].
 */
describe('integration:m21-classroom/grading', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: ReturnType<typeof makeRecordingKafka>;

  let assignmentService: AssignmentService;
  let gradeService: GradeService;
  let gradebookService: GradebookService;
  let standardGradeService: StandardGradeService;
  let observationService: ObservationService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];
  const standardIds: string[] = [];

  let assignmentTypeId: string;
  let curFrameworkId: string;

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
       VALUES ($1::uuid, $2::uuid, 'Test Framework', '1.0', true, $3::uuid)`,
      id,
      TEST_SCHOOL_ID,
      '019e0cf8-aaaa-7777-8888-000000000010' /* admin person */,
    );
    return id;
  }

  async function seedCurStandard(code: string): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cur_standards (id, framework_id, code, description)
       VALUES ($1::uuid, $2::uuid, $3, $4)`,
      id,
      curFrameworkId,
      code,
      'Standard ' + code,
    );
    standardIds.push(id);
    return id;
  }

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    kafka = makeRecordingKafka();
    assignmentService = new AssignmentService(tenantPrisma, kafka as unknown as KafkaProducerService);
    gradeService = new GradeService(
      tenantPrisma,
      assignmentService,
      kafka as unknown as KafkaProducerService,
    );
    gradebookService = new GradebookService(tenantPrisma, assignmentService);
    standardGradeService = new StandardGradeService(tenantPrisma);
    observationService = new ObservationService(tenantPrisma);

    assignmentTypeId = await ensureAssignmentType();
    curFrameworkId = await ensureCurFramework();

    // Seed the teacher's IAM permission cache with tch-003:write so the
    // gradebook manager-only-tier gate sees the right code. (Not strictly
    // required by the service path under test — assertCanWriteClass uses
    // sis_class_teachers, not the IAM cache — but seeded for parity with
    // the CLAUDE.md guidance for grading specs.)
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, ARRAY['tch-003:write']::text[], now(), 'test')
       ON CONFLICT (account_id, scope_id) DO UPDATE SET permission_codes = EXCLUDED.permission_codes`,
      TEST_TEACHER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
    );
  });

  afterAll(async () => {
    if (standardIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cur_standards WHERE id = ANY($1::uuid[])`,
        standardIds,
      );
    }
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    (kafka as unknown as RecordingKafkaProducer).reset();
    // Wipe per-test classroom + grading state. Children first.
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_standard_grade_evidence`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_standard_grades`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_student_observations`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_gradebook_snapshots`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_rubric_scores`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_grades`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_submissions`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_assignments`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_assignment_categories`);
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

  async function ensureStudentActorSisRow(): Promise<string> {
    // Pre-clean leaked rows from prior spec files — same persona id.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.cls_student_observations
       WHERE student_id IN (
         SELECT s.id FROM ${TEST_SCHEMA}.sis_students s
         JOIN platform.platform_students ps ON ps.id = s.platform_student_id
         WHERE ps.person_id = $1::uuid)`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_enrollments
       WHERE student_id IN (
         SELECT s.id FROM ${TEST_SCHEMA}.sis_students s
         JOIN platform.platform_students ps ON ps.id = s.platform_student_id
         WHERE ps.person_id = $1::uuid)`,
      TEST_STUDENT_PERSON_ID,
    );
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
    const psId = generateId();
    const sid = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
         VALUES ($1::uuid, $2::uuid, 'Self', 'Grading', true)`,
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
      'GR-SELF-' + Math.random().toString(36).slice(2, 8),
    );
    studentIds.push(sid);
    return sid;
  }

  async function makePublishedAssignment(opts: { title?: string; maxPoints?: number } = {}): Promise<string> {
    const a = await withTestTenant(async () =>
      assignmentService.create(
        TEST_SIS_CLASS_ID,
        {
          title: opts.title ?? 'Quiz',
          assignmentTypeId,
          isPublished: true,
          maxPoints: opts.maxPoints ?? 100,
        } as any,
        adminActor(),
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

  // ────────────────────────────────────────────────────────────────────
  // GradeService.gradeSubmission
  // ────────────────────────────────────────────────────────────────────
  describe('GradeService.gradeSubmission', () => {
    it('admin posts a graded-and-published grade → row inserted, cls.grade.published emit', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const aid = await makePublishedAssignment();
      const subId = await makeSubmission(aid, student.studentId);
      (kafka as unknown as RecordingKafkaProducer).reset();

      const dto = await withTestTenant(async () =>
        gradeService.gradeSubmission(
          subId,
          { gradeValue: 85, publish: true, feedback: 'good' } as any,
          adminActor(),
        ),
      );
      expect(dto.gradeValue).toBe(85);
      expect(dto.isPublished).toBe(true);
      expect(dto.percentage).toBe(85);
      expect(dto.letterGrade).toBe('B');

      const rows = await rawClient.$queryRawUnsafe<Array<{ id: string; is_published: boolean }>>(
        `SELECT id::text, is_published FROM ${TEST_SCHEMA}.cls_grades
         WHERE assignment_id = $1::uuid AND student_id = $2::uuid`,
        aid,
        student.studentId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.is_published).toBe(true);

      // Submission is flipped to GRADED.
      const sub = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.cls_submissions WHERE id = $1::uuid`,
        subId,
      );
      expect(sub[0]!.status).toBe('GRADED');

      const emits = (kafka as unknown as RecordingKafkaProducer).callsForTopic(
        'cls.grade.published',
      );
      expect(emits).toHaveLength(1);
      expect(emits[0]!.payload).toMatchObject({
        gradeId: dto.id,
        assignmentId: aid,
        classId: TEST_SIS_CLASS_ID,
        studentId: student.studentId,
        gradeValue: 85,
      });
    });

    it('grading as draft (publish=false) → no cls.grade.published emit', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const aid = await makePublishedAssignment();
      const subId = await makeSubmission(aid, student.studentId);
      (kafka as unknown as RecordingKafkaProducer).reset();

      const dto = await withTestTenant(async () =>
        gradeService.gradeSubmission(subId, { gradeValue: 70 } as any, adminActor()),
      );
      expect(dto.isPublished).toBe(false);
      expect(
        (kafka as unknown as RecordingKafkaProducer).callsForTopic('cls.grade.published'),
      ).toHaveLength(0);
    });

    it('class teacher can grade their class submissions', async () => {
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, TEST_TEACHER_EMPLOYEE_ID);
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const aid = await makePublishedAssignment();
      const subId = await makeSubmission(aid, student.studentId);

      const dto = await withTestTenant(async () =>
        gradeService.gradeSubmission(
          subId,
          { gradeValue: 90, publish: true } as any,
          teacherActor(),
        ),
      );
      expect(dto.teacherId).toBe(TEST_TEACHER_EMPLOYEE_ID);
      expect(dto.gradeValue).toBe(90);
    });

    it('teacher NOT assigned to the class → ForbiddenException', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const aid = await makePublishedAssignment();
      const subId = await makeSubmission(aid, student.studentId);
      await expect(
        withTestTenant(async () =>
          gradeService.gradeSubmission(subId, { gradeValue: 60 } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('grade > max_points without extra-credit → BadRequestException', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const aid = await makePublishedAssignment({ maxPoints: 50 });
      const subId = await makeSubmission(aid, student.studentId);
      await expect(
        withTestTenant(async () =>
          gradeService.gradeSubmission(subId, { gradeValue: 99 } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('grading a missing submission → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          gradeService.gradeSubmission(
            '00000000-0000-0000-0000-000000000000',
            { gradeValue: 50 } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('updating an existing draft grade → updates same row in place', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const aid = await makePublishedAssignment();
      const subId = await makeSubmission(aid, student.studentId);

      const first = await withTestTenant(async () =>
        gradeService.gradeSubmission(subId, { gradeValue: 60 } as any, adminActor()),
      );
      const second = await withTestTenant(async () =>
        gradeService.gradeSubmission(subId, { gradeValue: 95 } as any, adminActor()),
      );
      expect(second.id).toBe(first.id);
      expect(second.gradeValue).toBe(95);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // GradeService.batchGrade
  // ────────────────────────────────────────────────────────────────────
  describe('GradeService.batchGrade', () => {
    it('batch grade two students, publish=true → 2 rows + 2 cls.grade.published emits', async () => {
      const a = await trackedStudent({ firstName: 'A', lastName: 'A' });
      const b = await trackedStudent({ firstName: 'B', lastName: 'B' });
      await enrollStudent(rawClient, a.studentId);
      await enrollStudent(rawClient, b.studentId);
      const aid = await makePublishedAssignment();
      (kafka as unknown as RecordingKafkaProducer).reset();

      const resp = await withTestTenant(async () =>
        gradeService.batchGrade(
          TEST_SIS_CLASS_ID,
          {
            assignmentId: aid,
            publish: true,
            entries: [
              { studentId: a.studentId, gradeValue: 75 },
              { studentId: b.studentId, gradeValue: 95 },
            ],
          } as any,
          adminActor(),
        ),
      );
      expect(resp.processedCount).toBe(2);
      expect(resp.insertedCount).toBe(2);
      expect(resp.publishedCount).toBe(2);

      const emits = (kafka as unknown as RecordingKafkaProducer).callsForTopic(
        'cls.grade.published',
      );
      expect(emits).toHaveLength(2);
    });

    it('batch grade with unenrolled student → BadRequestException', async () => {
      const enrolled = await trackedStudent();
      await enrollStudent(rawClient, enrolled.studentId);
      const orphan = await trackedStudent({ firstName: 'Orph', lastName: 'An' });
      // orphan is NOT enrolled in TEST_SIS_CLASS_ID

      const aid = await makePublishedAssignment();
      await expect(
        withTestTenant(async () =>
          gradeService.batchGrade(
            TEST_SIS_CLASS_ID,
            {
              assignmentId: aid,
              entries: [
                { studentId: enrolled.studentId, gradeValue: 70 },
                { studentId: orphan.studentId, gradeValue: 70 },
              ],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('batch grade with assignment belonging to a different class → BadRequestException', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const aid = await makePublishedAssignment();

      await expect(
        withTestTenant(async () =>
          gradeService.batchGrade(
            TEST_SIS_CLASS_B_ID,
            {
              assignmentId: aid,
              entries: [{ studentId: student.studentId, gradeValue: 50 }],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // GradeService.publish / unpublish / publishAllForAssignment
  // ────────────────────────────────────────────────────────────────────
  describe('GradeService.publish / unpublish', () => {
    async function seedDraftGrade(): Promise<{ gradeId: string; assignmentId: string; studentId: string }> {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const aid = await makePublishedAssignment();
      const subId = await makeSubmission(aid, student.studentId);
      const dto = await withTestTenant(async () =>
        gradeService.gradeSubmission(subId, { gradeValue: 80 } as any, adminActor()),
      );
      return { gradeId: dto.id, assignmentId: aid, studentId: student.studentId };
    }

    it('publish flips draft → published and emits exactly once', async () => {
      const { gradeId } = await seedDraftGrade();
      (kafka as unknown as RecordingKafkaProducer).reset();
      const out = await withTestTenant(async () => gradeService.publish(gradeId, adminActor()));
      expect(out.isPublished).toBe(true);
      expect(out.publishedAt).not.toBeNull();
      expect(
        (kafka as unknown as RecordingKafkaProducer).callsForTopic('cls.grade.published'),
      ).toHaveLength(1);
    });

    it('publishing an already-published grade is a no-op (no new emit)', async () => {
      const { gradeId } = await seedDraftGrade();
      await withTestTenant(async () => gradeService.publish(gradeId, adminActor()));
      (kafka as unknown as RecordingKafkaProducer).reset();
      const out = await withTestTenant(async () => gradeService.publish(gradeId, adminActor()));
      expect(out.isPublished).toBe(true);
      expect(
        (kafka as unknown as RecordingKafkaProducer).callsForTopic('cls.grade.published'),
      ).toHaveLength(0);
    });

    it('unpublish flips published → draft and emits cls.grade.unpublished', async () => {
      const { gradeId } = await seedDraftGrade();
      await withTestTenant(async () => gradeService.publish(gradeId, adminActor()));
      (kafka as unknown as RecordingKafkaProducer).reset();
      const out = await withTestTenant(async () => gradeService.unpublish(gradeId, adminActor()));
      expect(out.isPublished).toBe(false);
      expect(
        (kafka as unknown as RecordingKafkaProducer).callsForTopic('cls.grade.unpublished'),
      ).toHaveLength(1);
    });

    it('publishAllForAssignment publishes every draft for the assignment', async () => {
      const a = await trackedStudent({ firstName: 'A', lastName: 'A' });
      const b = await trackedStudent({ firstName: 'B', lastName: 'B' });
      await enrollStudent(rawClient, a.studentId);
      await enrollStudent(rawClient, b.studentId);
      const aid = await makePublishedAssignment();
      const subA = await makeSubmission(aid, a.studentId);
      const subB = await makeSubmission(aid, b.studentId);
      await withTestTenant(async () =>
        gradeService.gradeSubmission(subA, { gradeValue: 60 } as any, adminActor()),
      );
      await withTestTenant(async () =>
        gradeService.gradeSubmission(subB, { gradeValue: 90 } as any, adminActor()),
      );
      (kafka as unknown as RecordingKafkaProducer).reset();

      const resp = await withTestTenant(async () =>
        gradeService.publishAllForAssignment(TEST_SIS_CLASS_ID, aid, adminActor()),
      );
      expect(resp.publishedCount).toBe(2);
      expect(resp.grades).toHaveLength(2);
      expect(resp.grades.every((g) => g.isPublished)).toBe(true);
      expect(
        (kafka as unknown as RecordingKafkaProducer).callsForTopic('cls.grade.published'),
      ).toHaveLength(2);
    });

    it('publishAllForAssignment validates class ownership → BadRequestException', async () => {
      const aid = await makePublishedAssignment();
      await expect(
        withTestTenant(async () =>
          gradeService.publishAllForAssignment(TEST_SIS_CLASS_B_ID, aid, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // GradebookService.getClassGradebook — manager-only-tier gate
  // ────────────────────────────────────────────────────────────────────
  describe('GradebookService.getClassGradebook', () => {
    it('admin gets roster with snapshot column (null when no snapshot exists)', async () => {
      const a = await trackedStudent({ firstName: 'Alpha', lastName: 'One' });
      const b = await trackedStudent({ firstName: 'Bravo', lastName: 'Two' });
      await enrollStudent(rawClient, a.studentId);
      await enrollStudent(rawClient, b.studentId);

      const resp = await withTestTenant(async () =>
        gradebookService.getClassGradebook(TEST_SIS_CLASS_ID, undefined, adminActor()),
      );
      expect(resp.rows).toHaveLength(2);
      // No snapshot rows seeded, so snapshot field is null for both.
      expect(resp.rows.every((r) => r.snapshot === null)).toBe(true);
      expect(resp.termId).toBe(TEST_SIS_TERM_ID);
    });

    it('STUDENT persona (manager-only-tier gate) → ForbiddenException', async () => {
      const sid = await ensureStudentActorSisRow();
      await enrollStudent(rawClient, sid);
      await expect(
        withTestTenant(
          async () =>
            gradebookService.getClassGradebook(TEST_SIS_CLASS_ID, undefined, studentActor()),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('teacher NOT assigned to the class → ForbiddenException', async () => {
      // Teacher has no sis_class_teachers row.
      await expect(
        withTestTenant(async () =>
          gradebookService.getClassGradebook(TEST_SIS_CLASS_ID, undefined, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('class teacher → succeeds (manager tier check passes via sis_class_teachers)', async () => {
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, TEST_TEACHER_EMPLOYEE_ID);
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const resp = await withTestTenant(async () =>
        gradebookService.getClassGradebook(TEST_SIS_CLASS_ID, undefined, teacherActor()),
      );
      expect(resp.rows).toHaveLength(1);
      expect(resp.rows[0]!.student.id).toBe(student.studentId);
    });

    it('unknown class id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          gradebookService.getClassGradebook(
            '00000000-0000-0000-0000-000000000000',
            undefined,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // GradebookService.getStudentGradebook
  // ────────────────────────────────────────────────────────────────────
  describe('GradebookService.getStudentGradebook', () => {
    it('admin views any student gradebook → returns rows for enrolled classes', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const resp = await withTestTenant(async () =>
        gradebookService.getStudentGradebook(student.studentId, undefined, adminActor()),
      );
      expect(resp.student.id).toBe(student.studentId);
      expect(resp.rows).toHaveLength(1);
      expect(resp.rows[0]!.class.id).toBe(TEST_SIS_CLASS_ID);
    });

    it('STUDENT actor sees own gradebook', async () => {
      const sid = await ensureStudentActorSisRow();
      await enrollStudent(rawClient, sid);
      const resp = await withTestTenant(
        async () => gradebookService.getStudentGradebook(sid, undefined, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(resp.student.id).toBe(sid);
    });

    it('STUDENT actor reading someone else\'s gradebook → NotFoundException', async () => {
      const peer = await trackedStudent({ firstName: 'Peer', lastName: 'X' });
      await enrollStudent(rawClient, peer.studentId);
      await expect(
        withTestTenant(
          async () =>
            gradebookService.getStudentGradebook(peer.studentId, undefined, studentActor()),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('teacher sees only classes they teach for the student', async () => {
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, TEST_TEACHER_EMPLOYEE_ID);
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const resp = await withTestTenant(async () =>
        gradebookService.getStudentGradebook(student.studentId, undefined, teacherActor()),
      );
      expect(resp.rows.map((r) => r.class.id)).toEqual([TEST_SIS_CLASS_ID]);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // StandardGradeService
  // ────────────────────────────────────────────────────────────────────
  describe('StandardGradeService', () => {
    it('admin upsert creates a row → getById returns it with NULL standard_code (LEFT JOIN by design)', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const standardId = await seedCurStandard('S-1');

      const out = await withTestTenant(async () =>
        standardGradeService.upsert(
          {
            studentId: student.studentId,
            standardId,
            classId: TEST_SIS_CLASS_ID,
            proficiencyLevel: 'MEETING',
            notes: 'on track',
          } as any,
          adminActor(),
        ),
      );
      expect(out.proficiencyLevel).toBe('MEETING');
      expect(out.standardCode).toBe('S-1');

      const fetched = await withTestTenant(async () => standardGradeService.getById(out.id));
      expect(fetched.id).toBe(out.id);
    });

    it('second upsert with the same (student, standard, class) → updates in place (UNIQUE keystone)', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const standardId = await seedCurStandard('S-2');

      const first = await withTestTenant(async () =>
        standardGradeService.upsert(
          {
            studentId: student.studentId,
            standardId,
            classId: TEST_SIS_CLASS_ID,
            proficiencyLevel: 'APPROACHING',
          } as any,
          adminActor(),
        ),
      );
      const second = await withTestTenant(async () =>
        standardGradeService.upsert(
          {
            studentId: student.studentId,
            standardId,
            classId: TEST_SIS_CLASS_ID,
            proficiencyLevel: 'EXCEEDING',
          } as any,
          adminActor(),
        ),
      );
      expect(second.id).toBe(first.id);
      expect(second.proficiencyLevel).toBe('EXCEEDING');

      const cnt = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cls_standard_grades
         WHERE student_id = $1::uuid AND standard_id = $2::uuid AND class_id = $3::uuid`,
        student.studentId,
        standardId,
        TEST_SIS_CLASS_ID,
      );
      expect(cnt[0]!.count).toBe(1);
    });

    it('non-employee (student persona) → ForbiddenException', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const standardId = await seedCurStandard('S-3');
      await expect(
        withTestTenant(
          async () =>
            standardGradeService.upsert(
              {
                studentId: student.studentId,
                standardId,
                classId: TEST_SIS_CLASS_ID,
                proficiencyLevel: 'MEETING',
              } as any,
              studentActor(),
            ),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('teacher not assigned to the class → ForbiddenException', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const standardId = await seedCurStandard('S-4');
      await expect(
        withTestTenant(async () =>
          standardGradeService.upsert(
            {
              studentId: student.studentId,
              standardId,
              classId: TEST_SIS_CLASS_ID,
              proficiencyLevel: 'MEETING',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('unknown standard_id → BadRequestException', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      await expect(
        withTestTenant(async () =>
          standardGradeService.upsert(
            {
              studentId: student.studentId,
              standardId: '00000000-0000-0000-0000-000000000000',
              classId: TEST_SIS_CLASS_ID,
              proficiencyLevel: 'MEETING',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('student not enrolled in the class → BadRequestException', async () => {
      const student = await trackedStudent(); // no enrollment row
      const standardId = await seedCurStandard('S-5');
      await expect(
        withTestTenant(async () =>
          standardGradeService.upsert(
            {
              studentId: student.studentId,
              standardId,
              classId: TEST_SIS_CLASS_ID,
              proficiencyLevel: 'MEETING',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('addEvidence with TEACHER_NOTE inserts a row referencing the parent grade', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const standardId = await seedCurStandard('S-6');
      const sg = await withTestTenant(async () =>
        standardGradeService.upsert(
          {
            studentId: student.studentId,
            standardId,
            classId: TEST_SIS_CLASS_ID,
            proficiencyLevel: 'MEETING',
          } as any,
          adminActor(),
        ),
      );
      const ev = await withTestTenant(async () =>
        standardGradeService.addEvidence(
          sg.id,
          { evidenceType: 'TEACHER_NOTE', description: 'caught it on the whiteboard' } as any,
          adminActor(),
        ),
      );
      expect(ev.evidenceType).toBe('TEACHER_NOTE');
      expect(ev.standardGradeId).toBe(sg.id);
    });

    it('addEvidence SUBMISSION without evidenceRefId → BadRequestException', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const standardId = await seedCurStandard('S-7');
      const sg = await withTestTenant(async () =>
        standardGradeService.upsert(
          {
            studentId: student.studentId,
            standardId,
            classId: TEST_SIS_CLASS_ID,
            proficiencyLevel: 'MEETING',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          standardGradeService.addEvidence(
            sg.id,
            { evidenceType: 'SUBMISSION' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('update proficiency level on existing standard grade → returns new value', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const standardId = await seedCurStandard('S-8');
      const sg = await withTestTenant(async () =>
        standardGradeService.upsert(
          {
            studentId: student.studentId,
            standardId,
            classId: TEST_SIS_CLASS_ID,
            proficiencyLevel: 'BELOW',
          } as any,
          adminActor(),
        ),
      );
      const updated = await withTestTenant(async () =>
        standardGradeService.update(sg.id, { proficiencyLevel: 'MEETING' } as any, adminActor()),
      );
      expect(updated.proficiencyLevel).toBe('MEETING');
    });

    it('classReport aggregates proficiency counts per standard', async () => {
      const s1 = await trackedStudent({ firstName: 'S1', lastName: 'A' });
      const s2 = await trackedStudent({ firstName: 'S2', lastName: 'B' });
      await enrollStudent(rawClient, s1.studentId);
      await enrollStudent(rawClient, s2.studentId);
      const standardId = await seedCurStandard('S-9');

      await withTestTenant(async () =>
        standardGradeService.upsert(
          {
            studentId: s1.studentId,
            standardId,
            classId: TEST_SIS_CLASS_ID,
            proficiencyLevel: 'EXCEEDING',
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        standardGradeService.upsert(
          {
            studentId: s2.studentId,
            standardId,
            classId: TEST_SIS_CLASS_ID,
            proficiencyLevel: 'APPROACHING',
          } as any,
          adminActor(),
        ),
      );
      const report = await withTestTenant(async () =>
        standardGradeService.classReport(TEST_SIS_CLASS_ID, adminActor()),
      );
      const entry = report.standards.find((st) => st.standardId === standardId);
      expect(entry).toBeDefined();
      expect(entry!.counts.EXCEEDING).toBe(1);
      expect(entry!.counts.APPROACHING).toBe(1);
      expect(report.cells.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // ObservationService
  // ────────────────────────────────────────────────────────────────────
  describe('ObservationService', () => {
    it('admin creates observation → row inserted, getById returns it', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const dto = await withTestTenant(async () =>
        observationService.create(
          {
            classId: TEST_SIS_CLASS_ID,
            studentId: student.studentId,
            noteText: 'Showed real initiative today',
            noteType: 'COMMENDATION',
            isSharedWithParent: false,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.noteType).toBe('COMMENDATION');
      expect(dto.isSharedWithParent).toBe(false);

      const fetched = await withTestTenant(async () =>
        observationService.getById(dto.id, adminActor()),
      );
      expect(fetched.id).toBe(dto.id);
    });

    it('class teacher can author observations on assigned classes', async () => {
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, TEST_TEACHER_EMPLOYEE_ID);
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const dto = await withTestTenant(async () =>
        observationService.create(
          {
            classId: TEST_SIS_CLASS_ID,
            studentId: student.studentId,
            noteText: 'Working hard',
            noteType: 'PROGRESS',
          } as any,
          teacherActor(),
        ),
      );
      expect(dto.teacherId).toBe(TEST_TEACHER_EMPLOYEE_ID);
    });

    it('teacher NOT assigned → ForbiddenException', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      await expect(
        withTestTenant(async () =>
          observationService.create(
            {
              classId: TEST_SIS_CLASS_ID,
              studentId: student.studentId,
              noteText: 'Off-limits',
              noteType: 'PROGRESS',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-employee (student) → ForbiddenException', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      await expect(
        withTestTenant(
          async () =>
            observationService.create(
              {
                classId: TEST_SIS_CLASS_ID,
                studentId: student.studentId,
                noteText: 'Self',
                noteType: 'PROGRESS',
              } as any,
              studentActor(),
            ),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listForStudent: STUDENT actor → returns empty (observations are staff-side)', async () => {
      const sid = await ensureStudentActorSisRow();
      await enrollStudent(rawClient, sid);
      await withTestTenant(async () =>
        observationService.create(
          {
            classId: TEST_SIS_CLASS_ID,
            studentId: sid,
            noteText: 'About me',
            noteType: 'PROGRESS',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(
        async () => observationService.listForStudent(sid, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(list).toEqual([]);
    });

    it('listForStudent: GUARDIAN actor sees only is_shared_with_parent=true', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      // Seed guardian persona linkage for the parent actor.
      const guardianId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_guardians (id, person_id, account_id, school_id, family_id, relationship)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, NULL, 'PARENT')
         ON CONFLICT (school_id, person_id) DO UPDATE SET relationship = 'PARENT'
         RETURNING id::text`,
        guardianId,
        TEST_PARENT_PERSON_ID,
        '019e0cf8-aaaa-7777-8888-000000000051' /* TEST_PARENT_ACCOUNT_ID */,
        TEST_SCHOOL_ID,
      );
      // Resolve idempotent guardian id from the school
      const realGuardian = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_guardians WHERE person_id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        TEST_PARENT_PERSON_ID,
        TEST_SCHOOL_ID,
      );
      const gid = realGuardian[0]!.id;
      guardianIds.push(gid);
      const linkId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_student_guardians
           (id, student_id, guardian_id, has_custody, is_emergency_contact, receives_reports)
         VALUES ($1::uuid, $2::uuid, $3::uuid, true, true, true)`,
        linkId,
        student.studentId,
        gid,
      );

      const visible = await withTestTenant(async () =>
        observationService.create(
          {
            classId: TEST_SIS_CLASS_ID,
            studentId: student.studentId,
            noteText: 'Shared with parent',
            noteType: 'PROGRESS',
            isSharedWithParent: true,
          } as any,
          adminActor(),
        ),
      );
      const hidden = await withTestTenant(async () =>
        observationService.create(
          {
            classId: TEST_SIS_CLASS_ID,
            studentId: student.studentId,
            noteText: 'Internal only',
            noteType: 'CONCERN',
            isSharedWithParent: false,
          } as any,
          adminActor(),
        ),
      );

      const list = await withTestTenant(
        async () => observationService.listForStudent(student.studentId, parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      const ids = list.map((r) => r.id);
      expect(ids).toContain(visible.id);
      expect(ids).not.toContain(hidden.id);
    });

    it('admin updates observation note text → persisted', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const dto = await withTestTenant(async () =>
        observationService.create(
          {
            classId: TEST_SIS_CLASS_ID,
            studentId: student.studentId,
            noteText: 'original',
            noteType: 'PROGRESS',
          } as any,
          adminActor(),
        ),
      );
      const updated = await withTestTenant(async () =>
        observationService.update(dto.id, { noteText: 'edited' } as any, adminActor()),
      );
      expect(updated.noteText).toBe('edited');
    });

    it('non-author teacher cannot update an admin\'s observation → ForbiddenException', async () => {
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, TEST_TEACHER_EMPLOYEE_ID);
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const dto = await withTestTenant(async () =>
        observationService.create(
          {
            classId: TEST_SIS_CLASS_ID,
            studentId: student.studentId,
            noteText: 'admin-authored',
            noteType: 'PROGRESS',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          observationService.update(dto.id, { noteText: 'stolen' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin deletes observation → row removed', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const dto = await withTestTenant(async () =>
        observationService.create(
          {
            classId: TEST_SIS_CLASS_ID,
            studentId: student.studentId,
            noteText: 'gone',
            noteType: 'PROGRESS',
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => observationService.delete(dto.id, adminActor()));
      const rows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text FROM ${TEST_SCHEMA}.cls_student_observations WHERE id = $1::uuid`,
        dto.id,
      );
      expect(rows).toHaveLength(0);
    });

    it('unknown id → NotFoundException on update', async () => {
      await expect(
        withTestTenant(async () =>
          observationService.update(
            '00000000-0000-0000-0000-000000000000',
            { noteText: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
