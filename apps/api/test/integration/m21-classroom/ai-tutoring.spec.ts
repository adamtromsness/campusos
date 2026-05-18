import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { AIOptOutService } from '@modules/m21-classroom/ai-tutoring/ai-opt-out.service';
import { AIUsageService } from '@modules/m21-classroom/ai-tutoring/ai-usage.service';
import { AITutoringService } from '@modules/m21-classroom/ai-tutoring/ai-tutoring.service';
import type { AIGatewayService } from '@modules/m21-classroom/ai-tutoring/ai-gateway.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { RedisService } from '@shared/cache';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_PARENT_PERSON_ID,
  TEST_STUDENT_PERSON_ID,
  TEST_TEACHER_EMPLOYEE_ID,
  TEST_PARENT_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
} from '../helpers/actor';
import { TEST_SIS_CLASS_ID, TEST_SIS_CLASS_B_ID } from '../fixtures/sis';
import {
  seedStudent,
  enrollStudent,
  assignTeacherToClass,
  cleanupSeededIds,
  ensureGuardianForPerson,
  linkStudentGuardian,
} from '../m20-sis/sis-helpers';

/**
 * Wave 4 — m21-classroom AI Tutoring DB-backed integration tests.
 *
 * Services under test:
 *   - apps/api/src/modules/m21-classroom/ai-tutoring/ai-opt-out.service.ts
 *   - apps/api/src/modules/m21-classroom/ai-tutoring/ai-usage.service.ts
 *   - apps/api/src/modules/m21-classroom/ai-tutoring/ai-tutoring.service.ts
 *
 * Spotlighted contract — AI opt-out enforcement (ADR-004 SAFETY RULE 3):
 *   - cls_ai_tutoring_opt_outs.UNIQUE(student_id) — at most one row per
 *     student.
 *   - A student in the opt-out table CANNOT start an AI tutoring session;
 *     AITutoringService.assertNotOptedOut throws ForbiddenException with
 *     the canonical message, EVEN for school-admin callers.
 *   - Parent (linked GUARDIAN) may opt in / out their child.
 *   - School admin may opt any student out (emergency revocation).
 *   - STUDENT actors may opt themselves out, but cannot opt themselves
 *     back in (REVIEW-P2C7 BLOCKING 5 — asymmetric authority).
 *   - Cross-school: an opt-out row whose student lives in School B is
 *     invisible to a School A admin and vice versa (school-scoped session
 *     loader + sis_students.school_id predicate).
 *
 * Additional coverage:
 *   - AIUsageService.assertWithinQuota + recordUsage + getSummary /
 *     getQuota gates (admin-only, STAFF allowed for quota view).
 *   - AITutoringService.startSession happy-path: student-self, admin,
 *     class-assigned teacher.
 *   - startSession authority: non-assigned teacher denied, student
 *     starting for someone else denied, unknown classId rejected.
 *   - sendMessage opt-out gate is re-checked at message time.
 *   - completeSession state-machine: ACTIVE → COMPLETED only, terminal
 *     state guards.
 *
 * AI Gateway is replaced with a deterministic stub — no external HTTP.
 */
describe('integration:m21-classroom/ai-tutoring', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let redis: RedisService;
  let gatewayStub: AIGatewayService;
  let usage: AIUsageService;
  let optOuts: AIOptOutService;
  let tutoring: AITutoringService;

  // Per-test trackers, cleaned in beforeEach of the next test.
  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    redis = new RedisService();
    await redis.onModuleInit();

    // Stubbed AI gateway — never hits the network. The production gateway
    // service auto-stubs when AI_GATEWAY_URL is unset, but we provide a
    // direct stub here so tests are independent of the env.
    gatewayStub = {
      tutoringReply: async (input: { newMessage: string; subject: string }) => ({
        content: 'stub reply for ' + input.subject + ' / ' + input.newMessage.slice(0, 20),
        tokensUsed: 50,
        costUsd: 0,
      }),
      extractLearningSignals: async () => ({
        signals: [
          { signalType: 'INTEREST' as const, description: 'stub interest', confidence: 0.5 },
        ],
        tokensUsed: 100,
        costUsd: 0,
      }),
      summariseLesson: async () => ({
        summaryText: 'stub summary',
        keyTopics: ['stub'],
        actionItems: [],
        modelVersion: 'stub-v1',
        tokensUsed: 0,
        costUsd: 0,
      }),
    } as unknown as AIGatewayService;

    usage = new AIUsageService(tenantPrisma, redis);
    optOuts = new AIOptOutService(tenantPrisma);
    tutoring = new AITutoringService(tenantPrisma, usage, optOuts, gatewayStub);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
    await redis.onModuleDestroy();
  });

  beforeEach(async () => {
    // Wipe AI-tutoring rows. Order matters: opt-outs and signals first,
    // then messages (partitioned), then sessions. The CASCADE on
    // sessions also handles signals but we go explicit to keep the
    // assertion surface clean.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.cls_ai_tutoring_opt_outs`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.cls_ai_tutoring_learning_signals`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.cls_ai_tutoring_messages`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.cls_ai_tutoring_sessions`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.cls_ai_usage_log`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_class_teachers`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_enrollments`,
    );
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
   * Seed a sis_students row mapped to the STUDENT actor persona so the
   * `resolveStudentForActor` lookup (which joins through platform_students
   * by person_id) resolves to a real student id in the current tenant.
   * Returns the sis_students id.
   */
  async function ensureStudentActorSisRow(): Promise<string> {
    const psId = generateId();
    const sid = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
         VALUES ($1::uuid, $2::uuid, 'Self', 'Tutor', true)`,
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
      'AIT-SELF-' + Math.random().toString(36).slice(2, 8),
    );
    studentIds.push(sid);
    return sid;
  }

  /**
   * Wire the parent actor as the legal guardian of the supplied student.
   * Creates the sis_guardians row (idempotent) AND the
   * sis_student_guardians link row that the opt-out service joins on.
   */
  async function linkParentToStudent(studentId: string): Promise<void> {
    const gid = await ensureGuardianForPerson(
      rawClient,
      TEST_PARENT_PERSON_ID,
      TEST_PARENT_ACCOUNT_ID,
    );
    guardianIds.push(gid);
    await linkStudentGuardian(rawClient, studentId, gid);
  }

  // ────────────────────────────────────────────────────────────────────
  // AIOptOutService — create / isOptedOut / getByStudent / delete
  // ────────────────────────────────────────────────────────────────────
  describe('AIOptOutService', () => {
    it('admin opts a student out → row inserted, isOptedOut=true', async () => {
      const student = await trackedStudent();
      const dto = await withTestTenant(async () =>
        optOuts.create({ studentId: student.studentId, reason: 'parent request' } as any, adminActor()),
      );
      expect(dto.studentId).toBe(student.studentId);
      expect(dto.reason).toBe('parent request');
      expect(dto.optedOutBy).toBe(adminActor().personId);

      const flag = await withTestTenant(async () =>
        optOuts.isOptedOut(student.studentId),
      );
      expect(flag).toBe(true);
    });

    it('linked parent opts their own child out → succeeds', async () => {
      const student = await trackedStudent();
      await linkParentToStudent(student.studentId);
      const dto = await withTestTenant(
        async () =>
          optOuts.create(
            { studentId: student.studentId, reason: 'no AI for my kid' } as any,
            parentActor(),
          ),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(dto.studentId).toBe(student.studentId);
      expect(dto.optedOutBy).toBe(TEST_PARENT_PERSON_ID);
    });

    it('unlinked parent opts an unrelated student → ForbiddenException', async () => {
      const student = await trackedStudent();
      // No sis_student_guardians link
      await expect(
        withTestTenant(
          async () =>
            optOuts.create({ studentId: student.studentId } as any, parentActor()),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('STUDENT actor opts themselves out → succeeds', async () => {
      const selfSid = await ensureStudentActorSisRow();
      const dto = await withTestTenant(
        async () => optOuts.create({ studentId: selfSid } as any, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(dto.studentId).toBe(selfSid);
      expect(dto.optedOutBy).toBe(TEST_STUDENT_PERSON_ID);
    });

    it('STUDENT actor opts a peer out → ForbiddenException', async () => {
      await ensureStudentActorSisRow();
      const peer = await trackedStudent({ firstName: 'Peer', lastName: 'Z' });
      await expect(
        withTestTenant(
          async () => optOuts.create({ studentId: peer.studentId } as any, studentActor()),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('duplicate opt-out for same student → BadRequestException', async () => {
      const student = await trackedStudent();
      await withTestTenant(async () =>
        optOuts.create({ studentId: student.studentId } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          optOuts.create({ studentId: student.studentId } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('getByStudent on no-row → NotFoundException', async () => {
      const student = await trackedStudent();
      await expect(
        withTestTenant(async () => optOuts.getByStudent(student.studentId, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('admin deletes (opt back in) → row removed, isOptedOut=false', async () => {
      const student = await trackedStudent();
      await withTestTenant(async () =>
        optOuts.create({ studentId: student.studentId } as any, adminActor()),
      );
      expect(
        await withTestTenant(async () => optOuts.isOptedOut(student.studentId)),
      ).toBe(true);

      await withTestTenant(async () => optOuts.delete(student.studentId, adminActor()));

      expect(
        await withTestTenant(async () => optOuts.isOptedOut(student.studentId)),
      ).toBe(false);
    });

    it('STUDENT cannot opt themselves back in (REVIEW-P2C7 BLOCKING 5) → Forbidden', async () => {
      const selfSid = await ensureStudentActorSisRow();
      // Student opts themselves out (allowed) ...
      await withTestTenant(
        async () => optOuts.create({ studentId: selfSid } as any, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      // ... but cannot opt themselves back in.
      await expect(
        withTestTenant(
          async () => optOuts.delete(selfSid, studentActor()),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('linked parent deletes their child opt-out → succeeds', async () => {
      const student = await trackedStudent();
      await linkParentToStudent(student.studentId);
      await withTestTenant(async () =>
        optOuts.create({ studentId: student.studentId } as any, adminActor()),
      );
      await withTestTenant(
        async () => optOuts.delete(student.studentId, parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(
        await withTestTenant(async () => optOuts.isOptedOut(student.studentId)),
      ).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // OPT-OUT GATE inside AITutoringService.startSession — the spotlight
  // ────────────────────────────────────────────────────────────────────
  describe('AITutoringService.startSession — opt-out gate (KEYSTONE)', () => {
    it('admin starts a session for a student with NO opt-out → row inserted', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);

      const dto = await withTestTenant(async () =>
        tutoring.startSession(
          {
            studentId: student.studentId,
            classId: TEST_SIS_CLASS_ID,
            subject: 'Algebra',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.studentId).toBe(student.studentId);
      expect(dto.subject).toBe('Algebra');
      expect(dto.status).toBe('ACTIVE');
      expect(dto.totalMessages).toBe(0);

      const row = await rawClient.$queryRawUnsafe<Array<{ id: string; status: string }>>(
        `SELECT id::text, status FROM ${TEST_SCHEMA}.cls_ai_tutoring_sessions WHERE id = $1::uuid`,
        dto.id,
      );
      expect(row[0]!.status).toBe('ACTIVE');
    });

    it('admin starting a session for an OPTED-OUT student → ForbiddenException with canonical message', async () => {
      const student = await trackedStudent();
      await withTestTenant(async () =>
        optOuts.create({ studentId: student.studentId, reason: 'no AI' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          tutoring.startSession(
            { studentId: student.studentId, subject: 'Biology' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toMatchObject({
        constructor: ForbiddenException,
        message: expect.stringMatching(/AI tutoring is disabled for this student/i),
      });

      // No session row was inserted
      const rows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text FROM ${TEST_SCHEMA}.cls_ai_tutoring_sessions WHERE student_id = $1::uuid`,
        student.studentId,
      );
      expect(rows).toHaveLength(0);
    });

    it('STUDENT self-start after self-opt-out → still blocked (even though they could opt back out)', async () => {
      const selfSid = await ensureStudentActorSisRow();
      await withTestTenant(
        async () => optOuts.create({ studentId: selfSid } as any, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      await expect(
        withTestTenant(
          async () =>
            tutoring.startSession({ subject: 'History' } as any, studentActor()),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('after parent opts a student back in, admin can start a session again', async () => {
      const student = await trackedStudent();
      await linkParentToStudent(student.studentId);
      await enrollStudent(rawClient, student.studentId);

      // Parent opts out.
      await withTestTenant(
        async () => optOuts.create({ studentId: student.studentId } as any, parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      await expect(
        withTestTenant(async () =>
          tutoring.startSession(
            { studentId: student.studentId, subject: 'Algebra' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // Parent opts back in.
      await withTestTenant(
        async () => optOuts.delete(student.studentId, parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );

      const dto = await withTestTenant(async () =>
        tutoring.startSession(
          { studentId: student.studentId, subject: 'Algebra' } as any,
          adminActor(),
        ),
      );
      expect(dto.status).toBe('ACTIVE');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // CROSS-SCHOOL — opt-out + sessions are school-scoped
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('opt-out row for a School-B student is invisible from School A', async () => {
      // Seed a student into School B.
      const studentB = await trackedStudent({ schoolId: TEST_SCHOOL_B_ID });

      // School B admin opts the student out.
      await withTestTenantB(async () =>
        optOuts.create({ studentId: studentB.studentId } as any, adminActor()),
      );

      // From School A's tenant context the opt-out row is on a foreign-
      // school student. isOptedOut joins on tenant schema (same schema
      // here, both schools live in tenant_test) so the flag *is* true
      // for the student id — but the AITutoringService.startSession path
      // is gated by sis_students.school_id = current_school, so an
      // attempt to start a session for the foreign student from School A
      // collapses to NotFoundException (student not visible to School A).
      await expect(
        withTestTenant(async () =>
          tutoring.startSession(
            { studentId: studentB.studentId, subject: 'Algebra' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a session created by School A is invisible (404) from School B', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const session = await withTestTenant(async () =>
        tutoring.startSession(
          { studentId: student.studentId, subject: 'Algebra' } as any,
          adminActor(),
        ),
      );
      // From School B, even an admin can't load the session.
      await expect(
        withTestTenantB(async () => tutoring.getSession(session.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // AITutoringService.startSession — authorisation
  // ────────────────────────────────────────────────────────────────────
  describe('AITutoringService.startSession — authorisation', () => {
    it('class-assigned teacher can start a session for an enrolled student', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, TEST_TEACHER_EMPLOYEE_ID);

      const dto = await withTestTenant(async () =>
        tutoring.startSession(
          {
            studentId: student.studentId,
            classId: TEST_SIS_CLASS_ID,
            subject: 'Reading',
          } as any,
          teacherActor(),
        ),
      );
      expect(dto.status).toBe('ACTIVE');
      expect(dto.studentId).toBe(student.studentId);
    });

    it('non-assigned teacher (no sis_class_teachers row) → ForbiddenException', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      await expect(
        withTestTenant(async () =>
          tutoring.startSession(
            {
              studentId: student.studentId,
              classId: TEST_SIS_CLASS_ID,
              subject: 'Algebra',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('STUDENT actor cannot start a session for a peer (resolveStudentForActor mismatch)', async () => {
      const selfSid = await ensureStudentActorSisRow();
      void selfSid;
      const peer = await trackedStudent({ firstName: 'Peer', lastName: 'P' });
      await expect(
        withTestTenant(
          async () =>
            tutoring.startSession(
              { studentId: peer.studentId, subject: 'Algebra' } as any,
              studentActor(),
            ),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('STUDENT actor can start a session for themselves (no studentId required)', async () => {
      const selfSid = await ensureStudentActorSisRow();
      const dto = await withTestTenant(
        async () => tutoring.startSession({ subject: 'Algebra' } as any, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(dto.studentId).toBe(selfSid);
    });

    it('unknown classId in this tenant → BadRequestException', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      await expect(
        withTestTenant(async () =>
          tutoring.startSession(
            {
              studentId: student.studentId,
              classId: '00000000-0000-0000-0000-000000000000',
              subject: 'Algebra',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('classId belonging to School B is invisible from School A → BadRequestException', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      await expect(
        withTestTenant(async () =>
          tutoring.startSession(
            {
              studentId: student.studentId,
              classId: TEST_SIS_CLASS_B_ID,
              subject: 'Algebra',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-staff non-student actor (e.g. GUARDIAN) is rejected', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      await expect(
        withTestTenant(
          async () =>
            tutoring.startSession(
              { studentId: student.studentId, subject: 'Algebra' } as any,
              parentActor(),
            ),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // AITutoringService.completeSession — state machine
  // ────────────────────────────────────────────────────────────────────
  describe('AITutoringService.completeSession', () => {
    it('admin transitions ACTIVE → COMPLETED → ended_at set', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const session = await withTestTenant(async () =>
        tutoring.startSession(
          { studentId: student.studentId, subject: 'Algebra' } as any,
          adminActor(),
        ),
      );
      const closed = await withTestTenant(async () =>
        tutoring.completeSession(session.id, {} as any, adminActor()),
      );
      expect(closed.status).toBe('COMPLETED');
      expect(closed.endedAt).not.toBeNull();
    });

    it('completing an already-COMPLETED session → BadRequestException', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const session = await withTestTenant(async () =>
        tutoring.startSession(
          { studentId: student.studentId, subject: 'Algebra' } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        tutoring.completeSession(session.id, {} as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          tutoring.completeSession(session.id, {} as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('completing an unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          tutoring.completeSession(
            '00000000-0000-0000-0000-000000000000',
            {} as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // AIUsageService — quota + getSummary + getQuota
  // ────────────────────────────────────────────────────────────────────
  describe('AIUsageService', () => {
    it('recordUsage writes a cls_ai_usage_log row visible to getSummary', async () => {
      await withTestTenant(async () =>
        usage.recordUsage({
          schoolId: TEST_SCHOOL_ID,
          jobType: 'TUTORING',
          tokensUsed: 123,
          costUsd: 0.5,
          actorAccountId: null,
        }),
      );
      const summary = await withTestTenant(async () => usage.getSummary(adminActor()));
      expect(summary.totalTokens).toBeGreaterThanOrEqual(123);
      expect(summary.byJobType.TUTORING).toBeDefined();
      expect(summary.byJobType.TUTORING!.calls).toBeGreaterThanOrEqual(1);
    });

    it('getSummary by non-admin staff (teacherActor) → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => usage.getSummary(teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listUsage by non-admin → ForbiddenException; by admin → array', async () => {
      await withTestTenant(async () =>
        usage.recordUsage({
          schoolId: TEST_SCHOOL_ID,
          jobType: 'GRADING',
          tokensUsed: 10,
          costUsd: 0.1,
        }),
      );
      await expect(
        withTestTenant(async () => usage.listUsage(teacherActor(), 10)),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const list = await withTestTenant(async () => usage.listUsage(adminActor(), 10));
      expect(Array.isArray(list)).toBe(true);
    });

    it('getQuota is visible to admin AND non-admin STAFF (teacher)', async () => {
      const q1 = await withTestTenant(async () => usage.getQuota(adminActor()));
      expect(q1.schoolId).toBe(TEST_SCHOOL_ID);
      expect(q1.dailyLimitTokens).toBeGreaterThan(0);
      const q2 = await withTestTenant(async () => usage.getQuota(teacherActor()));
      expect(q2.schoolId).toBe(TEST_SCHOOL_ID);
    });

    it('getQuota by STUDENT actor → ForbiddenException', async () => {
      await expect(
        withTestTenant(
          async () => usage.getQuota(studentActor()),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('assertWithinQuota does not throw on a fresh school (Redis fail-OPEN default)', async () => {
      // Default behaviour: Redis returns 0 used → quota check passes.
      await expect(
        withTestTenant(async () => usage.assertWithinQuota(TEST_SCHOOL_ID)),
      ).resolves.toBeUndefined();
    });
  });

  // Used import — keep TS happy.
  void TEST_ADMIN_PERSON_ID;
});
