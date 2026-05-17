import { describe, it, expect } from 'vitest';
import { GlReconciliationWorker } from './gl-reconciliation.worker';
import type { TenantInfo } from '../tenant/tenant.context';

/**
 * P2-H4 test coverage uplift — gl-reconciliation.worker.ts (352 LOC,
 * critical-path Tier 1 Financial ≥95%).
 *
 * P2-H3 Step 3 keystone for Phase 2 IMP-07 (GL reconciliation controls).
 * Five daily check types verify that every financial source row has at
 * least one fin_gl_entries row pointing back at it:
 *
 *   INVOICE_AR       pay_invoices  (non-DRAFT, non-CANCELLED)
 *   PAYMENT_CASH     pay_payments  (COMPLETED, REFUNDED)
 *   REFUND_REVERSAL  pay_refunds   (COMPLETED)
 *   CREDIT_NOTE     pay_credit_notes
 *   PAYMENT_REVERSAL pay_payment_reversals
 *
 * Discrepancies emit `fin.gl_reconciliation.discrepancy` via the durable
 * outbox so PagerDuty can wake SRE inside the 15-minute financial-event
 * SLA. FAILED rows coerce matched=total_source + discrepancy=0 so the
 * schema's counts_chk passes while the discrepancies JSONB preserves
 * the operator-facing truth.
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

function makeFakes(opts: {
  // Per-check-type: discrepancy rows + source count
  invoiceArDiscrepancies?: Array<{ id: string }>;
  paymentCashDiscrepancies?: Array<{ id: string }>;
  refundReversalDiscrepancies?: Array<{ id: string }>;
  creditNoteDiscrepancies?: Array<{ id: string }>;
  paymentReversalDiscrepancies?: Array<{ id: string }>;
  sourceCounts?: Record<string, number>;
  // platform.schools result
  schools?: Array<{
    id: string;
    subdomain: string;
    schema_name: string;
    organisation_id: string | null;
  }>;
  // Per-call SQL override (e.g. simulate missing source table by throwing)
  shouldThrowOnQuery?: (sql: string) => boolean;
}) {
  const captures: SqlCapture[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      captures.push({ sql, args, fn: 'q' });
      if (opts.shouldThrowOnQuery?.(sql)) throw new Error('relation does not exist');
      // Per-check discrepancy queries — fake mirrors the SELECT's
      // `'<table>'::text AS source_table` literal so the worker's mapper
      // populates sourceTable correctly.
      if (sql.includes('FROM pay_invoices') && sql.includes('NOT EXISTS')) {
        return (opts.invoiceArDiscrepancies ?? []).map((r) => ({
          ...r,
          source_table: 'pay_invoices',
        }));
      }
      if (sql.includes('FROM pay_payments') && sql.includes('NOT EXISTS')) {
        return (opts.paymentCashDiscrepancies ?? []).map((r) => ({
          ...r,
          source_table: 'pay_payments',
        }));
      }
      if (sql.includes('FROM pay_refunds') && sql.includes('NOT EXISTS')) {
        return (opts.refundReversalDiscrepancies ?? []).map((r) => ({
          ...r,
          source_table: 'pay_refunds',
        }));
      }
      if (sql.includes('FROM pay_credit_notes') && sql.includes('NOT EXISTS')) {
        return (opts.creditNoteDiscrepancies ?? []).map((r) => ({
          ...r,
          source_table: 'pay_credit_notes',
        }));
      }
      if (sql.includes('FROM pay_payment_reversals') && sql.includes('NOT EXISTS')) {
        return (opts.paymentReversalDiscrepancies ?? []).map((r) => ({
          ...r,
          source_table: 'pay_payment_reversals',
        }));
      }
      // COUNT queries
      if (sql.includes('COUNT(*)::int') && sql.includes('FROM pay_invoices')) {
        return [{ n: opts.sourceCounts?.INVOICE_AR ?? 0 }];
      }
      if (sql.includes('COUNT(*)::int') && sql.includes('FROM pay_payments')) {
        return [{ n: opts.sourceCounts?.PAYMENT_CASH ?? 0 }];
      }
      if (sql.includes('COUNT(*)::int') && sql.includes('FROM pay_refunds')) {
        return [{ n: opts.sourceCounts?.REFUND_REVERSAL ?? 0 }];
      }
      if (sql.includes('COUNT(*)::int') && sql.includes('FROM pay_credit_notes')) {
        return [{ n: opts.sourceCounts?.CREDIT_NOTE ?? 0 }];
      }
      if (sql.includes('COUNT(*)::int') && sql.includes('FROM pay_payment_reversals')) {
        return [{ n: opts.sourceCounts?.PAYMENT_REVERSAL ?? 0 }];
      }
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

describe('GlReconciliationWorker.runForTenant — CLEAN path', () => {
  it('writes 5 CLEAN rpt_gl_reconciliation rows when every source matches', async () => {
    const fakes = makeFakes({
      sourceCounts: {
        INVOICE_AR: 10,
        PAYMENT_CASH: 8,
        REFUND_REVERSAL: 2,
        CREDIT_NOTE: 1,
        PAYMENT_REVERSAL: 0,
      },
    });
    const { outbox, enqueued } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    const count = await worker.runForTenant(TENANT);
    expect(count).toBe(5);
    const inserts = findInsert(fakes.captures);
    expect(inserts).toHaveLength(5);
    // Every INSERT carries status='CLEAN' and matched = total_source
    for (const ins of inserts) {
      expect(ins.args[7]).toBe('CLEAN');
      expect(ins.args[3]).toBe(ins.args[4]); // total_source === matched
      expect(ins.args[5]).toBe(0); // discrepancy_count = 0
    }
    // No outbox emit when everything is CLEAN
    expect(enqueued).toHaveLength(0);
  });
});

describe('GlReconciliationWorker.runForTenant — DISCREPANCIES_FOUND path', () => {
  it('writes a DISCREPANCIES_FOUND row + emits fin.gl_reconciliation.discrepancy when invoices are missing GL', async () => {
    const fakes = makeFakes({
      invoiceArDiscrepancies: [{ id: 'inv-1' }, { id: 'inv-2' }],
      sourceCounts: { INVOICE_AR: 10 },
    });
    const { outbox, enqueued } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    await worker.runForTenant(TENANT);
    const inserts = findInsert(fakes.captures);
    const invoiceArInsert = inserts.find((c) => c.args[2] === 'INVOICE_AR');
    expect(invoiceArInsert).toBeDefined();
    expect(invoiceArInsert!.args[3]).toBe(10); // total_source
    expect(invoiceArInsert!.args[4]).toBe(8); // matched = 10 - 2
    expect(invoiceArInsert!.args[5]).toBe(2); // discrepancy_count
    expect(invoiceArInsert!.args[7]).toBe('DISCREPANCIES_FOUND');
    // The JSONB discrepancies payload carries one entry per discrepancy
    const discrepanciesJson = JSON.parse(invoiceArInsert!.args[6] as string);
    expect(discrepanciesJson).toHaveLength(2);
    expect(discrepanciesJson[0]).toEqual({
      sourceId: 'inv-1',
      sourceTable: 'pay_invoices',
      issue: 'MISSING_GL_ENTRY',
    });
    // Outbox emit fired with full alert payload
    const emit = enqueued.find((e) => e.payload.checkType === 'INVOICE_AR');
    expect(emit).toBeDefined();
    expect(emit!.topic).toBe('fin.gl_reconciliation.discrepancy');
    expect(emit!.sourceModule).toBe('finance');
    expect(emit!.payload.schoolId).toBe(TENANT.schoolId);
    expect(emit!.payload.discrepancyCount).toBe(2);
    expect(emit!.payload.severity).toBe('URGENT');
    expect(emit!.payload.reconciliationRunId).toBe(emit!.key);
  });

  it('caps the discrepancies JSONB to 100 entries (operator-facing payload limit)', async () => {
    const bigDiscrepancyList = Array.from({ length: 250 }, (_, i) => ({ id: `inv-${i}` }));
    const fakes = makeFakes({
      paymentCashDiscrepancies: bigDiscrepancyList,
      sourceCounts: { PAYMENT_CASH: 300 },
    });
    const { outbox } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    await worker.runForTenant(TENANT);
    const inserts = findInsert(fakes.captures);
    const paymentInsert = inserts.find((c) => c.args[2] === 'PAYMENT_CASH');
    const discrepancies = JSON.parse(paymentInsert!.args[6] as string);
    expect(discrepancies).toHaveLength(100);
    // But discrepancy_count column still reports the real total
    expect(paymentInsert!.args[5]).toBe(250);
  });

  it('emits a separate fin.gl_reconciliation.discrepancy per affected check_type', async () => {
    const fakes = makeFakes({
      invoiceArDiscrepancies: [{ id: 'inv-1' }],
      refundReversalDiscrepancies: [{ id: 'r-1' }, { id: 'r-2' }],
      sourceCounts: {
        INVOICE_AR: 5,
        PAYMENT_CASH: 0,
        REFUND_REVERSAL: 3,
        CREDIT_NOTE: 0,
        PAYMENT_REVERSAL: 0,
      },
    });
    const { outbox, enqueued } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    await worker.runForTenant(TENANT);
    expect(enqueued).toHaveLength(2);
    expect(enqueued.map((e) => e.payload.checkType).sort()).toEqual([
      'INVOICE_AR',
      'REFUND_REVERSAL',
    ]);
  });
});

describe('GlReconciliationWorker — FAILED path (source table missing or query error)', () => {
  it('writes a FAILED row with counts coerced to satisfy counts_chk', async () => {
    const fakes = makeFakes({
      // Simulate missing pay_credit_notes table — query throws
      shouldThrowOnQuery: (sql) =>
        sql.includes('FROM pay_credit_notes') && sql.includes('NOT EXISTS'),
    });
    const { outbox, enqueued } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    await worker.runForTenant(TENANT);
    const inserts = findInsert(fakes.captures);
    const creditNoteInsert = inserts.find((c) => c.args[2] === 'CREDIT_NOTE');
    expect(creditNoteInsert).toBeDefined();
    expect(creditNoteInsert!.args[7]).toBe('FAILED');
    // counts_chk requires matched = total_source AND discrepancy = 0 in this state
    expect(creditNoteInsert!.args[3]).toBe(0); // total_source
    expect(creditNoteInsert!.args[4]).toBe(0); // matched
    expect(creditNoteInsert!.args[5]).toBe(0); // discrepancy_count
    expect(creditNoteInsert!.args[6]).toBe('[]'); // empty discrepancies payload
    // FAILED rows do NOT emit the outbox discrepancy event
    expect(enqueued.find((e) => e.payload.checkType === 'CREDIT_NOTE')).toBeUndefined();
  });
});

describe('GlReconciliationWorker.runOnce — multi-tenant iteration', () => {
  it('iterates active schools and accumulates the rpt row count', async () => {
    const fakes = makeFakes({
      schools: [
        { id: 'school-1', subdomain: 's1', schema_name: 'tenant_s1', organisation_id: 'org-1' },
        { id: 'school-2', subdomain: 's2', schema_name: 'tenant_s2', organisation_id: null },
      ],
      sourceCounts: {
        INVOICE_AR: 1,
        PAYMENT_CASH: 1,
        REFUND_REVERSAL: 1,
        CREDIT_NOTE: 1,
        PAYMENT_REVERSAL: 1,
      },
    });
    const { outbox } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    const count = await worker.runOnce();
    // 5 check types × 2 schools = 10 rpt rows
    expect(count).toBe(10);
  });

  it('returns 0 when there are no active schools (gracefully)', async () => {
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

describe('GlReconciliationWorker — SQL shape per check_type', () => {
  it('INVOICE_AR query: excludes DRAFT and CANCELLED, NOT EXISTS on pay_invoices reference', async () => {
    const fakes = makeFakes({ sourceCounts: { INVOICE_AR: 0 } });
    const { outbox } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    await worker.runForTenant(TENANT);
    const invoiceQuery = fakes.captures.find(
      (c) => c.sql.includes('FROM pay_invoices i') && c.sql.includes('NOT EXISTS'),
    );
    expect(invoiceQuery).toBeDefined();
    expect(invoiceQuery!.sql).toContain("i.status NOT IN ('DRAFT', 'CANCELLED')");
    expect(invoiceQuery!.sql).toContain("g.reference_type = 'pay_invoices'");
  });

  it('PAYMENT_CASH query: filters COMPLETED + REFUNDED', async () => {
    const fakes = makeFakes({ sourceCounts: { PAYMENT_CASH: 0 } });
    const { outbox } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    await worker.runForTenant(TENANT);
    const q = fakes.captures.find(
      (c) => c.sql.includes('FROM pay_payments p') && c.sql.includes('NOT EXISTS'),
    );
    expect(q!.sql).toContain("p.status IN ('COMPLETED', 'REFUNDED')");
    expect(q!.sql).toContain("g.reference_type = 'pay_payments'");
  });

  it('REFUND_REVERSAL query: filters COMPLETED only', async () => {
    const fakes = makeFakes({ sourceCounts: { REFUND_REVERSAL: 0 } });
    const { outbox } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    await worker.runForTenant(TENANT);
    const q = fakes.captures.find(
      (c) => c.sql.includes('FROM pay_refunds r') && c.sql.includes('NOT EXISTS'),
    );
    expect(q!.sql).toContain("r.status = 'COMPLETED'");
    expect(q!.sql).toContain("g.reference_type = 'pay_refunds'");
  });

  it('CREDIT_NOTE query: every row checked (no status filter — credit notes are immutable)', async () => {
    const fakes = makeFakes({ sourceCounts: { CREDIT_NOTE: 0 } });
    const { outbox } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    await worker.runForTenant(TENANT);
    const q = fakes.captures.find(
      (c) => c.sql.includes('FROM pay_credit_notes c') && c.sql.includes('NOT EXISTS'),
    );
    expect(q!.sql).toContain("g.reference_type = 'pay_credit_notes'");
    expect(q!.sql).not.toContain('c.status');
  });

  it('PAYMENT_REVERSAL query: every row checked (also immutable)', async () => {
    const fakes = makeFakes({ sourceCounts: { PAYMENT_REVERSAL: 0 } });
    const { outbox } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    await worker.runForTenant(TENANT);
    const q = fakes.captures.find(
      (c) => c.sql.includes('FROM pay_payment_reversals pr') && c.sql.includes('NOT EXISTS'),
    );
    expect(q!.sql).toContain("g.reference_type = 'pay_payment_reversals'");
    expect(q!.sql).not.toContain('pr.status');
  });

  it('loadActiveSchools query: filters platform.schools by is_active=true', async () => {
    const platformCaptures: SqlCapture[] = [];
    const tenantPrisma = {
      executeInTenantContext: async () => [],
      executeInTenantTransaction: async () => [],
      getPlatformClient: () => ({
        $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
          platformCaptures.push({ sql, args, fn: 'q' });
          return [];
        },
      }),
    };
    const { outbox } = makeOutbox();
    const worker = new GlReconciliationWorker(tenantPrisma as never, outbox as never);
    await worker.runOnce();
    expect(platformCaptures).toHaveLength(1);
    expect(platformCaptures[0].sql).toContain('FROM platform.schools');
    expect(platformCaptures[0].sql).toContain('is_active = true');
  });
});

describe('GlReconciliationWorker.recordRun — INSERT shape', () => {
  it('INSERT into rpt_gl_reconciliation includes all 8 documented columns', async () => {
    const fakes = makeFakes({ sourceCounts: { INVOICE_AR: 3 } });
    const { outbox } = makeOutbox();
    const worker = new GlReconciliationWorker(fakes.tenantPrisma as never, outbox as never);
    await worker.runForTenant(TENANT);
    const insert = findInsert(fakes.captures)[0];
    expect(insert.sql).toContain('INSERT INTO rpt_gl_reconciliation');
    expect(insert.sql).toContain(
      'id, school_id, check_type, total_source_rows, total_matched_rows',
    );
    expect(insert.sql).toContain('discrepancy_count, discrepancies, status');
    expect(insert.sql).toContain('::jsonb');
    // School id is the second argument
    expect(insert.args[1]).toBe(TENANT.schoolId);
  });
});
