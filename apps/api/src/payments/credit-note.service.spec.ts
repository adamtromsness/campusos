import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '../tenant/tenant.context';
import { CreditNoteService, deterministicCreditNoteEventId } from './credit-note.service';
import type { ResolvedActor } from '../iam/actor-context.service';

/**
 * P2-H4 test coverage uplift — payments/credit-note.service.ts (241 LOC,
 * Tier 1 Financial IMMUTABLE credit note per ADR-010).
 *
 * Service exposes only list / getById / issue — no update / delete methods.
 * Corrections are made by issuing a NEW offsetting credit note or refund.
 *
 * issue() locks parent invoice FOR UPDATE, validates not CANCELLED + optional
 * line_item belongs to invoice, writes CREDIT ledger entry (negative amount
 * reduces balance owed), INSERTs the credit note row, emits
 * pay.credit_note.issued with deterministic event_id for redelivery dedup.
 *
 * Tests cover:
 *   - deterministicCreditNoteEventId v5 shape + stability
 *   - list + getById admin-only with school-scoped reads (REVIEW-P2-6)
 *   - issue() guardrails: admin gate, amount > 0, empty/whitespace reason,
 *     invoice NotFound, CANCELLED invoice rejection, line_item validation
 *   - issue() happy path: invoice lock, ledger CREDIT entry (negative),
 *     credit-note INSERT with ledger_entry_id wired, outbox emit with
 *     deterministic event_id + full envelope
 *   - default category to GOODWILL when omitted
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
  rowsForInvoiceLock?: Array<{
    id: string;
    school_id: string;
    family_account_id: string;
    total_amount: string;
    status: string;
  }>;
  rowsForLineItem?: unknown[];
}

function makeFake(opts: FakeOpts = {}) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'q' });
      const s = sql.toLowerCase();
      if (
        s.includes('from pay_invoices') &&
        s.includes('for update') &&
        s.includes('total_amount::text')
      ) {
        return opts.rowsForInvoiceLock ?? [];
      }
      if (s.includes('from pay_invoice_line_items')) {
        return opts.rowsForLineItem ?? [];
      }
      if (s.includes('from pay_credit_notes')) {
        if (s.includes('and id = $2::uuid')) return opts.rowsForGetById ?? [];
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

const sampleInvoiceLock = {
  id: 'inv-1',
  school_id: SCHOOL.schoolId,
  family_account_id: 'fa-1',
  total_amount: '500',
  status: 'SENT',
};

const sampleCreditNoteRow = {
  id: 'cn-1',
  school_id: SCHOOL.schoolId,
  invoice_id: 'inv-1',
  line_item_id: null,
  family_account_id: 'fa-1',
  credit_amount: '25',
  credit_category: 'GOODWILL',
  reason: 'Service issue compensation',
  ledger_entry_id: 'ledger-1',
  issued_by: 'acc-admin',
  issued_at: '2026-04-15T00:00:00Z',
};

describe('deterministicCreditNoteEventId helper', () => {
  it('produces a v5-shaped UUID', () => {
    const id = deterministicCreditNoteEventId('cn-1');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('stable across calls (same input → same output)', () => {
    const a = deterministicCreditNoteEventId('cn-1');
    const b = deterministicCreditNoteEventId('cn-1');
    expect(a).toBe(b);
  });

  it('different credit-note ids produce different event ids', () => {
    expect(deterministicCreditNoteEventId('cn-1')).not.toBe(deterministicCreditNoteEventId('cn-2'));
  });
});

describe('CreditNoteService.list — admin-only + school-scoped', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new CreditNoteService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.list({}, guardianActor)).rejects.toThrow(/Only admins can list/);
    });
  });

  it('admin sees all with school_id predicate', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForList: [sampleCreditNoteRow] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new CreditNoteService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.list({}, adminActor);
    });
    expect(capture[0]!.sql.toLowerCase()).toContain('school_id = $1::uuid');
    expect(capture[0]!.args).toContain(SCHOOL.schoolId);
  });

  it('applies invoiceId + familyAccountId filters', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForList: [] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new CreditNoteService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.list({ invoiceId: 'inv-1', familyAccountId: 'fa-1' } as never, adminActor);
    });
    const sql = capture[0]!.sql.toLowerCase();
    expect(sql).toContain('invoice_id = $2::uuid');
    expect(sql).toContain('family_account_id = $3::uuid');
    expect(capture[0]!.args).toEqual([SCHOOL.schoolId, 'inv-1', 'fa-1']);
  });
});

describe('CreditNoteService.getById', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new CreditNoteService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.getById('cn-1', guardianActor)).rejects.toThrow(ForbiddenException);
    });
  });

  it('NotFound when row missing', async () => {
    const { tenantPrisma } = makeFake({ rowsForGetById: [] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new CreditNoteService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.getById('cn-missing', adminActor)).rejects.toThrow(NotFoundException);
    });
  });

  it('admin reads with school binding', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForGetById: [sampleCreditNoteRow] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new CreditNoteService(tenantPrisma as never, outbox as never, ledger as never);
    let result: { id: string; creditAmount: number } | undefined;
    await inTenant(async () => {
      result = await svc.getById('cn-1', adminActor);
    });
    expect(result?.id).toBe('cn-1');
    expect(result?.creditAmount).toBe(25);
    expect(capture[0]!.args).toEqual([SCHOOL.schoolId, 'cn-1']);
  });
});

describe('CreditNoteService.issue — guardrails', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new CreditNoteService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.issue('inv-1', { creditAmount: 25, reason: 'r' } as never, guardianActor),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('rejects creditAmount <= 0', async () => {
    const { tenantPrisma } = makeFake();
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new CreditNoteService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.issue('inv-1', { creditAmount: 0, reason: 'r' } as never, adminActor),
      ).rejects.toThrow('creditAmount must be > 0');
      await expect(
        svc.issue('inv-1', { creditAmount: -5, reason: 'r' } as never, adminActor),
      ).rejects.toThrow('creditAmount must be > 0');
    });
  });

  it('rejects empty / whitespace-only reason', async () => {
    const { tenantPrisma } = makeFake();
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new CreditNoteService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.issue('inv-1', { creditAmount: 25, reason: '' } as never, adminActor),
      ).rejects.toThrow('reason is required');
      await expect(
        svc.issue('inv-1', { creditAmount: 25, reason: '   ' } as never, adminActor),
      ).rejects.toThrow('reason is required');
    });
  });

  it('NotFound when invoice missing (cross-school predicate fires first)', async () => {
    const { tenantPrisma } = makeFake({ rowsForInvoiceLock: [] });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new CreditNoteService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.issue('inv-missing', { creditAmount: 25, reason: 'r' } as never, adminActor),
      ).rejects.toThrow(NotFoundException);
    });
  });

  it('rejects CANCELLED invoice with friendly message', async () => {
    const { tenantPrisma } = makeFake({
      rowsForInvoiceLock: [{ ...sampleInvoiceLock, status: 'CANCELLED' }],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new CreditNoteService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.issue('inv-1', { creditAmount: 25, reason: 'r' } as never, adminActor),
      ).rejects.toThrow('Cannot issue credit against a CANCELLED invoice');
    });
  });

  it('rejects lineItemId that does not belong to the invoice', async () => {
    const { tenantPrisma } = makeFake({
      rowsForInvoiceLock: [sampleInvoiceLock],
      rowsForLineItem: [], // line item lookup returns empty → 400
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new CreditNoteService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await expect(
        svc.issue(
          'inv-1',
          { creditAmount: 25, reason: 'r', lineItemId: 'li-other' } as never,
          adminActor,
        ),
      ).rejects.toThrow('lineItemId does not belong to this invoice');
    });
  });

  it('accepts lineItemId when it belongs to the invoice', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForInvoiceLock: [sampleInvoiceLock],
      rowsForLineItem: [{ id: 'li-1' }],
      rowsForGetById: [{ ...sampleCreditNoteRow, line_item_id: 'li-1' }],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new CreditNoteService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.issue(
        'inv-1',
        { creditAmount: 25, reason: 'partial credit', lineItemId: 'li-1' } as never,
        adminActor,
      );
    });
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_credit_notes'),
    );
    expect(insert!.args).toContain('li-1');
  });
});

describe('CreditNoteService.issue — happy path + side effects', () => {
  it('locks invoice FOR UPDATE with school-scoped predicate', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForInvoiceLock: [sampleInvoiceLock],
      rowsForGetById: [sampleCreditNoteRow],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new CreditNoteService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.issue('inv-1', { creditAmount: 25, reason: 'r' } as never, adminActor);
    });
    const lockRead = capture.find(
      (c) =>
        c.fn === 'q' &&
        c.sql.toLowerCase().includes('from pay_invoices') &&
        c.sql.toLowerCase().includes('for update'),
    );
    expect(lockRead).toBeTruthy();
    expect(lockRead!.sql.toLowerCase()).toContain('school_id = $1::uuid');
    expect(lockRead!.args).toEqual([SCHOOL.schoolId, 'inv-1']);
  });

  it('writes CREDIT ledger entry with negative amount (reduces balance owed)', async () => {
    const { tenantPrisma } = makeFake({
      rowsForInvoiceLock: [sampleInvoiceLock],
      rowsForGetById: [sampleCreditNoteRow],
    });
    const { outbox } = makeOutbox();
    const { ledger, calls: ledgerCalls } = makeLedger();
    const svc = new CreditNoteService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.issue(
        'inv-1',
        { creditAmount: 25, reason: 'goodwill comp', creditCategory: 'SERVICE_ISSUE' } as never,
        adminActor,
      );
    });
    expect(ledgerCalls).toHaveLength(1);
    const entry = ledgerCalls[0]!.args[0] as Record<string, unknown>;
    expect(entry).toMatchObject({
      familyAccountId: 'fa-1',
      entryType: 'CREDIT',
      amount: -25, // negative — reduces balance owed
    });
    expect(entry.description).toContain('CREDIT');
    expect(entry.description).toContain('SERVICE_ISSUE');
    expect(entry.description).toContain('goodwill comp');
  });

  it('credit note INSERT carries category, trimmed reason, ledger_entry_id, line_item_id=null when omitted', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForInvoiceLock: [sampleInvoiceLock],
      rowsForGetById: [sampleCreditNoteRow],
    });
    const { outbox } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new CreditNoteService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.issue(
        'inv-1',
        {
          creditAmount: 25,
          reason: '  partial credit issued  ',
          creditCategory: 'PROGRAMME_CANCELLED',
        } as never,
        adminActor,
      );
    });
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_credit_notes'),
    );
    expect(insert).toBeTruthy();
    expect(insert!.args).toContain('partial credit issued'); // trimmed
    expect(insert!.args).toContain('PROGRAMME_CANCELLED');
    expect(insert!.args).toContain('25.00');
    expect(insert!.args).toContain('ledger-entry-new-1');
    expect(insert!.args).toContain(null); // line_item_id default
  });

  it('defaults creditCategory to GOODWILL when not supplied', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForInvoiceLock: [sampleInvoiceLock],
      rowsForGetById: [sampleCreditNoteRow],
    });
    const { outbox } = makeOutbox();
    const { ledger, calls: ledgerCalls } = makeLedger();
    const svc = new CreditNoteService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.issue('inv-1', { creditAmount: 25, reason: 'r' } as never, adminActor);
    });
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_credit_notes'),
    );
    expect(insert!.args).toContain('GOODWILL');
    const entry = ledgerCalls[0]!.args[0] as Record<string, unknown>;
    expect(entry.description).toContain('GOODWILL');
  });

  it('outbox emit carries deterministic event_id + full payload', async () => {
    const { tenantPrisma } = makeFake({
      rowsForInvoiceLock: [sampleInvoiceLock],
      rowsForGetById: [sampleCreditNoteRow],
    });
    const { outbox, calls: outboxCalls } = makeOutbox();
    const { ledger } = makeLedger();
    const svc = new CreditNoteService(tenantPrisma as never, outbox as never, ledger as never);
    await inTenant(async () => {
      await svc.issue(
        'inv-1',
        { creditAmount: 25, reason: 'r', creditCategory: 'GOODWILL' } as never,
        adminActor,
      );
    });
    expect(outboxCalls).toHaveLength(1);
    const emit = outboxCalls[0]!.args[0] as Record<string, unknown>;
    expect(emit.topic).toBe('pay.credit_note.issued');
    expect(emit.sourceModule).toBe('payments');
    expect(emit.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const payload = emit.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      invoiceId: 'inv-1',
      familyAccountId: 'fa-1',
      creditAmount: 25,
      creditCategory: 'GOODWILL',
      reason: 'r',
      issuedBy: 'acc-admin',
      ledgerEntryId: 'ledger-entry-new-1',
    });
    // sourceRefId === creditNoteId
    expect(payload.sourceRefId).toBe(payload.creditNoteId);
  });

  it('no UPDATE/DELETE methods on prototype (ADR-010 IMMUTABLE)', () => {
    const proto = CreditNoteService.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.update).toBe('undefined');
    expect(typeof proto.delete).toBe('undefined');
    expect(typeof proto.patch).toBe('undefined');
    expect(typeof proto.remove).toBe('undefined');
    expect(typeof proto.cancel).toBe('undefined');
    expect(typeof proto.void).toBe('undefined');
    // Verify the only mutation is `issue`
    expect(typeof proto.issue).toBe('function');
  });
});
