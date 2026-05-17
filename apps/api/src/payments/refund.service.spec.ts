import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '../tenant/tenant.context';
import { RefundService } from './refund.service';
import type { ResolvedActor } from '../iam/actor-context.service';

/**
 * P2-H4 test coverage uplift — payments/refund.service.ts (305 LOC,
 * Tier 1 Financial keystone — admin-only refund issuance).
 *
 * REVIEW-CYCLE6 fix 7 lock-order consistency: locks the parent invoice
 * BEFORE the payment row to match PaymentService.pay()'s order
 * (invoice → payment-write). Without this consistent ordering, a
 * concurrent pay + refund on the same invoice can deadlock.
 *
 * Tests cover:
 *   - list admin-only (parent → 403)
 *   - issue() guardrails: admin gate, amount > 0, payment NotFound, invoice
 *     NotFound, non-COMPLETED payment, over-refund cap (sum of prior
 *     refunds)
 *   - issue() happy path: invoice lock, payment lock, refund INSERT with
 *     COMPLETED status + Stripe re_dev_ mock id + authorised_by + ledger
 *     REFUND entry (positive amount)
 *   - full-refund flips payment to REFUNDED; partial refund leaves it
 *     COMPLETED
 *   - invoice status reconciliation: PAID → PARTIAL after partial refund;
 *     PAID → SENT when refund nets balance back to zero; status unchanged
 *     when DRAFT/CANCELLED
 *   - outbox emit with pay.refund.issued envelope (durable in-tx)
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
  rowsForGetById?: unknown[];
  rowsForPaymentInvoice?: Array<{ invoice_id: string }>;
  rowsForPaymentLock?: Array<{
    id: string;
    family_account_id: string;
    amount: string;
    status: string;
  }>;
  rowsForPriorRefunds?: Array<{ prior: string }>;
  rowsForInvoiceStatus?: Array<{
    id: string;
    total_amount: string;
    status: string;
    amount_paid: string;
  }>;
}

function makeFake(opts: FakeOpts = {}) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'q' });
      const s = sql.toLowerCase();
      // payment → invoice lookup (1st query in issue)
      if (s.includes('select invoice_id::text as invoice_id from pay_payments')) {
        return opts.rowsForPaymentInvoice ?? [];
      }
      // invoice FOR UPDATE (2nd)
      if (
        s.includes('select id from pay_invoices') &&
        s.includes('for update') &&
        !s.includes('total_amount')
      ) {
        return [{ id: 'inv-1' }];
      }
      // payment lock (3rd)
      if (
        s.includes('select id, family_account_id, amount::text, status from pay_payments') &&
        s.includes('for update')
      ) {
        return opts.rowsForPaymentLock ?? [];
      }
      // prior refunds aggregate
      if (s.includes('coalesce(sum(amount), 0)::text as prior')) {
        return opts.rowsForPriorRefunds ?? [{ prior: '0' }];
      }
      // invoice status recompute (last query before outbox)
      if (s.includes('amount_paid') && s.includes('select id, total_amount::text')) {
        return opts.rowsForInvoiceStatus ?? [];
      }
      // list / getById
      if (s.includes('from pay_refunds')) {
        if (s.includes('where id = $1::uuid')) return opts.rowsForGetById ?? [];
        return opts.rowsForList ?? [];
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

function makeOutbox() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const outbox = {
    enqueueInTx: async (_tx: unknown, opts: unknown) => {
      calls.push({ method: 'enqueueInTx', args: [opts] });
    },
  };
  return { outbox, calls };
}

function makeLedger() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const ledger = {
    recordEntry: async (_tx: unknown, opts: unknown) => {
      calls.push({ method: 'recordEntry', args: [opts] });
    },
  };
  return { ledger, calls };
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

const samplePaymentLock = {
  id: 'pay-1',
  family_account_id: 'fa-1',
  amount: '500',
  status: 'COMPLETED',
};

const sampleRefundRow = {
  id: 'ref-1',
  school_id: SCHOOL.schoolId,
  payment_id: 'pay-1',
  family_account_id: 'fa-1',
  amount: '50.00',
  refund_category: 'GOODWILL',
  reason: 'Tuition adjustment',
  stripe_refund_id: 're_dev_abc123',
  status: 'COMPLETED',
  authorised_by: 'acc-admin',
  authorised_at: '2026-04-15T00:00:00Z',
  completed_at: '2026-04-15T00:00:00Z',
  created_at: '2026-04-15T00:00:00Z',
  updated_at: '2026-04-15T00:00:00Z',
};

describe('RefundService.list — admin-only', () => {
  it('rejects non-admin with ForbiddenException', async () => {
    const { tenantPrisma } = makeFake();
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new RefundService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.list({}, guardianActor)).rejects.toThrow(/Only admins can list refunds/);
    });
  });

  it('admin sees all + applies familyAccountId/paymentId/status filters', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForList: [sampleRefundRow] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new RefundService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.list(
        { familyAccountId: 'fa-1', paymentId: 'pay-1', status: 'COMPLETED' } as never,
        adminActor,
      );
    });
    const sql = capture[0]!.sql.toLowerCase();
    expect(sql).toContain('family_account_id = $1::uuid');
    expect(sql).toContain('payment_id = $2::uuid');
    expect(sql).toContain('status = $3');
    expect(capture[0]!.args).toEqual(['fa-1', 'pay-1', 'COMPLETED']);
  });

  it('admin list with no filters reads order by created_at DESC', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForList: [] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new RefundService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.list({}, adminActor);
    });
    expect(capture[0]!.sql.toLowerCase()).toContain('order by created_at desc');
  });
});

describe('RefundService.getById', () => {
  it('returns DTO when found', async () => {
    const { tenantPrisma } = makeFake({ rowsForGetById: [sampleRefundRow] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new RefundService(tenantPrisma as never, outbox as never, ledger as never);
    let result: { id: string; amount: number } | undefined;
    await inTenant(async () => {
      result = await svc.getById('ref-1');
    });
    expect(result?.id).toBe('ref-1');
    expect(result?.amount).toBe(50);
  });

  it('NotFound on miss', async () => {
    const { tenantPrisma } = makeFake({ rowsForGetById: [] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new RefundService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.getById('ref-missing')).rejects.toThrow(NotFoundException);
    });
  });
});

describe('RefundService.issue — guardrails', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new RefundService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.issue(
          'pay-1',
          { amount: 50, refundCategory: 'GOODWILL', reason: 'x' } as never,
          guardianActor,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('rejects amount <= 0', async () => {
    const { tenantPrisma } = makeFake();
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new RefundService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.issue(
          'pay-1',
          { amount: 0, refundCategory: 'GOODWILL', reason: 'x' } as never,
          adminActor,
        ),
      ).rejects.toThrow('amount must be > 0');
      await expect(
        svc.issue(
          'pay-1',
          { amount: -10, refundCategory: 'GOODWILL', reason: 'x' } as never,
          adminActor,
        ),
      ).rejects.toThrow('amount must be > 0');
    });
  });

  it('rejects when payment not found (first lookup)', async () => {
    const { tenantPrisma } = makeFake({ rowsForPaymentInvoice: [] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new RefundService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.issue(
          'pay-missing',
          { amount: 50, refundCategory: 'GOODWILL', reason: 'x' } as never,
          adminActor,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  it('rejects when payment lock returns empty (race deletion)', async () => {
    const { tenantPrisma } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new RefundService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.issue(
          'pay-1',
          { amount: 50, refundCategory: 'GOODWILL', reason: 'x' } as never,
          adminActor,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  it('rejects non-COMPLETED payment with current status in message', async () => {
    const { tenantPrisma } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [{ ...samplePaymentLock, status: 'PENDING' }],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new RefundService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.issue(
          'pay-1',
          { amount: 50, refundCategory: 'GOODWILL', reason: 'x' } as never,
          adminActor,
        ),
      ).rejects.toThrow(/Cannot refund payment in status PENDING.*only COMPLETED/);
    });
  });

  it('rejects over-refund beyond remaining refundable (sum of priors)', async () => {
    const { tenantPrisma } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePaymentLock],
      rowsForPriorRefunds: [{ prior: '400' }], // already refunded 400 of 500
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new RefundService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.issue(
          'pay-1',
          { amount: 150, refundCategory: 'GOODWILL', reason: 'x' } as never,
          adminActor,
        ),
      ).rejects.toThrow(/exceeds remaining refundable \$100/);
    });
  });
});

describe('RefundService.issue — happy path + side effects', () => {
  it('issues full refund: locks invoice + payment, INSERTs refund, writes ledger, flips payment to REFUNDED', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePaymentLock],
      rowsForPriorRefunds: [{ prior: '0' }],
      rowsForInvoiceStatus: [
        { id: 'inv-1', total_amount: '500', status: 'PAID', amount_paid: '0' },
      ],
      rowsForGetById: [{ ...sampleRefundRow, amount: '500.00' }],
    });
    const { outbox, calls: outboxCalls } = makeOutbox();
    const { ledger, calls: ledgerCalls } = makeLedger();
    const svc = new RefundService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.issue(
        'pay-1',
        { amount: 500, refundCategory: 'WITHDRAWAL', reason: 'Student withdrew' } as never,
        adminActor,
      );
    });

    // Lock order: payment-invoice lookup → invoice FOR UPDATE → payment FOR UPDATE
    const queries = capture.filter((c) => c.fn === 'q').map((c) => c.sql.toLowerCase());
    const invoiceLockIdx = queries.findIndex(
      (q) => q.includes('select id from pay_invoices') && q.includes('for update'),
    );
    const paymentLockIdx = queries.findIndex(
      (q) =>
        q.includes('select id, family_account_id, amount::text, status from pay_payments') &&
        q.includes('for update'),
    );
    expect(invoiceLockIdx).toBeGreaterThan(-1);
    expect(paymentLockIdx).toBeGreaterThan(-1);
    expect(invoiceLockIdx).toBeLessThan(paymentLockIdx);

    // Refund INSERT with stripe re_dev_ id + COMPLETED status
    const refundInsert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_refunds'),
    );
    expect(refundInsert).toBeTruthy();
    expect(refundInsert!.sql.toLowerCase()).toContain("'completed'");
    expect(refundInsert!.args).toContain('500.00');
    expect(refundInsert!.args).toContain('WITHDRAWAL');
    expect(refundInsert!.args).toContain('Student withdrew');
    const stripeId = refundInsert!.args.find(
      (a) => typeof a === 'string' && a.startsWith('re_dev_'),
    );
    expect(stripeId).toBeTruthy();

    // Ledger REFUND entry with positive amount
    expect(ledgerCalls).toHaveLength(1);
    const ledgerEntry = ledgerCalls[0]!.args[0] as Record<string, unknown>;
    expect(ledgerEntry.entryType).toBe('REFUND');
    expect(ledgerEntry.amount).toBe(500);
    expect(ledgerEntry.familyAccountId).toBe('fa-1');

    // Payment flipped to REFUNDED
    const paymentRefundedUpdate = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('update pay_payments') &&
        c.sql.toLowerCase().includes("status = 'refunded'"),
    );
    expect(paymentRefundedUpdate).toBeTruthy();

    // Outbox emit with pay.refund.issued envelope
    expect(outboxCalls).toHaveLength(1);
    const emit = outboxCalls[0]!.args[0] as Record<string, unknown>;
    expect(emit.topic).toBe('pay.refund.issued');
    expect(emit.sourceModule).toBe('payments');
    const payload = emit.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      paymentId: 'pay-1',
      familyAccountId: 'fa-1',
      amount: 500,
      refundCategory: 'WITHDRAWAL',
      reason: 'Student withdrew',
      status: 'COMPLETED',
      authorisedBy: 'acc-admin',
    });
  });

  it('partial refund leaves payment as COMPLETED', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePaymentLock],
      rowsForPriorRefunds: [{ prior: '0' }],
      rowsForInvoiceStatus: [
        { id: 'inv-1', total_amount: '500', status: 'PAID', amount_paid: '450' },
      ],
      rowsForGetById: [sampleRefundRow],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new RefundService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.issue(
        'pay-1',
        { amount: 50, refundCategory: 'GOODWILL', reason: 'partial' } as never,
        adminActor,
      );
    });
    const paymentRefundedUpdate = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('update pay_payments') &&
        c.sql.toLowerCase().includes("status = 'refunded'"),
    );
    expect(paymentRefundedUpdate).toBeUndefined();
  });

  it('invoice status PAID → PARTIAL after partial refund nets balance below total', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePaymentLock],
      rowsForPriorRefunds: [{ prior: '0' }],
      // amount_paid = 450 (was 500 paid, minus 50 refund just issued)
      rowsForInvoiceStatus: [
        { id: 'inv-1', total_amount: '500', status: 'PAID', amount_paid: '450' },
      ],
      rowsForGetById: [sampleRefundRow],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new RefundService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.issue(
        'pay-1',
        { amount: 50, refundCategory: 'GOODWILL', reason: 'r' } as never,
        adminActor,
      );
    });
    const invoiceUpdate = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('update pay_invoices set status = $1') &&
        c.args[0] === 'PARTIAL',
    );
    expect(invoiceUpdate).toBeTruthy();
  });

  it('invoice status PAID → SENT when refund nets balance back to zero', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePaymentLock],
      rowsForPriorRefunds: [{ prior: '0' }],
      // amount_paid = 0 after full refund
      rowsForInvoiceStatus: [
        { id: 'inv-1', total_amount: '500', status: 'PAID', amount_paid: '0' },
      ],
      rowsForGetById: [sampleRefundRow],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new RefundService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.issue(
        'pay-1',
        { amount: 500, refundCategory: 'WITHDRAWAL', reason: 'r' } as never,
        adminActor,
      );
    });
    const invoiceUpdate = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('update pay_invoices set status = $1') &&
        c.args[0] === 'SENT',
    );
    expect(invoiceUpdate).toBeTruthy();
  });

  it('invoice status stays PAID when refund computes back to PAID (no transition)', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePaymentLock],
      rowsForPriorRefunds: [{ prior: '0' }],
      // total=500, paid=500 → stays PAID
      rowsForInvoiceStatus: [
        { id: 'inv-1', total_amount: '500', status: 'PAID', amount_paid: '500' },
      ],
      rowsForGetById: [sampleRefundRow],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new RefundService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.issue(
        'pay-1',
        { amount: 1, refundCategory: 'GOODWILL', reason: 'r' } as never,
        adminActor,
      );
    });
    const invoiceUpdate = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('update pay_invoices set status = $1'),
    );
    expect(invoiceUpdate).toBeUndefined();
  });

  it('does NOT touch invoice status when invoice is DRAFT', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePaymentLock],
      rowsForPriorRefunds: [{ prior: '0' }],
      rowsForInvoiceStatus: [
        { id: 'inv-1', total_amount: '500', status: 'DRAFT', amount_paid: '0' },
      ],
      rowsForGetById: [sampleRefundRow],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new RefundService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.issue(
        'pay-1',
        { amount: 50, refundCategory: 'GOODWILL', reason: 'r' } as never,
        adminActor,
      );
    });
    const invoiceUpdate = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('update pay_invoices set status = $1'),
    );
    expect(invoiceUpdate).toBeUndefined();
  });

  it('does NOT touch invoice status when invoice is CANCELLED', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePaymentLock],
      rowsForPriorRefunds: [{ prior: '0' }],
      rowsForInvoiceStatus: [
        { id: 'inv-1', total_amount: '500', status: 'CANCELLED', amount_paid: '0' },
      ],
      rowsForGetById: [sampleRefundRow],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new RefundService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.issue(
        'pay-1',
        { amount: 50, refundCategory: 'GOODWILL', reason: 'r' } as never,
        adminActor,
      );
    });
    const invoiceUpdate = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('update pay_invoices set status = $1'),
    );
    expect(invoiceUpdate).toBeUndefined();
  });

  it('PARTIAL → SENT transition after full refund of single payment', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePaymentLock],
      rowsForPriorRefunds: [{ prior: '0' }],
      rowsForInvoiceStatus: [
        { id: 'inv-1', total_amount: '500', status: 'PARTIAL', amount_paid: '0' },
      ],
      rowsForGetById: [sampleRefundRow],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new RefundService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.issue(
        'pay-1',
        { amount: 500, refundCategory: 'WITHDRAWAL', reason: 'r' } as never,
        adminActor,
      );
    });
    const invoiceUpdate = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('update pay_invoices set status = $1') &&
        c.args[0] === 'SENT',
    );
    expect(invoiceUpdate).toBeTruthy();
  });

  it('successive partial refunds accumulate against priorRefunded', async () => {
    // 2nd refund of $100 on a $500 payment already partially refunded $300
    const { tenantPrisma } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePaymentLock],
      rowsForPriorRefunds: [{ prior: '300' }],
      rowsForInvoiceStatus: [
        { id: 'inv-1', total_amount: '500', status: 'PAID', amount_paid: '100' },
      ],
      rowsForGetById: [sampleRefundRow],
    });
    const { outbox } = makeOutbox();
    const { ledger, calls: ledgerCalls } = makeLedger();
    const svc = new RefundService(tenantPrisma as never, outbox as never, ledger as never);
    // $300 already + $100 new = $400 total refunded; within the $500 cap
    await inTenant(async () => {
      await svc.issue(
        'pay-1',
        { amount: 100, refundCategory: 'GOODWILL', reason: 'r' } as never,
        adminActor,
      );
    });
    expect(ledgerCalls).toHaveLength(1);
  });

  it('refund stripe id uses re_dev_ prefix with 24-char suffix', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePaymentLock],
      rowsForPriorRefunds: [{ prior: '0' }],
      rowsForInvoiceStatus: [
        { id: 'inv-1', total_amount: '500', status: 'PAID', amount_paid: '0' },
      ],
      rowsForGetById: [sampleRefundRow],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new RefundService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.issue(
        'pay-1',
        { amount: 50, refundCategory: 'GOODWILL', reason: 'r' } as never,
        adminActor,
      );
    });
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_refunds'),
    );
    const stripeId = insert!.args.find(
      (a) => typeof a === 'string' && a.startsWith('re_dev_'),
    ) as string;
    expect(stripeId).toBeTruthy();
    expect(stripeId.startsWith('re_dev_')).toBe(true);
    expect(stripeId.length).toBe('re_dev_'.length + 24);
  });

  it('authorised_by + authorised_at populated on INSERT (schema CHECK requires both NOT NULL)', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePaymentLock],
      rowsForPriorRefunds: [{ prior: '0' }],
      rowsForInvoiceStatus: [
        { id: 'inv-1', total_amount: '500', status: 'PAID', amount_paid: '0' },
      ],
      rowsForGetById: [sampleRefundRow],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new RefundService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.issue(
        'pay-1',
        { amount: 50, refundCategory: 'GOODWILL', reason: 'r' } as never,
        adminActor,
      );
    });
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_refunds'),
    );
    // authorised_at and completed_at are now() literals; authorised_by is actor.accountId
    expect(insert!.args).toContain('acc-admin');
    expect(insert!.sql.toLowerCase()).toContain('authorised_at');
    expect(insert!.sql.toLowerCase()).toContain('now()');
  });
});
