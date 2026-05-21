import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { FormativeAssessmentService } from '@modules/m21-classroom/assignments/formative-assessment.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

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
 * Wave 4 — m21-classroom FormativeAssessmentService DB-backed integration tests.
 *
 * Contracts:
 *   - create: teacher-of-class or admin; non-employee → 403.
 *   - create: empty questions array → 400.
 *   - update: refused once active; only author/admin can edit.
 *   - activate/close state machine — multi-column active_chk lockstep
 *     (activated_at NOT NULL when is_active=true, closed_at NULL).
 *   - Closed assessments cannot be re-activated.
 *   - submitResponse: STUDENT or admin only; assessment must be active;
 *     student must be enrolled in the class.
 *   - submitResponse UPSERT on (assessment, student) — second submit
 *     overwrites; getResults aggregates response counts per question.
 *   - listForClass: students see ONLY active; staff/admin see all.
 *   - Cross-school isolation: a School B class id is not addressable
 *     from a School A tenant context.
 */
describe('integration:m21-classroom/formative-assessment', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let service: FormativeAssessmentService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  async function pruneStudentActorLeak(): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.cls_formative_responses
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
    service = new FormativeAssessmentService(tenantPrisma);
    await pruneStudentActorLeak();
  });

  afterAll(async () => {
    await pruneStudentActorLeak();
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_formative_responses`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_formative_assessments`);
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
    await pruneStudentActorLeak();
    const psId = generateId();
    const sid = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
         VALUES ($1::uuid, $2::uuid, 'Self', 'Formative', true)`,
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
      'FA-SELF-' + Math.random().toString(36).slice(2, 8),
    );
    studentIds.push(sid);
    return sid;
  }

  async function createDraft(opts: { title?: string; type?: string } = {}) {
    return withTestTenant(async () =>
      service.create(
        {
          classId: TEST_SIS_CLASS_ID,
          title: opts.title ?? 'Exit Ticket Q1',
          assessmentType: (opts.type ?? 'EXIT_TICKET') as any,
          questions: [{ questionId: 'q1', prompt: 'How did it go?', responseType: 'TEXT' }],
        } as any,
        adminActor(),
      ),
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // create
  // ────────────────────────────────────────────────────────────────────
  describe('create', () => {
    it('admin creates a draft assessment', async () => {
      const dto = await createDraft();
      expect(dto.title).toBe('Exit Ticket Q1');
      expect(dto.assessmentType).toBe('EXIT_TICKET');
      expect(dto.questions).toHaveLength(1);
      expect(dto.isActive).toBe(false);
      expect(dto.activatedAt).toBeNull();
      expect(dto.closedAt).toBeNull();
      expect(dto.responseCount).toBe(0);
    });

    it('class teacher creates an assessment → created_by = teacher employee', async () => {
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, TEST_TEACHER_EMPLOYEE_ID);
      const dto = await withTestTenant(async () =>
        service.create(
          {
            classId: TEST_SIS_CLASS_ID,
            title: 'Teacher quiz',
            assessmentType: 'QUICK_CHECK',
            questions: [{ questionId: 'q1', prompt: 'A or B?', responseType: 'TEXT' }],
          } as any,
          teacherActor(),
        ),
      );
      expect(dto.createdBy).toBe(TEST_TEACHER_EMPLOYEE_ID);
    });

    it('teacher NOT in class → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              classId: TEST_SIS_CLASS_ID,
              title: 'Nope',
              assessmentType: 'POLL',
              questions: [{ questionId: 'q1', prompt: 'p', responseType: 'TEXT' }],
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-employee (student) → ForbiddenException', async () => {
      await expect(
        withTestTenant(
          async () =>
            service.create(
              {
                classId: TEST_SIS_CLASS_ID,
                title: 'Selfie',
                assessmentType: 'DO_NOW',
                questions: [{ questionId: 'q1', prompt: 'q', responseType: 'TEXT' }],
              } as any,
              studentActor(),
            ),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin on a phantom class id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              classId: '00000000-0000-0000-0000-000000000000',
              title: 'Ghost',
              assessmentType: 'DO_NOW',
              questions: [{ questionId: 'q1', prompt: 'q', responseType: 'TEXT' }],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('empty questions array → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              classId: TEST_SIS_CLASS_ID,
              title: 'Empty',
              assessmentType: 'EXIT_TICKET',
              questions: [],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // update
  // ────────────────────────────────────────────────────────────────────
  describe('update', () => {
    it('admin updates title on a draft → returns new title', async () => {
      const draft = await createDraft();
      const out = await withTestTenant(async () =>
        service.update(draft.id, { title: 'renamed' } as any, adminActor()),
      );
      expect(out.title).toBe('renamed');
    });

    it('update questions = empty array → BadRequest', async () => {
      const draft = await createDraft();
      await expect(
        withTestTenant(async () =>
          service.update(draft.id, { questions: [] } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-author teacher updating an admin-authored draft → ForbiddenException', async () => {
      const draft = await createDraft();
      await expect(
        withTestTenant(async () =>
          service.update(draft.id, { title: 'stolen' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('update on an ACTIVE assessment → BadRequest', async () => {
      const draft = await createDraft();
      await withTestTenant(async () => service.activate(draft.id, adminActor()));
      await expect(
        withTestTenant(async () =>
          service.update(draft.id, { title: 'too-late' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('empty patch is a no-op', async () => {
      const draft = await createDraft();
      const out = await withTestTenant(async () =>
        service.update(draft.id, {} as any, adminActor()),
      );
      expect(out.id).toBe(draft.id);
    });

    it('phantom id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.update(
            '00000000-0000-0000-0000-000000000000',
            { title: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // activate / close — state machine
  // ────────────────────────────────────────────────────────────────────
  describe('activate / close', () => {
    it('activate flips is_active=true, activated_at set', async () => {
      const draft = await createDraft();
      const out = await withTestTenant(async () => service.activate(draft.id, adminActor()));
      expect(out.isActive).toBe(true);
      expect(out.activatedAt).not.toBeNull();
      expect(out.closedAt).toBeNull();
    });

    it('double-activate → BadRequest', async () => {
      const draft = await createDraft();
      await withTestTenant(async () => service.activate(draft.id, adminActor()));
      await expect(
        withTestTenant(async () => service.activate(draft.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('close flips is_active=false, closed_at set', async () => {
      const draft = await createDraft();
      await withTestTenant(async () => service.activate(draft.id, adminActor()));
      const out = await withTestTenant(async () => service.close(draft.id, adminActor()));
      expect(out.isActive).toBe(false);
      expect(out.closedAt).not.toBeNull();
    });

    it('close on a non-active assessment → BadRequest', async () => {
      const draft = await createDraft();
      await expect(
        withTestTenant(async () => service.close(draft.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('activate after close → BadRequest (cannot re-activate)', async () => {
      const draft = await createDraft();
      await withTestTenant(async () => service.activate(draft.id, adminActor()));
      await withTestTenant(async () => service.close(draft.id, adminActor()));
      await expect(
        withTestTenant(async () => service.activate(draft.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("non-author teacher cannot activate someone else's assessment → ForbiddenException", async () => {
      const draft = await createDraft();
      await expect(
        withTestTenant(async () => service.activate(draft.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('phantom id activate → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.activate('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // submitResponse + getResults
  // ────────────────────────────────────────────────────────────────────
  describe('submitResponse / getResults', () => {
    it('STUDENT submits a response on an active assessment → row inserted', async () => {
      const sid = await ensureStudentActorSisRow();
      await enrollStudent(rawClient, sid);
      const draft = await createDraft();
      await withTestTenant(async () => service.activate(draft.id, adminActor()));

      const dto = await withTestTenant(
        async () =>
          service.submitResponse(draft.id, { responses: { q1: 'Yes' } } as any, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(dto.studentId).toBe(sid);
      expect(dto.responses).toEqual({ q1: 'Yes' });
    });

    it('second submit by same student UPSERTs (no duplicate row)', async () => {
      const sid = await ensureStudentActorSisRow();
      await enrollStudent(rawClient, sid);
      const draft = await createDraft();
      await withTestTenant(async () => service.activate(draft.id, adminActor()));
      await withTestTenant(
        async () =>
          service.submitResponse(draft.id, { responses: { q1: 'first' } } as any, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      const second = await withTestTenant(
        async () =>
          service.submitResponse(draft.id, { responses: { q1: 'second' } } as any, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(second.responses).toEqual({ q1: 'second' });
      const cnt = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cls_formative_responses
         WHERE assessment_id = $1::uuid AND student_id = $2::uuid`,
        draft.id,
        sid,
      );
      expect(cnt[0]!.count).toBe(1);
    });

    it('submit on a CLOSED assessment → BadRequest', async () => {
      const sid = await ensureStudentActorSisRow();
      await enrollStudent(rawClient, sid);
      const draft = await createDraft();
      await withTestTenant(async () => service.activate(draft.id, adminActor()));
      await withTestTenant(async () => service.close(draft.id, adminActor()));
      await expect(
        withTestTenant(
          async () =>
            service.submitResponse(draft.id, { responses: { q1: 'x' } } as any, studentActor()),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('student not enrolled in class → ForbiddenException', async () => {
      await ensureStudentActorSisRow(); // no enroll
      const draft = await createDraft();
      await withTestTenant(async () => service.activate(draft.id, adminActor()));
      await expect(
        withTestTenant(
          async () =>
            service.submitResponse(draft.id, { responses: { q1: 'x' } } as any, studentActor()),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-STUDENT, non-admin actor (teacher) → ForbiddenException', async () => {
      const draft = await createDraft();
      await withTestTenant(async () => service.activate(draft.id, adminActor()));
      await expect(
        withTestTenant(async () =>
          service.submitResponse(draft.id, { responses: {} } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('phantom assessment id → NotFoundException', async () => {
      const sid = await ensureStudentActorSisRow();
      await enrollStudent(rawClient, sid);
      await expect(
        withTestTenant(
          async () =>
            service.submitResponse(
              '00000000-0000-0000-0000-000000000000',
              { responses: {} } as any,
              studentActor(),
            ),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getResults aggregates per-question response counts', async () => {
      const sid = await ensureStudentActorSisRow();
      await enrollStudent(rawClient, sid);
      const peer = await trackedStudent({ firstName: 'P', lastName: '2' });
      await enrollStudent(rawClient, peer.studentId);

      const draft = await withTestTenant(async () =>
        service.create(
          {
            classId: TEST_SIS_CLASS_ID,
            title: 'Two answers',
            assessmentType: 'POLL',
            questions: [{ questionId: 'q1', prompt: 'Pick A or B', responseType: 'TEXT' }],
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => service.activate(draft.id, adminActor()));
      await withTestTenant(
        async () =>
          service.submitResponse(draft.id, { responses: { q1: 'A' } } as any, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      // Peer submission via admin override is blocked (no studentId resolve).
      // Use direct INSERT for the peer's response so we can assert counts.
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cls_formative_responses (id, assessment_id, student_id, responses)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
        generateId(),
        draft.id,
        peer.studentId,
        JSON.stringify({ q1: 'A' }),
      );

      const results = await withTestTenant(async () => service.getResults(draft.id, adminActor()));
      expect(results.totalResponses).toBe(2);
      const q1Summary = results.questionSummaries.find((s) => s.questionId === 'q1')!;
      expect(q1Summary.responseCounts.A).toBe(2);
    });

    it('getResults on phantom id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.getResults('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // listForClass / getById
  // ────────────────────────────────────────────────────────────────────
  describe('listForClass / getById', () => {
    it('admin + staff see all assessments (active + draft)', async () => {
      const draft = await createDraft({ title: 'D1' });
      const active = await createDraft({ title: 'A1' });
      await withTestTenant(async () => service.activate(active.id, adminActor()));

      const list = await withTestTenant(async () =>
        service.listForClass(TEST_SIS_CLASS_ID, adminActor()),
      );
      const ids = list.map((r) => r.id);
      expect(ids).toContain(draft.id);
      expect(ids).toContain(active.id);
    });

    it('STUDENT sees only ACTIVE assessments', async () => {
      const sid = await ensureStudentActorSisRow();
      await enrollStudent(rawClient, sid);
      const draft = await createDraft({ title: 'D1' });
      const active = await createDraft({ title: 'A1' });
      await withTestTenant(async () => service.activate(active.id, adminActor()));

      const list = await withTestTenant(
        async () => service.listForClass(TEST_SIS_CLASS_ID, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      const ids = list.map((r) => r.id);
      expect(ids).toContain(active.id);
      expect(ids).not.toContain(draft.id);
    });

    it('getById phantom → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => service.getById('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // cross-school isolation
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('a School A admin context cannot see assessments seeded against School B class', async () => {
      // Seed an assessment directly under School B's class id.
      const id = generateId();
      // Need an hr_employees row to satisfy created_by — but soft FK,
      // so any UUID is fine.
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cls_formative_assessments
           (id, class_id, created_by, title, assessment_type, questions)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'B-only', 'EXIT_TICKET', '[]'::jsonb)`,
        id,
        TEST_SIS_CLASS_B_ID,
        '019e0cf8-aaaa-7777-8888-000000000099', // arbitrary uuid soft-FK
      );
      // From School A tenant context the listForClass on class A excludes B
      const list = await withTestTenant(async () =>
        service.listForClass(TEST_SIS_CLASS_ID, adminActor()),
      );
      expect(list.map((r) => r.id)).not.toContain(id);
      // Cleanup
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cls_formative_assessments WHERE id = $1::uuid`,
        id,
      );
    });
  });

  // Suppress unused-import warning
  void withTestTenantB;
});
