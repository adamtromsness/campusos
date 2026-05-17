import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '@shared/tenant';
import { PaymentService } from './payment.service';
import type { ResolvedActor } from '@modules/m00-platform';

/**
 * P2-H4 test coverage uplift — payments/payment.service.ts (299 LOC,
 * Tier 1 Financial keystone — the family billing collect-payment surface).
 *
 * REVIEW-CYCLE6 fix 7 lock ordering: locks the invoice row FOR UPDATE
 * inside one tenant tx, recomputes amount_paid via the refund-aware
 * formula (SUM(COMPLETED+REFUNDED payments) - SUM(COMPLETED refunds))
 * before deciding PAID vs PARTIAL.
 *
 * Tests cover:
 *   - list row scope: admin all / guardian own family / non-guardian non-admin empty
 *   - getById 404 don't-leak-existence for non-owner non-admin
 *   - pay() guardrails: amount>0, self-service method gate (CARD/BANK_TRANSFER),
 *     account holder check, account status, invoice status (DRAFT/CANCELLED/PAID),
 *     overpay rejection
 *   - pay() happy path: invoice lock, payment INSERT with stripe pi_dev id,
 *     PAYMENT ledger entry written via injected service, invoice flip PAID/PARTIAL,
 *     outbox enqueue with pay.payment.received envelope
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

interface InvoiceRow {
  id: string;
  family_account_id: string;
  total_amount: string;
  status: string;
  amount_paid: string;
  account_holder_id: string;
  account_status: string;
}

interface FakeOpts {
  rowsForList?: unknown[];
  rowsForGetById?: unknown[];
  rowsForAccountHolder?: Array<{ holder: string }>;
  invoiceForPay?: InvoiceRow | null;
}

function makeFake(opts: FakeOpts = {}) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'q' });
      const s = sql.toLowerCase();
      if (s.includes('for update of i')) {
        return opts.invoiceForPay ? [opts.invoiceForPay] : [];
      }
      if (s.includes('from pay_payments p')) {
        // distinguish list vs single
        if (s.includes('where p.id = $1::uuid')) return opts.rowsForGetById ?? [];
        return opts.rowsForList ?? [];
      }
      if (s.includes('from pay_family_accounts where id')) {
        return opts.rowsForAccountHolder ?? [];
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

const studentActor: ResolvedActor = {
  accountId: 'acc-maya',
  personId: 'pers-maya',
  personType: 'STUDENT',
  isSchoolAdmin: false,
  employeeId: null,
};

const samplePayment = {
  id: 'pay-1',
  school_id: SCHOOL.schoolId,
  invoice_id: 'inv-1',
  invoice_title: 'Tuition Q4',
  family_account_id: 'fa-1',
  family_account_number: 'FA-1001',
  amount: '500.00',
  payment_method: 'CARD',
  stripe_payment_intent_id: 'pi_dev_abc123',
  status: 'COMPLETED',
  paid_at: '2026-04-15T00:00:00Z',
  receipt_s3_key: null,
  notes: null,
  created_by: 'acc-david',
  created_at: '2026-04-15T00:00:00Z',
  updated_at: '2026-04-15T00:00:00Z',
};

const sampleInvoice: InvoiceRow = {
  id: 'inv-1',
  family_account_id: 'fa-1',
  total_amount: '500',
  status: 'SENT',
  amount_paid: '0',
  account_holder_id: 'pers-david',
  account_status: 'ACTIVE',
};

describe('PaymentService.list — row scope', () => {
  it('admin sees all', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForList: [samplePayment] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    let result: unknown[] = [];
    await inTenant(async () => {
      result = await svc.list({}, adminActor);
    });
    expect(result).toHaveLength(1);
    expect(capture[0]!.sql.toLowerCase()).not.toContain('account_holder_id');
  });

  it('guardian filters by account_holder_id = actor.personId', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForList: [samplePayment] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.list({}, guardianActor);
    });
    expect(capture[0]!.sql.toLowerCase()).toContain('account_holder_id = $1::uuid');
    expect(capture[0]!.args).toContain('pers-david');
  });

  it('student gets empty list (non-guardian non-admin)', async () => {
    const { tenantPrisma, capture } = makeFake();
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    let result: unknown[] = [];
    await inTenant(async () => {
      result = await svc.list({}, studentActor);
    });
    expect(result).toEqual([]);
    expect(capture.filter((c) => c.fn === 'q')).toHaveLength(0);
  });

  it('applies familyAccountId/invoiceId/status filters', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForList: [] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.list(
        {
          familyAccountId: 'fa-1',
          invoiceId: 'inv-1',
          status: 'COMPLETED',
        } as never,
        adminActor,
      );
    });
    const sql = capture[0]!.sql.toLowerCase();
    expect(sql).toContain('p.family_account_id = $1::uuid');
    expect(sql).toContain('p.invoice_id = $2::uuid');
    expect(sql).toContain('p.status = $3');
    expect(capture[0]!.args).toEqual(['fa-1', 'inv-1', 'COMPLETED']);
  });
});

describe('PaymentService.getById — row scope', () => {
  it('NotFound when row missing', async () => {
    const { tenantPrisma } = makeFake({ rowsForGetById: [] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.getById('p-missing', adminActor)).rejects.toThrow(NotFoundException);
    });
  });

  it('admin sees any payment', async () => {
    const { tenantPrisma } = makeFake({
      rowsForGetById: [samplePayment],
      rowsForAccountHolder: [{ holder: 'pers-david' }],
      rowsForAccountHolder: [{ holder: 'pers-david' }],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    let result: { id: string } | undefined;
    await inTenant(async () => {
      result = await svc.getById('pay-1', adminActor);
    });
    expect(result?.id).toBe('pay-1');
  });

  it('guardian sees own family payment', async () => {
    const { tenantPrisma } = makeFake({
      rowsForGetById: [samplePayment],
      rowsForAccountHolder: [{ holder: 'pers-david' }],
      rowsForAccountHolder: [{ holder: 'pers-david' }],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    let result: { id: string } | undefined;
    await inTenant(async () => {
      result = await svc.getById('pay-1', guardianActor);
    });
    expect(result?.id).toBe('pay-1');
  });

  it("guardian gets 404 (not 403) for other family payment — don't-leak-existence", async () => {
    const { tenantPrisma } = makeFake({
      rowsForGetById: [samplePayment],
      rowsForAccountHolder: [{ holder: 'pers-david' }],
      rowsForAccountHolder: [{ holder: 'pers-someone-else' }],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.getById('pay-1', guardianActor)).rejects.toThrow(NotFoundException);
    });
  });

  it('student gets 404 for any payment (not guardian)', async () => {
    const { tenantPrisma } = makeFake({
      rowsForGetById: [samplePayment],
      rowsForAccountHolder: [{ holder: 'pers-david' }],
      rowsForAccountHolder: [{ holder: 'pers-maya' }],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.getById('pay-1', studentActor)).rejects.toThrow(NotFoundException);
    });
  });
});

describe('PaymentService.pay — guardrails', () => {
  it('rejects amount <= 0', async () => {
    const { tenantPrisma } = makeFake();
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.pay('inv-1', { amount: 0, paymentMethod: 'CARD' } as never, guardianActor),
      ).rejects.toThrow('amount must be > 0');
      await expect(
        svc.pay('inv-1', { amount: -50, paymentMethod: 'CARD' } as never, guardianActor),
      ).rejects.toThrow('amount must be > 0');
    });
  });

  it('rejects CASH/CHEQUE/WAIVER from non-admin (self-service method gate)', async () => {
    const { tenantPrisma } = makeFake();
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.pay('inv-1', { amount: 50, paymentMethod: 'CASH' } as never, guardianActor),
      ).rejects.toThrow(/CARD or BANK_TRANSFER only/);
    });
  });

  it('admin can use CASH/CHEQUE/WAIVER', async () => {
    const { tenantPrisma } = makeFake({
      invoiceForPay: sampleInvoice,
      rowsForGetById: [samplePayment],
      rowsForAccountHolder: [{ holder: 'pers-david' }],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.pay('inv-1', { amount: 50, paymentMethod: 'CASH' } as never, adminActor);
    });
    // happy path — no throw
  });

  it('defaults paymentMethod to CARD when omitted', async () => {
    const { tenantPrisma, capture } = makeFake({
      invoiceForPay: sampleInvoice,
      rowsForGetById: [samplePayment],
      rowsForAccountHolder: [{ holder: 'pers-david' }],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.pay('inv-1', { amount: 50 } as never, guardianActor);
    });
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_payments'),
    );
    expect(insert!.args).toContain('CARD');
  });

  it('rejects when invoice not found', async () => {
    const { tenantPrisma } = makeFake({ invoiceForPay: null });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.pay('inv-missing', { amount: 50, paymentMethod: 'CARD' } as never, guardianActor),
      ).rejects.toThrow(NotFoundException);
    });
  });

  it('rejects non-account-holder guardian (other family)', async () => {
    const { tenantPrisma } = makeFake({
      invoiceForPay: { ...sampleInvoice, account_holder_id: 'pers-other' },
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.pay('inv-1', { amount: 50, paymentMethod: 'CARD' } as never, guardianActor),
      ).rejects.toThrow(/Only the account holder/);
    });
  });

  it('rejects when family account is SUSPENDED', async () => {
    const { tenantPrisma } = makeFake({
      invoiceForPay: { ...sampleInvoice, account_status: 'SUSPENDED' },
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.pay('inv-1', { amount: 50, paymentMethod: 'CARD' } as never, guardianActor),
      ).rejects.toThrow(/status SUSPENDED.*cannot collect payments/);
    });
  });

  it('rejects DRAFT invoice (not sent yet)', async () => {
    const { tenantPrisma } = makeFake({
      invoiceForPay: { ...sampleInvoice, status: 'DRAFT' },
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.pay('inv-1', { amount: 50, paymentMethod: 'CARD' } as never, guardianActor),
      ).rejects.toThrow('Invoice has not been sent yet');
    });
  });

  it('rejects CANCELLED invoice', async () => {
    const { tenantPrisma } = makeFake({
      invoiceForPay: { ...sampleInvoice, status: 'CANCELLED' },
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.pay('inv-1', { amount: 50, paymentMethod: 'CARD' } as never, guardianActor),
      ).rejects.toThrow('Invoice is CANCELLED');
    });
  });

  it('rejects already-PAID invoice', async () => {
    const { tenantPrisma } = makeFake({
      invoiceForPay: { ...sampleInvoice, status: 'PAID', amount_paid: '500' },
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.pay('inv-1', { amount: 50, paymentMethod: 'CARD' } as never, guardianActor),
      ).rejects.toThrow('Invoice is already PAID');
    });
  });

  it('rejects overpay beyond balance + 0.001 tolerance', async () => {
    const { tenantPrisma } = makeFake({
      invoiceForPay: { ...sampleInvoice, total_amount: '500', amount_paid: '300' },
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.pay('inv-1', { amount: 250, paymentMethod: 'CARD' } as never, guardianActor),
      ).rejects.toThrow(/exceeds outstanding balance \$200/);
    });
  });
});

describe('PaymentService.pay — happy path + side effects', () => {
  it('full payment flips invoice to PAID + writes ledger + outbox emits with full envelope', async () => {
    const { tenantPrisma, capture } = makeFake({
      invoiceForPay: sampleInvoice,
      rowsForGetById: [samplePayment],
      rowsForAccountHolder: [{ holder: 'pers-david' }],
    });
    const { outbox, calls: outboxCalls } = makeOutbox();
    const { ledger, calls: ledgerCalls } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.pay('inv-1', { amount: 500, paymentMethod: 'CARD' } as never, guardianActor);
    });

    // Payment INSERT happened
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_payments'),
    );
    expect(insert).toBeTruthy();
    expect(insert!.sql.toLowerCase()).toContain("'completed'");
    expect(insert!.args).toContain('CARD');
    expect(insert!.args).toContain('500.00');
    // Mock pi_dev_ Stripe id present (CARD method)
    const stripeId = insert!.args.find((a) => typeof a === 'string' && a.startsWith('pi_dev_'));
    expect(stripeId).toBeTruthy();

    // Ledger PAYMENT entry written with negative amount
    expect(ledgerCalls).toHaveLength(1);
    const ledgerArgs = ledgerCalls[0]!.args[0] as Record<string, unknown>;
    expect(ledgerArgs.entryType).toBe('PAYMENT');
    expect(ledgerArgs.amount).toBe(-500);
    expect(ledgerArgs.familyAccountId).toBe('fa-1');

    // Invoice flipped to PAID
    const invoiceUpdate = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('update pay_invoices set status = $1') &&
        c.args[0] === 'PAID',
    );
    expect(invoiceUpdate).toBeTruthy();

    // Outbox emit with full payload
    expect(outboxCalls).toHaveLength(1);
    const emit = outboxCalls[0]!.args[0] as Record<string, unknown>;
    expect(emit.topic).toBe('pay.payment.received');
    expect(emit.sourceModule).toBe('payments');
    const payload = emit.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      invoiceId: 'inv-1',
      familyAccountId: 'fa-1',
      amount: 500,
      paymentMethod: 'CARD',
      invoiceStatus: 'PAID',
      totalAmount: 500,
      amountPaid: 500,
    });
  });

  it('partial payment flips invoice to PARTIAL', async () => {
    const { tenantPrisma, capture } = makeFake({
      invoiceForPay: sampleInvoice,
      rowsForGetById: [samplePayment],
      rowsForAccountHolder: [{ holder: 'pers-david' }],
    });
    const { outbox, calls: outboxCalls } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.pay('inv-1', { amount: 200, paymentMethod: 'CARD' } as never, guardianActor);
    });
    const invoiceUpdate = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('update pay_invoices'),
    );
    expect(invoiceUpdate!.args[0]).toBe('PARTIAL');
    const emit = outboxCalls[0]!.args[0] as Record<string, unknown>;
    const payload = emit.payload as Record<string, unknown>;
    expect(payload.invoiceStatus).toBe('PARTIAL');
    expect(payload.amountPaid).toBe(200);
  });

  it('BANK_TRANSFER skips the pi_dev_ Stripe id', async () => {
    const { tenantPrisma, capture } = makeFake({
      invoiceForPay: sampleInvoice,
      rowsForGetById: [samplePayment],
      rowsForAccountHolder: [{ holder: 'pers-david' }],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.pay(
        'inv-1',
        { amount: 100, paymentMethod: 'BANK_TRANSFER' } as never,
        guardianActor,
      );
    });
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_payments'),
    );
    expect(insert!.args).toContain('BANK_TRANSFER');
    // Stripe intent id should be null (positional arg 7)
    expect(insert!.args[6]).toBeNull();
  });

  it('payment against PARTIAL invoice with existing payment recomputes against refund-aware balance', async () => {
    // $500 invoice, $300 already paid → balance $200; pay $200 → PAID
    const { tenantPrisma, capture } = makeFake({
      invoiceForPay: {
        ...sampleInvoice,
        status: 'PARTIAL',
        amount_paid: '300',
      },
      rowsForGetById: [samplePayment],
      rowsForAccountHolder: [{ holder: 'pers-david' }],
    });
    const { outbox, calls: outboxCalls } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.pay('inv-1', { amount: 200, paymentMethod: 'CARD' } as never, guardianActor);
    });
    const invoiceUpdate = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('update pay_invoices'),
    );
    expect(invoiceUpdate!.args[0]).toBe('PAID');
    const emit = outboxCalls[0]!.args[0] as Record<string, unknown>;
    const payload = emit.payload as Record<string, unknown>;
    expect(payload.amountPaid).toBe(500);
  });

  it('payment lock SQL uses FOR UPDATE OF i + refund-aware amount_paid subquery', async () => {
    const { tenantPrisma, capture } = makeFake({
      invoiceForPay: sampleInvoice,
      rowsForGetById: [samplePayment],
      rowsForAccountHolder: [{ holder: 'pers-david' }],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.pay('inv-1', { amount: 100, paymentMethod: 'CARD' } as never, guardianActor);
    });
    const lockRead = capture.find(
      (c) => c.fn === 'q' && c.sql.toLowerCase().includes('for update of i'),
    );
    expect(lockRead).toBeTruthy();
    expect(lockRead!.sql.toLowerCase()).toContain('coalesce((select sum(p.amount)');
    expect(lockRead!.sql.toLowerCase()).toContain("status in ('completed','refunded')");
    expect(lockRead!.sql.toLowerCase()).toContain('from pay_refunds r');
    expect(lockRead!.sql.toLowerCase()).toContain("r.status = 'completed'");
  });

  it('admin can pay on behalf of any family (skips account-holder check)', async () => {
    const { tenantPrisma } = makeFake({
      invoiceForPay: { ...sampleInvoice, account_holder_id: 'pers-other-family' },
      rowsForGetById: [samplePayment],
      rowsForAccountHolder: [{ holder: 'pers-david' }],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      // No throw expected
      await svc.pay('inv-1', { amount: 50, paymentMethod: 'CARD' } as never, adminActor);
    });
  });

  it('writes notes when provided', async () => {
    const { tenantPrisma, capture } = makeFake({
      invoiceForPay: sampleInvoice,
      rowsForGetById: [samplePayment],
      rowsForAccountHolder: [{ holder: 'pers-david' }],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new PaymentService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.pay(
        'inv-1',
        { amount: 50, paymentMethod: 'CARD', notes: 'Q4 tuition' } as never,
        guardianActor,
      );
    });
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_payments'),
    );
    expect(insert!.args).toContain('Q4 tuition');
  });
});
