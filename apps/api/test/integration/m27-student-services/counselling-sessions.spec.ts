import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import type { ResolvedActor } from '@modules/m00-platform';

import { SessionService } from '@modules/m27-student-services/counselling/session.service';
import { SessionNoteService } from '@modules/m27-student-services/counselling/session-note.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  TEST_SCHOOL_ID,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  officerActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_OFFICER_EMPLOYEE_ID,
  TEST_OFFICER_ACCOUNT_ID,
  TEST_TEACHER_EMPLOYEE_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { TEST_ACADEMIC_YEAR_ID } from '../fixtures/finance';

/**
 * Wave 3 — DB-backed integration tests for SessionService +
 * SessionNoteService.
 *
 * Strategy doc Wave 3 contracts:
 *   - FERPA KEYSTONE: every SessionNoteService read/write goes through
 *     `assertFerpaAccess`. The dedicated permission code is
 *     `student_counseling_record:read` (the single catalogue entry that
 *     does not follow the XXX-NNN convention — see CLAUDE.md). Held by
 *     Staff (counsellor / VP) + School / Platform Admin only. Teachers,
 *     parents, students NEVER hold it.
 *   - Irreversible lock: SessionNoteService.lock stamps is_locked +
 *     locked_at + locked_by atomically per the multi-column locked_chk.
 *     Subsequent patch() returns BadRequest. No unlock surface.
 *   - Row-scope: SessionService.list / loadOrFail / patch enforce
 *     "non-admin counsellors see only their own sessions" by filtering
 *     on counselor_id = actor.employeeId. patch() locks the row
 *     inside the tx so a stale check cannot race a reassignment.
 *   - UNIQUE invariants: svc_session_participants(session_id, student_id)
 *     + svc_session_notes(session_id, student_id) both rejected with
 *     friendly BadRequest.
 */
describe('integration:m27-student-services/counselling-sessions', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let sessions: SessionService;
  let notes: SessionNoteService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    sessions = new SessionService(tenantPrisma, permCheck);
    notes = new SessionNoteService(tenantPrisma, permCheck, sessions);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  const createdPersonIds: string[] = [];
  const createdPlatformStudentIds: string[] = [];
  const createdStudentIds: string[] = [];
  const createdCaseloadIds: string[] = [];
  const createdSessionIds: string[] = [];

  beforeEach(async () => {
    // Reset IAM perms cache so each test starts clean
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_OFFICER_ACCOUNT_ID,
    );

    // Clean up test artifacts (notes → participants → sessions → caseloads → students cascade)
    if (createdSessionIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.svc_sessions WHERE id = ANY($1::uuid[])`,
        createdSessionIds.splice(0),
      );
    }
    if (createdCaseloadIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.svc_caseloads WHERE id = ANY($1::uuid[])`,
        createdCaseloadIds.splice(0),
      );
    }
    if (createdStudentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = ANY($1::uuid[])`,
        createdStudentIds.splice(0),
      );
    }
    if (createdPlatformStudentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_students WHERE id = ANY($1::uuid[])`,
        createdPlatformStudentIds.splice(0),
      );
    }
    if (createdPersonIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
        createdPersonIds.splice(0),
      );
    }
  });

  async function seedStudent(label: string): Promise<string> {
    const personId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    createdPersonIds.push(personId);
    createdPlatformStudentIds.push(platformStudentId);
    createdStudentIds.push(studentId);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'Sess', $2, 'STUDENT', true)`,
      personId,
      label,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'Sess', $3, true)`,
      platformStudentId,
      personId,
      label,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '9')`,
      studentId,
      platformStudentId,
      TEST_SCHOOL_ID,
      'SESS-TEST-' + studentId.slice(-12),
    );
    return studentId;
  }

  async function seedCaseload(
    studentId: string,
    counselorEmployeeId: string,
  ): Promise<string> {
    const caseloadId = generateId();
    createdCaseloadIds.push(caseloadId);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.svc_caseloads
         (id, school_id, counselor_id, student_id, academic_year_id, primary_concern, opened_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'ACADEMIC', '2025-09-01')`,
      caseloadId,
      TEST_SCHOOL_ID,
      counselorEmployeeId,
      studentId,
      TEST_ACADEMIC_YEAR_ID,
    );
    return caseloadId;
  }

  async function grantOfficerCounsellor(): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_OFFICER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      ['cou-001:write', 'student_counseling_record:read'],
    );
  }

  // Track created sessions for cleanup
  function trackSession(id: string): string {
    createdSessionIds.push(id);
    return id;
  }

  // ────────────────────────────────────────────────────────────────────
  // SessionService.create
  // ────────────────────────────────────────────────────────────────────
  describe('SessionService.create', () => {
    it('admin creates INDIVIDUAL session with primary caseload → ok', async () => {
      const studentId = await seedStudent('IndCreate');
      const caseloadId = await seedCaseload(studentId, TEST_ADMIN_EMPLOYEE_ID);
      const dto = await withTestTenant(async () =>
        sessions.create(
          {
            counselorId: TEST_ADMIN_EMPLOYEE_ID,
            sessionDate: '2026-05-12',
            sessionType: 'INDIVIDUAL' as any,
            primaryCaseloadId: caseloadId,
          },
          adminActor(),
        ),
      );
      trackSession(dto.id);
      expect(dto.status).toBe('SCHEDULED');
      expect(dto.primaryCaseloadId).toBe(caseloadId);
      expect(dto.primaryStudentId).toBe(studentId);
    });

    it('INDIVIDUAL without primaryCaseloadId → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          sessions.create(
            {
              counselorId: TEST_ADMIN_EMPLOYEE_ID,
              sessionDate: '2026-05-12',
              sessionType: 'INDIVIDUAL' as any,
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('GROUP with primaryCaseloadId → BadRequest (must use participants list)', async () => {
      const studentId = await seedStudent('GrpReject');
      const caseloadId = await seedCaseload(studentId, TEST_ADMIN_EMPLOYEE_ID);
      await expect(
        withTestTenant(async () =>
          sessions.create(
            {
              counselorId: TEST_ADMIN_EMPLOYEE_ID,
              sessionDate: '2026-05-12',
              sessionType: 'GROUP' as any,
              primaryCaseloadId: caseloadId,
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('GROUP without primaryCaseloadId → ok', async () => {
      const dto = await withTestTenant(async () =>
        sessions.create(
          {
            counselorId: TEST_ADMIN_EMPLOYEE_ID,
            sessionDate: '2026-05-12',
            sessionType: 'GROUP' as any,
          },
          adminActor(),
        ),
      );
      trackSession(dto.id);
      expect(dto.primaryCaseloadId).toBeNull();
    });

    it('non-admin counsellor creating on a DIFFERENT counsellor\'s calendar → Forbidden', async () => {
      await grantOfficerCounsellor();
      await expect(
        withTestTenant(async () =>
          sessions.create(
            {
              counselorId: TEST_ADMIN_EMPLOYEE_ID, // not officer.employeeId
              sessionDate: '2026-05-12',
              sessionType: 'CRISIS' as any,
            },
            officerActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-admin counsellor creating on their OWN calendar → ok', async () => {
      await grantOfficerCounsellor();
      const dto = await withTestTenant(async () =>
        sessions.create(
          {
            counselorId: TEST_OFFICER_EMPLOYEE_ID,
            sessionDate: '2026-05-12',
            sessionType: 'CRISIS' as any,
          },
          officerActor(),
        ),
      );
      trackSession(dto.id);
      expect(dto.counselorId).toBe(TEST_OFFICER_EMPLOYEE_ID);
    });

    it('unknown primaryCaseloadId → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          sessions.create(
            {
              counselorId: TEST_ADMIN_EMPLOYEE_ID,
              sessionDate: '2026-05-12',
              sessionType: 'INDIVIDUAL' as any,
              primaryCaseloadId: '00000000-0000-0000-0000-000000000000',
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
      ['officer (no cou-001:write)', officerActor],
    ])('create as %s → Forbidden', async (_label, actor) => {
      await expect(
        withTestTenant(async () =>
          sessions.create(
            {
              counselorId: TEST_ADMIN_EMPLOYEE_ID,
              sessionDate: '2026-05-12',
              sessionType: 'CRISIS' as any,
            },
            actor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // SessionService.patch — SELECT FOR UPDATE + non-admin row scope
  // ────────────────────────────────────────────────────────────────────
  describe('SessionService.patch (row-locked transitions)', () => {
    async function createForAdmin(): Promise<string> {
      const dto = await withTestTenant(async () =>
        sessions.create(
          {
            counselorId: TEST_ADMIN_EMPLOYEE_ID,
            sessionDate: '2026-05-12',
            sessionType: 'CRISIS' as any,
          },
          adminActor(),
        ),
      );
      trackSession(dto.id);
      return dto.id;
    }

    it('admin patches SCHEDULED → COMPLETED with notes + duration', async () => {
      const sessionId = await createForAdmin();
      const dto = await withTestTenant(async () =>
        sessions.patch(
          sessionId,
          { status: 'COMPLETED' as any, durationMinutes: 45, notes: 'productive session' },
          adminActor(),
        ),
      );
      expect(dto.status).toBe('COMPLETED');
      expect(dto.durationMinutes).toBe(45);
      expect(dto.notes).toBe('productive session');
    });

    it('non-admin counsellor cannot patch a different counsellor\'s session → Forbidden', async () => {
      const sessionId = await createForAdmin();
      await grantOfficerCounsellor();
      await expect(
        withTestTenant(async () =>
          sessions.patch(sessionId, { status: 'COMPLETED' as any }, officerActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-admin counsellor patches their OWN session → ok', async () => {
      await grantOfficerCounsellor();
      const owned = await withTestTenant(async () =>
        sessions.create(
          {
            counselorId: TEST_OFFICER_EMPLOYEE_ID,
            sessionDate: '2026-05-12',
            sessionType: 'CHECK_IN' as any,
          },
          officerActor(),
        ),
      );
      trackSession(owned.id);
      const dto = await withTestTenant(async () =>
        sessions.patch(owned.id, { status: 'NO_SHOW' as any }, officerActor()),
      );
      expect(dto.status).toBe('NO_SHOW');
    });

    it('patch missing session → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          sessions.patch(
            '00000000-0000-0000-0000-000000000000',
            { status: 'COMPLETED' as any },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('empty patch is a no-op (returns current state)', async () => {
      const sessionId = await createForAdmin();
      const dto = await withTestTenant(async () => sessions.patch(sessionId, {}, adminActor()));
      expect(dto.id).toBe(sessionId);
      expect(dto.status).toBe('SCHEDULED');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // SessionService.list — row-scope visibility
  // ────────────────────────────────────────────────────────────────────
  describe('SessionService.list (visibility)', () => {
    it('admin sees both admin-owned and officer-owned sessions', async () => {
      await grantOfficerCounsellor();
      const adm = await withTestTenant(async () =>
        sessions.create(
          {
            counselorId: TEST_ADMIN_EMPLOYEE_ID,
            sessionDate: '2026-05-12',
            sessionType: 'CRISIS' as any,
          },
          adminActor(),
        ),
      );
      trackSession(adm.id);
      const off = await withTestTenant(async () =>
        sessions.create(
          {
            counselorId: TEST_OFFICER_EMPLOYEE_ID,
            sessionDate: '2026-05-12',
            sessionType: 'CHECK_IN' as any,
          },
          officerActor(),
        ),
      );
      trackSession(off.id);
      const rows = await withTestTenant(async () => sessions.list({}, adminActor()));
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(adm.id);
      expect(ids).toContain(off.id);
    });

    it('non-admin counsellor sees ONLY their own counselor_id sessions', async () => {
      await grantOfficerCounsellor();
      const adm = await withTestTenant(async () =>
        sessions.create(
          {
            counselorId: TEST_ADMIN_EMPLOYEE_ID,
            sessionDate: '2026-05-12',
            sessionType: 'CRISIS' as any,
          },
          adminActor(),
        ),
      );
      trackSession(adm.id);
      const off = await withTestTenant(async () =>
        sessions.create(
          {
            counselorId: TEST_OFFICER_EMPLOYEE_ID,
            sessionDate: '2026-05-12',
            sessionType: 'CHECK_IN' as any,
          },
          officerActor(),
        ),
      );
      trackSession(off.id);
      const rows = await withTestTenant(async () => sessions.list({}, officerActor()));
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(off.id);
      expect(ids).not.toContain(adm.id);
    });

    it('STUDENT actor sees nothing (AND FALSE row scope)', async () => {
      const dto = await withTestTenant(async () =>
        sessions.create(
          {
            counselorId: TEST_ADMIN_EMPLOYEE_ID,
            sessionDate: '2026-05-12',
            sessionType: 'CRISIS' as any,
          },
          adminActor(),
        ),
      );
      trackSession(dto.id);
      const rows = await withTestTenant(async () => sessions.list({}, studentActor()));
      expect(rows).toHaveLength(0);
    });

    it('filter by status returns matching only', async () => {
      const dto = await withTestTenant(async () =>
        sessions.create(
          {
            counselorId: TEST_ADMIN_EMPLOYEE_ID,
            sessionDate: '2026-05-12',
            sessionType: 'CRISIS' as any,
          },
          adminActor(),
        ),
      );
      trackSession(dto.id);
      await withTestTenant(async () =>
        sessions.patch(dto.id, { status: 'COMPLETED' as any }, adminActor()),
      );
      const scheduled = await withTestTenant(async () =>
        sessions.list({ status: 'SCHEDULED' as any }, adminActor()),
      );
      const completed = await withTestTenant(async () =>
        sessions.list({ status: 'COMPLETED' as any }, adminActor()),
      );
      expect(scheduled.map((r) => r.id)).not.toContain(dto.id);
      expect(completed.map((r) => r.id)).toContain(dto.id);
    });

    it('loadOrFail with non-admin actor reading another counsellor\'s session → NotFound (don\'t-leak)', async () => {
      const dto = await withTestTenant(async () =>
        sessions.create(
          {
            counselorId: TEST_ADMIN_EMPLOYEE_ID,
            sessionDate: '2026-05-12',
            sessionType: 'CRISIS' as any,
          },
          adminActor(),
        ),
      );
      trackSession(dto.id);
      await grantOfficerCounsellor();
      await expect(
        withTestTenant(async () => sessions.loadOrFail(dto.id, officerActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // SessionService.addParticipant + markAttendance
  // ────────────────────────────────────────────────────────────────────
  describe('SessionService participants + attendance', () => {
    it('admin adds participant to GROUP session, then marks attendance', async () => {
      const studentId = await seedStudent('PartA');
      const group = await withTestTenant(async () =>
        sessions.create(
          {
            counselorId: TEST_ADMIN_EMPLOYEE_ID,
            sessionDate: '2026-05-12',
            sessionType: 'GROUP' as any,
          },
          adminActor(),
        ),
      );
      trackSession(group.id);
      const p = await withTestTenant(async () =>
        sessions.addParticipant(group.id, { studentId } as any, adminActor()),
      );
      expect(p.studentId).toBe(studentId);
      expect(p.attendanceStatus).toBe('ATTENDED');
      const marked = await withTestTenant(async () =>
        sessions.markAttendance(p.id, { attendanceStatus: 'LATE' as any }, adminActor()),
      );
      expect(marked.attendanceStatus).toBe('LATE');
    });

    it('duplicate addParticipant for the same (session, student) → BadRequest', async () => {
      const studentId = await seedStudent('PartDup');
      const group = await withTestTenant(async () =>
        sessions.create(
          {
            counselorId: TEST_ADMIN_EMPLOYEE_ID,
            sessionDate: '2026-05-12',
            sessionType: 'GROUP' as any,
          },
          adminActor(),
        ),
      );
      trackSession(group.id);
      await withTestTenant(async () =>
        sessions.addParticipant(group.id, { studentId } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          sessions.addParticipant(group.id, { studentId } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-admin counsellor cannot add participant to another counsellor\'s session', async () => {
      const studentId = await seedStudent('PartFor');
      const group = await withTestTenant(async () =>
        sessions.create(
          {
            counselorId: TEST_ADMIN_EMPLOYEE_ID,
            sessionDate: '2026-05-12',
            sessionType: 'GROUP' as any,
          },
          adminActor(),
        ),
      );
      trackSession(group.id);
      await grantOfficerCounsellor();
      await expect(
        withTestTenant(async () =>
          sessions.addParticipant(group.id, { studentId } as any, officerActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('unknown studentId → BadRequest', async () => {
      const group = await withTestTenant(async () =>
        sessions.create(
          {
            counselorId: TEST_ADMIN_EMPLOYEE_ID,
            sessionDate: '2026-05-12',
            sessionType: 'GROUP' as any,
          },
          adminActor(),
        ),
      );
      trackSession(group.id);
      await expect(
        withTestTenant(async () =>
          sessions.addParticipant(
            group.id,
            { studentId: '00000000-0000-0000-0000-000000000000' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('markAttendance on missing participant → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          sessions.markAttendance(
            '00000000-0000-0000-0000-000000000000',
            { attendanceStatus: 'NO_SHOW' as any },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // SessionNoteService — FERPA KEYSTONE + IRREVERSIBLE LOCK
  // ────────────────────────────────────────────────────────────────────
  describe('SessionNoteService (FERPA + irreversible lock)', () => {
    async function setupAdminSessionWithStudent(): Promise<{
      sessionId: string;
      studentId: string;
    }> {
      const studentId = await seedStudent('NoteSub');
      const caseloadId = await seedCaseload(studentId, TEST_ADMIN_EMPLOYEE_ID);
      const session = await withTestTenant(async () =>
        sessions.create(
          {
            counselorId: TEST_ADMIN_EMPLOYEE_ID,
            sessionDate: '2026-05-12',
            sessionType: 'INDIVIDUAL' as any,
            primaryCaseloadId: caseloadId,
          },
          adminActor(),
        ),
      );
      trackSession(session.id);
      return { sessionId: session.id, studentId };
    }

    it('admin creates a note for the primary-caseload student → ok', async () => {
      const { sessionId, studentId } = await setupAdminSessionWithStudent();
      const note = await withTestTenant(async () =>
        notes.create(
          sessionId,
          { studentId, notesText: 'Initial assessment' } as any,
          adminActor(),
        ),
      );
      expect(note.sessionId).toBe(sessionId);
      expect(note.studentId).toBe(studentId);
      expect(note.notesText).toBe('Initial assessment');
      expect(note.isLocked).toBe(false);
    });

    it('STAFF with student_counseling_record:read can read notes for sessions they own', async () => {
      await grantOfficerCounsellor();
      const studentId = await seedStudent('OffStaff');
      const caseloadId = await seedCaseload(studentId, TEST_OFFICER_EMPLOYEE_ID);
      const session = await withTestTenant(async () =>
        sessions.create(
          {
            counselorId: TEST_OFFICER_EMPLOYEE_ID,
            sessionDate: '2026-05-12',
            sessionType: 'INDIVIDUAL' as any,
            primaryCaseloadId: caseloadId,
          },
          officerActor(),
        ),
      );
      trackSession(session.id);
      await withTestTenant(async () =>
        notes.create(
          session.id,
          { studentId, notesText: 'Officer counsellor note' } as any,
          officerActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        notes.listForSession(session.id, officerActor()),
      );
      expect(list).toHaveLength(1);
    });

    it.each([
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
    ])('FERPA gate: %s reading notes → Forbidden with FERPA message', async (_label, actor) => {
      const { sessionId } = await setupAdminSessionWithStudent();
      await expect(
        withTestTenant(async () => notes.listForSession(sessionId, actor())),
      ).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/FERPA/) });
    });

    it('STAFF with cou-001:write but WITHOUT student_counseling_record:read → Forbidden FERPA', async () => {
      // Grant only cou-001:write — counsellor scope passes but FERPA gate fails
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_effective_access_cache
           (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
         ON CONFLICT (account_id, scope_id) DO UPDATE
           SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
        generateId(),
        TEST_OFFICER_ACCOUNT_ID,
        TEST_SCHOOL_SCOPE_ID,
        ['cou-001:write'], // intentionally missing student_counseling_record:read
      );
      const { sessionId } = await setupAdminSessionWithStudent();
      await expect(
        withTestTenant(async () => notes.listForSession(sessionId, officerActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create note with studentId not in session → BadRequest', async () => {
      const { sessionId } = await setupAdminSessionWithStudent();
      const otherStudent = await seedStudent('NotInSess');
      await expect(
        withTestTenant(async () =>
          notes.create(
            sessionId,
            { studentId: otherStudent, notesText: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('UNIQUE(session_id, student_id): second note for same pair → BadRequest', async () => {
      const { sessionId, studentId } = await setupAdminSessionWithStudent();
      await withTestTenant(async () =>
        notes.create(sessionId, { studentId, notesText: 'first' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          notes.create(sessionId, { studentId, notesText: 'second' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch on unlocked note → ok; row stays is_locked=false', async () => {
      const { sessionId, studentId } = await setupAdminSessionWithStudent();
      const note = await withTestTenant(async () =>
        notes.create(sessionId, { studentId, notesText: 'draft' } as any, adminActor()),
      );
      const patched = await withTestTenant(async () =>
        notes.patch(note.id, { notesText: 'revised', followUpRequired: true } as any, adminActor()),
      );
      expect(patched.notesText).toBe('revised');
      expect(patched.followUpRequired).toBe(true);
      expect(patched.isLocked).toBe(false);
    });

    it('lock stamps is_locked + locked_at + locked_by atomically; second lock → BadRequest', async () => {
      const { sessionId, studentId } = await setupAdminSessionWithStudent();
      const note = await withTestTenant(async () =>
        notes.create(sessionId, { studentId, notesText: 'final' } as any, adminActor()),
      );
      const locked = await withTestTenant(async () => notes.lock(note.id, adminActor()));
      expect(locked.isLocked).toBe(true);
      expect(locked.lockedAt).not.toBeNull();
      expect(locked.lockedById).toBe(TEST_ADMIN_EMPLOYEE_ID);

      // Schema locked_chk should be satisfied — all three fields populated
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT is_locked, locked_at, locked_by::text AS locked_by
           FROM ${TEST_SCHEMA}.svc_session_notes WHERE id = $1::uuid`,
        note.id,
      )) as Array<{ is_locked: boolean; locked_at: string; locked_by: string }>;
      expect(rows[0]!.is_locked).toBe(true);
      expect(rows[0]!.locked_at).not.toBeNull();
      expect(rows[0]!.locked_by).toBe(TEST_ADMIN_EMPLOYEE_ID);

      await expect(
        withTestTenant(async () => notes.lock(note.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('IRREVERSIBLE: patch on a locked note → BadRequest "locked and immutable"', async () => {
      const { sessionId, studentId } = await setupAdminSessionWithStudent();
      const note = await withTestTenant(async () =>
        notes.create(sessionId, { studentId, notesText: 'will lock' } as any, adminActor()),
      );
      await withTestTenant(async () => notes.lock(note.id, adminActor()));
      await expect(
        withTestTenant(async () =>
          notes.patch(note.id, { notesText: 'attempt edit after lock' } as any, adminActor()),
        ),
      ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/locked/i) });
    });

    it('lock by actor WITHOUT employeeId (synthetic Platform Admin) → Forbidden', async () => {
      const { sessionId, studentId } = await setupAdminSessionWithStudent();
      const note = await withTestTenant(async () =>
        notes.create(sessionId, { studentId, notesText: 'cannot lock' } as any, adminActor()),
      );
      const adminNoEmployee: ResolvedActor = {
        accountId: TEST_ADMIN_ACCOUNT_ID,
        personId: '019e0cf8-aaaa-7777-8888-000000000010',
        employeeId: null,
        personType: 'STAFF',
        isSchoolAdmin: true,
      };
      await expect(
        withTestTenant(async () => notes.lock(note.id, adminNoEmployee)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lock on missing note → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          notes.lock('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin counsellor cannot patch a note on another counsellor\'s session', async () => {
      const { sessionId, studentId } = await setupAdminSessionWithStudent();
      const note = await withTestTenant(async () =>
        notes.create(sessionId, { studentId, notesText: 'admin owned' } as any, adminActor()),
      );
      await grantOfficerCounsellor();
      await expect(
        withTestTenant(async () =>
          notes.patch(note.id, { notesText: 'hijack' } as any, officerActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById walks parent session row scope: non-owning counsellor → NotFound', async () => {
      const { sessionId, studentId } = await setupAdminSessionWithStudent();
      const note = await withTestTenant(async () =>
        notes.create(sessionId, { studentId, notesText: 'guarded' } as any, adminActor()),
      );
      await grantOfficerCounsellor();
      await expect(
        withTestTenant(async () => notes.getById(note.id, officerActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('no unlock surface exists on SessionNoteService', () => {
      const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(notes))
        .filter((n) => typeof (notes as any)[n] === 'function');
      expect(methodNames).not.toContain('unlock');
    });
  });
});
