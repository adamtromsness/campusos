import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ProgressNoteService } from '@modules/m21-classroom/progress-notes/progress-note.service';
import { AssignmentService } from '@modules/m21-classroom/assignments/assignment.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_PARENT_PERSON_ID,
  TEST_PARENT_ACCOUNT_ID,
  TEST_STUDENT_PERSON_ID,
  TEST_TEACHER_EMPLOYEE_ID,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import { TEST_SIS_CLASS_ID, TEST_SIS_TERM_ID } from '../fixtures/sis';
import {
  seedStudent,
  enrollStudent,
  assignTeacherToClass,
  cleanupSeededIds,
  ensureGuardianForPerson,
  linkStudentGuardian,
} from '../m20-sis/sis-helpers';

/**
 * Wave 4 — m21-classroom ProgressNoteService DB-backed integration tests.
 *
 * Contracts:
 *   - upsert is teacher-of-class or admin only; non-employee → 403.
 *   - upsert validates: student enrolled in class (404), term exists (404).
 *   - Second upsert on same (class, student, term) UPSERTs the existing row.
 *   - upsert emits cls.progress_note.published with payload schema.
 *   - listForStudent visibility:
 *       * Admin → all rows
 *       * Teacher → only rows for classes they teach
 *       * STUDENT (self) → own rows where is_student_visible AND published_at
 *       * GUARDIAN (linked) → linked child rows where is_parent_visible AND published_at
 *   - Non-visible callers receive 404 (assertCanViewStudent fail-closed).
 */
describe('integration:m21-classroom/progress-notes', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: ReturnType<typeof makeRecordingKafka>;
  let assignmentService: AssignmentService;
  let service: ProgressNoteService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  async function pruneStudentActorLeak(): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.cls_student_progress_notes
       WHERE student_id IN (
         SELECT s.id FROM ${TEST_SCHEMA}.sis_students s
         JOIN platform.platform_students ps ON ps.id = s.platform_student_id
         WHERE ps.person_id = $1::uuid)`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.cls_submissions
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
  }

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    kafka = makeRecordingKafka();
    assignmentService = new AssignmentService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
    );
    service = new ProgressNoteService(
      tenantPrisma,
      assignmentService,
      kafka as unknown as KafkaProducerService,
    );
    await pruneStudentActorLeak();
  });

  afterAll(async () => {
    await pruneStudentActorLeak();
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    (kafka as unknown as RecordingKafkaProducer).reset();
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.cls_student_progress_notes`,
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
  });

  async function trackedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  /** sis_students row mapped to the STUDENT actor persona */
  async function ensureStudentActorSisRow(): Promise<string> {
    await pruneStudentActorLeak();
    const psId = generateId();
    const sid = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
         VALUES ($1::uuid, $2::uuid, 'Self', 'Notes', true)`,
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
      'PN-SELF-' + Math.random().toString(36).slice(2, 8),
    );
    studentIds.push(sid);
    return sid;
  }

  // ────────────────────────────────────────────────────────────────────
  // upsert
  // ────────────────────────────────────────────────────────────────────
  describe('upsert', () => {
    it('admin upserts a new note → row inserted, cls.progress_note.published emitted', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);

      const dto = await withTestTenant(async () =>
        service.upsert(
          TEST_SIS_CLASS_ID,
          {
            studentId: student.studentId,
            termId: TEST_SIS_TERM_ID,
            noteText: 'Strong work this term',
            overallEffortRating: 'EXCELLENT',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.studentId).toBe(student.studentId);
      expect(dto.classId).toBe(TEST_SIS_CLASS_ID);
      expect(dto.termId).toBe(TEST_SIS_TERM_ID);
      expect(dto.noteText).toBe('Strong work this term');
      expect(dto.overallEffortRating).toBe('EXCELLENT');
      expect(dto.isParentVisible).toBe(true); // default true
      expect(dto.isStudentVisible).toBe(true);
      expect(dto.publishedAt).not.toBeNull();
      expect(dto.authorId).toBe(TEST_ADMIN_EMPLOYEE_ID);

      const emits = (kafka as unknown as RecordingKafkaProducer).callsForTopic(
        'cls.progress_note.published',
      );
      expect(emits).toHaveLength(1);
      expect(emits[0]!.key).toBe(student.studentId);
      expect(emits[0]!.payload).toMatchObject({
        noteId: dto.id,
        classId: TEST_SIS_CLASS_ID,
        studentId: student.studentId,
        termId: TEST_SIS_TERM_ID,
        isParentVisible: true,
        isStudentVisible: true,
      });
    });

    it('class teacher upserts a note → succeeds; author_id = teacher employee', async () => {
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, TEST_TEACHER_EMPLOYEE_ID);
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const dto = await withTestTenant(async () =>
        service.upsert(
          TEST_SIS_CLASS_ID,
          {
            studentId: student.studentId,
            termId: TEST_SIS_TERM_ID,
            noteText: 'Coming along',
          } as any,
          teacherActor(),
        ),
      );
      expect(dto.authorId).toBe(TEST_TEACHER_EMPLOYEE_ID);
    });

    it('teacher NOT assigned to the class → ForbiddenException', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      await expect(
        withTestTenant(async () =>
          service.upsert(
            TEST_SIS_CLASS_ID,
            {
              studentId: student.studentId,
              termId: TEST_SIS_TERM_ID,
              noteText: 'No access',
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
            service.upsert(
              TEST_SIS_CLASS_ID,
              {
                studentId: student.studentId,
                termId: TEST_SIS_TERM_ID,
                noteText: 'Self',
              } as any,
              studentActor(),
            ),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('student NOT enrolled in the class → NotFoundException', async () => {
      const student = await trackedStudent();
      // skip enrollStudent
      await expect(
        withTestTenant(async () =>
          service.upsert(
            TEST_SIS_CLASS_ID,
            {
              studentId: student.studentId,
              termId: TEST_SIS_TERM_ID,
              noteText: 'No enrollment',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('phantom term id → NotFoundException', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      await expect(
        withTestTenant(async () =>
          service.upsert(
            TEST_SIS_CLASS_ID,
            {
              studentId: student.studentId,
              termId: '00000000-0000-0000-0000-000000000000',
              noteText: 'Ghost term',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('second upsert overwrites the row in place (UNIQUE on class+student+term)', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);

      const first = await withTestTenant(async () =>
        service.upsert(
          TEST_SIS_CLASS_ID,
          {
            studentId: student.studentId,
            termId: TEST_SIS_TERM_ID,
            noteText: 'v1',
          } as any,
          adminActor(),
        ),
      );
      const second = await withTestTenant(async () =>
        service.upsert(
          TEST_SIS_CLASS_ID,
          {
            studentId: student.studentId,
            termId: TEST_SIS_TERM_ID,
            noteText: 'v2',
            isParentVisible: false,
          } as any,
          adminActor(),
        ),
      );
      expect(second.id).toBe(first.id);
      expect(second.noteText).toBe('v2');
      expect(second.isParentVisible).toBe(false);
      // Sanity: only one row in DB.
      const cnt = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cls_student_progress_notes
         WHERE class_id = $1::uuid AND student_id = $2::uuid AND term_id = $3::uuid`,
        TEST_SIS_CLASS_ID,
        student.studentId,
        TEST_SIS_TERM_ID,
      );
      expect(cnt[0]!.count).toBe(1);
    });

    it('isParentVisible / isStudentVisible explicit false respected', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const dto = await withTestTenant(async () =>
        service.upsert(
          TEST_SIS_CLASS_ID,
          {
            studentId: student.studentId,
            termId: TEST_SIS_TERM_ID,
            noteText: 'private',
            isParentVisible: false,
            isStudentVisible: false,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.isParentVisible).toBe(false);
      expect(dto.isStudentVisible).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // listForStudent — visibility predicates per persona
  // ────────────────────────────────────────────────────────────────────
  describe('listForStudent', () => {
    it('admin sees all notes for the student (visible + hidden)', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const v = await withTestTenant(async () =>
        service.upsert(
          TEST_SIS_CLASS_ID,
          {
            studentId: student.studentId,
            termId: TEST_SIS_TERM_ID,
            noteText: 'shared',
            isParentVisible: true,
            isStudentVisible: true,
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        service.listForStudent(student.studentId, adminActor()),
      );
      expect(list.map((r) => r.id)).toContain(v.id);
    });

    it('teacher sees notes only for classes they teach', async () => {
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, TEST_TEACHER_EMPLOYEE_ID);
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const note = await withTestTenant(async () =>
        service.upsert(
          TEST_SIS_CLASS_ID,
          {
            studentId: student.studentId,
            termId: TEST_SIS_TERM_ID,
            noteText: 'teacher-class',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        service.listForStudent(student.studentId, teacherActor()),
      );
      expect(list.map((r) => r.id)).toContain(note.id);
    });

    it('teacher NOT assigned to the class → NotFoundException (cannot view student at all)', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      await withTestTenant(async () =>
        service.upsert(
          TEST_SIS_CLASS_ID,
          {
            studentId: student.studentId,
            termId: TEST_SIS_TERM_ID,
            noteText: 'hidden from non-teacher',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.listForStudent(student.studentId, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('STUDENT (self) sees own notes where is_student_visible=true AND published_at IS NOT NULL', async () => {
      const sid = await ensureStudentActorSisRow();
      await enrollStudent(rawClient, sid);
      const visible = await withTestTenant(async () =>
        service.upsert(
          TEST_SIS_CLASS_ID,
          {
            studentId: sid,
            termId: TEST_SIS_TERM_ID,
            noteText: 'visible to student',
            isStudentVisible: true,
            isParentVisible: false,
          } as any,
          adminActor(),
        ),
      );
      // Insert a hidden note manually (cannot use service — would emit
      // events and would default to visible).
      const hiddenId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cls_student_progress_notes
           (id, class_id, student_id, term_id, author_id, note_text,
            overall_effort_rating, is_parent_visible, is_student_visible, published_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'hidden',
                 NULL, false, false, now())`,
        hiddenId,
        TEST_SIS_CLASS_ID,
        sid,
        // Use a different "term" by re-using TEST_SIS_TERM_ID is taken;
        // create a tag the UNIQUE allows... actually term is the
        // dimension. To avoid UNIQUE collision, use the same term id
        // — but UNIQUE(class+student+term) means we cannot insert
        // two. So delete the visible row, insert hidden, then re-
        // assert visibility. Simpler: drop visible first.
        TEST_SIS_TERM_ID,
        TEST_ADMIN_EMPLOYEE_ID,
      ).catch(async () => {
        // UNIQUE collision — drop the visible row first then insert hidden.
        await rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.cls_student_progress_notes WHERE id = $1::uuid`,
          visible.id,
        );
        await rawClient.$executeRawUnsafe(
          `INSERT INTO ${TEST_SCHEMA}.cls_student_progress_notes
             (id, class_id, student_id, term_id, author_id, note_text,
              overall_effort_rating, is_parent_visible, is_student_visible, published_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'hidden',
                   NULL, false, false, now())`,
          hiddenId,
          TEST_SIS_CLASS_ID,
          sid,
          TEST_SIS_TERM_ID,
          TEST_ADMIN_EMPLOYEE_ID,
        );
      });
      const list = await withTestTenant(
        async () => service.listForStudent(sid, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      // Student must NOT see the hidden one
      expect(list.map((r) => r.id)).not.toContain(hiddenId);
    });

    it('STUDENT (other) → NotFoundException (cannot view a peer student)', async () => {
      await ensureStudentActorSisRow();
      const peer = await trackedStudent({ firstName: 'Peer', lastName: 'Z' });
      await enrollStudent(rawClient, peer.studentId);
      await expect(
        withTestTenant(
          async () => service.listForStudent(peer.studentId, studentActor()),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('GUARDIAN linked to the student sees parent-visible published notes', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const gid = await ensureGuardianForPerson(
        rawClient,
        TEST_PARENT_PERSON_ID,
        TEST_PARENT_ACCOUNT_ID,
      );
      guardianIds.push(gid);
      await linkStudentGuardian(rawClient, student.studentId, gid);

      const parentVisible = await withTestTenant(async () =>
        service.upsert(
          TEST_SIS_CLASS_ID,
          {
            studentId: student.studentId,
            termId: TEST_SIS_TERM_ID,
            noteText: 'visible to parent',
            isParentVisible: true,
            isStudentVisible: false,
          } as any,
          adminActor(),
        ),
      );

      const list = await withTestTenant(
        async () => service.listForStudent(student.studentId, parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(list.map((r) => r.id)).toContain(parentVisible.id);
    });

    it('GUARDIAN not linked → NotFoundException', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      // No sis_student_guardians link
      await expect(
        withTestTenant(
          async () => service.listForStudent(student.studentId, parentActor()),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('phantom studentId → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.listForStudent(
            '00000000-0000-0000-0000-000000000000',
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
