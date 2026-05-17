import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '../tenant/tenant.context';
import { PaymentAllocationService } from './payment-allocation.service';
import type { ResolvedActor } from '../iam/actor-context.service';

/**
 * P2-H4 test coverage uplift — payments/payment-allocation.service.ts
 * (171 LOC, Tier 1 Financial; distributes a single payment across one
 * or more invoices with SUM equality enforcement + same-family check).
 *
 * Tests cover:
 *   - listForPayment admin-only + school-scoped predicate
 *   - allocate admin-only
 *   - allocate cross-school payment 404
 *   - allocate SUM != payment.amount → 400 (tolerance ±0.001)
 *   - allocate per-allocation amount > 0
 *   - allocate cross-school / missing invoice 400
 *   - allocate cross-family invoice 400
 *   - allocate UNIQUE catch translates to friendly 400
 *   - allocate non-UNIQUE error rethrows unchanged
 *   - allocate happy path: locks payment, deletes existing, inserts
 *     new rows, returns listForPayment
 *   - allocate idempotency: existing allocations DELETEd before INSERT
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

interface FakeOpts {
  rowsForList?: unknown[];
  rowsForPaymentLock?: unknown[];
  rowsForInvoice?: unknown[];
  rowsForInvoiceByCall?: Array<unknown[]>;
  insertFail?: { message?: string };
}

function makeFake(opts: FakeOpts = {}) {
  const capture: CapturedCall[] = [];
  let invoiceCallIdx = 0;
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'q' });
      const s = sql.toLowerCase();
      if (s.includes('from pay_payment_allocations a left join pay_invoices')) {
        return opts.rowsForList ?? [];
      }
      if (s.includes('from pay_payments where school_id =')) {
        return opts.rowsForPaymentLock ?? [];
      }
      if (s.includes('from pay_invoices where school_id =')) {
        if (opts.rowsForInvoiceByCall) {
          const row = opts.rowsForInvoiceByCall[invoiceCallIdx] ?? [];
          invoiceCallIdx++;
          return row;
        }
        return opts.rowsForInvoice ?? [];
      }
      return [];
    },
    $executeRawUnsafe: async (sql: string, ..._args: unknown[]) => {
      capture.push({ sql, args: _args, fn: 'e' });
      const s = sql.toLowerCase();
      if (opts.insertFail && s.includes('insert into pay_payment_allocations')) {
        throw new Error(opts.insertFail.message ?? 'insert fail');
      }
      return 1;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
    executeInTenantTransaction: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
  };
  return { tenantPrisma, capture };
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

const sampleAllocation = {
  id: 'alloc-1',
  school_id: SCHOOL.schoolId,
  payment_id: 'pay-1',
  invoice_id: 'inv-1',
  invoice_title: 'Tuition Fall 2026',
  allocated_amount: '300.00',
  allocated_by: 'acc-admin',
  allocated_at: '2026-04-28T10:00:00Z',
};

const samplePayment = {
  id: 'pay-1',
  school_id: SCHOOL.schoolId,
  family_account_id: 'fa-1',
  amount: '500.00',
  status: 'COMPLETED',
};

describe('PaymentAllocationService.listForPayment', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new PaymentAllocationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.listForPayment('pay-1', guardianActor)).rejects.toThrow(ForbiddenException);
    });
  });

  it('admin happy path returns DTOs school-scoped', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForList: [sampleAllocation] });
    const svc = new PaymentAllocationService(tenantPrisma as never);
    let rows: Array<{ id: string; allocatedAmount: number }> = [];
    await inTenant(async () => {
      rows = await svc.listForPayment('pay-1', adminActor);
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.allocatedAmount).toBe(300);
    expect(capture[0]!.sql.toLowerCase()).toContain('a.school_id = $1::uuid');
    expect(capture[0]!.sql.toLowerCase()).toContain('a.payment_id = $2::uuid');
    expect(capture[0]!.args).toEqual([SCHOOL.schoolId, 'pay-1']);
  });

  it('returns empty when no allocations exist', async () => {
    const { tenantPrisma } = makeFake({ rowsForList: [] });
    const svc = new PaymentAllocationService(tenantPrisma as never);
    let rows: unknown[] = [];
    await inTenant(async () => {
      rows = await svc.listForPayment('pay-empty', adminActor);
    });
    expect(rows).toEqual([]);
  });
});

describe('PaymentAllocationService.allocate', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new PaymentAllocationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.allocate(
          'pay-1',
          { allocations: [{ invoiceId: 'inv-1', allocatedAmount: 500 }] } as never,
          guardianActor,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('404 when payment not found (school-scoped lookup)', async () => {
    const { tenantPrisma } = makeFake({ rowsForPaymentLock: [] });
    const svc = new PaymentAllocationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.allocate(
          'pay-missing',
          { allocations: [{ invoiceId: 'inv-1', allocatedAmount: 500 }] } as never,
          adminActor,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  it('rejects SUM != payment.amount', async () => {
    const { tenantPrisma } = makeFake({ rowsForPaymentLock: [samplePayment] });
    const svc = new PaymentAllocationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.allocate(
          'pay-1',
          { allocations: [{ invoiceId: 'inv-1', allocatedAmount: 300 }] } as never,
          adminActor,
        ),
      ).rejects.toThrow(/Allocation total \$300\.00 must equal payment amount \$500\.00/);
    });
  });

  it('accepts SUM within ±0.001 tolerance', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPaymentLock: [samplePayment],
      rowsForInvoice: [{ id: 'inv-1', family_account_id: 'fa-1' }],
      rowsForList: [sampleAllocation],
    });
    const svc = new PaymentAllocationService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.allocate(
        'pay-1',
        { allocations: [{ invoiceId: 'inv-1', allocatedAmount: 500.0009 }] } as never,
        adminActor,
      );
    });
    // Should have called INSERT despite the tiny rounding residue
    const insert = capture.find((c) =>
      c.sql.toLowerCase().includes('insert into pay_payment_allocations'),
    );
    expect(insert).toBeTruthy();
  });

  it('rejects allocatedAmount <= 0', async () => {
    const { tenantPrisma } = makeFake({
      rowsForPaymentLock: [samplePayment],
      rowsForInvoice: [{ id: 'inv-1', family_account_id: 'fa-1' }],
    });
    const svc = new PaymentAllocationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.allocate(
          'pay-1',
          {
            allocations: [
              { invoiceId: 'inv-1', allocatedAmount: 600 },
              { invoiceId: 'inv-2', allocatedAmount: -100 },
            ],
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/allocatedAmount must be > 0 for invoice inv-2/);
    });
  });

  it('rejects when invoice not found (cross-school or missing)', async () => {
    const { tenantPrisma } = makeFake({
      rowsForPaymentLock: [samplePayment],
      rowsForInvoice: [],
    });
    const svc = new PaymentAllocationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.allocate(
          'pay-1',
          { allocations: [{ invoiceId: 'inv-cross-school', allocatedAmount: 500 }] } as never,
          adminActor,
        ),
      ).rejects.toThrow(/Invoice inv-cross-school not found/);
    });
  });

  it('rejects cross-family invoice', async () => {
    const { tenantPrisma } = makeFake({
      rowsForPaymentLock: [samplePayment],
      rowsForInvoice: [{ id: 'inv-other-family', family_account_id: 'fa-other' }],
    });
    const svc = new PaymentAllocationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.allocate(
          'pay-1',
          { allocations: [{ invoiceId: 'inv-other-family', allocatedAmount: 500 }] } as never,
          adminActor,
        ),
      ).rejects.toThrow(/does not belong to the same family account/);
    });
  });

  it('UNIQUE catch (pay_payment_alloc_pay_inv_uq) translates to friendly 400', async () => {
    const { tenantPrisma } = makeFake({
      rowsForPaymentLock: [samplePayment],
      rowsForInvoice: [{ id: 'inv-1', family_account_id: 'fa-1' }],
      insertFail: { message: 'duplicate key violates pay_payment_alloc_pay_inv_uq' },
    });
    const svc = new PaymentAllocationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.allocate(
          'pay-1',
          { allocations: [{ invoiceId: 'inv-1', allocatedAmount: 500 }] } as never,
          adminActor,
        ),
      ).rejects.toThrow(/Duplicate allocation for payment \+ invoice pair/);
    });
  });

  it('UNIQUE catch via 23505 message fragment', async () => {
    const { tenantPrisma } = makeFake({
      rowsForPaymentLock: [samplePayment],
      rowsForInvoice: [{ id: 'inv-1', family_account_id: 'fa-1' }],
      insertFail: { message: 'unique violation SQLSTATE 23505' },
    });
    const svc = new PaymentAllocationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.allocate(
          'pay-1',
          { allocations: [{ invoiceId: 'inv-1', allocatedAmount: 500 }] } as never,
          adminActor,
        ),
      ).rejects.toThrow(/Duplicate allocation/);
    });
  });

  it('non-UNIQUE insert errors rethrow unchanged', async () => {
    const { tenantPrisma } = makeFake({
      rowsForPaymentLock: [samplePayment],
      rowsForInvoice: [{ id: 'inv-1', family_account_id: 'fa-1' }],
      insertFail: { message: 'connection refused' },
    });
    const svc = new PaymentAllocationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.allocate(
          'pay-1',
          { allocations: [{ invoiceId: 'inv-1', allocatedAmount: 500 }] } as never,
          adminActor,
        ),
      ).rejects.toThrow(/connection refused/);
    });
  });

  it('happy path: locks payment, deletes existing, inserts new rows, returns listForPayment', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPaymentLock: [samplePayment],
      rowsForInvoiceByCall: [
        [{ id: 'inv-1', family_account_id: 'fa-1' }],
        [{ id: 'inv-2', family_account_id: 'fa-1' }],
      ],
      rowsForList: [
        sampleAllocation,
        { ...sampleAllocation, id: 'alloc-2', invoice_id: 'inv-2', allocated_amount: '200.00' },
      ],
    });
    const svc = new PaymentAllocationService(tenantPrisma as never);
    let rows: Array<{ invoiceId: string; allocatedAmount: number }> = [];
    await inTenant(async () => {
      rows = await svc.allocate(
        'pay-1',
        {
          allocations: [
            { invoiceId: 'inv-1', allocatedAmount: 300 },
            { invoiceId: 'inv-2', allocatedAmount: 200 },
          ],
        } as never,
        adminActor,
      );
    });
    expect(rows).toHaveLength(2);

    // Sequence: lock + DELETE + 2× (lookup + INSERT) + final list SELECT
    const lockIdx = capture.findIndex(
      (c) =>
        c.sql.toLowerCase().includes('for update') &&
        c.sql.toLowerCase().includes('from pay_payments'),
    );
    const deleteIdx = capture.findIndex(
      (c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('delete from pay_payment_allocations'),
    );
    const insertIdxs = capture
      .map((c, i) => ({ i, c }))
      .filter(
        ({ c }) =>
          c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_payment_allocations'),
      )
      .map((p) => p.i);
    expect(lockIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(lockIdx);
    expect(insertIdxs.length).toBe(2);
    expect(insertIdxs[0]).toBeGreaterThan(deleteIdx);
    expect(insertIdxs[1]).toBeGreaterThan(insertIdxs[0]!);
  });

  it('idempotency: DELETE existing allocations before INSERTing new ones', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPaymentLock: [samplePayment],
      rowsForInvoice: [{ id: 'inv-1', family_account_id: 'fa-1' }],
      rowsForList: [sampleAllocation],
    });
    const svc = new PaymentAllocationService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.allocate(
        'pay-1',
        { allocations: [{ invoiceId: 'inv-1', allocatedAmount: 500 }] } as never,
        adminActor,
      );
    });
    const del = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('delete from pay_payment_allocations'),
    );
    expect(del).toBeTruthy();
    expect(del!.args).toEqual(['pay-1']);
  });
});
