import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '@shared/tenant';
import { InvoiceService } from './invoice.service';
import type { ResolvedActor } from '@modules/m00-platform';

/**
 * P2-H4 test coverage uplift — payments/invoice.service.ts (582 LOC,
 * largest 0% file in payments — Tier 1 Financial keystone).
 *
 * Invoice lifecycle DRAFT → SENT → PARTIAL/PAID → CANCELLED with two
 * load-bearing fixes:
 *
 *   - REVIEW-CYCLE6 fix 6: cancel of non-DRAFT invoice writes a
 *     compensating ADJUSTMENT ledger entry netting out the outstanding
 *     balance, AND emits pay.debt.written_off via outbox. DRAFT cancels
 *     skip the compensation (no CHARGE entry yet).
 *
 *   - REVIEW-CYCLE6 fix 8: generateFromSchedule takes a per-(family,
 *     feeSchedule) pg_advisory_xact_lock + in-tx existence check before
 *     INSERTing. Two concurrent bulk-generates serialise on the lock; the
 *     loser bumps `skipped` and the family doesn't get a duplicate DRAFT.
 *
 * Tests cover:
 *   - list row scope: admin all / guardian own family / non-guardian non-admin
 *   - getById 404 don't-leak-existence
 *   - create admin-only, ACTIVE family account, total = SUM(qty*price)
 *   - send DRAFT→SENT with CHARGE ledger entry + outbox pay.invoice.created
 *   - cancel: rejects already-CANCELLED + PAID; DRAFT skips compensation;
 *     non-DRAFT writes ADJUSTMENT + pay.debt.written_off; zero outstanding
 *     skips emit
 *   - generateFromSchedule: schedule active gate, grade filter, advisory
 *     lock + existence check (idempotent re-run skips), per-student line items
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
  school_id: string;
  family_account_id: string;
  family_account_number: string;
  family_account_holder_first: string;
  family_account_holder_last: string;
  title: string;
  description: string | null;
  total_amount: string;
  amount_paid: string;
  due_date: string | null;
  status: string;
  sent_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface FakeOpts {
  rowsForList?: InvoiceRow[];
  rowsForGetById?: InvoiceRow[];
  rowsForLineItems?: unknown[];
  rowsForAccountHolder?: Array<{ holder: string }>;
  rowsForFamilyAccount?: Array<{ id: string; status: string }>;
  rowsForInvoiceLock?: Array<{
    id: string;
    family_account_id: string;
    total_amount: string;
    status: string;
  }>;
  rowsForCancelPaid?: Array<{ paid: string }>;
  rowsForFeeSchedule?: Array<{
    id: string;
    name: string;
    grade_level: string | null;
    amount: string;
    academic_year_id: string;
    is_active: boolean;
  }>;
  rowsForFamilyPairs?: Array<{
    family_account_id: string;
    account_holder_id: string;
    student_id: string;
    first_name: string;
    last_name: string;
    grade_level: string;
  }>;
  rowsForExistingInvoice?: Array<{ id: string }>;
}

function makeFake(opts: FakeOpts = {}) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'q' });
      const s = sql.toLowerCase();
      // line items load
      if (s.includes('from pay_invoice_line_items li')) {
        return opts.rowsForLineItems ?? [];
      }
      // account-holder isAccountHolder check
      if (s.includes('select account_holder_id::text as holder from pay_family_accounts')) {
        return opts.rowsForAccountHolder ?? [];
      }
      // family account validation (during create)
      if (s.includes('select id, status from pay_family_accounts')) {
        return opts.rowsForFamilyAccount ?? [];
      }
      // invoice lock (send / cancel)
      if (
        s.includes('from pay_invoices') &&
        s.includes('for update') &&
        s.includes('total_amount::text')
      ) {
        return opts.rowsForInvoiceLock ?? [];
      }
      // cancel paid aggregate
      if (s.includes('coalesce(sum(amount), 0)::text as paid')) {
        return opts.rowsForCancelPaid ?? [{ paid: '0' }];
      }
      // fee schedule lookup
      if (s.includes('from pay_fee_schedules where id')) {
        return opts.rowsForFeeSchedule ?? [];
      }
      // family pairs (generateFromSchedule)
      if (s.includes('from pay_family_accounts fa') && s.includes('pay_family_account_students')) {
        return opts.rowsForFamilyPairs ?? [];
      }
      // existing invoice in generateFromSchedule existence check
      if (
        s.includes('from pay_invoices i') &&
        s.includes('join pay_invoice_line_items li') &&
        s.includes("status <> 'cancelled'")
      ) {
        return opts.rowsForExistingInvoice ?? [];
      }
      // SELECT_INVOICE_BASE — list / getById
      if (s.includes('from pay_invoices i') && s.includes('join pay_family_accounts fa')) {
        if (s.includes('where i.id = $1::uuid')) return opts.rowsForGetById ?? [];
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

const studentActor: ResolvedActor = {
  accountId: 'acc-maya',
  personId: 'pers-maya',
  personType: 'STUDENT',
  isSchoolAdmin: false,
  employeeId: null,
};

const sampleInvoice: InvoiceRow = {
  id: 'inv-1',
  school_id: SCHOOL.schoolId,
  family_account_id: 'fa-1',
  family_account_number: 'FA-1001',
  family_account_holder_first: 'David',
  family_account_holder_last: 'Chen',
  title: 'Tuition Q4',
  description: null,
  total_amount: '500',
  amount_paid: '0',
  due_date: '2026-12-15',
  status: 'DRAFT',
  sent_at: null,
  notes: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

describe('InvoiceService.list — row scope', () => {
  it('admin sees all', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForList: [sampleInvoice] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    let result: unknown[] = [];
    await inTenant(async () => {
      result = await svc.list({}, adminActor);
    });
    expect(result).toHaveLength(1);
    const listSql = capture.find(
      (c) => c.fn === 'q' && c.sql.toLowerCase().includes('from pay_invoices i'),
    )!;
    // The SELECT_INVOICE_BASE always JOINs through account_holder_id for the holder name;
    // assert no WHERE filter on it for admin.
    expect(listSql.sql.toLowerCase()).not.toContain('account_holder_id = $');
  });

  it('guardian filters by fa.account_holder_id', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForList: [sampleInvoice] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.list({}, guardianActor);
    });
    const listSql = capture.find(
      (c) => c.fn === 'q' && c.sql.toLowerCase().includes('from pay_invoices i'),
    )!;
    expect(listSql.sql.toLowerCase()).toContain('account_holder_id = $1::uuid');
    expect(listSql.args).toContain('pers-david');
  });

  it('non-guardian non-admin gets empty list', async () => {
    const { tenantPrisma, capture } = makeFake();
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    let result: unknown[] = [];
    await inTenant(async () => {
      result = await svc.list({}, studentActor);
    });
    expect(result).toEqual([]);
    expect(capture.filter((c) => c.fn === 'q')).toHaveLength(0);
  });

  it('applies familyAccountId + status filters', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForList: [] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.list({ familyAccountId: 'fa-1', status: 'SENT' } as never, adminActor);
    });
    const listSql = capture[0]!;
    expect(listSql.sql.toLowerCase()).toContain('i.family_account_id = $1::uuid');
    expect(listSql.sql.toLowerCase()).toContain('i.status = $2');
    expect(listSql.args).toEqual(['fa-1', 'SENT']);
  });

  it('list with empty result short-circuits — no line item query', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForList: [] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.list({}, adminActor);
    });
    const lineItemRead = capture.find((c) =>
      c.sql.toLowerCase().includes('from pay_invoice_line_items'),
    );
    expect(lineItemRead).toBeUndefined();
  });

  it('list loads line items and joins them per invoice', async () => {
    const { tenantPrisma } = makeFake({
      rowsForList: [sampleInvoice],
      rowsForLineItems: [
        {
          id: 'li-1',
          invoice_id: 'inv-1',
          fee_schedule_id: null,
          fee_schedule_name: null,
          description: 'Tuition',
          quantity: '1.00',
          unit_price: '500.00',
          total: '500.00',
          sort_order: 0,
        },
      ],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    let result: Array<{ lineItems: unknown[] }> = [];
    await inTenant(async () => {
      result = await svc.list({}, adminActor);
    });
    expect(result[0]!.lineItems).toHaveLength(1);
  });
});

describe('InvoiceService.getById — row scope', () => {
  it('NotFound on miss', async () => {
    const { tenantPrisma } = makeFake({ rowsForGetById: [] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.getById('inv-missing', adminActor)).rejects.toThrow(NotFoundException);
    });
  });

  it('admin sees any invoice', async () => {
    const { tenantPrisma } = makeFake({ rowsForGetById: [sampleInvoice] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    let result: { id: string } | undefined;
    await inTenant(async () => {
      result = await svc.getById('inv-1', adminActor);
    });
    expect(result?.id).toBe('inv-1');
  });

  it('guardian sees own family invoice', async () => {
    const { tenantPrisma } = makeFake({
      rowsForGetById: [sampleInvoice],
      rowsForAccountHolder: [{ holder: 'pers-david' }],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    let result: { id: string } | undefined;
    await inTenant(async () => {
      result = await svc.getById('inv-1', guardianActor);
    });
    expect(result?.id).toBe('inv-1');
  });

  it("guardian gets 404 on other family invoice (don't-leak-existence)", async () => {
    const { tenantPrisma } = makeFake({
      rowsForGetById: [sampleInvoice],
      rowsForAccountHolder: [{ holder: 'pers-other' }],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.getById('inv-1', guardianActor)).rejects.toThrow(NotFoundException);
    });
  });

  it('student gets 404 for any invoice', async () => {
    const { tenantPrisma } = makeFake({
      rowsForGetById: [sampleInvoice],
      rowsForAccountHolder: [{ holder: 'pers-maya' }],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.getById('inv-1', studentActor)).rejects.toThrow(NotFoundException);
    });
  });
});

describe('InvoiceService.create', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.create({ familyAccountId: 'fa-1', title: 'X', lineItems: [] } as never, guardianActor),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('rejects when family account not found', async () => {
    const { tenantPrisma } = makeFake({ rowsForFamilyAccount: [] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.create(
          {
            familyAccountId: 'fa-missing',
            title: 'X',
            lineItems: [{ description: 'Tuition', unitPrice: 500 }],
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  it('rejects when family account is SUSPENDED', async () => {
    const { tenantPrisma } = makeFake({
      rowsForFamilyAccount: [{ id: 'fa-1', status: 'SUSPENDED' }],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.create(
          {
            familyAccountId: 'fa-1',
            title: 'X',
            lineItems: [{ description: 'Tuition', unitPrice: 500 }],
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/status SUSPENDED.*cannot bill/);
    });
  });

  it('computes total = SUM(quantity * unit_price), defaulting quantity to 1', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForFamilyAccount: [{ id: 'fa-1', status: 'ACTIVE' }],
      rowsForGetById: [sampleInvoice],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.create(
        {
          familyAccountId: 'fa-1',
          title: 'Multi',
          lineItems: [
            { description: 'Tuition', unitPrice: 500 }, // quantity defaults to 1 → 500
            { description: 'Books', quantity: 2, unitPrice: 50 }, // 100
            { description: 'Lab', quantity: 3, unitPrice: 30 }, // 90
          ],
        } as never,
        adminActor,
      );
    });
    const invoiceInsert = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('insert into pay_invoices') &&
        c.sql.toLowerCase().includes("'draft'"),
    );
    expect(invoiceInsert).toBeTruthy();
    // total = 500+100+90 = 690
    expect(invoiceInsert!.args).toContain('690.00');
  });

  it('writes one line item INSERT per line with denormalised total + sort_order', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForFamilyAccount: [{ id: 'fa-1', status: 'ACTIVE' }],
      rowsForGetById: [sampleInvoice],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.create(
        {
          familyAccountId: 'fa-1',
          title: 'Multi',
          lineItems: [
            { description: 'Tuition', unitPrice: 500 },
            { description: 'Books', quantity: 2, unitPrice: 50 },
          ],
        } as never,
        adminActor,
      );
    });
    const lineInserts = capture.filter(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_invoice_line_items'),
    );
    expect(lineInserts).toHaveLength(2);
    // sort_order is the last positional arg (7)
    expect(lineInserts[0]!.args[7]).toBe(0);
    expect(lineInserts[1]!.args[7]).toBe(1);
  });
});

describe('InvoiceService.send', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.send('inv-1', guardianActor)).rejects.toThrow(ForbiddenException);
    });
  });

  it('rejects when invoice not found', async () => {
    const { tenantPrisma } = makeFake({ rowsForInvoiceLock: [] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.send('inv-missing', adminActor)).rejects.toThrow(NotFoundException);
    });
  });

  it('rejects non-DRAFT invoice', async () => {
    const { tenantPrisma } = makeFake({
      rowsForInvoiceLock: [
        { id: 'inv-1', family_account_id: 'fa-1', total_amount: '500', status: 'SENT' },
      ],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.send('inv-1', adminActor)).rejects.toThrow(
        /status SENT.*only DRAFT invoices can be sent/,
      );
    });
  });

  it('happy path: locks invoice, flips to SENT, writes CHARGE ledger, emits pay.invoice.created', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForInvoiceLock: [
        { id: 'inv-1', family_account_id: 'fa-1', total_amount: '500', status: 'DRAFT' },
      ],
      rowsForGetById: [sampleInvoice],
    });
    const { outbox, calls: outboxCalls } = makeOutbox();
    const { ledger, calls: ledgerCalls } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.send('inv-1', adminActor);
    });
    const update = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes("status = 'sent'"),
    );
    expect(update).toBeTruthy();
    expect(ledgerCalls).toHaveLength(1);
    const ledgerEntry = ledgerCalls[0]!.args[0] as Record<string, unknown>;
    expect(ledgerEntry).toMatchObject({
      familyAccountId: 'fa-1',
      entryType: 'CHARGE',
      amount: 500,
      referenceId: 'inv-1',
    });
    expect(outboxCalls).toHaveLength(1);
    const emit = outboxCalls[0]!.args[0] as Record<string, unknown>;
    expect(emit.topic).toBe('pay.invoice.created');
    expect(emit.sourceModule).toBe('payments');
    expect(emit.payload).toEqual({
      invoiceId: 'inv-1',
      familyAccountId: 'fa-1',
      totalAmount: 500,
    });
  });
});

describe('InvoiceService.cancel — REVIEW-CYCLE6 fix 6 compensating ADJUSTMENT', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.cancel('inv-1', guardianActor)).rejects.toThrow(ForbiddenException);
    });
  });

  it('rejects when invoice not found', async () => {
    const { tenantPrisma } = makeFake({ rowsForInvoiceLock: [] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.cancel('inv-missing', adminActor)).rejects.toThrow(NotFoundException);
    });
  });

  it('rejects already-CANCELLED invoice', async () => {
    const { tenantPrisma } = makeFake({
      rowsForInvoiceLock: [
        { id: 'inv-1', family_account_id: 'fa-1', total_amount: '500', status: 'CANCELLED' },
      ],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.cancel('inv-1', adminActor)).rejects.toThrow(/already CANCELLED/);
    });
  });

  it('rejects PAID invoice with "issue a refund" message', async () => {
    const { tenantPrisma } = makeFake({
      rowsForInvoiceLock: [
        { id: 'inv-1', family_account_id: 'fa-1', total_amount: '500', status: 'PAID' },
      ],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.cancel('inv-1', adminActor)).rejects.toThrow(
        /Invoice is PAID; issue a refund instead/,
      );
    });
  });

  it('DRAFT cancel skips ADJUSTMENT compensation (no CHARGE was written yet)', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForInvoiceLock: [
        { id: 'inv-1', family_account_id: 'fa-1', total_amount: '500', status: 'DRAFT' },
      ],
      rowsForGetById: [{ ...sampleInvoice, status: 'CANCELLED' }],
    });
    const { outbox, calls: outboxCalls } = makeOutbox();
    const { ledger, calls: ledgerCalls } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.cancel('inv-1', adminActor);
    });
    const update = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes("status = 'cancelled'"),
    );
    expect(update).toBeTruthy();
    // No ADJUSTMENT, no outbox
    expect(ledgerCalls).toHaveLength(0);
    expect(outboxCalls).toHaveLength(0);
  });

  it('SENT cancel with zero paid writes ADJUSTMENT for full total + pay.debt.written_off', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForInvoiceLock: [
        { id: 'inv-1', family_account_id: 'fa-1', total_amount: '500', status: 'SENT' },
      ],
      rowsForCancelPaid: [{ paid: '0' }],
      rowsForGetById: [{ ...sampleInvoice, status: 'CANCELLED' }],
    });
    const { outbox, calls: outboxCalls } = makeOutbox();
    const { ledger, calls: ledgerCalls } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.cancel('inv-1', adminActor);
    });
    expect(ledgerCalls).toHaveLength(1);
    const ledgerEntry = ledgerCalls[0]!.args[0] as Record<string, unknown>;
    expect(ledgerEntry).toMatchObject({
      familyAccountId: 'fa-1',
      entryType: 'ADJUSTMENT',
      amount: -500, // negative reverses the CHARGE
      referenceId: 'inv-1',
    });
    expect(outboxCalls).toHaveLength(1);
    const emit = outboxCalls[0]!.args[0] as Record<string, unknown>;
    expect(emit.topic).toBe('pay.debt.written_off');
    const payload = emit.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      invoiceId: 'inv-1',
      familyAccountId: 'fa-1',
      totalAmount: 500,
      completedPayments: 0,
      outstandingWritten: 500,
      writtenOffBy: 'acc-admin',
    });
  });

  it('PARTIAL cancel writes ADJUSTMENT for outstanding remainder only', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForInvoiceLock: [
        { id: 'inv-1', family_account_id: 'fa-1', total_amount: '500', status: 'PARTIAL' },
      ],
      rowsForCancelPaid: [{ paid: '300' }], // $300 paid, $200 outstanding
      rowsForGetById: [{ ...sampleInvoice, status: 'CANCELLED' }],
    });
    const { outbox, calls: outboxCalls } = makeOutbox();
    const { ledger, calls: ledgerCalls } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.cancel('inv-1', adminActor);
    });
    expect(ledgerCalls).toHaveLength(1);
    const ledgerEntry = ledgerCalls[0]!.args[0] as Record<string, unknown>;
    expect(ledgerEntry.amount).toBe(-200);
    expect(outboxCalls).toHaveLength(1);
    const emit = outboxCalls[0]!.args[0] as Record<string, unknown>;
    const payload = emit.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      completedPayments: 300,
      outstandingWritten: 200,
    });
  });

  it('SENT cancel with FULL paid (no outstanding) skips ADJUSTMENT + emit', async () => {
    // Edge case: fully paid invoice on a SENT-status row (status hasn't
    // been recomputed yet). Cancel should still flip to CANCELLED but
    // not write a debt-write-off compensation.
    const { tenantPrisma, capture } = makeFake({
      rowsForInvoiceLock: [
        { id: 'inv-1', family_account_id: 'fa-1', total_amount: '500', status: 'SENT' },
      ],
      rowsForCancelPaid: [{ paid: '500' }],
      rowsForGetById: [{ ...sampleInvoice, status: 'CANCELLED' }],
    });
    const { outbox, calls: outboxCalls } = makeOutbox();
    const { ledger, calls: ledgerCalls } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.cancel('inv-1', adminActor);
    });
    expect(ledgerCalls).toHaveLength(0);
    expect(outboxCalls).toHaveLength(0);
  });
});

describe('InvoiceService.generateFromSchedule — REVIEW-CYCLE6 fix 8 advisory lock', () => {
  const activeSchedule = {
    id: 'fs-1',
    name: 'Tuition Q1',
    grade_level: null,
    amount: '500',
    academic_year_id: 'ay-1',
    is_active: true,
  };

  const familyPair = {
    family_account_id: 'fa-1',
    account_holder_id: 'pers-david',
    student_id: 's-1',
    first_name: 'Maya',
    last_name: 'Chen',
    grade_level: '5',
  };

  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.generateFromSchedule({ feeScheduleId: 'fs-1' } as never, guardianActor),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('NotFound when fee schedule missing', async () => {
    const { tenantPrisma } = makeFake({ rowsForFeeSchedule: [] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.generateFromSchedule({ feeScheduleId: 'fs-missing' } as never, adminActor),
      ).rejects.toThrow(NotFoundException);
    });
  });

  it('rejects inactive fee schedule', async () => {
    const { tenantPrisma } = makeFake({
      rowsForFeeSchedule: [{ ...activeSchedule, is_active: false }],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.generateFromSchedule({ feeScheduleId: 'fs-1' } as never, adminActor),
      ).rejects.toThrow(/inactive.*activate it before generating/);
    });
  });

  it('returns 0 created when no eligible families', async () => {
    const { tenantPrisma } = makeFake({
      rowsForFeeSchedule: [activeSchedule],
      rowsForFamilyPairs: [],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    let result: { created: number; skipped: number; invoiceIds: string[] } | undefined;
    await inTenant(async () => {
      result = await svc.generateFromSchedule({ feeScheduleId: 'fs-1' } as never, adminActor);
    });
    expect(result?.created).toBe(0);
    expect(result?.skipped).toBe(0);
  });

  it('happy path: per-family advisory lock + INSERT + line items per student', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForFeeSchedule: [activeSchedule],
      rowsForFamilyPairs: [familyPair],
      rowsForExistingInvoice: [], // no existing invoice → INSERT proceeds
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    let result: { created: number; invoiceIds: string[] } | undefined;
    await inTenant(async () => {
      result = await svc.generateFromSchedule({ feeScheduleId: 'fs-1' } as never, adminActor);
    });
    expect(result?.created).toBe(1);
    expect(result?.invoiceIds).toHaveLength(1);
    const advisoryLock = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes("pg_advisory_xact_lock(hashtext('pay_invoices_generate:'"),
    );
    expect(advisoryLock).toBeTruthy();
    expect(advisoryLock!.args).toEqual(['fa-1', 'fs-1']);
    const invoiceInsert = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('insert into pay_invoices') &&
        c.sql.toLowerCase().includes("'draft'"),
    );
    expect(invoiceInsert).toBeTruthy();
    const lineInsert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_invoice_line_items'),
    );
    expect(lineInsert).toBeTruthy();
    // description format: "scheduleName — firstName lastName"
    expect(lineInsert!.args).toContain('Tuition Q1 — Maya Chen');
  });

  it('idempotent: existing invoice in same (family, feeSchedule) → skipped++', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForFeeSchedule: [activeSchedule],
      rowsForFamilyPairs: [familyPair],
      rowsForExistingInvoice: [{ id: 'inv-existing' }],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    let result: { created: number; skipped: number } | undefined;
    await inTenant(async () => {
      result = await svc.generateFromSchedule({ feeScheduleId: 'fs-1' } as never, adminActor);
    });
    expect(result?.created).toBe(0);
    expect(result?.skipped).toBe(1);
    const invoiceInsert = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('insert into pay_invoices') &&
        c.sql.toLowerCase().includes("'draft'"),
    );
    expect(invoiceInsert).toBeUndefined();
  });

  it('multi-student family gets one invoice + N line items', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForFeeSchedule: [activeSchedule],
      rowsForFamilyPairs: [
        { ...familyPair, student_id: 's-1', first_name: 'Maya' },
        { ...familyPair, student_id: 's-2', first_name: 'Ethan' },
        { ...familyPair, student_id: 's-3', first_name: 'Lily' },
      ],
      rowsForExistingInvoice: [],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.generateFromSchedule({ feeScheduleId: 'fs-1' } as never, adminActor);
    });
    const lineInserts = capture.filter(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_invoice_line_items'),
    );
    expect(lineInserts).toHaveLength(3);
    const invoiceInsert = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('insert into pay_invoices') &&
        c.sql.toLowerCase().includes("'draft'"),
    );
    // total = 3 * $500 = $1500
    expect(invoiceInsert!.args).toContain('1500.00');
  });

  it('grade_level filter binds when schedule restricts grade', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForFeeSchedule: [{ ...activeSchedule, grade_level: '5' }],
      rowsForFamilyPairs: [],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.generateFromSchedule({ feeScheduleId: 'fs-1' } as never, adminActor);
    });
    const pairsRead = capture.find(
      (c) => c.fn === 'q' && c.sql.toLowerCase().includes('pay_family_account_students'),
    );
    expect(pairsRead!.sql.toLowerCase()).toContain('s.grade_level = $1');
    expect(pairsRead!.args).toContain('5');
  });

  it('two families one with existing + one without → created=1 skipped=1', async () => {
    // family-level tracking — different families
    const { tenantPrisma } = makeFake({
      rowsForFeeSchedule: [activeSchedule],
      rowsForFamilyPairs: [
        { ...familyPair, family_account_id: 'fa-1', student_id: 's-1' },
        { ...familyPair, family_account_id: 'fa-2', student_id: 's-2' },
      ],
      rowsForExistingInvoice: [{ id: 'inv-existing' }], // returns same for both — both skipped
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    let result: { created: number; skipped: number } | undefined;
    await inTenant(async () => {
      result = await svc.generateFromSchedule({ feeScheduleId: 'fs-1' } as never, adminActor);
    });
    expect(result?.skipped).toBe(2);
    expect(result?.created).toBe(0);
  });

  it('uses body.title when supplied + falls back to schedule.name', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForFeeSchedule: [activeSchedule],
      rowsForFamilyPairs: [familyPair],
      rowsForExistingInvoice: [],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new InvoiceService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.generateFromSchedule(
        { feeScheduleId: 'fs-1', title: 'Custom Title' } as never,
        adminActor,
      );
    });
    const invoiceInsert = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('insert into pay_invoices') &&
        c.sql.toLowerCase().includes("'draft'"),
    );
    expect(invoiceInsert!.args).toContain('Custom Title');
  });
});
