import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '@shared/tenant/tenant.context';
import { ReversalService, deterministicReversalEventId } from './reversal.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';

/**
 * P2-H4 test coverage uplift — payments/reversal.service.ts (298 LOC,
 * Tier 1 Financial IMMUTABLE payment-reversal — ADR-010).
 *
 * IMMUTABLE table: schema-enforced UNIQUE(payment_id) caps reversals at one
 * per payment. Service exposes ONLY list / get / reverse — no update or
 * delete methods.
 *
 * Lock order matches PaymentService.pay + RefundService.issue (invoice
 * first, then payment) to prevent deadlock under concurrent pay + refund +
 * reverse on the same invoice.
 *
 * Tests cover:
 *   - deterministicReversalEventId v5 shape + stability across calls
 *   - list + getById admin-only (REVIEW-P2-6 BLOCKING 3 school-scoped reads)
 *   - reverse() guardrails: admin gate, empty-reason rejection, payment
 *     NotFound, payment lock NotFound, non-COMPLETED payment, UNIQUE
 *     violation translated to "already reversed" message
 *   - reverse() happy path: invoice-first lock order, ledger CHARGE entry
 *     (positive amount restoring owed balance), reversal INSERT,
 *     payment flip to FAILED, invoice status reconcile (PAID→OVERDUE
 *     mapped to SENT/PARTIAL/PAID per refund-aware formula), outbox emit
 *     with deterministic event_id
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
    school_id: string;
    family_account_id: string;
    amount: string;
    status: string;
  }>;
  rowsForInvoiceStatus?: Array<{
    id: string;
    total_amount: string;
    status: string;
    amount_paid: string;
  }>;
  insertFail?: { message: string };
}

function makeFake(opts: FakeOpts = {}) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'q' });
      const s = sql.toLowerCase();
      // payment → invoice id lookup
      if (s.includes('select invoice_id::text as invoice_id from pay_payments where school_id')) {
        return opts.rowsForPaymentInvoice ?? [];
      }
      // invoice lock
      if (
        s.includes('select id from pay_invoices') &&
        s.includes('for update') &&
        !s.includes('total_amount')
      ) {
        return [{ id: 'inv-1' }];
      }
      // payment lock
      if (
        s.includes(
          'select id, school_id, family_account_id, amount::text, status from pay_payments',
        )
      ) {
        return opts.rowsForPaymentLock ?? [];
      }
      // invoice status recompute
      if (s.includes('select id, total_amount::text') && s.includes('amount_paid')) {
        return opts.rowsForInvoiceStatus ?? [];
      }
      // SELECT_BASE list / getById
      if (s.includes('from pay_payment_reversals')) {
        if (s.includes('and id = $2::uuid')) return opts.rowsForGetById ?? [];
        return opts.rowsForList ?? [];
      }
      return [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'e' });
      const lower = sql.toLowerCase();
      if (opts.insertFail && lower.includes('insert into pay_payment_reversals')) {
        throw new Error(opts.insertFail.message);
      }
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
      return 'ledger-entry-new-1';
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

const samplePayment = {
  id: 'pay-1',
  school_id: SCHOOL.schoolId,
  family_account_id: 'fa-1',
  amount: '500',
  status: 'COMPLETED',
};

const sampleReversalRow = {
  id: 'rev-1',
  school_id: SCHOOL.schoolId,
  payment_id: 'pay-1',
  family_account_id: 'fa-1',
  invoice_id: 'inv-1',
  reversal_type: 'BOUNCED_CHEQUE',
  reversal_reason: 'NSF',
  bank_reference: 'CHQ-12345',
  reversed_amount: '500',
  ledger_entry_id: 'ledger-1',
  reversed_by: 'acc-admin',
  reversed_at: '2026-04-15T00:00:00Z',
};

describe('deterministicReversalEventId helper', () => {
  it('produces a v5-shaped UUID', () => {
    const id = deterministicReversalEventId('rev-1');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('is stable across calls (same input → same output)', () => {
    const a = deterministicReversalEventId('rev-1');
    const b = deterministicReversalEventId('rev-1');
    expect(a).toBe(b);
  });

  it('different reversal ids produce different event ids', () => {
    const a = deterministicReversalEventId('rev-1');
    const b = deterministicReversalEventId('rev-2');
    expect(a).not.toBe(b);
  });
});

describe('ReversalService.list — admin-only + school-scoped', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.list({}, guardianActor)).rejects.toThrow(/Only admins can list/);
    });
  });

  it('admin sees all with school_id predicate', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForList: [sampleReversalRow] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.list({}, adminActor);
    });
    expect(capture[0]!.sql.toLowerCase()).toContain('school_id = $1::uuid');
    expect(capture[0]!.args).toContain(SCHOOL.schoolId);
  });

  it('applies familyAccountId + invoiceId filters', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForList: [sampleReversalRow] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.list({ familyAccountId: 'fa-1', invoiceId: 'inv-1' } as never, adminActor);
    });
    const sql = capture[0]!.sql.toLowerCase();
    expect(sql).toContain('family_account_id = $2::uuid');
    expect(sql).toContain('invoice_id = $3::uuid');
    expect(capture[0]!.args).toEqual([SCHOOL.schoolId, 'fa-1', 'inv-1']);
  });
});

describe('ReversalService.getById', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.getById('rev-1', guardianActor)).rejects.toThrow(ForbiddenException);
    });
  });

  it('NotFound when row missing', async () => {
    const { tenantPrisma } = makeFake({ rowsForGetById: [] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.getById('rev-missing', adminActor)).rejects.toThrow(NotFoundException);
    });
  });

  it('admin reads row with school binding', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForGetById: [sampleReversalRow] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    let result: { id: string } | undefined;
    await inTenant(async () => {
      result = await svc.getById('rev-1', adminActor);
    });
    expect(result?.id).toBe('rev-1');
    expect(capture[0]!.args).toEqual([SCHOOL.schoolId, 'rev-1']);
  });
});

describe('ReversalService.reverse — guardrails', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.reverse(
          'pay-1',
          { reversalType: 'BOUNCED_CHEQUE', reversalReason: 'NSF' } as never,
          guardianActor,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('rejects empty / whitespace-only reason', async () => {
    const { tenantPrisma } = makeFake();
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.reverse(
          'pay-1',
          { reversalType: 'BOUNCED_CHEQUE', reversalReason: '' } as never,
          adminActor,
        ),
      ).rejects.toThrow('reversalReason is required');
      await expect(
        svc.reverse(
          'pay-1',
          { reversalType: 'BOUNCED_CHEQUE', reversalReason: '   ' } as never,
          adminActor,
        ),
      ).rejects.toThrow('reversalReason is required');
    });
  });

  it('rejects when payment not found (cross-school predicate)', async () => {
    const { tenantPrisma } = makeFake({ rowsForPaymentInvoice: [] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.reverse(
          'pay-missing',
          { reversalType: 'BOUNCED_CHEQUE', reversalReason: 'NSF' } as never,
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
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.reverse(
          'pay-1',
          { reversalType: 'BOUNCED_CHEQUE', reversalReason: 'NSF' } as never,
          adminActor,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  it('rejects non-COMPLETED payment with current status in message', async () => {
    const { tenantPrisma } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [{ ...samplePayment, status: 'REFUNDED' }],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.reverse(
          'pay-1',
          { reversalType: 'BOUNCED_CHEQUE', reversalReason: 'NSF' } as never,
          adminActor,
        ),
      ).rejects.toThrow(/Cannot reverse payment in status REFUNDED.*only COMPLETED/);
    });
  });

  it('translates UNIQUE(payment_id) violation into "already reversed" message', async () => {
    const { tenantPrisma } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePayment],
      insertFail: {
        message: 'duplicate key value violates 23505 pay_payment_reversals_payment_uq',
      },
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.reverse(
          'pay-1',
          { reversalType: 'BOUNCED_CHEQUE', reversalReason: 'NSF' } as never,
          adminActor,
        ),
      ).rejects.toThrow(/Payment pay-1 has already been reversed/);
    });
  });

  it('rethrows non-UNIQUE errors unchanged', async () => {
    const { tenantPrisma } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePayment],
      insertFail: { message: 'connection refused' },
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.reverse(
          'pay-1',
          { reversalType: 'BOUNCED_CHEQUE', reversalReason: 'NSF' } as never,
          adminActor,
        ),
      ).rejects.toThrow('connection refused');
    });
  });
});

describe('ReversalService.reverse — happy path + side effects', () => {
  const PAID_INVOICE_STATUS = [
    { id: 'inv-1', total_amount: '500', status: 'PAID', amount_paid: '0' },
  ];

  it('locks invoice FIRST then payment (consistent order with PaymentService.pay + RefundService.issue)', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePayment],
      rowsForInvoiceStatus: PAID_INVOICE_STATUS,
      rowsForGetById: [sampleReversalRow],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.reverse(
        'pay-1',
        { reversalType: 'BOUNCED_CHEQUE', reversalReason: 'NSF' } as never,
        adminActor,
      );
    });
    const queries = capture.filter((c) => c.fn === 'q').map((c) => c.sql.toLowerCase());
    const invoiceLockIdx = queries.findIndex(
      (q) =>
        q.includes('select id from pay_invoices') &&
        q.includes('for update') &&
        !q.includes('total_amount'),
    );
    const paymentLockIdx = queries.findIndex((q) =>
      q.includes('select id, school_id, family_account_id, amount::text, status'),
    );
    expect(invoiceLockIdx).toBeGreaterThan(-1);
    expect(paymentLockIdx).toBeGreaterThan(-1);
    expect(invoiceLockIdx).toBeLessThan(paymentLockIdx);
  });

  it('writes CHARGE ledger entry (positive amount restoring balance owed)', async () => {
    const { tenantPrisma } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePayment],
      rowsForInvoiceStatus: PAID_INVOICE_STATUS,
      rowsForGetById: [sampleReversalRow],
    });
    const { outbox } = makeOutbox();
    const { ledger, calls: ledgerCalls } = makeLedger();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.reverse(
        'pay-1',
        { reversalType: 'BOUNCED_CHEQUE', reversalReason: 'NSF' } as never,
        adminActor,
      );
    });
    expect(ledgerCalls).toHaveLength(1);
    const entry = ledgerCalls[0]!.args[0] as Record<string, unknown>;
    expect(entry).toMatchObject({
      familyAccountId: 'fa-1',
      entryType: 'CHARGE',
      amount: 500,
    });
    expect(entry.description).toContain('REVERSAL');
    expect(entry.description).toContain('BOUNCED_CHEQUE');
    expect(entry.description).toContain('NSF');
  });

  it('flips payment status to FAILED', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePayment],
      rowsForInvoiceStatus: PAID_INVOICE_STATUS,
      rowsForGetById: [sampleReversalRow],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.reverse(
        'pay-1',
        { reversalType: 'BOUNCED_CHEQUE', reversalReason: 'NSF' } as never,
        adminActor,
      );
    });
    const update = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('update pay_payments') &&
        c.sql.toLowerCase().includes("status = 'failed'"),
    );
    expect(update).toBeTruthy();
  });

  it('reversal INSERT carries trimmed reason + bankReference + reversedAmount', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePayment],
      rowsForInvoiceStatus: PAID_INVOICE_STATUS,
      rowsForGetById: [sampleReversalRow],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.reverse(
        'pay-1',
        {
          reversalType: 'BOUNCED_CHEQUE',
          reversalReason: '  NSF — check bounced  ',
          bankReference: 'CHQ-12345',
        } as never,
        adminActor,
      );
    });
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_payment_reversals'),
    );
    expect(insert).toBeTruthy();
    expect(insert!.args).toContain('NSF — check bounced'); // trimmed
    expect(insert!.args).toContain('CHQ-12345');
    expect(insert!.args).toContain('500.00');
    expect(insert!.args).toContain('BOUNCED_CHEQUE');
  });

  it('PAID invoice → SENT after reversal nets balance to zero', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePayment],
      rowsForInvoiceStatus: [
        { id: 'inv-1', total_amount: '500', status: 'PAID', amount_paid: '0' },
      ],
      rowsForGetById: [sampleReversalRow],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.reverse(
        'pay-1',
        { reversalType: 'BOUNCED_CHEQUE', reversalReason: 'NSF' } as never,
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

  it('PAID invoice → PARTIAL when reversed payment was partial (other payments remain)', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePayment],
      rowsForInvoiceStatus: [
        { id: 'inv-1', total_amount: '500', status: 'PAID', amount_paid: '250' },
      ],
      rowsForGetById: [sampleReversalRow],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.reverse(
        'pay-1',
        { reversalType: 'BOUNCED_CHEQUE', reversalReason: 'NSF' } as never,
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

  it('Invoice stays in current status when reconciled status matches existing', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePayment],
      rowsForInvoiceStatus: [
        { id: 'inv-1', total_amount: '500', status: 'PARTIAL', amount_paid: '250' },
      ],
      rowsForGetById: [sampleReversalRow],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.reverse(
        'pay-1',
        { reversalType: 'BOUNCED_CHEQUE', reversalReason: 'NSF' } as never,
        adminActor,
      );
    });
    const invoiceUpdate = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('update pay_invoices set status = $1'),
    );
    expect(invoiceUpdate).toBeUndefined();
  });

  it('Skips invoice status reconciliation for DRAFT', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePayment],
      rowsForInvoiceStatus: [
        { id: 'inv-1', total_amount: '500', status: 'DRAFT', amount_paid: '0' },
      ],
      rowsForGetById: [sampleReversalRow],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.reverse(
        'pay-1',
        { reversalType: 'BOUNCED_CHEQUE', reversalReason: 'NSF' } as never,
        adminActor,
      );
    });
    const invoiceUpdate = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('update pay_invoices set status = $1'),
    );
    expect(invoiceUpdate).toBeUndefined();
  });

  it('Skips invoice status reconciliation for CANCELLED', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePayment],
      rowsForInvoiceStatus: [
        { id: 'inv-1', total_amount: '500', status: 'CANCELLED', amount_paid: '0' },
      ],
      rowsForGetById: [sampleReversalRow],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.reverse(
        'pay-1',
        { reversalType: 'BOUNCED_CHEQUE', reversalReason: 'NSF' } as never,
        adminActor,
      );
    });
    const invoiceUpdate = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('update pay_invoices set status = $1'),
    );
    expect(invoiceUpdate).toBeUndefined();
  });

  it('emits pay.payment.reversed with deterministic event_id + full envelope', async () => {
    const { tenantPrisma } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePayment],
      rowsForInvoiceStatus: PAID_INVOICE_STATUS,
      rowsForGetById: [sampleReversalRow],
    });
    const { outbox, calls: outboxCalls } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.reverse(
        'pay-1',
        {
          reversalType: 'BOUNCED_CHEQUE',
          reversalReason: 'NSF',
          bankReference: 'CHQ-12345',
        } as never,
        adminActor,
      );
    });
    expect(outboxCalls).toHaveLength(1);
    const emit = outboxCalls[0]!.args[0] as Record<string, unknown>;
    expect(emit.topic).toBe('pay.payment.reversed');
    expect(emit.sourceModule).toBe('payments');
    // Deterministic event_id is set explicitly
    expect(emit.eventId).toBeTruthy();
    expect(emit.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const payload = emit.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      paymentId: 'pay-1',
      invoiceId: 'inv-1',
      familyAccountId: 'fa-1',
      reversalType: 'BOUNCED_CHEQUE',
      reversalReason: 'NSF',
      reversedAmount: 500,
      reversedBy: 'acc-admin',
    });
    // sourceRefId === reversalId
    expect(payload.sourceRefId).toBe(payload.reversalId);
  });

  it('reversal INSERT links the ledger entry id (chains audit trail)', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPaymentInvoice: [{ invoice_id: 'inv-1' }],
      rowsForPaymentLock: [samplePayment],
      rowsForInvoiceStatus: PAID_INVOICE_STATUS,
      rowsForGetById: [sampleReversalRow],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.reverse(
        'pay-1',
        { reversalType: 'BOUNCED_CHEQUE', reversalReason: 'NSF' } as never,
        adminActor,
      );
    });
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_payment_reversals'),
    );
    // makeLedger returns 'ledger-entry-new-1' from recordEntry; the
    // reversal INSERT should contain it.
    expect(insert!.args).toContain('ledger-entry-new-1');
  });
});
