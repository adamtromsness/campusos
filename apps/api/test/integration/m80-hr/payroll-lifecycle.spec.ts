import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { PayGradeService } from '@modules/m80-hr/payroll/pay-grade.service';
import {
  PayrollService,
  deterministicPayrollEventId,
} from '@modules/m80-hr/payroll/payroll.service';
import { SalaryReviewService } from '@modules/m80-hr/payroll/salary-review.service';
import { PayrollController } from '@modules/m80-hr/payroll/payroll.controller';
import { ActorContextService, PermissionCheckService } from '@modules/m00-platform';
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
  teacherActor,
  parentActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_TEACHER_EMPLOYEE_ID,
  TEST_OFFICER_EMPLOYEE_ID,
} from '../helpers/actor';
import { ensureWorkflowsPlatformFixtures } from '../fixtures/workflows';
import {
  resetAndSeedHr,
  ensureHrFixtures,
  TEST_HR_PAY_GRADE_A_ID,
  TEST_HR_PAY_GRADE_B_ID,
  TEST_HR_SALARY_SCALE_A1_ID,
  TEST_HR_SALARY_SCALE_A2_ID,
  TEST_HR_SHADOW_EMPLOYEE_B_ID,
} from '../fixtures/hr';
import { generateId } from '@campusos/database';

describe('integration:m80-hr/payroll-lifecycle', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let payGrades: PayGradeService;
  let payroll: PayrollService;
  let salaryReviews: SalaryReviewService;
  let payrollCtrl: PayrollController;
  let actors: ActorContextService;
  let outbox: OutboxService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    // Restore canonical admin iam_effective_access_cache row. Sibling
    // specs that ran earlier may have wiped it to seed narrow per-test
    // permissions. PayrollController + PayGradeService + SalaryReviewService
    // gate on isSchoolAdmin which needs sch-001:admin in the cache.
    await ensureWorkflowsPlatformFixtures(rawClient);

    const permissions = new PermissionCheckService(rawClient);
    actors = new ActorContextService(rawClient, permissions, tenantPrisma);
    outbox = new OutboxService();
    payGrades = new PayGradeService(tenantPrisma, permissions);
    payroll = new PayrollService(tenantPrisma, permissions, outbox);
    salaryReviews = new SalaryReviewService(tenantPrisma, permissions);
    payrollCtrl = new PayrollController(payGrades, payroll, salaryReviews, actors);

    await ensureHrFixtures(rawClient);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetAndSeedHr(rawClient);
    // Wire the admin's primary position to the A2 salary scale so
    // processPeriod can compute gross pay.
    await rawClient.$executeRawUnsafe(
      `UPDATE ${TEST_SCHEMA}.hr_employee_positions
         SET salary_scale_id = $1::uuid
       WHERE employee_id = $2::uuid AND is_primary = true AND effective_to IS NULL`,
      TEST_HR_SALARY_SCALE_A2_ID,
      TEST_ADMIN_EMPLOYEE_ID,
    );
  });

  function adminReq(): any {
    return {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
        email: 'admin@test.local',
        displayName: 'Admin',
        sessionId: 's',
      },
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // PayGradeService
  // ───────────────────────────────────────────────────────────────────
  describe('PayGradeService', () => {
    it('list returns school-scoped grades with scales', async () => {
      const list = await withTestTenant(async () => payGrades.list());
      const ids = list.map((g) => g.id);
      expect(ids).toContain(TEST_HR_PAY_GRADE_A_ID);
      const gradeA = list.find((g) => g.id === TEST_HR_PAY_GRADE_A_ID)!;
      expect(gradeA.scales.length).toBeGreaterThanOrEqual(2);
    });

    it('list includeInactive expands', async () => {
      const all = await withTestTenant(async () => payGrades.list(true));
      expect(all.length).toBeGreaterThan(0);
    });

    it('getById returns + 404 on missing', async () => {
      const dto = await withTestTenant(async () =>
        payGrades.getById(TEST_HR_PAY_GRADE_A_ID),
      );
      expect(dto.scales.length).toBeGreaterThanOrEqual(2);

      await expect(
        withTestTenant(async () =>
          payGrades.getById('019e0cf8-aaaa-7777-8888-00000000ffff'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('create rejects non-admin', async () => {
      await expect(
        withTestTenant(async () =>
          payGrades.create({ gradeName: 'X' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create + reject when min > max', async () => {
      await expect(
        withTestTenant(async () =>
          payGrades.create(
            { gradeName: 'Bad', minSalary: 100, maxSalary: 10 } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const dto = await withTestTenant(async () =>
        payGrades.create(
          {
            gradeName: 'PG-' + Date.now(),
            minSalary: 10,
            maxSalary: 100,
            description: 'd',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.scales).toEqual([]);
    });

    it('create duplicate name → BadRequest', async () => {
      const name = 'Dup-' + Date.now();
      await withTestTenant(async () =>
        payGrades.create({ gradeName: name } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          payGrades.create({ gradeName: name } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch with no fields → no-op returns existing', async () => {
      const dto = await withTestTenant(async () =>
        payGrades.patch(TEST_HR_PAY_GRADE_A_ID, {} as any, adminActor()),
      );
      expect(dto.id).toBe(TEST_HR_PAY_GRADE_A_ID);
    });

    it('patch updates fields', async () => {
      const dto = await withTestTenant(async () =>
        payGrades.patch(
          TEST_HR_PAY_GRADE_A_ID,
          {
            gradeName: 'Renamed-' + Date.now(),
            description: 'new',
            minSalary: 25000,
            maxSalary: 60000,
            isActive: false,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.isActive).toBe(false);
      expect(dto.minSalary).toBe(25000);
    });

    it('patch rejects non-admin', async () => {
      await expect(
        withTestTenant(async () =>
          payGrades.patch(TEST_HR_PAY_GRADE_A_ID, {} as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listScales requires existing grade', async () => {
      const scales = await withTestTenant(async () =>
        payGrades.listScales(TEST_HR_PAY_GRADE_A_ID),
      );
      expect(scales.length).toBeGreaterThanOrEqual(2);
      await expect(
        withTestTenant(async () =>
          payGrades.listScales('019e0cf8-aaaa-7777-8888-00000000ffff'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('addScale + patchScale + duplicate-step BadRequest', async () => {
      // Generate a unique step number per run so leftover scales from
      // other tests don't pre-occupy the slot.
      const uniqueStep = 100 + Math.floor(Math.random() * 9000);
      const scale = await withTestTenant(async () =>
        payGrades.addScale(
          TEST_HR_PAY_GRADE_A_ID,
          { step: uniqueStep, annualSalary: 99000 } as any,
          adminActor(),
        ),
      );
      expect(scale.step).toBe(uniqueStep);

      await expect(
        withTestTenant(async () =>
          payGrades.addScale(
            TEST_HR_PAY_GRADE_A_ID,
            { step: uniqueStep, annualSalary: 99001 } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const upd = await withTestTenant(async () =>
        payGrades.patchScale(
          scale.id,
          { annualSalary: 99500, notes: 'updated' } as any,
          adminActor(),
        ),
      );
      expect(upd.annualSalary).toBe(99500);

      const noop = await withTestTenant(async () =>
        payGrades.patchScale(scale.id, {} as any, adminActor()),
      );
      expect(noop.id).toBe(scale.id);
    });

    it('loadScaleForCompute hits scale + miss returns null', async () => {
      const r = await withTestTenant(async () =>
        payGrades.loadScaleForCompute(TEST_HR_SALARY_SCALE_A1_ID),
      );
      expect(r?.annualSalary).toBe(40000);

      const miss = await withTestTenant(async () =>
        payGrades.loadScaleForCompute('019e0cf8-aaaa-7777-8888-00000000ffff'),
      );
      expect(miss).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // PayrollService — pay periods
  // ───────────────────────────────────────────────────────────────────
  describe('PayrollService pay-periods', () => {
    async function createPeriod() {
      return withTestTenant(async () =>
        payroll.createPeriod(
          {
            periodLabel: 'P-' + Date.now(),
            startDate: '2026-01-01',
            endDate: '2026-01-15',
            payDate: '2026-01-22',
          } as any,
          adminActor(),
        ),
      );
    }

    it('createPeriod rejects non-admin + bad-date validation', async () => {
      await expect(
        withTestTenant(async () =>
          payroll.createPeriod(
            {
              periodLabel: 'X',
              startDate: '2026-01-01',
              endDate: '2026-01-15',
              payDate: '2026-01-22',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      await expect(
        withTestTenant(async () =>
          payroll.createPeriod(
            {
              periodLabel: 'Y',
              startDate: '2026-01-15',
              endDate: '2026-01-01', // end before start
              payDate: '2026-01-22',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        withTestTenant(async () =>
          payroll.createPeriod(
            {
              periodLabel: 'Z',
              startDate: '2026-01-15',
              endDate: '2026-01-20',
              payDate: '2026-01-01', // pay before start
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createPeriod duplicate start_date → BadRequest', async () => {
      await withTestTenant(async () =>
        payroll.createPeriod(
          {
            periodLabel: 'Dup1',
            startDate: '2026-02-01',
            endDate: '2026-02-15',
            payDate: '2026-02-22',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          payroll.createPeriod(
            {
              periodLabel: 'Dup2',
              startDate: '2026-02-01',
              endDate: '2026-02-15',
              payDate: '2026-02-22',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('listPeriods + filter by status', async () => {
      const p = await createPeriod();
      const all = await withTestTenant(async () => payroll.listPeriods({} as any));
      expect(all.map((x) => x.id)).toContain(p.id);
      const open = await withTestTenant(async () =>
        payroll.listPeriods({ status: 'OPEN' } as any),
      );
      expect(open.every((p) => p.status === 'OPEN')).toBe(true);
    });

    it('getPeriod 404 on missing', async () => {
      await expect(
        withTestTenant(async () =>
          payroll.getPeriod('019e0cf8-aaaa-7777-8888-00000000ffff'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    // ─────────────────────────────────────────────────────────────────
    // KEYSTONE — process → approve → markPaid → outbox emit
    // ─────────────────────────────────────────────────────────────────
    it('full lifecycle: process → approve → markPaid emits hr.payroll.processed outbox', async () => {
      const p = await createPeriod();
      const res = await withTestTenant(async () =>
        payroll.processPeriod(
          p.id,
          { employeeIds: [TEST_ADMIN_EMPLOYEE_ID] } as any,
          adminActor(),
        ),
      );
      expect(res.processed).toBe(1);
      expect(res.skipped).toBe(0);

      // Period is now PROCESSING
      const period2 = await withTestTenant(async () => payroll.getPeriod(p.id));
      expect(period2.status).toBe('PROCESSING');
      expect(period2.recordCount).toBe(1);
      expect(period2.totalGross).toBeGreaterThan(0);

      // Approve
      const approved = await withTestTenant(async () =>
        payroll.approvePeriod(p.id, adminActor()),
      );
      // Period stays PROCESSING (only records flip to APPROVED)
      expect(approved.status).toBe('PROCESSING');

      // Mark paid → flips PAID + queues outbox emits
      const paid = await withTestTenant(async () =>
        payroll.markPaid(p.id, adminActor()),
      );
      expect(paid.status).toBe('PAID');

      // Verify outbox has exactly one envelope per payroll record.
      const outboxRows = (await rawClient.$queryRawUnsafe(
        `SELECT topic, envelope::text AS envelope
           FROM platform.platform_outbox
          WHERE topic = 'hr.payroll.processed'
            AND tenant_id = $1::uuid
          ORDER BY created_at DESC`,
        TEST_SCHOOL_ID,
      )) as Array<{ topic: string; envelope: string }>;
      expect(outboxRows.length).toBe(1);
      const env = JSON.parse(outboxRows[0]!.envelope);
      expect(env.payload.payrollRecordId).toBeTruthy();
      expect(env.payload.deductions.length).toBeGreaterThan(0);
      // Deterministic event_id by payroll_record_id (stamped into
      // the envelope by OutboxService.enqueueInTx).
      expect(env.event_id).toBe(
        deterministicPayrollEventId(env.payload.payrollRecordId),
      );
    });

    it('processPeriod is idempotent (re-run does not duplicate)', async () => {
      const p = await createPeriod();
      const a = await withTestTenant(async () =>
        payroll.processPeriod(
          p.id,
          { employeeIds: [TEST_ADMIN_EMPLOYEE_ID] } as any,
          adminActor(),
        ),
      );
      const b = await withTestTenant(async () =>
        payroll.processPeriod(
          p.id,
          { employeeIds: [TEST_ADMIN_EMPLOYEE_ID] } as any,
          adminActor(),
        ),
      );
      expect(a.processed).toBe(1);
      // Second run sees no new rows to create
      expect(b.processed).toBe(0);
      expect(b.skipped).toBeGreaterThanOrEqual(1);
    });

    it('processPeriod skips employees without salary scale', async () => {
      const p = await createPeriod();
      // Officer + teacher have no salary scale wired
      const res = await withTestTenant(async () =>
        payroll.processPeriod(
          p.id,
          {
            employeeIds: [TEST_TEACHER_EMPLOYEE_ID, TEST_OFFICER_EMPLOYEE_ID],
          } as any,
          adminActor(),
        ),
      );
      expect(res.processed).toBe(0);
      expect(res.skipped).toBe(2);
    });

    it('processPeriod rejects when status != OPEN/PROCESSING', async () => {
      const p = await createPeriod();
      await withTestTenant(async () =>
        payroll.processPeriod(
          p.id,
          { employeeIds: [TEST_ADMIN_EMPLOYEE_ID] } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        payroll.approvePeriod(p.id, adminActor()),
      );
      await withTestTenant(async () => payroll.markPaid(p.id, adminActor()));
      await expect(
        withTestTenant(async () =>
          payroll.processPeriod(p.id, {} as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('approvePeriod rejects when not PROCESSING', async () => {
      const p = await createPeriod();
      await expect(
        withTestTenant(async () => payroll.approvePeriod(p.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('approvePeriod missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          payroll.approvePeriod('019e0cf8-aaaa-7777-8888-00000000ffff', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('markPaid rejects unapproved records', async () => {
      const p = await createPeriod();
      await withTestTenant(async () =>
        payroll.processPeriod(
          p.id,
          { employeeIds: [TEST_ADMIN_EMPLOYEE_ID] } as any,
          adminActor(),
        ),
      );
      // Skip approve step
      await expect(
        withTestTenant(async () => payroll.markPaid(p.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('processPeriod rejects non-admin', async () => {
      const p = await createPeriod();
      await expect(
        withTestTenant(async () =>
          payroll.processPeriod(p.id, {} as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('processPeriod missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          payroll.processPeriod(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            {} as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('markPaid missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          payroll.markPaid('019e0cf8-aaaa-7777-8888-00000000ffff', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // PayrollService — record reads
  // ───────────────────────────────────────────────────────────────────
  describe('PayrollService records', () => {
    async function processOne() {
      const p = await withTestTenant(async () =>
        payroll.createPeriod(
          {
            periodLabel: 'PR-' + Date.now(),
            startDate: '2026-03-01',
            endDate: '2026-03-15',
            payDate: '2026-03-22',
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        payroll.processPeriod(
          p.id,
          { employeeIds: [TEST_ADMIN_EMPLOYEE_ID] } as any,
          adminActor(),
        ),
      );
      return p;
    }

    it('listRecords + getRecord paths + admin / non-admin scoping', async () => {
      const p = await processOne();
      const list = await withTestTenant(async () =>
        payroll.listRecords({ payPeriodId: p.id } as any, adminActor()),
      );
      expect(list.length).toBe(1);
      const recordId = list[0]!.id;
      const got = await withTestTenant(async () =>
        payroll.getRecord(recordId, adminActor()),
      );
      expect(got.id).toBe(recordId);
      expect(got.deductions.length).toBeGreaterThan(0);

      // Non-admin: parent has no employeeId → empty
      const empty = await withTestTenant(async () =>
        payroll.listRecords({} as any, parentActor()),
      );
      expect(empty).toEqual([]);

      // Admin's own employee
      const filtered = await withTestTenant(async () =>
        payroll.listRecords({ employeeId: TEST_ADMIN_EMPLOYEE_ID } as any, adminActor()),
      );
      expect(filtered.length).toBeGreaterThan(0);

      // Status filter
      const draft = await withTestTenant(async () =>
        payroll.listRecords({ status: 'DRAFT' } as any, adminActor()),
      );
      expect(draft.every((r) => r.status === 'DRAFT')).toBe(true);
    });

    it('getRecord missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          payroll.getRecord('019e0cf8-aaaa-7777-8888-00000000ffff', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin viewing foreign record → 404 (no leak)', async () => {
      const p = await processOne();
      const list = await withTestTenant(async () =>
        payroll.listRecords({ payPeriodId: p.id } as any, adminActor()),
      );
      const recordId = list[0]!.id;
      // teacher has employeeId != admin's record's employee_id
      await expect(
        withTestTenant(async () => payroll.getRecord(recordId, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // SalaryReviewService
  // ───────────────────────────────────────────────────────────────────
  describe('SalaryReviewService', () => {
    async function submitReview() {
      return withTestTenant(async () =>
        salaryReviews.create(
          {
            employeeId: TEST_ADMIN_EMPLOYEE_ID,
            reviewType: 'ANNUAL_INCREMENT',
            currentSalary: 50000,
            recommendedSalary: 55000,
            effectiveDate: '2026-06-01',
            justification: 'Outstanding performance',
          } as any,
          adminActor(),
        ),
      );
    }

    it('create rejects unnamed user', async () => {
      await expect(
        withTestTenant(async () =>
          salaryReviews.create(
            {
              employeeId: TEST_ADMIN_EMPLOYEE_ID,
              reviewType: 'ANNUAL_INCREMENT',
              justification: 'j',
            } as any,
            { ...adminActor(), personId: null as any },
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create rejects bad reviewType', async () => {
      await expect(
        withTestTenant(async () =>
          salaryReviews.create(
            {
              employeeId: TEST_ADMIN_EMPLOYEE_ID,
              reviewType: 'BOGUS' as any,
              justification: 'j',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create rejects negative recommendedSalary', async () => {
      await expect(
        withTestTenant(async () =>
          salaryReviews.create(
            {
              employeeId: TEST_ADMIN_EMPLOYEE_ID,
              reviewType: 'ANNUAL_INCREMENT',
              currentSalary: 50000,
              recommendedSalary: -1,
              justification: 'j',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create rejects foreign employeeId', async () => {
      await expect(
        withTestTenant(async () =>
          salaryReviews.create(
            {
              employeeId: '019e0cf8-aaaa-7777-8888-00000000ffff',
              reviewType: 'ANNUAL_INCREMENT',
              justification: 'j',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('happy path: create + list + getById + patch', async () => {
      const dto = await submitReview();
      expect(dto.status).toBe('SUBMITTED');

      const list = await withTestTenant(async () =>
        salaryReviews.list({} as any, adminActor()),
      );
      expect(list.map((r) => r.id)).toContain(dto.id);

      const filtered = await withTestTenant(async () =>
        salaryReviews.list(
          { status: 'SUBMITTED', employeeId: TEST_ADMIN_EMPLOYEE_ID } as any,
          adminActor(),
        ),
      );
      expect(filtered.length).toBeGreaterThan(0);

      const got = await withTestTenant(async () =>
        salaryReviews.getById(dto.id, adminActor()),
      );
      expect(got.id).toBe(dto.id);
    });

    it('list non-admin sees own (requester/employee) only', async () => {
      const dto = await submitReview();
      // Admin is both requester + employee of this row
      const adminList = await withTestTenant(async () =>
        salaryReviews.list({} as any, adminActor()),
      );
      expect(adminList.map((r) => r.id)).toContain(dto.id);
      // Teacher has different personId/employeeId → empty
      const teacherList = await withTestTenant(async () =>
        salaryReviews.list({} as any, teacherActor()),
      );
      expect(teacherList.map((r) => r.id)).not.toContain(dto.id);
    });

    it('list non-admin without ids → []', async () => {
      const empty = await withTestTenant(async () =>
        salaryReviews.list({} as any, {
          ...parentActor(),
          personId: null as any,
          employeeId: null,
        } as any),
      );
      expect(empty).toEqual([]);
    });

    it('getById missing → 404; non-owner non-admin → 404', async () => {
      await expect(
        withTestTenant(async () =>
          salaryReviews.getById(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      const dto = await submitReview();
      await expect(
        withTestTenant(async () => salaryReviews.getById(dto.id, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch flips status APPROVED + stamps decided fields', async () => {
      const dto = await submitReview();
      const out = await withTestTenant(async () =>
        salaryReviews.patch(
          dto.id,
          {
            status: 'APPROVED',
            decisionNotes: 'approved',
            recommendedSalary: 56000,
          } as any,
          adminActor(),
        ),
      );
      expect(out.status).toBe('APPROVED');
      expect(out.decidedBy).toBe(TEST_ADMIN_PERSON_ID);
      expect(out.decisionNotes).toBe('approved');
    });

    it('patch rejects modifying terminal record', async () => {
      const dto = await submitReview();
      await withTestTenant(async () =>
        salaryReviews.patch(dto.id, { status: 'APPROVED' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          salaryReviews.patch(dto.id, { justification: 'X' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch WITHDRAWN by requester allowed; by foreigner → Forbidden', async () => {
      const dto = await submitReview();
      await expect(
        withTestTenant(async () =>
          salaryReviews.patch(dto.id, { status: 'WITHDRAWN' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      const out = await withTestTenant(async () =>
        salaryReviews.patch(dto.id, { status: 'WITHDRAWN' } as any, adminActor()),
      );
      expect(out.status).toBe('WITHDRAWN');
    });

    it('patch UNDER_REVIEW requires admin', async () => {
      const dto = await submitReview();
      await expect(
        withTestTenant(async () =>
          salaryReviews.patch(dto.id, { status: 'UNDER_REVIEW' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const out = await withTestTenant(async () =>
        salaryReviews.patch(dto.id, { status: 'UNDER_REVIEW' } as any, adminActor()),
      );
      expect(out.status).toBe('UNDER_REVIEW');
    });

    it('patch invalid status → BadRequest', async () => {
      const dto = await submitReview();
      await expect(
        withTestTenant(async () =>
          salaryReviews.patch(dto.id, { status: 'BOGUS' as any } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          salaryReviews.patch(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            { status: 'APPROVED' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch no-op returns existing', async () => {
      const dto = await submitReview();
      const same = await withTestTenant(async () =>
        salaryReviews.patch(dto.id, {} as any, adminActor()),
      );
      expect(same.id).toBe(dto.id);
    });

    it('patch APPROVED without personId → Forbidden', async () => {
      const dto = await submitReview();
      await expect(
        withTestTenant(async () =>
          salaryReviews.patch(
            dto.id,
            { status: 'APPROVED' } as any,
            { ...adminActor(), personId: null as any },
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // PayrollController pass-through
  // ───────────────────────────────────────────────────────────────────
  describe('PayrollController', () => {
    it('pay-grades CRUD + scales', async () => {
      const grades = await withTestTenant(async () =>
        payrollCtrl.listGrades('false'),
      );
      expect(grades.length).toBeGreaterThan(0);

      const got = await withTestTenant(async () =>
        payrollCtrl.getGrade(TEST_HR_PAY_GRADE_A_ID),
      );
      expect(got.id).toBe(TEST_HR_PAY_GRADE_A_ID);

      const created = await withTestTenant(async () =>
        payrollCtrl.createGrade(adminReq(), {
          gradeName: 'Ctrl-' + Date.now(),
        } as any),
      );
      expect(created.id).toBeTruthy();

      const upd = await withTestTenant(async () =>
        payrollCtrl.patchGrade(adminReq(), created.id, {
          isActive: false,
        } as any),
      );
      expect(upd.isActive).toBe(false);

      const scales = await withTestTenant(async () =>
        payrollCtrl.listScales(TEST_HR_PAY_GRADE_A_ID),
      );
      expect(scales.length).toBeGreaterThanOrEqual(2);

      const ctrlStep = 200 + Math.floor(Math.random() * 9000);
      const addedScale = await withTestTenant(async () =>
        payrollCtrl.addScale(adminReq(), TEST_HR_PAY_GRADE_A_ID, {
          step: ctrlStep,
          annualSalary: 88000,
        } as any),
      );
      expect(addedScale.step).toBe(ctrlStep);

      const updScale = await withTestTenant(async () =>
        payrollCtrl.patchScale(adminReq(), addedScale.id, {
          annualSalary: 89000,
        } as any),
      );
      expect(updScale.annualSalary).toBe(89000);
    });

    it('pay-periods + process + approve + markPaid via controller', async () => {
      const periods = await withTestTenant(async () =>
        payrollCtrl.listPeriods({} as any),
      );
      expect(Array.isArray(periods)).toBe(true);

      const created = await withTestTenant(async () =>
        payrollCtrl.createPeriod(adminReq(), {
          periodLabel: 'Ctrl-' + Date.now(),
          startDate: '2026-04-01',
          endDate: '2026-04-15',
          payDate: '2026-04-22',
        } as any),
      );

      const got = await withTestTenant(async () => payrollCtrl.getPeriod(created.id));
      expect(got.id).toBe(created.id);

      const proc = await withTestTenant(async () =>
        payrollCtrl.process(adminReq(), created.id, {
          employeeIds: [TEST_ADMIN_EMPLOYEE_ID],
        } as any),
      );
      expect(proc.processed).toBe(1);

      const approved = await withTestTenant(async () =>
        payrollCtrl.approve(adminReq(), created.id),
      );
      expect(approved.status).toBe('PROCESSING');

      const paid = await withTestTenant(async () =>
        payrollCtrl.markPaid(adminReq(), created.id),
      );
      expect(paid.status).toBe('PAID');
    });

    it('records list + me/payslips + getById', async () => {
      const p = await withTestTenant(async () =>
        payrollCtrl.createPeriod(adminReq(), {
          periodLabel: 'CtrlR-' + Date.now(),
          startDate: '2026-05-01',
          endDate: '2026-05-15',
          payDate: '2026-05-22',
        } as any),
      );
      await withTestTenant(async () =>
        payrollCtrl.process(adminReq(), p.id, {
          employeeIds: [TEST_ADMIN_EMPLOYEE_ID],
        } as any),
      );
      const list = await withTestTenant(async () =>
        payrollCtrl.listRecords(adminReq(), { payPeriodId: p.id } as any),
      );
      expect(list.length).toBe(1);
      const r0 = list[0]!;
      const got = await withTestTenant(async () =>
        payrollCtrl.getRecord(adminReq(), r0.id),
      );
      expect(got.id).toBe(r0.id);

      const mine = await withTestTenant(async () =>
        payrollCtrl.myPayslips(adminReq(), {} as any),
      );
      expect(mine.map((m) => m.id)).toContain(r0.id);
    });

    it('salary-reviews controller flow', async () => {
      const dto = await withTestTenant(async () =>
        payrollCtrl.submitReview(adminReq(), {
          employeeId: TEST_ADMIN_EMPLOYEE_ID,
          reviewType: 'PROMOTION',
          justification: 'ctrl',
        } as any),
      );
      const list = await withTestTenant(async () =>
        payrollCtrl.listReviews(adminReq(), {} as any),
      );
      expect(list.map((r) => r.id)).toContain(dto.id);
      const got = await withTestTenant(async () =>
        payrollCtrl.getReview(adminReq(), dto.id),
      );
      expect(got.id).toBe(dto.id);
      const upd = await withTestTenant(async () =>
        payrollCtrl.patchReview(adminReq(), dto.id, {
          status: 'APPROVED',
        } as any),
      );
      expect(upd.status).toBe('APPROVED');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ───────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('pay-grades scoped: B does not see A', async () => {
      const a = await withTestTenant(async () => payGrades.list());
      const b = await withTestTenantB(async () => payGrades.list());
      const aIds = new Set(a.map((g) => g.id));
      const bIds = b.map((g) => g.id);
      expect(aIds.has(TEST_HR_PAY_GRADE_A_ID)).toBe(true);
      expect(bIds).not.toContain(TEST_HR_PAY_GRADE_A_ID);
    });

    it('pay-period under B does not see A periods', async () => {
      const p = await withTestTenant(async () =>
        payroll.createPeriod(
          {
            periodLabel: 'XB-' + Date.now(),
            startDate: '2026-10-01',
            endDate: '2026-10-15',
            payDate: '2026-10-22',
          } as any,
          adminActor(),
        ),
      );
      const fromB = await withTestTenantB(async () => payroll.listPeriods({} as any));
      expect(fromB.map((x) => x.id)).not.toContain(p.id);
    });
  });

  // Reference unused exports
  it('exports B + admin person references', () => {
    expect(TEST_HR_PAY_GRADE_B_ID).toBeTruthy();
    expect(TEST_SCHOOL_B_ID).toBeTruthy();
    expect(TEST_HR_SHADOW_EMPLOYEE_B_ID).toBeTruthy();
  });
});
