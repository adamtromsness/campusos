import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '@shared/tenant';
import { PERMISSIONS_KEY } from '@shared/auth';
import { PayrollController } from './payroll.controller';
import { PayGradeService } from './pay-grade.service';
import { PayrollService, deterministicPayrollEventId } from './payroll.service';
import { SalaryReviewService } from './salary-review.service';

/**
 * P2C4 sub-cycle a — Payroll keystone unit tests.
 *
 * After REVIEW-P2-4a Round 1 the suite covers the original 12
 * keystone behaviours plus 4 new regression tests for the BLOCKING
 * fixes:
 *   - markPaid uses OutboxService.enqueueInTx instead of best-effort
 *     Kafka emit (BLOCKING #1).
 *   - markPaid rejects when any record is still DRAFT (BLOCKING #2).
 *   - Controller permission metadata uses hr-010 for admin reads /
 *     hr-003 for self-service payslips (BLOCKING #3).
 *   - deterministicPayrollEventId returns a stable v5-shaped UUID so
 *     outbox retries land the same event_id and the GLConsumer
 *     dedupes on platform_event_consumer_idempotency.
 */

const SCHOOL: TenantInfo = {
  schoolId: '019e0cf8-bbb8-7556-8c81-f07b3369e584',
  schemaName: 'tenant_demo',
  organisationId: 'org-1',
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'MEDIUM',
  homeRegion: 'us-east-1',
};

const ADMIN_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-000000000001',
  personId: '019e0cf8-bbb8-7556-8c81-000000000002',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
  employeeId: '019e0cf8-bbb8-7556-8c81-000000000099',
} as never;

const EMPLOYEE_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-000000000010',
  personId: '019e0cf8-bbb8-7556-8c81-000000000011',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
  employeeId: '019e0cf8-bbb8-7556-8c81-000000000050',
} as never;

interface CapturedCall {
  sql: string;
  args: unknown[];
  fn: 'q' | 'e';
}

function makeFake(handler: (call: CapturedCall) => unknown) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'q' };
      capture.push(call);
      return handler(call) ?? [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'e' };
      capture.push(call);
      return handler(call) ?? 0;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
  };
  return { capture, client, tenantPrisma };
}

function makeOutbox() {
  const enqueued: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    eventId?: string;
    payload: Record<string, unknown>;
  }> = [];
  const outbox = {
    enqueueInTx: async (_tx: unknown, opts: any) => {
      enqueued.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        eventId: opts.eventId,
        payload: opts.payload,
      });
    },
  };
  return { outbox, enqueued };
}

describe('PayGradeService — admin gate + salary range check', () => {
  it('rejects min > max with BadRequest before any SQL fires', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const svc = new PayGradeService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create({ gradeName: 'Grade X', minSalary: 60000, maxSalary: 50000 }, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fake.capture.find((c) => c.fn === 'e')).toBeUndefined();
  });

  it('non-admin without hr-010:admin is rejected with Forbidden', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const svc = new PayGradeService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create({ gradeName: 'Grade X' }, EMPLOYEE_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('admin can create — INSERT carries school_id + grade_name + range', async () => {
    let stage = 0;
    const fake = makeFake(() => {
      stage += 1;
      if (stage > 1) {
        return [
          {
            id: 'gr-1',
            school_id: SCHOOL.schoolId,
            grade_name: 'Grade X',
            description: null,
            min_salary: '40000',
            max_salary: '60000',
            is_active: true,
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const svc = new PayGradeService(fake.tenantPrisma as never, permissions as never);
    const dto = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.create({ gradeName: 'Grade X', minSalary: 40000, maxSalary: 60000 }, ADMIN_ACTOR),
    );
    expect(dto.gradeName).toBe('Grade X');
    expect(dto.minSalary).toBe(40000);
    const insertCall = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into hr_pay_grades'),
    );
    expect(insertCall).toBeTruthy();
    expect(insertCall!.args).toContain(SCHOOL.schoolId);
    expect(insertCall!.args).toContain('Grade X');
  });
});

describe('PayrollService — process() lifecycle + idempotency', () => {
  it('refuses to process a PAID period', async () => {
    const fake = makeFake((c) => {
      if (c.sql.toLowerCase().includes('for update')) {
        return [{ id: 'pp-1', status: 'PAID' }];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.processPeriod('pp-1', {}, ADMIN_ACTOR),
      ),
    ).rejects.toThrow(/Cannot process/);
  });

  it('process() second-run skips already-materialised rows via ON CONFLICT DO NOTHING', async () => {
    let runStage = 0;
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) return [{ id: 'pp-1', status: 'OPEN' }];
      if (sql.includes('from hr_employees') && sql.includes('order by e.id'))
        return [{ id: 'emp-A' }];
      if (sql.includes('from hr_employee_tax_info')) return [];
      if (sql.includes('from hr_employee_benefits')) return [];
      // P2-4b: resolveEmployeesForProcessing now joins
      // hr_employee_positions → hr_salary_scales for the per-position
      // scale assignment (migration 113 added the column).
      if (sql.includes('from hr_employee_positions ep'))
        return [{ employee_id: 'emp-A', salary_scale_id: 'sc-1', annual_salary: '52000' }];
      if (sql.includes('insert into hr_payroll_records')) {
        runStage += 1;
        return runStage === 1 ? [{ id: 'rec-A' }] : [];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const r1 = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.processPeriod('pp-1', {}, ADMIN_ACTOR),
    );
    expect(r1).toEqual({ processed: 1, skipped: 0 });
    const r2 = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.processPeriod('pp-1', {}, ADMIN_ACTOR),
    );
    expect(r2).toEqual({ processed: 0, skipped: 1 });
    const deductionInserts = fake.capture.filter(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into hr_payroll_deductions'),
    );
    expect(deductionInserts.length).toBeGreaterThan(0);
  });

  // REVIEW-P2-4a BLOCKING #2 — markPaid rejects DRAFT records.
  it('markPaid rejects when any record remains DRAFT', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) return [{ id: 'pp-1', status: 'PROCESSING' }];
      // Match the dedicated "AS n" alias to discriminate from the
      // SELECT_PERIOD_BASE subquery which also contains COUNT(*) but
      // aliased as record_count.
      if (sql.includes('count(*)::int as n')) return [{ n: 2 }];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox, enqueued } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () => svc.markPaid('pp-1', ADMIN_ACTOR)),
    ).rejects.toThrow(/2 payroll record\(s\) are not yet APPROVED/);
    // Period UPDATE must NOT have fired — pre-check aborts before the
    // UPDATE statement runs.
    expect(
      fake.capture.find(
        (c) =>
          c.fn === 'e' && c.sql.toLowerCase().includes("update hr_pay_periods set status = 'paid'"),
      ),
    ).toBeUndefined();
    // No outbox enqueue should have happened either.
    expect(enqueued).toHaveLength(0);
  });

  // REVIEW-P2-4a BLOCKING #1 — markPaid uses durable outbox.
  it('markPaid enqueues hr.payroll.processed via OutboxService inside the tx', async () => {
    const recordId = '019e0cf8-bbb8-7556-8c81-aaaaaaaaaaaa';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) return [{ id: 'pp-1', status: 'PROCESSING' }];
      // 0 unapproved records — all APPROVED so markPaid proceeds.
      // Discriminate via the "AS n" alias from the SELECT_PERIOD_BASE
      // record_count aggregate.
      if (sql.includes('count(*)::int as n')) return [{ n: 0 }];
      if (sql.includes('from hr_payroll_records r')) {
        return [
          {
            id: recordId,
            school_id: SCHOOL.schoolId,
            employee_id: 'emp-A',
            employee_first: 'James',
            employee_last: 'Rivera',
            pay_period_id: 'pp-1',
            pay_period_label: 'Pay Period 2026-04',
            pay_date: '2026-05-07',
            salary_scale_id: 'sc-1',
            gross_pay: '2000.00',
            total_deductions: '820.00',
            total_adjustments: '0.00',
            net_pay: '1180.00',
            status: 'PAID',
            notes: null,
            created_at: '2026-05-09T00:00:00Z',
          },
        ];
      }
      if (sql.includes('from hr_payroll_deductions')) {
        return [
          {
            id: 'd-1',
            payroll_record_id: recordId,
            deduction_type: 'FEDERAL_TAX',
            description: null,
            amount: '400.00',
            is_pretax: false,
          },
          {
            id: 'd-2',
            payroll_record_id: recordId,
            deduction_type: 'HEALTH_INSURANCE',
            description: null,
            amount: '150.00',
            is_pretax: true,
          },
        ];
      }
      if (sql.includes('from hr_pay_periods p')) {
        return [
          {
            id: 'pp-1',
            school_id: SCHOOL.schoolId,
            period_label: 'Pay Period 2026-04',
            start_date: '2026-04-19',
            end_date: '2026-05-02',
            pay_date: '2026-05-07',
            status: 'PAID',
            processed_at: '2026-05-08T00:00:00Z',
            paid_at: '2026-05-09T00:00:00Z',
            record_count: 1,
            total_gross: '2000',
            total_deductions: '820',
            total_net: '1180',
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox, enqueued } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const dto = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.markPaid('pp-1', ADMIN_ACTOR),
    );
    expect(dto.status).toBe('PAID');
    // Durable outbox must hold the envelope — best-effort emit gone.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.topic).toBe('hr.payroll.processed');
    expect(enqueued[0]!.sourceModule).toBe('hr-payroll');
    expect(enqueued[0]!.key).toBe(recordId);
    // Deterministic event_id keyed on payroll_record_id so outbox
    // retries land the same envelope id.
    expect(enqueued[0]!.eventId).toBe(deterministicPayrollEventId(recordId));
    const payload = enqueued[0]!.payload;
    // Cycle 26 GLConsumer contract — the salary-journal posting
    // depends on these fields landing inline so the consumer doesn't
    // round-trip back to the DB.
    expect(payload.payrollRecordId).toBe(recordId);
    expect(payload.schoolId).toBe(SCHOOL.schoolId);
    expect(payload.employeeId).toBe('emp-A');
    expect(payload.payPeriodId).toBe('pp-1');
    expect(payload.payDate).toBe('2026-05-07');
    expect(payload.grossPay).toBe(2000);
    expect(payload.totalDeductions).toBe(820);
    expect(payload.netPay).toBe(1180);
    expect((payload.deductions as Array<unknown>).length).toBe(2);
    expect(typeof payload.paidAt).toBe('string');

    // Belt-and-braces: the period UPDATE only flips APPROVED rows to
    // PAID — no longer "DRAFT or APPROVED" as before the fix.
    const recordUpdate = fake.capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes("update hr_payroll_records set status = 'paid'"),
    );
    expect(recordUpdate).toBeTruthy();
    expect(recordUpdate!.sql.toLowerCase()).toContain("status = 'approved'");
    expect(recordUpdate!.sql.toLowerCase()).not.toContain("'draft'");
  });

  // REVIEW-P2-4a BLOCKING #1 — deterministic event_id.
  it('deterministicPayrollEventId is stable + v5-shaped', () => {
    const id = '019e0cf8-bbb8-7556-8c81-aaaaaaaaaaaa';
    const a = deterministicPayrollEventId(id);
    const b = deterministicPayrollEventId(id);
    expect(a).toBe(b);
    // v5 marker: third group starts with '5'.
    expect(a.length).toBe(36);
    expect(a[14]).toBe('5');
    expect(['8', '9', 'a', 'b']).toContain(a[19]);
    // Different input → different output.
    expect(deterministicPayrollEventId(id.replace(/a/g, 'b'))).not.toBe(a);
  });

  it('non-admin payroll record list narrows to actor.employeeId', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => svc.listRecords({}, EMPLOYEE_ACTOR));
    const selectCall = fake.capture.find(
      (c) => c.fn === 'q' && c.sql.toLowerCase().includes('from hr_payroll_records r'),
    );
    expect(selectCall).toBeTruthy();
    expect(selectCall!.args).toContain(EMPLOYEE_ACTOR.employeeId);
  });

  it('non-admin getRecord on someone else returns collapsed 404', async () => {
    const fake = makeFake((c) => {
      if (c.sql.toLowerCase().includes('from hr_payroll_records r')) {
        return [
          {
            id: 'rec-A',
            school_id: SCHOOL.schoolId,
            employee_id: 'someone-else',
            employee_first: 'Other',
            employee_last: 'Person',
            pay_period_id: 'pp-1',
            pay_period_label: 'X',
            pay_date: '2026-05-07',
            salary_scale_id: 'sc-1',
            gross_pay: '2000',
            total_deductions: '820',
            total_adjustments: '0',
            net_pay: '1180',
            status: 'PAID',
            notes: null,
            created_at: '2026-05-09T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () => svc.getRecord('rec-A', EMPLOYEE_ACTOR)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SalaryReviewService — submission stamps requester', () => {
  it('create stamps requested_by from actor.personId', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select id from hr_employees')) return [{ id: 'emp-A' }];
      if (sql.includes('from hr_salary_review_requests r')) {
        return [
          {
            id: 'rv-1',
            school_id: SCHOOL.schoolId,
            employee_id: 'emp-A',
            employee_first: 'James',
            employee_last: 'Rivera',
            requested_by: ADMIN_ACTOR.personId,
            requestor_first: 'Admin',
            requestor_last: 'Person',
            review_type: 'PROMOTION',
            current_salary: '50000',
            recommended_salary: '60000',
            effective_date: '2026-08-01',
            justification: 'Outstanding performance',
            status: 'SUBMITTED',
            decision_notes: null,
            decided_by: null,
            decided_at: null,
            created_at: '2026-05-09T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const svc = new SalaryReviewService(fake.tenantPrisma as never, permissions as never);
    const dto = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.create(
        {
          employeeId: 'emp-A',
          reviewType: 'PROMOTION',
          currentSalary: 50000,
          recommendedSalary: 60000,
          justification: 'Outstanding performance',
        },
        ADMIN_ACTOR,
      ),
    );
    expect(dto.requestedBy).toBe(ADMIN_ACTOR.personId);
    expect(dto.status).toBe('SUBMITTED');
    const insertCall = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into hr_salary_review_requests'),
    );
    expect(insertCall).toBeTruthy();
    expect(insertCall!.args).toContain(ADMIN_ACTOR.personId);
  });
});

describe('PayrollController — REVIEW-P2-4a permission gate distribution', () => {
  const proto = PayrollController.prototype as unknown as Record<string, () => unknown>;

  function gateFor(methodName: string): string[] {
    return Reflect.getMetadata(PERMISSIONS_KEY, proto[methodName]!) ?? [];
  }

  // REVIEW-P2-4a BLOCKING #3 — admin reads carry hr-010 not hr-003.
  it('admin reads + writes carry hr-010 (not the broad hr-003)', () => {
    expect(gateFor('listGrades')).toEqual(['hr-010:read']);
    expect(gateFor('getGrade')).toEqual(['hr-010:read']);
    expect(gateFor('listScales')).toEqual(['hr-010:read']);
    expect(gateFor('listPeriods')).toEqual(['hr-010:read']);
    expect(gateFor('getPeriod')).toEqual(['hr-010:read']);
    expect(gateFor('createGrade')).toEqual(['hr-010:admin']);
    expect(gateFor('patchGrade')).toEqual(['hr-010:admin']);
    expect(gateFor('addScale')).toEqual(['hr-010:admin']);
    expect(gateFor('patchScale')).toEqual(['hr-010:admin']);
    expect(gateFor('createPeriod')).toEqual(['hr-010:admin']);
    expect(gateFor('process')).toEqual(['hr-010:admin']);
    expect(gateFor('approve')).toEqual(['hr-010:admin']);
    expect(gateFor('markPaid')).toEqual(['hr-010:admin']);
  });

  it('self-service payslip surfaces stay on hr-003:read with service narrowing', () => {
    expect(gateFor('listRecords')).toEqual(['hr-003:read']);
    expect(gateFor('getRecord')).toEqual(['hr-003:read']);
    expect(gateFor('myPayslips')).toEqual(['hr-003:read']);
  });

  it('salary review submit + patch carry hr-003:write', () => {
    // Submission stays on hr-003:write because Department Heads (and
    // any HR-003 holder) initiate reviews — the decision authority
    // narrows to hr-010 at the service layer when it transitions
    // through to APPROVED / REJECTED.
    expect(gateFor('submitReview')).toEqual(['hr-003:write']);
    expect(gateFor('patchReview')).toEqual(['hr-003:write']);
  });
});
