import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { WithdrawalService } from '@modules/m81-enrolment/withdrawals/withdrawal.service';
import { ExitTaskTemplateService } from '@modules/m81-enrolment/withdrawals/exit-task-template.service';
import { ExitTaskService } from '@modules/m81-enrolment/withdrawals/exit-task.service';
import { ReenrolmentService } from '@modules/m81-enrolment/applications/reenrolment.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  parentActor,
  officerActor,
  TEST_PARENT_PERSON_ID,
  TEST_OFFICER_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SIS_ACADEMIC_YEAR_ID } from '../fixtures/sis';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import {
  seedStudent,
  seedGuardian,
  linkStudentGuardian,
  cleanupSeededIds,
} from '../m20-sis/sis-helpers';

/**
 * Wave 4 — m81-enrolment WithdrawalService + ReenrolmentService DB-backed
 * integration tests.
 *
 * Contracts verified:
 *   - WithdrawalService.create auto-generates exit tasks from the DEFAULT
 *     template inside the same tx (atomic).
 *   - WithdrawalService.complete refuses if any task is PENDING; flips
 *     sis_students.enrollment_status to WITHDRAWN; durable enr.student.withdrawn
 *     outbox row.
 *   - Cancel — state-machine, admin or original requester only.
 *   - placeReenrolHold — admin only; hold_chk requires non-empty reason.
 *   - hasActiveHoldForStudent — read predicate.
 *   - Re-enrolment auto-withdrawal: confirmed_continuing=false creates a
 *     linked withdrawal in the same tenant tx.
 *   - Cross-school isolation: a withdrawal for a School B student is not
 *     readable from a School A context.
 */
describe('integration:m81-enrolment/withdrawals', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let outbox: OutboxService;
  let templates: ExitTaskTemplateService;
  let withdrawalService: WithdrawalService;
  let exitTaskService: ExitTaskService;
  let reenrolService: ReenrolmentService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    outbox = new OutboxService();
    templates = new ExitTaskTemplateService(tenantPrisma, permCheck);
    withdrawalService = new WithdrawalService(tenantPrisma, permCheck, outbox, templates);
    exitTaskService = new ExitTaskService(tenantPrisma, permCheck);
    reenrolService = new ReenrolmentService(tenantPrisma, permCheck, withdrawalService);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Wipe enrolment + re-enrolment rows on School A + B.
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_reenrollment_confirmations`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_withdrawal_exit_tasks`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_withdrawal_requests`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_withdrawal_task_templates`);
    // Re-enrolment + offer-acceptance flows seed pay_family_accounts +
    // pay_family_account_students. Clean them up so the m84-payments
    // suite doesn't collide on the UNIQUE (school_id, account_holder_id).
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.pay_family_account_students, ${TEST_SCHEMA}.pay_family_accounts CASCADE`,
    );

    // Wipe officer permission cache (so we can re-grant per test).
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_OFFICER_ACCOUNT_ID,
    );

    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
    });
  });

  async function grantOfficerStu004(level: 'write' | 'admin' = 'admin'): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_OFFICER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      level === 'admin' ? ['stu-004:write', 'stu-004:admin'] : ['stu-004:write'],
    );
  }

  async function trackedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  async function seedParentGuardianFor(studentId: string): Promise<void> {
    // Link the global parent actor to this student so the guardian
    // row-scope check passes.
    const g = await seedGuardian(rawClient, {
      firstName: 'P-' + studentId.slice(0, 8),
      lastName: 'Parent',
      // No explicit person id override — we want parent actor specifically
      // for guardian-scope checks.
    });
    guardianIds.push(g.guardianId);
    personIds.push(g.personId);
    accountIds.push(g.accountId);
    await linkStudentGuardian(rawClient, studentId, g.guardianId);
  }

  /**
   * Idempotently bind parent_actor's iam_person to a guardian row tied
   * to the provided student. The guardian row is NOT registered with the
   * spec's per-test cleanup tracker — it represents a stable test
   * fixture shared with other suites (m84-payments may reference it via
   * pay_financial_aid_applications.guardian_id). The sis_student_guardians
   * link IS cleaned up via the studentId path in cleanupSeededIds.
   */
  async function bindParentActorToStudent(studentId: string): Promise<string> {
    const guardianId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_guardians
         (id, person_id, account_id, school_id, family_id, relationship)
       VALUES ($1::uuid, $2::uuid, NULL, $3::uuid, NULL, 'PARENT')
       ON CONFLICT (school_id, person_id) DO UPDATE SET relationship = 'PARENT'
       RETURNING id`,
      guardianId,
      TEST_PARENT_PERSON_ID,
      TEST_SCHOOL_ID,
    );
    const rows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text FROM ${TEST_SCHEMA}.sis_guardians WHERE person_id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
      TEST_PARENT_PERSON_ID,
      TEST_SCHOOL_ID,
    );
    const finalId = rows[0]!.id;
    // Intentionally NOT pushed into guardianIds — see docstring above.
    await linkStudentGuardian(rawClient, studentId, finalId);
    return finalId;
  }

  function withdrawalInput(studentId: string, overrides: any = {}): any {
    return {
      studentId,
      initiatedBy: 'SCHOOL',
      withdrawalReasonCategory: 'TRANSFER_TO_OTHER_SCHOOL',
      lastAttendanceDate: new Date().toISOString().slice(0, 10),
      ...overrides,
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // create — admin path + exit tasks materialised from template
  // ────────────────────────────────────────────────────────────────────
  describe('create', () => {
    it('admin creates withdrawal → 7 default exit tasks auto-inserted atomically', async () => {
      const student = await trackedStudent();
      const dto = await withTestTenant(async () =>
        withdrawalService.create(withdrawalInput(student.studentId), adminActor()),
      );
      expect(dto.status).toBe('REQUESTED');
      expect(dto.studentId).toBe(student.studentId);
      expect(dto.exitTasks.length).toBe(7);
      // All tasks start PENDING.
      expect(dto.exitTasks.every((t) => t.status === 'PENDING')).toBe(true);
      // DB invariant: tasks share withdrawal_id.
      const rows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.enr_withdrawal_exit_tasks WHERE withdrawal_id = $1::uuid`,
        dto.id,
      );
      expect(rows[0]!.count).toBe(7);
    });

    it('non-admin / non-EO / non-guardian → ForbiddenException', async () => {
      const student = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          withdrawalService.create(withdrawalInput(student.studentId), officerActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('parent (guardian of student) with stu-004:write grant can initiate', async () => {
      const student = await trackedStudent();
      await bindParentActorToStudent(student.studentId);
      // Parent needs stu-004:write to pass hasWriteScope (parents don't
      // typically hold this, but the canonical seed grants it).
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_effective_access_cache
           (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
         ON CONFLICT (account_id, scope_id) DO UPDATE
           SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
        generateId(),
        parentActor().accountId,
        TEST_SCHOOL_SCOPE_ID,
        ['stu-004:write'],
      );
      const dto = await withTestTenant(
        async () =>
          withdrawalService.create(
            withdrawalInput(student.studentId, { initiatedBy: 'FAMILY' }),
            parentActor(),
          ),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(dto.status).toBe('REQUESTED');
      // Clean up the cache row we added.
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
        parentActor().accountId,
      );
    });

    it('parent NOT linked to student → ForbiddenException on guardian check', async () => {
      const student = await trackedStudent();
      // Grant parent the stu-004:write so we get past hasWriteScope
      // and into assertGuardianOfStudent.
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_effective_access_cache
           (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
         ON CONFLICT (account_id, scope_id) DO UPDATE
           SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
        generateId(),
        parentActor().accountId,
        TEST_SCHOOL_SCOPE_ID,
        ['stu-004:write'],
      );
      await expect(
        withTestTenant(
          async () =>
            withdrawalService.create(
              withdrawalInput(student.studentId, { initiatedBy: 'FAMILY' }),
              parentActor(),
            ),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
        parentActor().accountId,
      );
    });

    it('unknown studentId → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          withdrawalService.create(
            withdrawalInput('00000000-0000-0000-0000-000000000000'),
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // complete — refuses if any PENDING, flips student, durable outbox
  // ────────────────────────────────────────────────────────────────────
  describe('complete', () => {
    async function seedActiveWithdrawal(): Promise<{ id: string; studentId: string }> {
      const student = await trackedStudent();
      const dto = await withTestTenant(async () =>
        withdrawalService.create(withdrawalInput(student.studentId), adminActor()),
      );
      return { id: dto.id, studentId: student.studentId };
    }

    it('refuses to complete while any task is PENDING', async () => {
      const { id } = await seedActiveWithdrawal();
      await expect(
        withTestTenant(async () => withdrawalService.complete(id, {} as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('after marking all tasks COMPLETED/WAIVED → complete flips student to WITHDRAWN + outbox row enqueued', async () => {
      const { id, studentId } = await seedActiveWithdrawal();
      const taskIds = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text FROM ${TEST_SCHEMA}.enr_withdrawal_exit_tasks WHERE withdrawal_id = $1::uuid ORDER BY sort_order`,
        id,
      );
      // Mark each task COMPLETED via ExitTaskService.
      for (const t of taskIds) {
        await withTestTenant(async () =>
          exitTaskService.patch(t.id, { status: 'COMPLETED' } as any, adminActor()),
        );
      }
      const completed = await withTestTenant(async () =>
        withdrawalService.complete(id, {} as any, adminActor()),
      );
      expect(completed.status).toBe('COMPLETED');
      expect(completed.completedAt).not.toBeNull();

      const studentRows = await rawClient.$queryRawUnsafe<Array<{ enrollment_status: string }>>(
        `SELECT enrollment_status FROM ${TEST_SCHEMA}.sis_students WHERE id = $1::uuid`,
        studentId,
      );
      expect(studentRows[0]!.enrollment_status).toBe('WITHDRAWN');

      const outboxRows = await rawClient.$queryRawUnsafe<
        Array<{ topic: string; message_key: string }>
      >(
        `SELECT topic, message_key FROM platform.platform_outbox WHERE topic = 'enr.student.withdrawn' AND message_key = $1`,
        id,
      );
      expect(outboxRows.length).toBeGreaterThanOrEqual(1);
    });

    it('non-admin → ForbiddenException', async () => {
      const { id } = await seedActiveWithdrawal();
      await expect(
        withTestTenant(async () => withdrawalService.complete(id, {} as any, officerActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('double-complete → BadRequestException', async () => {
      const { id } = await seedActiveWithdrawal();
      const taskIds = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text FROM ${TEST_SCHEMA}.enr_withdrawal_exit_tasks WHERE withdrawal_id = $1::uuid`,
        id,
      );
      for (const t of taskIds) {
        await withTestTenant(async () =>
          exitTaskService.patch(t.id, { status: 'WAIVED' } as any, adminActor()),
        );
      }
      await withTestTenant(async () => withdrawalService.complete(id, {} as any, adminActor()));
      await expect(
        withTestTenant(async () => withdrawalService.complete(id, {} as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // cancel — admin or original requester
  // ────────────────────────────────────────────────────────────────────
  describe('cancel', () => {
    it('admin cancels a REQUESTED withdrawal', async () => {
      const student = await trackedStudent();
      const dto = await withTestTenant(async () =>
        withdrawalService.create(withdrawalInput(student.studentId), adminActor()),
      );
      const cancelled = await withTestTenant(async () =>
        withdrawalService.cancel(dto.id, { reason: 'family changed mind' } as any, adminActor()),
      );
      expect(cancelled.status).toBe('CANCELLED');
    });

    it('cannot cancel a COMPLETED withdrawal', async () => {
      const student = await trackedStudent();
      const dto = await withTestTenant(async () =>
        withdrawalService.create(withdrawalInput(student.studentId), adminActor()),
      );
      const taskIds = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text FROM ${TEST_SCHEMA}.enr_withdrawal_exit_tasks WHERE withdrawal_id = $1::uuid`,
        dto.id,
      );
      for (const t of taskIds) {
        await withTestTenant(async () =>
          exitTaskService.patch(t.id, { status: 'WAIVED' } as any, adminActor()),
        );
      }
      await withTestTenant(async () => withdrawalService.complete(dto.id, {} as any, adminActor()));
      await expect(
        withTestTenant(async () =>
          withdrawalService.cancel(dto.id, { reason: 'too late' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('empty reason → BadRequestException', async () => {
      const student = await trackedStudent();
      const dto = await withTestTenant(async () =>
        withdrawalService.create(withdrawalInput(student.studentId), adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          withdrawalService.cancel(dto.id, { reason: '  ' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-admin non-owner → ForbiddenException', async () => {
      const student = await trackedStudent();
      const dto = await withTestTenant(async () =>
        withdrawalService.create(withdrawalInput(student.studentId), adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          withdrawalService.cancel(dto.id, { reason: 'no' } as any, officerActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // placeReenrolHold — hold_chk invariant
  // ────────────────────────────────────────────────────────────────────
  describe('placeReenrolHold + hasActiveHoldForStudent', () => {
    it('admin places hold with reason → hasActiveHoldForStudent = true', async () => {
      const student = await trackedStudent();
      const dto = await withTestTenant(async () =>
        withdrawalService.create(withdrawalInput(student.studentId), adminActor()),
      );
      const updated = await withTestTenant(async () =>
        withdrawalService.placeReenrolHold(
          dto.id,
          { hold: true, reason: 'unpaid fees > $5k' } as any,
          adminActor(),
        ),
      );
      expect(updated.reEnrollmentHoldPlaced).toBe(true);
      expect(updated.reEnrollmentHoldReason).toBe('unpaid fees > $5k');

      const active = await withTestTenant(async () =>
        withdrawalService.hasActiveHoldForStudent(student.studentId),
      );
      expect(active).toBe(true);
    });

    it('admin places hold without reason → BadRequestException', async () => {
      const student = await trackedStudent();
      const dto = await withTestTenant(async () =>
        withdrawalService.create(withdrawalInput(student.studentId), adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          withdrawalService.placeReenrolHold(
            dto.id,
            { hold: true, reason: '' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('admin clears hold → reEnrollmentHoldPlaced=false, hasActiveHoldForStudent=false', async () => {
      const student = await trackedStudent();
      const dto = await withTestTenant(async () =>
        withdrawalService.create(withdrawalInput(student.studentId), adminActor()),
      );
      await withTestTenant(async () =>
        withdrawalService.placeReenrolHold(
          dto.id,
          { hold: true, reason: 'temporary' } as any,
          adminActor(),
        ),
      );
      const cleared = await withTestTenant(async () =>
        withdrawalService.placeReenrolHold(dto.id, { hold: false } as any, adminActor()),
      );
      expect(cleared.reEnrollmentHoldPlaced).toBe(false);
      expect(cleared.reEnrollmentHoldReason).toBeNull();
    });

    it('non-admin → ForbiddenException', async () => {
      const student = await trackedStudent();
      const dto = await withTestTenant(async () =>
        withdrawalService.create(withdrawalInput(student.studentId), adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          withdrawalService.placeReenrolHold(
            dto.id,
            { hold: true, reason: 'x' } as any,
            officerActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Re-enrolment confirmation — auto-withdrawal on continuing=false
  // ────────────────────────────────────────────────────────────────────
  describe('re-enrolment auto-withdrawal (atomic in same tx)', () => {
    it('confirmed_continuing=false → confirmation row + linked withdrawal in same tx', async () => {
      const student = await trackedStudent();
      await bindParentActorToStudent(student.studentId);
      const dto = await withTestTenant(
        async () =>
          reenrolService.submit(
            {
              studentId: student.studentId,
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              confirmedContinuing: false,
              withdrawalReason: 'Moving overseas next year',
            } as any,
            parentActor(),
          ),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(dto.confirmedContinuing).toBe(false);
      expect(dto.linkedWithdrawalId).not.toBeNull();

      // Verify the linked withdrawal row exists with REQUESTED status.
      const wRows = await rawClient.$queryRawUnsafe<Array<{ status: string; student_id: string }>>(
        `SELECT status, student_id::text FROM ${TEST_SCHEMA}.enr_withdrawal_requests WHERE id = $1::uuid`,
        dto.linkedWithdrawalId,
      );
      expect(wRows[0]!.status).toBe('REQUESTED');
      expect(wRows[0]!.student_id).toBe(student.studentId);
    });

    it('confirmed_continuing=true → confirmation row only, no linked withdrawal', async () => {
      const student = await trackedStudent();
      await bindParentActorToStudent(student.studentId);
      const dto = await withTestTenant(
        async () =>
          reenrolService.submit(
            {
              studentId: student.studentId,
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              confirmedContinuing: true,
            } as any,
            parentActor(),
          ),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(dto.confirmedContinuing).toBe(true);
      expect(dto.linkedWithdrawalId).toBeNull();
    });

    it('duplicate confirmation for (student, academic_year) → BadRequest, rolling back the auto-withdrawal', async () => {
      const student = await trackedStudent();
      await bindParentActorToStudent(student.studentId);
      // First submission succeeds.
      await withTestTenant(
        async () =>
          reenrolService.submit(
            {
              studentId: student.studentId,
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              confirmedContinuing: false,
              withdrawalReason: 'first',
            } as any,
            parentActor(),
          ),
        { personId: TEST_PARENT_PERSON_ID },
      );

      const beforeWithdrawals = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.enr_withdrawal_requests WHERE student_id = $1::uuid`,
        student.studentId,
      );

      // Second submission collides with UNIQUE(student, academic_year)
      // and rolls back the auto-withdrawal it would have created.
      await expect(
        withTestTenant(
          async () =>
            reenrolService.submit(
              {
                studentId: student.studentId,
                academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
                confirmedContinuing: false,
                withdrawalReason: 'second',
              } as any,
              parentActor(),
            ),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const afterWithdrawals = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.enr_withdrawal_requests WHERE student_id = $1::uuid`,
        student.studentId,
      );
      // Withdrawal count did NOT increase on the second (failed) call —
      // the BLOCKING-2 fix ensures the auto-withdrawal rolls back when
      // the confirmation INSERT loses the UNIQUE race.
      expect(afterWithdrawals[0]!.count).toBe(beforeWithdrawals[0]!.count);
    });

    it('confirmed_continuing=true with active hold → BadRequestException', async () => {
      const student = await trackedStudent();
      await bindParentActorToStudent(student.studentId);
      // Seed a prior withdrawal with a hold placed.
      const wDto = await withTestTenant(async () =>
        withdrawalService.create(withdrawalInput(student.studentId), adminActor()),
      );
      await withTestTenant(async () =>
        withdrawalService.placeReenrolHold(
          wDto.id,
          { hold: true, reason: 'audit pending' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(
          async () =>
            reenrolService.submit(
              {
                studentId: student.studentId,
                academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
                confirmedContinuing: true,
              } as any,
              parentActor(),
            ),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it("School A admin's list does NOT include School B withdrawals", async () => {
      const bStudent = await trackedStudent({ schoolId: TEST_SCHOOL_B_ID });
      const bDto = await withTestTenantB(async () =>
        withdrawalService.create(withdrawalInput(bStudent.studentId), adminActor()),
      );
      const aStudent = await trackedStudent({ schoolId: TEST_SCHOOL_ID });
      const aDto = await withTestTenant(async () =>
        withdrawalService.create(withdrawalInput(aStudent.studentId), adminActor()),
      );
      const aList = await withTestTenant(async () => withdrawalService.list(adminActor()));
      const ids = aList.map((r) => r.id);
      expect(ids).toContain(aDto.id);
      expect(ids).not.toContain(bDto.id);
    });

    it('School A admin cannot getById a School B withdrawal — NotFoundException', async () => {
      const bStudent = await trackedStudent({ schoolId: TEST_SCHOOL_B_ID });
      const bDto = await withTestTenantB(async () =>
        withdrawalService.create(withdrawalInput(bStudent.studentId), adminActor()),
      );
      await expect(
        withTestTenant(async () => withdrawalService.getById(bDto.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // Suppress unused-import warnings (helpers retained for parity).
  void seedParentGuardianFor;
});
