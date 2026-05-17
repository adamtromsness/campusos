import { describe, it, expect } from 'vitest';
import { GlReconciliationWorker } from './gl-reconciliation.worker';
import type { TenantInfo } from '@shared/tenant';

/**
 * P2-H5 DEFECT 5 + DEFECT 6 — GlReconciliationWorker behavioural tests.
 *
 * The worker runs 7 reconciliation checks per tenant: the 5 source→GL
 * checks from P2-H3 (INVOICE_AR / PAYMENT_CASH / REFUND_REVERSAL /
 * CREDIT_NOTE / PAYMENT_REVERSAL) plus 2 new checks added in P2-H5
 * (DUPLICATE_POSTING / ORPHAN_GL_ENTRY). Each check writes one
 * rpt_gl_reconciliation row and emits fin.gl_reconciliation.discrepancy
 * via the durable outbox whenever discrepancies OR a FAILED status fires.
 *
 * The fakes below mock the tenant prisma + outbox and route each SQL
 * shape to the appropriate canned response. The tests assert on the
 * INSERT row + outbox emit, not on the SQL string itself.
 */

const TENANT: TenantInfo = {
  schoolId: '019e03f8-cf0b-7444-92d2-85e2c67b549a',
  schemaName: 'tenant_demo',
  organisationId: 'org-1',
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'MEDIUM',
  homeRegion: 'us-east-1',
};

interface SqlCapture {
  sql: string;
  args: unknown[];
  fn: 'q' | 'e';
}

interface FakeOpts {
  // P2-H5 source→GL: source rows + their amounts. The fake auto-stamps
  // a default `school_id` matching `TENANT.schoolId` on every source row
  // so the SCHOOL_MISMATCH branch is a no-op unless a per-source override
  // is supplied via `sourcesWithSchool`.
  sources?: {
    invoiceAr?: Array<{ id: string; amount: number }>;
    paymentCash?: Array<{ id: string; amount: number }>;
    refundReversal?: Array<{ id: string; amount: number }>;
    creditNote?: Array<{ id: string; amount: number }>;
    paymentReversal?: Array<{ id: string; amount: number }>;
  };
  // P2-H6 FIX 2 — per-source school_id override. When provided, the
  // fake stamps these school_ids onto the SELECT projection so the
  // SCHOOL_MISMATCH check fires against fake batch_school_ids.
  sourceSchoolOverrides?: Record<string, string>;
  // P2-H6 FIX 2 — GL aggregate now returns one row per
  // (reference_id, account_code, batch_school_id). Legacy callers that
  // pass `glAggregates` (gl_total shape) get an automatic split into
  // 50/50 legs across the expected debit + credit accounts for the
  // source type (preserves pre-fix test semantics). Tests that exercise
  // SIGN_MISMATCH or ACCOUNT_MISMATCH pass `glAggregatesByLeg` directly.
  glAggregates?: Record<
    string,
    Array<{ reference_id: string; gl_total: number; line_count: number }>
  >;
  glAggregatesByLeg?: Record<
    string,
    Array<{
      reference_id: string;
      account_code: string;
      batch_school_id: string;
      debit_total: number;
      credit_total: number;
      line_count: number;
    }>
  >;
  duplicates?: Array<{ source_event_id: string; batch_count: number; batch_ids: string[] }>;
  orphans?: Record<string, Array<{ id: string; reference_id: string }>>;
  orphanCounts?: Record<string, number>;
  distinctPostedEvents?: number;
  missingTables?: Set<string>;
  schools?: Array<{
    id: string;
    subdomain: string;
    schema_name: string;
    organisation_id: string | null;
  }>;
  shouldThrowOnQuery?: (sql: string, args: unknown[]) => boolean;
}

// Expected debit / credit chart-of-accounts codes per source type —
// mirrors SOURCE_CHECK_META in gl-reconciliation.worker.ts so the fake
// can split a legacy gl_total aggregate into the right legs.
const EXPECTED_LEGS: Record<string, { debitCode: string; creditCode: string }> = {
  pay_invoices: { debitCode: '1100', creditCode: '4000' },
  pay_payments: { debitCode: '1000', creditCode: '1100' },
  pay_refunds: { debitCode: '1100', creditCode: '1000' },
  pay_credit_notes: { debitCode: '4000', creditCode: '1100' },
  pay_payment_reversals: { debitCode: '1100', creditCode: '1000' },
};

function makeFakes(opts: FakeOpts = {}) {
  const captures: SqlCapture[] = [];
  const sources = opts.sources ?? {};
  const glAggregates = opts.glAggregates ?? {};
  const orphans = opts.orphans ?? {};
  const orphanCounts = opts.orphanCounts ?? {};
  const missing = opts.missingTables ?? new Set<string>();
  const distinct = opts.distinctPostedEvents ?? 0;

  const exists = (table: string) => !missing.has(table);

  const tenantSchoolId = TENANT.schoolId;
  const overrides = opts.sourceSchoolOverrides ?? {};
  const stampSchool = (rows: Array<{ id: string; amount: number }>) =>
    rows.map((r) => ({
      id: r.id,
      amount: r.amount,
      school_id: overrides[r.id] ?? tenantSchoolId,
      currency: null,
    }));

  // P2-H6 FIX 2 — split a legacy gl_total aggregate into per-leg rows
  // so existing tests using the simple {reference_id, gl_total} shape
  // still drive the new query path. The split puts half the total on
  // the expected debit account and half on the expected credit account,
  // each on a leg matching tenantSchoolId so SCHOOL_MISMATCH stays
  // quiet by default.
  const legAggregatesByRefType: Record<
    string,
    Array<{
      reference_id: string;
      account_code: string;
      batch_school_id: string;
      debit_total: number;
      credit_total: number;
      line_count: number;
    }>
  > = {};
  for (const [refType, rows] of Object.entries(glAggregates)) {
    const legs = EXPECTED_LEGS[refType];
    if (!legs) continue;
    const out: Array<{
      reference_id: string;
      account_code: string;
      batch_school_id: string;
      debit_total: number;
      credit_total: number;
      line_count: number;
    }> = [];
    for (const r of rows) {
      const half = r.gl_total / 2;
      out.push({
        reference_id: r.reference_id,
        account_code: legs.debitCode,
        batch_school_id: tenantSchoolId,
        debit_total: half,
        credit_total: 0,
        line_count: Math.max(1, Math.floor(r.line_count / 2)),
      });
      out.push({
        reference_id: r.reference_id,
        account_code: legs.creditCode,
        batch_school_id: tenantSchoolId,
        debit_total: 0,
        credit_total: half,
        line_count: Math.max(1, Math.ceil(r.line_count / 2)),
      });
    }
    legAggregatesByRefType[refType] = out;
  }
  // Per-leg overrides take precedence so tests can exercise
  // SIGN_MISMATCH / ACCOUNT_MISMATCH / SCHOOL_MISMATCH directly.
  for (const [refType, rows] of Object.entries(opts.glAggregatesByLeg ?? {})) {
    legAggregatesByRefType[refType] = rows;
  }

  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      captures.push({ sql, args, fn: 'q' });
      if (opts.shouldThrowOnQuery?.(sql, args)) {
        throw new Error('relation does not exist');
      }
      // Table-existence probe
      if (sql.includes('information_schema.tables')) {
        const tableArg = args[0] as string;
        return exists(tableArg) ? [{ ok: 1 }] : [];
      }
      // Orphan probe — matched FIRST because its SQL also contains
      // `FROM pay_invoices src` etc., which would otherwise substring-
      // match the source-row scans below.
      if (sql.includes('NOT EXISTS') && sql.includes('FROM fin_gl_entries g')) {
        const refType = args[0] as string;
        return orphans[refType] ?? [];
      }
      if (sql.includes('COUNT(*)::int AS n FROM fin_gl_entries WHERE reference_type')) {
        const refType = args[0] as string;
        return [{ n: orphanCounts[refType] ?? 0 }];
      }
      // GL aggregate (P2-H6 FIX 2 — new SQL shape with separate
      // SUM(g.debit) + SUM(g.credit) and JOINs through
      // fin_journal_batches + fin_chart_of_accounts).
      if (
        sql.includes('FROM fin_gl_entries g') &&
        sql.includes('SUM(g.debit)') &&
        sql.includes('JOIN fin_chart_of_accounts')
      ) {
        const refType = args[0] as string;
        return legAggregatesByRefType[refType] ?? [];
      }
      // Duplicate postings
      if (sql.includes('FROM fin_journal_batches') && sql.includes('HAVING COUNT(*) > 1')) {
        return opts.duplicates ?? [];
      }
      // Distinct posted-event count
      if (sql.includes('COUNT(DISTINCT source_event_id)')) {
        return [{ n: distinct }];
      }
      // Source-row scans — the new SELECT projects `school_id` + `currency`
      // alongside id + amount, so stamp default school + null currency.
      if (sql.includes('FROM pay_invoices s')) return stampSchool(sources.invoiceAr ?? []);
      if (sql.includes('FROM pay_payments s')) return stampSchool(sources.paymentCash ?? []);
      if (sql.includes('FROM pay_refunds s')) return stampSchool(sources.refundReversal ?? []);
      if (sql.includes('FROM pay_credit_notes s')) return stampSchool(sources.creditNote ?? []);
      if (sql.includes('FROM pay_payment_reversals s'))
        return stampSchool(sources.paymentReversal ?? []);
      return [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      captures.push({ sql, args, fn: 'e' });
      return 0;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
    executeInTenantTransaction: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
    getPlatformClient: () => ({
      $queryRawUnsafe: async () => opts.schools ?? [],
    }),
  };
  return { tenantPrisma, captures };
}

interface OutboxCall {
  topic: string;
  key: string;
  sourceModule: string;
  payload: Record<string, unknown>;
}

function makeOutbox() {
  const enqueued: OutboxCall[] = [];
  return {
    outbox: {
      enqueueInTx: async (
        _tx: unknown,
        opts: {
          topic: string;
          key: string;
          sourceModule: string;
          payload: Record<string, unknown>;
        },
      ) => {
        enqueued.push(opts);
      },
    },
    enqueued,
  };
}

function findInsert(captures: SqlCapture[]): SqlCapture[] {
  return captures.filter(
    (c) => c.fn === 'e' && c.sql.includes('INSERT INTO rpt_gl_reconciliation'),
  );
}

describe('GlReconciliationWorker.runForTenant', () => {
  it('writes 7 rpt_gl_reconciliation rows per tenant (5 source→GL + DUPLICATE_POSTING + ORPHAN_GL_ENTRY)', async () => {
    const fakes = makeFakes({});
    const { outbox } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    const count = await worker.runForTenant(TENANT);
    expect(count).toBe(7);
    const inserts = findInsert(fakes.captures);
    expect(inserts).toHaveLength(7);
    expect(inserts.map((i) => i.args[2]).sort()).toEqual([
      'CREDIT_NOTE',
      'DUPLICATE_POSTING',
      'INVOICE_AR',
      'ORPHAN_GL_ENTRY',
      'PAYMENT_CASH',
      'PAYMENT_REVERSAL',
      'REFUND_REVERSAL',
    ]);
  });

  it('marks CLEAN when every source row matches a GL entry of expected amount', async () => {
    // One invoice at $100, GL entry totals $200 (debit + credit balanced).
    const fakes = makeFakes({
      sources: { invoiceAr: [{ id: 'inv-1', amount: 100 }] },
      glAggregates: {
        pay_invoices: [{ reference_id: 'inv-1', gl_total: 200, line_count: 2 }],
      },
    });
    const { outbox, enqueued } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    await worker.runForTenant(TENANT);
    const invoice = findInsert(fakes.captures).find((c) => c.args[2] === 'INVOICE_AR')!;
    expect(invoice.args[7]).toBe('CLEAN');
    expect(invoice.args[3]).toBe(1); // total_source
    expect(invoice.args[4]).toBe(1); // matched
    expect(invoice.args[5]).toBe(0); // discrepancy_count
    // No outbox emit on CLEAN
    expect(enqueued.find((e) => e.payload.checkType === 'INVOICE_AR')).toBeUndefined();
  });
});

describe('source→GL — MISSING_GL_ENTRY discrepancies', () => {
  it('flags every source row with no matching GL entry', async () => {
    const fakes = makeFakes({
      sources: {
        invoiceAr: [
          { id: 'inv-1', amount: 100 },
          { id: 'inv-2', amount: 200 },
        ],
      },
      glAggregates: {
        // Only inv-1 has a GL entry; inv-2 is missing.
        pay_invoices: [{ reference_id: 'inv-1', gl_total: 200, line_count: 2 }],
      },
    });
    const { outbox, enqueued } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    await worker.runForTenant(TENANT);
    const invoice = findInsert(fakes.captures).find((c) => c.args[2] === 'INVOICE_AR')!;
    expect(invoice.args[7]).toBe('DISCREPANCIES_FOUND');
    expect(invoice.args[3]).toBe(2); // total_source
    expect(invoice.args[4]).toBe(1); // matched
    expect(invoice.args[5]).toBe(1); // discrepancy_count
    const discrepancies = JSON.parse(invoice.args[6] as string);
    expect(discrepancies).toHaveLength(1);
    expect(discrepancies[0]).toMatchObject({
      sourceId: 'inv-2',
      sourceTable: 'pay_invoices',
      issue: 'MISSING_GL_ENTRY',
    });
    // Outbox emit fires
    const emit = enqueued.find((e) => e.payload.checkType === 'INVOICE_AR');
    expect(emit).toBeDefined();
    expect(emit!.topic).toBe('fin.gl_reconciliation.discrepancy');
    expect(emit!.payload.severity).toBe('URGENT');
    expect(emit!.payload.status).toBe('DISCREPANCIES_FOUND');
  });
});

describe('source→GL — AMOUNT_MISMATCH discrepancies (P2-H5 DEFECT 5)', () => {
  it('flags source rows whose GL total ≠ source amount × 2 (balanced batch) or × 1 (single-line)', async () => {
    const fakes = makeFakes({
      sources: { paymentCash: [{ id: 'pay-1', amount: 50 }] },
      glAggregates: {
        // pay-1 has a GL entry totalling $80 — neither 1× ($50) nor 2× ($100). Mismatch.
        pay_payments: [{ reference_id: 'pay-1', gl_total: 80, line_count: 2 }],
      },
    });
    const { outbox, enqueued } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    await worker.runForTenant(TENANT);
    const payment = findInsert(fakes.captures).find((c) => c.args[2] === 'PAYMENT_CASH')!;
    expect(payment.args[7]).toBe('DISCREPANCIES_FOUND');
    const discrepancies = JSON.parse(payment.args[6] as string);
    expect(discrepancies).toHaveLength(1);
    expect(discrepancies[0]).toMatchObject({
      sourceId: 'pay-1',
      sourceTable: 'pay_payments',
      issue: 'AMOUNT_MISMATCH',
      expected: 100,
      actual: 80,
    });
    expect(enqueued.find((e) => e.payload.checkType === 'PAYMENT_CASH')).toBeDefined();
  });

  it('accepts single-line postings (1× source amount) without flagging AMOUNT_MISMATCH', async () => {
    const fakes = makeFakes({
      sources: { refundReversal: [{ id: 'r-1', amount: 25 }] },
      glAggregates: {
        pay_refunds: [{ reference_id: 'r-1', gl_total: 25, line_count: 1 }],
      },
    });
    const { outbox } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    await worker.runForTenant(TENANT);
    const refund = findInsert(fakes.captures).find((c) => c.args[2] === 'REFUND_REVERSAL')!;
    expect(refund.args[7]).toBe('CLEAN');
  });
});

describe('P2-H6 FIX 2 — SIGN_MISMATCH discrepancies', () => {
  it('flags an invoice posting whose debit/credit legs are flipped (DR Revenue / CR AR instead of DR AR / CR Revenue)', async () => {
    const fakes = makeFakes({
      sources: { invoiceAr: [{ id: 'inv-flip', amount: 100 }] },
      glAggregatesByLeg: {
        // Legs are flipped: expected debit on 1100 (AR), credit on 4000 (Revenue).
        // Here we have debit on 4000 (the expected credit account!) and credit on 1100.
        pay_invoices: [
          {
            reference_id: 'inv-flip',
            account_code: '4000', // expected as the credit account
            batch_school_id: TENANT.schoolId,
            debit_total: 100, // ← being DEBITED instead of credited
            credit_total: 0,
            line_count: 1,
          },
          {
            reference_id: 'inv-flip',
            account_code: '1100', // expected as the debit account
            batch_school_id: TENANT.schoolId,
            debit_total: 0,
            credit_total: 100, // ← being CREDITED instead of debited
            line_count: 1,
          },
        ],
      },
    });
    const { outbox, enqueued } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    await worker.runForTenant(TENANT);
    const invoice = findInsert(fakes.captures).find((c) => c.args[2] === 'INVOICE_AR')!;
    expect(invoice.args[7]).toBe('DISCREPANCIES_FOUND');
    const discrepancies = JSON.parse(invoice.args[6] as string);
    const signMismatch = discrepancies.find((d: { issue: string }) => d.issue === 'SIGN_MISMATCH');
    expect(signMismatch).toBeDefined();
    expect(signMismatch.expectedDebitAccount).toBe('1100');
    expect(signMismatch.expectedCreditAccount).toBe('4000');
    expect(enqueued.find((e) => e.payload.checkType === 'INVOICE_AR')).toBeDefined();
  });
});

describe('P2-H6 FIX 2 — ACCOUNT_MISMATCH discrepancies', () => {
  it('flags a payment posting that lands on the wrong chart-of-accounts code', async () => {
    const fakes = makeFakes({
      sources: { paymentCash: [{ id: 'pay-wrong', amount: 50 }] },
      glAggregatesByLeg: {
        // Expected for payments: DR 1000 (Cash) / CR 1100 (AR). Here both
        // legs land on a totally unrelated account (e.g. 9999 Suspense).
        pay_payments: [
          {
            reference_id: 'pay-wrong',
            account_code: '9999',
            batch_school_id: TENANT.schoolId,
            debit_total: 50,
            credit_total: 50,
            line_count: 2,
          },
        ],
      },
    });
    const { outbox, enqueued } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    await worker.runForTenant(TENANT);
    const payment = findInsert(fakes.captures).find((c) => c.args[2] === 'PAYMENT_CASH')!;
    expect(payment.args[7]).toBe('DISCREPANCIES_FOUND');
    const discrepancies = JSON.parse(payment.args[6] as string);
    const accountMismatch = discrepancies.find(
      (d: { issue: string }) => d.issue === 'ACCOUNT_MISMATCH',
    );
    expect(accountMismatch).toBeDefined();
    expect(accountMismatch.expectedDebitAccount).toBe('1000');
    expect(accountMismatch.expectedCreditAccount).toBe('1100');
    expect(accountMismatch.actualAccountCodes).toContain('9999');
    expect(enqueued.find((e) => e.payload.checkType === 'PAYMENT_CASH')).toBeDefined();
  });
});

describe('P2-H6 FIX 2 — SCHOOL_MISMATCH discrepancies', () => {
  it('flags a GL batch posted under a school different from the source row tenant', async () => {
    const otherSchoolId = '019e03f8-cf0b-7444-92d2-ffffffffffff';
    const fakes = makeFakes({
      sources: { invoiceAr: [{ id: 'inv-cross', amount: 100 }] },
      // Source row stamped with TENANT.schoolId (default), but the GL
      // batch landed under a different school.
      glAggregatesByLeg: {
        pay_invoices: [
          {
            reference_id: 'inv-cross',
            account_code: '1100',
            batch_school_id: otherSchoolId,
            debit_total: 100,
            credit_total: 0,
            line_count: 1,
          },
          {
            reference_id: 'inv-cross',
            account_code: '4000',
            batch_school_id: otherSchoolId,
            debit_total: 0,
            credit_total: 100,
            line_count: 1,
          },
        ],
      },
    });
    const { outbox, enqueued } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    await worker.runForTenant(TENANT);
    const invoice = findInsert(fakes.captures).find((c) => c.args[2] === 'INVOICE_AR')!;
    expect(invoice.args[7]).toBe('DISCREPANCIES_FOUND');
    const discrepancies = JSON.parse(invoice.args[6] as string);
    const schoolMismatch = discrepancies.find(
      (d: { issue: string }) => d.issue === 'SCHOOL_MISMATCH',
    );
    expect(schoolMismatch).toBeDefined();
    expect(schoolMismatch.expectedSchoolId).toBe(TENANT.schoolId);
    expect(schoolMismatch.actualSchoolId).toBe(otherSchoolId);
    expect(enqueued.find((e) => e.payload.checkType === 'INVOICE_AR')).toBeDefined();
  });
});

describe('DUPLICATE_POSTING check (P2-H5 DEFECT 5)', () => {
  it('emits a DISCREPANCIES_FOUND row + alert when the same source_event_id appears in multiple POSTED batches', async () => {
    const fakes = makeFakes({
      duplicates: [
        {
          source_event_id: 'evt-1',
          batch_count: 2,
          batch_ids: ['batch-a', 'batch-b'],
        },
      ],
      distinctPostedEvents: 5,
    });
    const { outbox, enqueued } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    await worker.runForTenant(TENANT);
    const dup = findInsert(fakes.captures).find((c) => c.args[2] === 'DUPLICATE_POSTING')!;
    expect(dup.args[7]).toBe('DISCREPANCIES_FOUND');
    expect(dup.args[3]).toBe(5);
    expect(dup.args[5]).toBe(1);
    const discrepancies = JSON.parse(dup.args[6] as string);
    expect(discrepancies[0]).toMatchObject({
      sourceId: 'evt-1',
      issue: 'DUPLICATE_POSTING',
      batchCount: 2,
      batchIds: ['batch-a', 'batch-b'],
    });
    expect(enqueued.find((e) => e.payload.checkType === 'DUPLICATE_POSTING')).toBeDefined();
  });

  it('reports CLEAN when no source_event_id appears more than once', async () => {
    const fakes = makeFakes({ duplicates: [], distinctPostedEvents: 10 });
    const { outbox } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    await worker.runForTenant(TENANT);
    const dup = findInsert(fakes.captures).find((c) => c.args[2] === 'DUPLICATE_POSTING')!;
    expect(dup.args[7]).toBe('CLEAN');
  });
});

describe('ORPHAN_GL_ENTRY check (P2-H5 DEFECT 5)', () => {
  it('flags GL entries whose reference_id no longer resolves in the named source table', async () => {
    const fakes = makeFakes({
      orphans: {
        pay_invoices: [{ id: 'gl-1', reference_id: 'inv-missing' }],
      },
      orphanCounts: { pay_invoices: 50 },
    });
    const { outbox, enqueued } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    await worker.runForTenant(TENANT);
    const orphan = findInsert(fakes.captures).find((c) => c.args[2] === 'ORPHAN_GL_ENTRY')!;
    expect(orphan.args[7]).toBe('DISCREPANCIES_FOUND');
    expect(orphan.args[5]).toBe(1);
    const discrepancies = JSON.parse(orphan.args[6] as string);
    expect(discrepancies[0]).toMatchObject({
      sourceId: 'gl-1',
      issue: 'ORPHAN_GL_ENTRY',
      referenceType: 'pay_invoices',
      referenceId: 'inv-missing',
    });
    expect(enqueued.find((e) => e.payload.checkType === 'ORPHAN_GL_ENTRY')).toBeDefined();
  });
});

describe('FAILED status emits an alert (P2-H5 DEFECT 5)', () => {
  it('emits fin.gl_reconciliation.discrepancy when the check query throws', async () => {
    const fakes = makeFakes({
      shouldThrowOnQuery: (sql) => sql.includes('FROM pay_credit_notes s'),
    });
    const { outbox, enqueued } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    await worker.runForTenant(TENANT);
    const failed = findInsert(fakes.captures).find((c) => c.args[2] === 'CREDIT_NOTE')!;
    expect(failed.args[7]).toBe('FAILED');
    // counts_chk-safe coercion
    expect(failed.args[3]).toBe(0);
    expect(failed.args[4]).toBe(0);
    expect(failed.args[5]).toBe(0);
    // Alert MUST fire even on FAILED so SRE pages on a broken check
    const emit = enqueued.find(
      (e) => e.payload.checkType === 'CREDIT_NOTE' && e.payload.status === 'FAILED',
    );
    expect(emit).toBeDefined();
    expect(emit!.payload.severity).toBe('URGENT');
    expect((emit!.payload.discrepancies as Array<{ issue: string }>)[0].issue).toBe(
      'CHECK_QUERY_FAILED',
    );
  });

  it('emits SOURCE_TABLE_MISSING when the source table does not exist in this tenant', async () => {
    const fakes = makeFakes({
      missingTables: new Set(['pay_credit_notes']),
    });
    const { outbox, enqueued } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    await worker.runForTenant(TENANT);
    const failed = findInsert(fakes.captures).find((c) => c.args[2] === 'CREDIT_NOTE')!;
    expect(failed.args[7]).toBe('FAILED');
    const emit = enqueued.find(
      (e) => e.payload.checkType === 'CREDIT_NOTE' && e.payload.status === 'FAILED',
    );
    expect(emit).toBeDefined();
    expect((emit!.payload.discrepancies as Array<{ issue: string }>)[0].issue).toBe(
      'SOURCE_TABLE_MISSING',
    );
  });
});

describe('GlReconciliationWorker.runOnce — multi-tenant iteration', () => {
  it('iterates active schools and accumulates the rpt row count (7 per school)', async () => {
    const fakes = makeFakes({
      schools: [
        { id: 'school-1', subdomain: 's1', schema_name: 'tenant_s1', organisation_id: 'org-1' },
        { id: 'school-2', subdomain: 's2', schema_name: 'tenant_s2', organisation_id: null },
      ],
    });
    const { outbox } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    const count = await worker.runOnce();
    // 7 checks × 2 schools
    expect(count).toBe(14);
  });

  it('returns 0 when there are no active schools', async () => {
    const fakes = makeFakes({ schools: [] });
    const { outbox } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    expect(await worker.runOnce()).toBe(0);
  });

  it('returns 0 when loadActiveSchools throws (logs + survives)', async () => {
    const tenantPrisma = {
      executeInTenantContext: async () => [],
      executeInTenantTransaction: async () => [],
      getPlatformClient: () => ({
        $queryRawUnsafe: async () => {
          throw new Error('platform schema down');
        },
      }),
    };
    const { outbox } = makeOutbox();
    const worker = new GlReconciliationWorker(tenantPrisma as never, outbox as never);
    expect(await worker.runOnce()).toBe(0);
  });
});
