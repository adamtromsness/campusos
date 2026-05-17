import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '@shared/tenant/tenant.context';
import { PaymentPlanService } from './payment-plan.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';

/**
 * P2-H4 test coverage uplift — payments/payment-plan.service.ts (197 LOC,
 * Tier 1 Financial).
 *
 * Auto-generates the installment rows in the same tx as the plan INSERT so
 * the plan + installments land atomically. Installment due_dates =
 * start_date + n * (MONTHLY=1 month | QUARTERLY=3 months) for n in
 * 0..installment_count-1. The last installment absorbs sub-cent residue
 * so SUM(installments.amount) === total_amount exactly.
 *
 * Schema enforces UNIQUE(invoice_id) — pre-flight existence check rejects
 * a second-plan-on-same-invoice attempt before the INSERT.
 *
 * Tests cover:
 *   - create() admin gate, installment count >= 2, invoice NotFound,
 *     PAID/CANCELLED status rejection, duplicate-plan rejection, total
 *     split + residue on last installment, MONTHLY vs QUARTERLY cadence
 *   - getById() returns plan + installments; NotFound on miss
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

interface CapturedCall {
  sql: string;
  args: unknown[];
  fn: 'q' | 'e';
}

interface PlanRow {
  id: string;
  school_id: string;
  family_account_id: string;
  invoice_id: string;
  total_amount: string;
  installment_count: number;
  frequency: string;
  start_date: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface FakeOpts {
  rowsForInvoiceLock?: Array<{
    id: string;
    family_account_id: string;
    total_amount: string;
    status: string;
  }>;
  rowsForExistingPlan?: Array<{ id: string }>;
  rowsForPlanById?: PlanRow[];
  rowsForInstallments?: unknown[];
}

function makeFake(opts: FakeOpts = {}) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'q' });
      const s = sql.toLowerCase();
      if (s.includes('from pay_invoices') && s.includes('for update')) {
        return opts.rowsForInvoiceLock ?? [];
      }
      if (s.includes('from pay_payment_plans where invoice_id')) {
        return opts.rowsForExistingPlan ?? [];
      }
      if (s.includes('from pay_payment_plans')) {
        return opts.rowsForPlanById ?? [];
      }
      if (s.includes('from pay_payment_plan_installments')) {
        return opts.rowsForInstallments ?? [];
      }
      return [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'e' });
      return 1;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
    executeInTenantTransaction: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
  };
  return { tenantPrisma, client, capture };
}

async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant: SCHOOL }, fn);
}

const adminActor: ResolvedActor = {
  accountId: 'acc-admin',
  personId: 'pers-admin',
  personType: 'STAFF',
  isSchoolAdmin: true,
  employeeId: 'emp-admin',
};

const guardianActor: ResolvedActor = {
  accountId: 'acc-david',
  personId: 'pers-david',
  personType: 'GUARDIAN',
  isSchoolAdmin: false,
  employeeId: null,
};

const sampleInvoiceLock = {
  id: 'inv-1',
  family_account_id: 'fa-1',
  total_amount: '1200',
  status: 'SENT',
};

const samplePlanRow: PlanRow = {
  id: 'plan-1',
  school_id: SCHOOL.schoolId,
  family_account_id: 'fa-1',
  invoice_id: 'inv-1',
  total_amount: '1200',
  installment_count: 4,
  frequency: 'MONTHLY',
  start_date: '2026-01-01',
  status: 'ACTIVE',
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

describe('PaymentPlanService.create — guardrails', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new PaymentPlanService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(
          'inv-1',
          { installmentCount: 4, frequency: 'MONTHLY', startDate: '2026-01-01' } as never,
          guardianActor,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('rejects installmentCount < 2', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new PaymentPlanService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(
          'inv-1',
          { installmentCount: 1, frequency: 'MONTHLY', startDate: '2026-01-01' } as never,
          adminActor,
        ),
      ).rejects.toThrow('installmentCount must be >= 2');
      await expect(
        svc.create(
          'inv-1',
          { installmentCount: 0, frequency: 'MONTHLY', startDate: '2026-01-01' } as never,
          adminActor,
        ),
      ).rejects.toThrow('installmentCount must be >= 2');
    });
  });

  it('NotFound when invoice missing', async () => {
    const { tenantPrisma } = makeFake({ rowsForInvoiceLock: [] });
    const svc = new PaymentPlanService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(
          'inv-missing',
          { installmentCount: 4, frequency: 'MONTHLY', startDate: '2026-01-01' } as never,
          adminActor,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  it('rejects PAID invoice', async () => {
    const { tenantPrisma } = makeFake({
      rowsForInvoiceLock: [{ ...sampleInvoiceLock, status: 'PAID' }],
    });
    const svc = new PaymentPlanService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(
          'inv-1',
          { installmentCount: 4, frequency: 'MONTHLY', startDate: '2026-01-01' } as never,
          adminActor,
        ),
      ).rejects.toThrow(/Cannot create payment plan on invoice in status PAID/);
    });
  });

  it('rejects CANCELLED invoice', async () => {
    const { tenantPrisma } = makeFake({
      rowsForInvoiceLock: [{ ...sampleInvoiceLock, status: 'CANCELLED' }],
    });
    const svc = new PaymentPlanService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(
          'inv-1',
          { installmentCount: 4, frequency: 'MONTHLY', startDate: '2026-01-01' } as never,
          adminActor,
        ),
      ).rejects.toThrow(/Cannot create payment plan on invoice in status CANCELLED/);
    });
  });

  it('rejects when invoice already has a payment plan (pre-flight UNIQUE catch)', async () => {
    const { tenantPrisma } = makeFake({
      rowsForInvoiceLock: [sampleInvoiceLock],
      rowsForExistingPlan: [{ id: 'plan-existing' }],
    });
    const svc = new PaymentPlanService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(
          'inv-1',
          { installmentCount: 4, frequency: 'MONTHLY', startDate: '2026-01-01' } as never,
          adminActor,
        ),
      ).rejects.toThrow('Invoice already has a payment plan');
    });
  });
});

describe('PaymentPlanService.create — happy path + installment generation', () => {
  it('creates plan + 4 MONTHLY installments with equal split (no residue)', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForInvoiceLock: [sampleInvoiceLock],
      rowsForExistingPlan: [],
      rowsForPlanById: [samplePlanRow],
    });
    const svc = new PaymentPlanService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.create(
        'inv-1',
        { installmentCount: 4, frequency: 'MONTHLY', startDate: '2026-01-01' } as never,
        adminActor,
      );
    });
    const planInsert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_payment_plans'),
    );
    expect(planInsert).toBeTruthy();
    expect(planInsert!.args).toContain('1200.00');
    expect(planInsert!.args).toContain(4);
    expect(planInsert!.args).toContain('MONTHLY');
    const installInserts = capture.filter(
      (c) =>
        c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_payment_plan_installments'),
    );
    expect(installInserts).toHaveLength(4);
    // All four installments should be 300.00 ($1200 / 4 = $300 evenly)
    for (const ins of installInserts) {
      expect(ins.args).toContain('300.00');
    }
    // Due dates walk monthly Jan→Feb→Mar→Apr 2026
    const dueDates = installInserts.map((c) => c.args[4] as string);
    expect(dueDates).toEqual(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']);
    // Installment numbers 1..4
    const numbers = installInserts.map((c) => c.args[2] as number);
    expect(numbers).toEqual([1, 2, 3, 4]);
  });

  it('last installment absorbs sub-cent residue when total does not divide evenly', async () => {
    // $1000 / 3 = $333.33 each → 3 * 333.33 = $999.99 → last installment = $333.34
    const { tenantPrisma, capture } = makeFake({
      rowsForInvoiceLock: [{ ...sampleInvoiceLock, total_amount: '1000' }],
      rowsForExistingPlan: [],
      rowsForPlanById: [samplePlanRow],
    });
    const svc = new PaymentPlanService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.create(
        'inv-1',
        { installmentCount: 3, frequency: 'MONTHLY', startDate: '2026-01-01' } as never,
        adminActor,
      );
    });
    const installInserts = capture.filter(
      (c) =>
        c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_payment_plan_installments'),
    );
    expect(installInserts).toHaveLength(3);
    expect(installInserts[0]!.args).toContain('333.33');
    expect(installInserts[1]!.args).toContain('333.33');
    // Last installment absorbs the 0.01 residue
    expect(installInserts[2]!.args).toContain('333.34');
  });

  it('QUARTERLY cadence walks installments 3 months apart', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForInvoiceLock: [sampleInvoiceLock],
      rowsForExistingPlan: [],
      rowsForPlanById: [{ ...samplePlanRow, frequency: 'QUARTERLY' }],
    });
    const svc = new PaymentPlanService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.create(
        'inv-1',
        { installmentCount: 4, frequency: 'QUARTERLY', startDate: '2026-01-01' } as never,
        adminActor,
      );
    });
    const installInserts = capture.filter(
      (c) =>
        c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_payment_plan_installments'),
    );
    const dueDates = installInserts.map((c) => c.args[4] as string);
    expect(dueDates).toEqual(['2026-01-01', '2026-04-01', '2026-07-01', '2026-10-01']);
  });

  it('plan INSERT stamps schoolId + actor.accountId + status=ACTIVE', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForInvoiceLock: [sampleInvoiceLock],
      rowsForExistingPlan: [],
      rowsForPlanById: [samplePlanRow],
    });
    const svc = new PaymentPlanService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.create(
        'inv-1',
        { installmentCount: 4, frequency: 'MONTHLY', startDate: '2026-01-01' } as never,
        adminActor,
      );
    });
    const planInsert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_payment_plans'),
    );
    expect(planInsert!.sql.toLowerCase()).toContain("'active'");
    expect(planInsert!.args).toContain(SCHOOL.schoolId);
    expect(planInsert!.args).toContain('acc-admin');
    // family_account_id derived from the invoice lock row
    expect(planInsert!.args).toContain('fa-1');
  });

  it('all installments start at UPCOMING', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForInvoiceLock: [sampleInvoiceLock],
      rowsForExistingPlan: [],
      rowsForPlanById: [samplePlanRow],
    });
    const svc = new PaymentPlanService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.create(
        'inv-1',
        { installmentCount: 4, frequency: 'MONTHLY', startDate: '2026-01-01' } as never,
        adminActor,
      );
    });
    const installInserts = capture.filter(
      (c) =>
        c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_payment_plan_installments'),
    );
    for (const ins of installInserts) {
      expect(ins.sql.toLowerCase()).toContain("'upcoming'");
    }
  });
});

describe('PaymentPlanService.getById', () => {
  it('returns plan + installments', async () => {
    const { tenantPrisma } = makeFake({
      rowsForPlanById: [samplePlanRow],
      rowsForInstallments: [
        {
          id: 'inst-1',
          plan_id: 'plan-1',
          installment_number: 1,
          amount: '300',
          due_date: '2026-01-01',
          status: 'UPCOMING',
          payment_id: null,
          paid_at: null,
        },
        {
          id: 'inst-2',
          plan_id: 'plan-1',
          installment_number: 2,
          amount: '300',
          due_date: '2026-02-01',
          status: 'UPCOMING',
          payment_id: null,
          paid_at: null,
        },
      ],
    });
    const svc = new PaymentPlanService(tenantPrisma as never);
    let result: { id: string; installments: unknown[] } | undefined;
    await inTenant(async () => {
      result = await svc.getById('plan-1');
    });
    expect(result?.id).toBe('plan-1');
    expect(result?.installments).toHaveLength(2);
  });

  it('throws NotFoundException when plan missing', async () => {
    const { tenantPrisma } = makeFake({ rowsForPlanById: [] });
    const svc = new PaymentPlanService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.getById('plan-missing')).rejects.toThrow(NotFoundException);
    });
  });

  it('filters installments to those matching plan_id', async () => {
    const { tenantPrisma } = makeFake({
      rowsForPlanById: [samplePlanRow],
      rowsForInstallments: [
        {
          id: 'inst-other',
          plan_id: 'plan-other', // would be filtered out client-side
          installment_number: 1,
          amount: '100',
          due_date: '2026-01-01',
          status: 'UPCOMING',
          payment_id: null,
          paid_at: null,
        },
      ],
    });
    const svc = new PaymentPlanService(tenantPrisma as never);
    let result: { installments: unknown[] } | undefined;
    await inTenant(async () => {
      result = await svc.getById('plan-1');
    });
    expect(result?.installments).toHaveLength(0);
  });
});
