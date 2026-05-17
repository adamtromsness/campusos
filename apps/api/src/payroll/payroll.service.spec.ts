import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '../tenant/tenant.context';
import { PayrollService, deterministicPayrollEventId } from './payroll.service';

/**
 * P2-H4 test coverage uplift — payroll.service.ts gap-fill.
 *
 * The existing `payroll.spec.ts` covers process/markPaid/idempotency
 * keystones, the BLOCKING-fix outbox emit, and controller permission
 * metadata (19 tests, ~71% line coverage). This spec fills the gaps:
 *
 *   - listPeriods (status filter, ORDER BY, status enum mapping)
 *   - getPeriod (404 path + happy path)
 *   - createPeriod (admin gate, date validation, UNIQUE catch, happy)
 *   - processPeriod (non-existent period, wrong status, employees
 *     filter, null-scale skip, ON CONFLICT skip, explicit employeeIds)
 *   - approvePeriod (admin gate, 404, non-PROCESSING, happy path)
 *   - markPaid (non-existent period, wrong status, happy outbox)
 *   - listRecords (admin sees all, non-admin own-only + null employee,
 *     all filter combinations)
 *   - getRecord (admin sees any, non-admin own only, 404, deductions)
 *   - resolveEmployeesForProcessing (tax + benefits + scale joins,
 *     ON CONFLICT scale ordering)
 *   - materialiseRecord (full tax + benefit calc, FEDERAL_TAX absent
 *     with additional-only withholding, health/dental/vision rollup,
 *     RETIREMENT pretax, all-zero edge case)
 *   - isUniqueViolation (P2010+meta + message regex paths)
 *   - periodRowToDto / recordRowToDto / deductionRowToDto enum guards
 *
 * Mirrors the existing payroll.spec.ts makeFake / makeOutbox helpers
 * for consistency.
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

const STAFF_EMPLOYEE = {
  accountId: '019e0cf8-bbb8-7556-8c81-000000000010',
  personId: '019e0cf8-bbb8-7556-8c81-000000000011',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
  employeeId: 'emp-self',
} as never;

const STAFF_NO_EMP = {
  accountId: '019e0cf8-bbb8-7556-8c81-000000000020',
  personId: '019e0cf8-bbb8-7556-8c81-000000000021',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
  employeeId: null,
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

function periodRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'pp-1',
    school_id: SCHOOL.schoolId,
    period_label: 'Pay Period 2026-04',
    start_date: '2026-04-15',
    end_date: '2026-04-28',
    pay_date: '2026-05-07',
    status: 'OPEN',
    processed_at: null,
    paid_at: null,
    record_count: 0,
    total_gross: null,
    total_deductions: null,
    total_net: null,
    ...overrides,
  };
}

function recordRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'rec-A',
    school_id: SCHOOL.schoolId,
    employee_id: 'emp-self',
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
    status: 'DRAFT',
    notes: null,
    created_at: '2026-05-09T00:00:00Z',
    ...overrides,
  };
}

// =====================================================================
// listPeriods
// =====================================================================

describe('PayrollService.listPeriods', () => {
  it('returns DTOs ordered DESC by start_date with no status filter', async () => {
    const fake = makeFake(() => [
      periodRow({ id: 'pp-1', start_date: '2026-04-15' }),
      periodRow({ id: 'pp-2', start_date: '2026-04-01', status: 'PAID' }),
    ]);
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const result = await runWithTenantContext({ tenant: SCHOOL }, async () => svc.listPeriods({}));
    expect(result).toHaveLength(2);
    expect(result[0]!.status).toBe('OPEN');
    expect(result[1]!.status).toBe('PAID');
    const sql = fake.capture[0]!.sql.toLowerCase();
    expect(sql).toContain('order by p.start_date desc');
    expect(sql).not.toContain('and p.status = $2');
  });

  it('applies status filter via $2 param when supplied', async () => {
    const fake = makeFake(() => [periodRow({ id: 'pp-1', status: 'PROCESSING' })]);
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.listPeriods({ status: 'PROCESSING' as never }),
    );
    const call = fake.capture[0]!;
    expect(call.sql.toLowerCase()).toContain('and p.status = $2');
    expect(call.args).toEqual([SCHOOL.schoolId, 'PROCESSING']);
  });

  it('coerces null aggregate totals to 0 in the DTO', async () => {
    const fake = makeFake(() => [
      periodRow({ total_gross: null, total_deductions: null, total_net: null }),
    ]);
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const result = await runWithTenantContext({ tenant: SCHOOL }, async () => svc.listPeriods({}));
    expect(result[0]!.totalGross).toBe(0);
    expect(result[0]!.totalDeductions).toBe(0);
    expect(result[0]!.totalNet).toBe(0);
  });

  it('parses populated aggregate totals as Number', async () => {
    const fake = makeFake(() => [
      periodRow({
        record_count: 3,
        total_gross: '6000.00',
        total_deductions: '2460.00',
        total_net: '3540.00',
      }),
    ]);
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const result = await runWithTenantContext({ tenant: SCHOOL }, async () => svc.listPeriods({}));
    expect(result[0]!.totalGross).toBe(6000);
    expect(result[0]!.totalDeductions).toBe(2460);
    expect(result[0]!.totalNet).toBe(3540);
    expect(result[0]!.recordCount).toBe(3);
  });
});

// =====================================================================
// getPeriod
// =====================================================================

describe('PayrollService.getPeriod', () => {
  it('throws NotFound when no row returned', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () => svc.getPeriod('missing')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns DTO for found period', async () => {
    const fake = makeFake(() => [periodRow({ id: 'pp-1', status: 'PROCESSING' })]);
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const dto = await runWithTenantContext({ tenant: SCHOOL }, async () => svc.getPeriod('pp-1'));
    expect(dto.id).toBe('pp-1');
    expect(dto.status).toBe('PROCESSING');
  });
});

// =====================================================================
// createPeriod
// =====================================================================

describe('PayrollService.createPeriod', () => {
  it('rejects non-admin actor with Forbidden', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createPeriod(
          {
            periodLabel: 'PP 1',
            startDate: '2026-04-15',
            endDate: '2026-04-28',
            payDate: '2026-05-07',
          },
          STAFF_EMPLOYEE,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fake.capture.find((c) => c.fn === 'e')).toBeUndefined();
  });

  it('rejects endDate before startDate with BadRequest', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createPeriod(
          {
            periodLabel: 'Bad Window',
            startDate: '2026-04-28',
            endDate: '2026-04-15', // before start
            payDate: '2026-05-07',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(/endDate must be on or after startDate/);
  });

  it('rejects payDate before startDate with BadRequest', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createPeriod(
          {
            periodLabel: 'Bad PayDate',
            startDate: '2026-04-15',
            endDate: '2026-04-28',
            payDate: '2026-04-01', // before start
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(/payDate must be on or after startDate/);
  });

  it('translates UNIQUE catch (P2010 + 23505) into BadRequest', async () => {
    const fake = makeFake((c) => {
      if (c.sql.toLowerCase().includes('insert into hr_pay_periods')) {
        const err: any = new Error('unique violation');
        err.code = 'P2010';
        err.meta = { code: '23505' };
        throw err;
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
        svc.createPeriod(
          {
            periodLabel: 'Duplicate',
            startDate: '2026-04-15',
            endDate: '2026-04-28',
            payDate: '2026-05-07',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(/A pay period already exists/);
  });

  it('rethrows non-UNIQUE errors verbatim', async () => {
    const fake = makeFake((c) => {
      if (c.sql.toLowerCase().includes('insert into hr_pay_periods')) {
        throw new Error('FK violation');
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
        svc.createPeriod(
          {
            periodLabel: 'Boom',
            startDate: '2026-04-15',
            endDate: '2026-04-28',
            payDate: '2026-05-07',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(/FK violation/);
  });

  it('happy path: INSERT carries every positional arg + returns reloaded DTO', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('insert into hr_pay_periods')) return 1;
      if (sql.includes('from hr_pay_periods')) return [periodRow({ id: 'pp-new' })];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const result = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.createPeriod(
        {
          periodLabel: 'Pay Period 2026-04',
          startDate: '2026-04-15',
          endDate: '2026-04-28',
          payDate: '2026-05-07',
        },
        ADMIN_ACTOR,
      ),
    );
    expect(result.id).toBe('pp-new');
    const insertCall = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into hr_pay_periods'),
    );
    expect(insertCall).toBeTruthy();
    expect(insertCall!.args[1]).toBe(SCHOOL.schoolId);
    expect(insertCall!.args[2]).toBe('Pay Period 2026-04');
    expect(insertCall!.args[3]).toBe('2026-04-15');
    expect(insertCall!.args[4]).toBe('2026-04-28');
    expect(insertCall!.args[5]).toBe('2026-05-07');
  });
});

// =====================================================================
// processPeriod (gap-fill on top of payroll.spec.ts coverage)
// =====================================================================

describe('PayrollService.processPeriod — gap fill', () => {
  it('rejects non-admin with Forbidden before any SQL fires', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.processPeriod('pp-1', {}, STAFF_EMPLOYEE),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fake.capture.find((c) => c.fn === 'e')).toBeUndefined();
  });

  it('throws NotFound when the period lookup returns no rows', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.processPeriod('pp-missing', {}, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses APPROVED period with BadRequest mentioning the current status', async () => {
    const fake = makeFake((c) => {
      if (c.sql.toLowerCase().includes('for update'))
        return [{ id: 'pp-1', status: 'APPROVED' }];
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
    ).rejects.toThrow(/in status APPROVED/);
  });

  it('counts employees with null scaleId as skipped without writing a record', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) return [{ id: 'pp-1', status: 'OPEN' }];
      if (sql.includes('from hr_employees') && sql.includes('order by e.id'))
        return [{ id: 'emp-no-scale' }];
      if (sql.includes('from hr_employee_tax_info')) return [];
      if (sql.includes('from hr_employee_benefits')) return [];
      if (sql.includes('from hr_employee_positions ep')) return []; // no scale row
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const r = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.processPeriod('pp-1', {}, ADMIN_ACTOR),
    );
    expect(r).toEqual({ processed: 0, skipped: 1 });
    // No INSERT into hr_payroll_records fired since scale was null
    expect(
      fake.capture.find(
        (c) =>
          c.fn === 'q' && c.sql.toLowerCase().includes('insert into hr_payroll_records'),
      ),
    ).toBeUndefined();
  });

  it('passes explicit employeeIds through as ANY($)::uuid[] filter', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) return [{ id: 'pp-1', status: 'OPEN' }];
      if (sql.includes('from hr_employees') && sql.includes('order by e.id')) return [];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.processPeriod('pp-1', { employeeIds: ['emp-A', 'emp-B'] }, ADMIN_ACTOR),
    );
    const empQuery = fake.capture.find(
      (c) => c.sql.toLowerCase().includes('from hr_employees') && c.sql.toLowerCase().includes('order by e.id'),
    );
    expect(empQuery).toBeTruthy();
    expect(empQuery!.sql.toLowerCase()).toContain('any($2::uuid[])');
    expect(empQuery!.args).toEqual([SCHOOL.schoolId, ['emp-A', 'emp-B']]);
    // No explicit employeeIds means ACTIVE filter — opposite case
  });

  it('default path (no employeeIds) adds employment_status=ACTIVE predicate', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) return [{ id: 'pp-1', status: 'OPEN' }];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.processPeriod('pp-1', {}, ADMIN_ACTOR),
    );
    const empQuery = fake.capture.find((c) =>
      c.sql.toLowerCase().includes('from hr_employees'),
    );
    expect(empQuery!.sql.toLowerCase()).toContain("employment_status = 'active'");
  });

  it('flips period to PROCESSING with actor.accountId stamped in processed_by', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) return [{ id: 'pp-1', status: 'OPEN' }];
      if (sql.includes('from hr_employees') && sql.includes('order by e.id')) return [];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.processPeriod('pp-1', {}, ADMIN_ACTOR),
    );
    const updateCall = fake.capture.find(
      (c) =>
        c.fn === 'e' && c.sql.toLowerCase().includes('update hr_pay_periods set status = $1'),
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall!.args).toEqual([
      'PROCESSING',
      ADMIN_ACTOR.accountId,
      SCHOOL.schoolId,
      'pp-1',
    ]);
  });

  it('handles materialised employee with full tax + benefits + scale shape', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) return [{ id: 'pp-1', status: 'OPEN' }];
      if (sql.includes('from hr_employees') && sql.includes('order by e.id'))
        return [{ id: 'emp-A' }];
      if (sql.includes('from hr_employee_tax_info'))
        return [
          {
            employee_id: 'emp-A',
            federal_allowances: 2,
            state_allowances: 1,
            additional: '25.00',
          },
        ];
      if (sql.includes('from hr_employee_benefits'))
        return [
          { employee_id: 'emp-A', benefit_type: 'HEALTH', employee_contribution: '80.00' },
          { employee_id: 'emp-A', benefit_type: 'DENTAL', employee_contribution: '15.00' },
          { employee_id: 'emp-A', benefit_type: 'RETIREMENT', employee_contribution: '100.00' },
        ];
      if (sql.includes('from hr_employee_positions ep'))
        return [{ employee_id: 'emp-A', salary_scale_id: 'sc-1', annual_salary: '52000' }];
      if (sql.includes('insert into hr_payroll_records'))
        return [{ id: 'rec-new' }]; // inserted
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const r = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.processPeriod('pp-1', {}, ADMIN_ACTOR),
    );
    expect(r).toEqual({ processed: 1, skipped: 0 });
    // 5 deductions expected: FEDERAL_TAX, STATE_TAX, SS, MEDICARE, HEALTH+DENTAL bucket, RETIREMENT
    const deductionInserts = fake.capture.filter(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into hr_payroll_deductions'),
    );
    expect(deductionInserts.length).toBeGreaterThanOrEqual(5);
    // FEDERAL_TAX deduction should include additional withholding
    const federalIns = deductionInserts.find((c) => c.args[2] === 'FEDERAL_TAX');
    expect(federalIns).toBeTruthy();
  });

  it('skips duplicate scale rows for the same employee (first row wins)', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) return [{ id: 'pp-1', status: 'OPEN' }];
      if (sql.includes('from hr_employees') && sql.includes('order by e.id'))
        return [{ id: 'emp-X' }];
      if (sql.includes('from hr_employee_tax_info')) return [];
      if (sql.includes('from hr_employee_benefits')) return [];
      if (sql.includes('from hr_employee_positions ep'))
        return [
          { employee_id: 'emp-X', salary_scale_id: 'sc-1', annual_salary: '52000' },
          { employee_id: 'emp-X', salary_scale_id: 'sc-OLD', annual_salary: '40000' },
        ];
      if (sql.includes('insert into hr_payroll_records')) return [{ id: 'rec-X' }];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const r = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.processPeriod('pp-1', {}, ADMIN_ACTOR),
    );
    expect(r).toEqual({ processed: 1, skipped: 0 });
    // Check that the insert carried the FIRST scale's salary_scale_id
    const recordInsert = fake.capture.find(
      (c) => c.fn === 'q' && c.sql.toLowerCase().includes('insert into hr_payroll_records'),
    );
    expect(recordInsert!.args[4]).toBe('sc-1'); // first scale wins
  });
});

// =====================================================================
// approvePeriod
// =====================================================================

describe('PayrollService.approvePeriod', () => {
  it('rejects non-admin with Forbidden', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.approvePeriod('pp-1', STAFF_EMPLOYEE),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws NotFound when period lookup returns no rows', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.approvePeriod('pp-missing', ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses period in OPEN status (only PROCESSING can be approved)', async () => {
    const fake = makeFake((c) => {
      if (c.sql.toLowerCase().includes('for update')) return [{ id: 'pp-1', status: 'OPEN' }];
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
        svc.approvePeriod('pp-1', ADMIN_ACTOR),
      ),
    ).rejects.toThrow(/Only PROCESSING periods can be approved/);
  });

  it('flips DRAFT records to APPROVED in same tx and returns reloaded DTO', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) return [{ id: 'pp-1', status: 'PROCESSING' }];
      if (sql.includes('from hr_pay_periods'))
        return [periodRow({ id: 'pp-1', status: 'PROCESSING' })];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const dto = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.approvePeriod('pp-1', ADMIN_ACTOR),
    );
    expect(dto.id).toBe('pp-1');
    const updateCall = fake.capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes("update hr_payroll_records set status = 'approved'"),
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall!.args).toEqual([SCHOOL.schoolId, 'pp-1']);
  });
});

// =====================================================================
// markPaid — gap fill (existing spec covers BLOCKING #1 + #2)
// =====================================================================

describe('PayrollService.markPaid — gap fill', () => {
  it('rejects non-admin with Forbidden before any SQL fires', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.markPaid('pp-1', STAFF_EMPLOYEE),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fake.capture.find((c) => c.fn === 'e')).toBeUndefined();
  });

  it('throws NotFound when period lookup returns no rows', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.markPaid('pp-missing', ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses non-PROCESSING period (e.g. OPEN)', async () => {
    const fake = makeFake((c) => {
      if (c.sql.toLowerCase().includes('for update')) return [{ id: 'pp-1', status: 'OPEN' }];
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
        svc.markPaid('pp-1', ADMIN_ACTOR),
      ),
    ).rejects.toThrow(/Only PROCESSING periods can be marked PAID/);
  });

  it('happy path with 0 records still flips period to PAID + no outbox emit', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) return [{ id: 'pp-1', status: 'PROCESSING' }];
      if (sql.includes('count(*)::int as n')) return [{ n: 0 }];
      if (sql.includes('from hr_payroll_records r')) return []; // 0 records
      if (sql.includes('from hr_pay_periods'))
        return [periodRow({ id: 'pp-1', status: 'PAID' })];
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
    expect(dto.id).toBe('pp-1');
    expect(enqueued).toHaveLength(0);
    // hr_pay_periods + hr_payroll_records UPDATEs both fired
    const periodUpd = fake.capture.find(
      (c) =>
        c.fn === 'e' && c.sql.toLowerCase().includes("update hr_pay_periods set status = 'paid'"),
    );
    expect(periodUpd).toBeTruthy();
    const recordUpd = fake.capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes("update hr_payroll_records set status = 'paid'"),
    );
    expect(recordUpd).toBeTruthy();
  });

  it('happy path with multiple records emits one outbox row per record with deterministic eventId', async () => {
    const recIds = [
      '019e0cf8-bbb8-7556-8c81-aaaaaaaaaaa1',
      '019e0cf8-bbb8-7556-8c81-aaaaaaaaaaa2',
    ];
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) return [{ id: 'pp-1', status: 'PROCESSING' }];
      if (sql.includes('count(*)::int as n')) return [{ n: 0 }];
      if (sql.includes('from hr_payroll_records r'))
        return recIds.map((id) => recordRow({ id, status: 'PAID' }));
      if (sql.includes('from hr_payroll_deductions'))
        return [
          {
            id: 'd-1',
            payroll_record_id: recIds[0],
            deduction_type: 'FEDERAL_TAX',
            description: null,
            amount: '400.00',
            is_pretax: false,
          },
        ];
      if (sql.includes('from hr_pay_periods'))
        return [periodRow({ id: 'pp-1', status: 'PAID' })];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox, enqueued } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.markPaid('pp-1', ADMIN_ACTOR),
    );
    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]!.topic).toBe('hr.payroll.processed');
    expect(enqueued[0]!.sourceModule).toBe('hr-payroll');
    expect(enqueued[0]!.eventId).toBe(deterministicPayrollEventId(recIds[0]!));
    expect(enqueued[1]!.eventId).toBe(deterministicPayrollEventId(recIds[1]!));
    // First record carries the FEDERAL_TAX deduction row
    expect((enqueued[0]!.payload.deductions as any[])).toEqual([
      { type: 'FEDERAL_TAX', amount: 400, isPretax: false },
    ]);
    // Second record has no deductions (we only seeded one matching row)
    expect((enqueued[1]!.payload.deductions as any[])).toEqual([]);
  });
});

// =====================================================================
// listRecords
// =====================================================================

describe('PayrollService.listRecords', () => {
  it('admin sees all records — no employee filter in WHERE', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from hr_payroll_records r'))
        return [recordRow({ id: 'rec-A' }), recordRow({ id: 'rec-B', employee_id: 'emp-other' })];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const result = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.listRecords({}, ADMIN_ACTOR),
    );
    expect(result).toHaveLength(2);
    // Should not include "and r.employee_id" filter when admin without employeeId arg
    const mainQ = fake.capture.find(
      (c) => c.fn === 'q' && c.sql.toLowerCase().includes('from hr_payroll_records r'),
    );
    expect(mainQ!.sql.toLowerCase()).not.toContain('and r.employee_id');
  });

  it('non-admin without employeeId returns [] without any SQL', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const result = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.listRecords({}, STAFF_NO_EMP),
    );
    expect(result).toEqual([]);
    expect(fake.capture).toHaveLength(0);
  });

  it('non-admin with employeeId narrows to actor.employeeId', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from hr_payroll_records r'))
        return [recordRow({ id: 'rec-self', employee_id: 'emp-self' })];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const result = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.listRecords({}, STAFF_EMPLOYEE),
    );
    expect(result).toHaveLength(1);
    const mainQ = fake.capture.find(
      (c) => c.fn === 'q' && c.sql.toLowerCase().includes('from hr_payroll_records r'),
    );
    expect(mainQ!.args).toContain('emp-self');
  });

  it('admin with explicit employeeId filter narrows server-side', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from hr_payroll_records r')) return [];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.listRecords({ employeeId: 'emp-target' } as never, ADMIN_ACTOR),
    );
    const mainQ = fake.capture.find(
      (c) => c.fn === 'q' && c.sql.toLowerCase().includes('from hr_payroll_records r'),
    );
    expect(mainQ!.args).toContain('emp-target');
  });

  it('applies all 3 filters together (payPeriodId + employeeId + status)', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from hr_payroll_records r')) return [];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.listRecords(
        { payPeriodId: 'pp-1', employeeId: 'emp-target', status: 'PAID' } as never,
        ADMIN_ACTOR,
      ),
    );
    const mainQ = fake.capture.find(
      (c) => c.fn === 'q' && c.sql.toLowerCase().includes('from hr_payroll_records r'),
    );
    expect(mainQ!.sql.toLowerCase()).toContain('and r.pay_period_id = $');
    expect(mainQ!.sql.toLowerCase()).toContain('and r.employee_id = $');
    expect(mainQ!.sql.toLowerCase()).toContain('and r.status = $');
    expect(mainQ!.args).toEqual([SCHOOL.schoolId, 'pp-1', 'emp-target', 'PAID']);
  });

  it('joins deductions per-record + maps them to DTOs', async () => {
    const recId = 'rec-with-deds';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from hr_payroll_records r'))
        return [recordRow({ id: recId, employee_id: 'emp-self' })];
      if (sql.includes('from hr_payroll_deductions'))
        return [
          {
            id: 'd-1',
            payroll_record_id: recId,
            deduction_type: 'FEDERAL_TAX',
            description: null,
            amount: '400.00',
            is_pretax: false,
          },
          {
            id: 'd-2',
            payroll_record_id: recId,
            deduction_type: 'MEDICARE',
            description: 'Medicare 1.45%',
            amount: '29.00',
            is_pretax: false,
          },
        ];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const result = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.listRecords({}, ADMIN_ACTOR),
    );
    expect(result[0]!.deductions).toHaveLength(2);
    expect(result[0]!.deductions[0]!.amount).toBe(400);
    expect(result[0]!.deductions[1]!.description).toBe('Medicare 1.45%');
    expect(result[0]!.deductions[1]!.amount).toBe(29);
  });

  it('handles empty record list — does not query deductions', async () => {
    const fake = makeFake((c) => {
      if (c.sql.toLowerCase().includes('from hr_payroll_records r')) return [];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const result = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.listRecords({}, ADMIN_ACTOR),
    );
    expect(result).toEqual([]);
    // No follow-up deductions query
    expect(
      fake.capture.find(
        (c) => c.sql.toLowerCase().includes('from hr_payroll_deductions'),
      ),
    ).toBeUndefined();
  });
});

// =====================================================================
// getRecord
// =====================================================================

describe('PayrollService.getRecord', () => {
  it('throws NotFound when no row returned', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () => svc.getRecord('rec-missing', ADMIN_ACTOR)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('non-admin reading another employee\'s record gets 404 don\'t-leak-existence', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from hr_payroll_records r'))
        return [recordRow({ id: 'rec-other', employee_id: 'emp-someone-else' })];
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
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.getRecord('rec-other', STAFF_EMPLOYEE),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('non-admin reading own record returns DTO with deductions', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from hr_payroll_records r'))
        return [recordRow({ id: 'rec-self', employee_id: 'emp-self' })];
      if (sql.includes('from hr_payroll_deductions'))
        return [
          {
            id: 'd-1',
            payroll_record_id: 'rec-self',
            deduction_type: 'STATE_TAX',
            description: null,
            amount: '120.00',
            is_pretax: false,
          },
        ];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const dto = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.getRecord('rec-self', STAFF_EMPLOYEE),
    );
    expect(dto.id).toBe('rec-self');
    expect(dto.employeeName).toBe('James Rivera');
    expect(dto.deductions).toHaveLength(1);
    expect(dto.deductions[0]!.deductionType).toBe('STATE_TAX');
  });

  it('admin reading any record returns DTO regardless of employee match', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from hr_payroll_records r'))
        return [recordRow({ id: 'rec-other', employee_id: 'emp-someone' })];
      if (sql.includes('from hr_payroll_deductions')) return [];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const dto = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.getRecord('rec-other', ADMIN_ACTOR),
    );
    expect(dto.id).toBe('rec-other');
    expect(dto.deductions).toEqual([]);
  });

  it('handles missing employee_first/last by returning null name', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from hr_payroll_records r'))
        return [
          recordRow({
            id: 'rec-noname',
            employee_id: 'emp-self',
            employee_first: null,
            employee_last: null,
          }),
        ];
      if (sql.includes('from hr_payroll_deductions')) return [];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const dto = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.getRecord('rec-noname', ADMIN_ACTOR),
    );
    expect(dto.employeeName).toBeNull();
  });
});

// =====================================================================
// materialiseRecord — exercised through processPeriod
// =====================================================================

describe('PayrollService.materialiseRecord — tax + deduction calc paths', () => {
  it('flat-rate tax with zero allowances: gross 2000 → fed 400, state 120, SS 124, medicare 29', async () => {
    // annual_salary=52000 → bi-weekly gross = 2000
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) return [{ id: 'pp-1', status: 'OPEN' }];
      if (sql.includes('from hr_employees') && sql.includes('order by e.id'))
        return [{ id: 'emp-A' }];
      if (sql.includes('from hr_employee_tax_info'))
        return [
          {
            employee_id: 'emp-A',
            federal_allowances: 0,
            state_allowances: 0,
            additional: '0.00',
          },
        ];
      if (sql.includes('from hr_employee_benefits')) return [];
      if (sql.includes('from hr_employee_positions ep'))
        return [{ employee_id: 'emp-A', salary_scale_id: 'sc-1', annual_salary: '52000' }];
      if (sql.includes('insert into hr_payroll_records')) return [{ id: 'rec-A' }];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.processPeriod('pp-1', {}, ADMIN_ACTOR),
    );
    const recordInsert = fake.capture.find(
      (c) => c.fn === 'q' && c.sql.toLowerCase().includes('insert into hr_payroll_records'),
    );
    // grossPay = 2000.00
    expect(recordInsert!.args[5]).toBe(2000);
    // 4 deductions: FEDERAL 400, STATE 120, SS 124, MEDICARE 29 = 673
    expect(recordInsert!.args[6]).toBe(673);
    // net = 2000 - 673 = 1327
    expect(recordInsert!.args[7]).toBe(1327);
  });

  it('federal allowances reduce federal tax via $50/allowance', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) return [{ id: 'pp-1', status: 'OPEN' }];
      if (sql.includes('from hr_employees') && sql.includes('order by e.id'))
        return [{ id: 'emp-A' }];
      if (sql.includes('from hr_employee_tax_info'))
        return [
          {
            employee_id: 'emp-A',
            federal_allowances: 4, // -200 from federal tax
            state_allowances: 0,
            additional: '0.00',
          },
        ];
      if (sql.includes('from hr_employee_benefits')) return [];
      if (sql.includes('from hr_employee_positions ep'))
        return [{ employee_id: 'emp-A', salary_scale_id: 'sc-1', annual_salary: '52000' }];
      if (sql.includes('insert into hr_payroll_records')) return [{ id: 'rec-A' }];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.processPeriod('pp-1', {}, ADMIN_ACTOR),
    );
    const federalIns = fake.capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('insert into hr_payroll_deductions') &&
        c.args[2] === 'FEDERAL_TAX',
    );
    // 2000 * 0.2 = 400, minus 4 allowances * $50 = $200, plus $0 additional = $200
    expect(federalIns!.args[3]).toBe(200);
  });

  it('zero federal tax + non-zero additional withholding creates FEDERAL_TAX line with only additional', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) return [{ id: 'pp-1', status: 'OPEN' }];
      if (sql.includes('from hr_employees') && sql.includes('order by e.id'))
        return [{ id: 'emp-A' }];
      if (sql.includes('from hr_employee_tax_info'))
        return [
          {
            employee_id: 'emp-A',
            federal_allowances: 50, // 50 * $50 = $2500 reduction → zero federal tax on $400 base
            state_allowances: 0,
            additional: '75.00',
          },
        ];
      if (sql.includes('from hr_employee_benefits')) return [];
      if (sql.includes('from hr_employee_positions ep'))
        return [{ employee_id: 'emp-A', salary_scale_id: 'sc-1', annual_salary: '52000' }];
      if (sql.includes('insert into hr_payroll_records')) return [{ id: 'rec-A' }];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.processPeriod('pp-1', {}, ADMIN_ACTOR),
    );
    const federalIns = fake.capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('insert into hr_payroll_deductions') &&
        c.args[2] === 'FEDERAL_TAX',
    );
    // base federal=0, additional=75 → line is 75
    expect(federalIns!.args[3]).toBe(75);
  });

  it('zero state tax (high state allowances) suppresses STATE_TAX deduction line', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) return [{ id: 'pp-1', status: 'OPEN' }];
      if (sql.includes('from hr_employees') && sql.includes('order by e.id'))
        return [{ id: 'emp-A' }];
      if (sql.includes('from hr_employee_tax_info'))
        return [
          {
            employee_id: 'emp-A',
            federal_allowances: 0,
            state_allowances: 99, // 99 * $25 = $2475 reduction → state tax max(0, ...) = 0
            additional: '0.00',
          },
        ];
      if (sql.includes('from hr_employee_benefits')) return [];
      if (sql.includes('from hr_employee_positions ep'))
        return [{ employee_id: 'emp-A', salary_scale_id: 'sc-1', annual_salary: '52000' }];
      if (sql.includes('insert into hr_payroll_records')) return [{ id: 'rec-A' }];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.processPeriod('pp-1', {}, ADMIN_ACTOR),
    );
    const stateIns = fake.capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('insert into hr_payroll_deductions') &&
        c.args[2] === 'STATE_TAX',
    );
    expect(stateIns).toBeUndefined(); // no STATE_TAX line emitted
  });

  it('rolls up HEALTH + DENTAL + VISION into a single HEALTH_INSURANCE pretax line', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) return [{ id: 'pp-1', status: 'OPEN' }];
      if (sql.includes('from hr_employees') && sql.includes('order by e.id'))
        return [{ id: 'emp-A' }];
      if (sql.includes('from hr_employee_tax_info'))
        return [
          {
            employee_id: 'emp-A',
            federal_allowances: 0,
            state_allowances: 0,
            additional: '0.00',
          },
        ];
      if (sql.includes('from hr_employee_benefits'))
        return [
          { employee_id: 'emp-A', benefit_type: 'HEALTH', employee_contribution: '50.00' },
          { employee_id: 'emp-A', benefit_type: 'DENTAL', employee_contribution: '15.00' },
          { employee_id: 'emp-A', benefit_type: 'VISION', employee_contribution: '5.00' },
        ];
      if (sql.includes('from hr_employee_positions ep'))
        return [{ employee_id: 'emp-A', salary_scale_id: 'sc-1', annual_salary: '52000' }];
      if (sql.includes('insert into hr_payroll_records')) return [{ id: 'rec-A' }];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.processPeriod('pp-1', {}, ADMIN_ACTOR),
    );
    const healthIns = fake.capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('insert into hr_payroll_deductions') &&
        c.args[2] === 'HEALTH_INSURANCE',
    );
    expect(healthIns).toBeTruthy();
    expect(healthIns!.args[3]).toBe(70); // 50 + 15 + 5
    expect(healthIns!.args[4]).toBe(true); // isPretax
  });

  it('emits RETIREMENT as a separate pretax line', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) return [{ id: 'pp-1', status: 'OPEN' }];
      if (sql.includes('from hr_employees') && sql.includes('order by e.id'))
        return [{ id: 'emp-A' }];
      if (sql.includes('from hr_employee_tax_info'))
        return [
          {
            employee_id: 'emp-A',
            federal_allowances: 0,
            state_allowances: 0,
            additional: '0.00',
          },
        ];
      if (sql.includes('from hr_employee_benefits'))
        return [
          { employee_id: 'emp-A', benefit_type: 'RETIREMENT', employee_contribution: '150.00' },
        ];
      if (sql.includes('from hr_employee_positions ep'))
        return [{ employee_id: 'emp-A', salary_scale_id: 'sc-1', annual_salary: '52000' }];
      if (sql.includes('insert into hr_payroll_records')) return [{ id: 'rec-A' }];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.processPeriod('pp-1', {}, ADMIN_ACTOR),
    );
    const retireIns = fake.capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('insert into hr_payroll_deductions') &&
        c.args[2] === 'RETIREMENT',
    );
    expect(retireIns).toBeTruthy();
    expect(retireIns!.args[3]).toBe(150);
    expect(retireIns!.args[4]).toBe(true);
  });

  it('ON CONFLICT DO NOTHING skips deductions insert (idempotent path)', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) return [{ id: 'pp-1', status: 'OPEN' }];
      if (sql.includes('from hr_employees') && sql.includes('order by e.id'))
        return [{ id: 'emp-A' }];
      if (sql.includes('from hr_employee_tax_info')) return [];
      if (sql.includes('from hr_employee_benefits')) return [];
      if (sql.includes('from hr_employee_positions ep'))
        return [{ employee_id: 'emp-A', salary_scale_id: 'sc-1', annual_salary: '52000' }];
      if (sql.includes('insert into hr_payroll_records')) return []; // ON CONFLICT DO NOTHING
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const result = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.processPeriod('pp-1', {}, ADMIN_ACTOR),
    );
    expect(result).toEqual({ processed: 0, skipped: 1 });
    // No deduction inserts since the record claim was lost
    expect(
      fake.capture.find(
        (c) =>
          c.fn === 'e' && c.sql.toLowerCase().includes('insert into hr_payroll_deductions'),
      ),
    ).toBeUndefined();
  });
});

// =====================================================================
// periodRowToDto / recordRowToDto / deductionRowToDto enum guards
// =====================================================================

describe('DTO mappers — status enum guards', () => {
  it('listPeriods throws ConflictException on unexpected period status', async () => {
    const fake = makeFake(() => [periodRow({ status: 'GARBAGE_VALUE' })]);
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new PayrollService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () => svc.listPeriods({})),
    ).rejects.toThrow(/Unexpected pay period status/);
  });

  it('listRecords throws ConflictException on unexpected record status', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from hr_payroll_records r'))
        return [recordRow({ status: 'BOGUS_STATUS' })];
      if (sql.includes('from hr_payroll_deductions')) return [];
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
      runWithTenantContext({ tenant: SCHOOL }, async () => svc.listRecords({}, ADMIN_ACTOR)),
    ).rejects.toThrow(/Unexpected payroll record status/);
  });
});

// =====================================================================
// isUniqueViolation (exercised through createPeriod)
// =====================================================================

describe('PayrollService.isUniqueViolation — error classification', () => {
  it('matches err.message regex /unique/i path', async () => {
    const fake = makeFake((c) => {
      if (c.sql.toLowerCase().includes('insert into hr_pay_periods')) {
        // No P2010/meta — fallback to message-regex path
        throw new Error('duplicate UNIQUE key on hr_pay_periods_school_id_start_date_key');
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
        svc.createPeriod(
          {
            periodLabel: 'X',
            startDate: '2026-04-15',
            endDate: '2026-04-28',
            payDate: '2026-05-07',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(/A pay period already exists/);
  });

  it('non-UNIQUE error with P2010 but no 23505 meta rethrows', async () => {
    const fake = makeFake((c) => {
      if (c.sql.toLowerCase().includes('insert into hr_pay_periods')) {
        const err: any = new Error('foreign key violation');
        err.code = 'P2010';
        err.meta = { code: '23503' }; // FK violation, not unique
        throw err;
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
        svc.createPeriod(
          {
            periodLabel: 'X',
            startDate: '2026-04-15',
            endDate: '2026-04-28',
            payDate: '2026-05-07',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(/foreign key violation/); // rethrows original, not the friendly message
  });
});
