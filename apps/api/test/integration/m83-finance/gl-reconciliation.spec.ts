import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { GlReconciliationWorker } from '@modules/m83-finance/gl-reconciliation.worker';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import type { TenantInfo } from '@shared/tenant/tenant.context';

import {
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_SCHEMA,
  TEST_SUBDOMAIN,
  TEST_ORG_ID,
} from '../helpers/tenant-context';
import { TEST_ADMIN_EMPLOYEE_ID } from '../helpers/actor';
import { resetFinanceAdvancedTables } from '../helpers/reset';
import {
  TEST_FUND_ID,
  TEST_COA_CASH_ID,
  TEST_COA_AR_ID,
  TEST_COA_REVENUE_ID,
  TEST_COA_SUPPLIES_ID,
  TEST_PERIOD_ID,
} from '../fixtures/finance';

/**
 * Wave 1 — DB-backed integration tests for GlReconciliationWorker.
 *
 * The worker scans every active school and writes one rpt_gl_reconciliation
 * row per (school, run, check_type). Seven check types:
 *   - INVOICE_AR, PAYMENT_CASH, REFUND_REVERSAL, CREDIT_NOTE, PAYMENT_REVERSAL
 *     (source-vs-GL checks)
 *   - DUPLICATE_POSTING (same source_event_id appears in >1 POSTED batch)
 *   - ORPHAN_GL_ENTRY (fin_gl_entries.reference_id missing from source)
 *
 * Per-check discrepancy classes: MISSING_GL_ENTRY, AMOUNT_MISMATCH,
 * SIGN_MISMATCH, ACCOUNT_MISMATCH, SCHOOL_MISMATCH.
 *
 * On DISCREPANCIES_FOUND or FAILED, the worker emits
 * fin.gl_reconciliation.discrepancy via the durable outbox. CLEAN runs
 * silently materialise the row and do NOT emit.
 */
describe('integration:m83-finance/gl-reconciliation', () => {
  let tenantPrisma: TenantPrismaService;
  let outbox: OutboxService;
  let worker: GlReconciliationWorker;
  let rawClient: PrismaClient;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    outbox = new OutboxService();
    worker = new GlReconciliationWorker(tenantPrisma, outbox);
    rawClient = new PrismaClient();
    await rawClient.$connect();
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await import('../helpers/tenant-context').then(({ withTestTenant }) =>
      withTestTenant(async () => {
        await resetFinanceAdvancedTables(tenantPrisma);
      }),
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE tenant_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  // Convenience: build the TenantInfo for runForTenant calls without
  // re-implementing the helpers.
  function tenantInfoA(): TenantInfo {
    return {
      schoolId: TEST_SCHOOL_ID,
      schemaName: TEST_SCHEMA,
      organisationId: TEST_ORG_ID,
      subdomain: TEST_SUBDOMAIN,
      isFrozen: false,
      planTier: 'MEDIUM',
      homeRegion: 'us-east-1',
    };
  }

  // ─── seed helpers ───
  async function seedFamilyAccount(schoolId = TEST_SCHOOL_ID): Promise<string> {
    const id = generateId();
    const holderId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pay_family_accounts (id, school_id, account_holder_id, account_number)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
      id,
      schoolId,
      holderId,
      'FA-' + id.slice(0, 8),
    );
    return id;
  }

  async function seedInvoice(opts: {
    schoolId?: string;
    familyAccountId: string;
    total: number;
    status?: string;
  }): Promise<string> {
    const id = generateId();
    const status = opts.status ?? 'SENT';
    const sentAt = status === 'DRAFT' || status === 'CANCELLED' ? null : new Date();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pay_invoices (id, school_id, family_account_id, title, total_amount, status, sent_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'Test invoice', $4::numeric, $5, $6)`,
      id,
      opts.schoolId ?? TEST_SCHOOL_ID,
      opts.familyAccountId,
      opts.total,
      status,
      sentAt,
    );
    return id;
  }

  async function seedPayment(opts: {
    schoolId?: string;
    invoiceId: string;
    familyAccountId: string;
    amount: number;
    status?: string;
  }): Promise<string> {
    const id = generateId();
    const status = opts.status ?? 'COMPLETED';
    const paidAt = status === 'COMPLETED' || status === 'REFUNDED' ? new Date() : null;
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pay_payments
         (id, school_id, invoice_id, family_account_id, amount, payment_method, status, paid_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, 'CARD', $6, $7)`,
      id,
      opts.schoolId ?? TEST_SCHOOL_ID,
      opts.invoiceId,
      opts.familyAccountId,
      opts.amount,
      status,
      paidAt,
    );
    return id;
  }

  /**
   * Insert a POSTED batch + 2-line GL entries balanced as DR `debitCode` /
   * CR `creditCode` for `amount`, referencing the supplied source row. Used
   * to seed "matching" GL postings to make a CLEAN run.
   */
  async function seedMatchingGl(opts: {
    referenceType: string;
    referenceId: string;
    amount: number;
    debitCode: string; // chart-of-accounts code e.g. '1100'
    creditCode: string;
    schoolId?: string;
    sourceEventId?: string;
  }): Promise<string> {
    const batchId = generateId();
    const schoolId = opts.schoolId ?? TEST_SCHOOL_ID;
    // Map account codes → IDs (fixture-provided)
    const codeToId: Record<string, string> = {
      '1000': TEST_COA_CASH_ID,
      '1100': TEST_COA_AR_ID,
      '4000': TEST_COA_REVENUE_ID,
      '5000': TEST_COA_SUPPLIES_ID,
    };
    const debitAccountId = codeToId[opts.debitCode]!;
    const creditAccountId = codeToId[opts.creditCode]!;
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.fin_journal_batches
         (id, school_id, batch_number, description, batch_type, source_event_id, accounting_period_id, posted_by, posted_at, status)
       VALUES ($1::uuid, $2::uuid, $3, 'recon-seed', 'AUTO_PAYMENT', $4::uuid, $5::uuid, $6::uuid, now(), 'POSTED')`,
      batchId,
      schoolId,
      'JB-' + batchId.slice(0, 8),
      opts.sourceEventId ?? null,
      TEST_PERIOD_ID,
      TEST_ADMIN_EMPLOYEE_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.fin_gl_entries
         (id, batch_id, account_id, fund_id, debit, credit, reference_type, reference_id, line_order)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, 0, $6, $7::uuid, 0),
         ($8::uuid, $2::uuid, $9::uuid, $4::uuid, 0, $5::numeric, $6, $7::uuid, 1)`,
      generateId(),
      batchId,
      debitAccountId,
      TEST_FUND_ID,
      opts.amount,
      opts.referenceType,
      opts.referenceId,
      generateId(),
      creditAccountId,
    );
    return batchId;
  }

  async function readReconRows(
    schoolId = TEST_SCHOOL_ID,
  ): Promise<
    Array<{
      id: string;
      check_type: string;
      total_source_rows: number;
      discrepancy_count: number;
      status: string;
      discrepancies: string;
    }>
  > {
    return (await rawClient.$queryRawUnsafe(
      `SELECT id::text AS id, check_type, total_source_rows, discrepancy_count, status, discrepancies::text AS discrepancies
         FROM ${TEST_SCHEMA}.rpt_gl_reconciliation WHERE school_id = $1::uuid ORDER BY check_type`,
      schoolId,
    )) as Array<{
      id: string;
      check_type: string;
      total_source_rows: number;
      discrepancy_count: number;
      status: string;
      discrepancies: string;
    }>;
  }

  async function readAlertOutbox(schoolId = TEST_SCHOOL_ID): Promise<
    Array<{ topic: string; message_key: string; envelope: string }>
  > {
    return (await rawClient.$queryRawUnsafe(
      `SELECT topic, message_key, envelope::text AS envelope
         FROM platform.platform_outbox
        WHERE topic = 'fin.gl_reconciliation.discrepancy' AND tenant_id = $1::uuid`,
      schoolId,
    )) as Array<{ topic: string; message_key: string; envelope: string }>;
  }

  // ────────────────────────────────────────────────────────────────────
  // Baseline — empty DB
  // ────────────────────────────────────────────────────────────────────
  describe('baseline (empty DB)', () => {
    it('runForTenant writes one row per check type (7 total) — CLEAN across the board with empty source [Finding 4 FIXED]', async () => {
      const written = await worker.runForTenant(tenantInfoA());
      expect(written).toBe(7);

      const rows = await readReconRows();
      expect(rows).toHaveLength(7);
      const types = rows.map((r) => r.check_type).sort();
      expect(types).toEqual([
        'CREDIT_NOTE',
        'DUPLICATE_POSTING',
        'INVOICE_AR',
        'ORPHAN_GL_ENTRY',
        'PAYMENT_CASH',
        'PAYMENT_REVERSAL',
        'REFUND_REVERSAL',
      ]);

      // Post-Finding-4 fix: every check type parses cleanly. With
      // empty source tables (and the new school_id filter from
      // Finding 5), every check returns CLEAN with zero discrepancies.
      for (const r of rows) {
        expect(r.status).toBe('CLEAN');
        expect(Number(r.discrepancy_count)).toBe(0);
      }

      // CLEAN runs emit no alerts.
      const alerts = await readAlertOutbox();
      expect(alerts).toHaveLength(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // INVOICE_AR check — MISSING / AMOUNT / SIGN / ACCOUNT mismatches
  // ────────────────────────────────────────────────────────────────────
  describe('INVOICE_AR check', () => {
    it('SENT invoice without any matching GL → MISSING_GL_ENTRY discrepancy + alert', async () => {
      const fa = await seedFamilyAccount();
      const invId = await seedInvoice({ familyAccountId: fa, total: 500, status: 'SENT' });

      await worker.runForTenant(tenantInfoA());

      const rows = await readReconRows();
      const invoiceRow = rows.find((r) => r.check_type === 'INVOICE_AR')!;
      expect(invoiceRow.status).toBe('DISCREPANCIES_FOUND');
      expect(Number(invoiceRow.total_source_rows)).toBe(1);
      expect(Number(invoiceRow.discrepancy_count)).toBe(1);

      const discreps = JSON.parse(invoiceRow.discrepancies) as Array<{
        sourceId: string;
        issue: string;
      }>;
      expect(discreps).toHaveLength(1);
      expect(discreps[0]!.sourceId).toBe(invId);
      expect(discreps[0]!.issue).toBe('MISSING_GL_ENTRY');

      // Alert emitted (one outbox row for INVOICE_AR)
      const alerts = await readAlertOutbox();
      const invoiceAlert = alerts.find((a) => {
        const env = JSON.parse(a.envelope);
        return env.payload.checkType === 'INVOICE_AR';
      });
      expect(invoiceAlert).toBeDefined();
      const env = JSON.parse(invoiceAlert!.envelope);
      expect(env.event_type).toBe('fin.gl_reconciliation.discrepancy');
      expect(env.payload.status).toBe('DISCREPANCIES_FOUND');
      expect(env.payload.severity).toBe('URGENT');
      expect(env.payload.schoolId).toBe(TEST_SCHOOL_ID);
      expect(env.payload.discrepancyCount).toBe(1);
    });

    it('SENT invoice with correctly-coded matching GL ($amount, DR AR 1100 / CR Revenue 4000) → CLEAN', async () => {
      const fa = await seedFamilyAccount();
      const invId = await seedInvoice({ familyAccountId: fa, total: 250 });
      await seedMatchingGl({
        referenceType: 'pay_invoices',
        referenceId: invId,
        amount: 250,
        debitCode: '1100',
        creditCode: '4000',
      });

      await worker.runForTenant(tenantInfoA());

      const rows = await readReconRows();
      const invoiceRow = rows.find((r) => r.check_type === 'INVOICE_AR')!;
      expect(invoiceRow.status).toBe('CLEAN');
      expect(Number(invoiceRow.total_source_rows)).toBe(1);
      expect(Number(invoiceRow.discrepancy_count)).toBe(0);

      // No alert for the INVOICE_AR check
      const alerts = await readAlertOutbox();
      const invoiceAlert = alerts.find((a) =>
        JSON.parse(a.envelope).payload.checkType === 'INVOICE_AR',
      );
      expect(invoiceAlert).toBeUndefined();
    });

    it('SENT invoice with GL amount $999 ≠ source $250 → AMOUNT_MISMATCH', async () => {
      const fa = await seedFamilyAccount();
      const invId = await seedInvoice({ familyAccountId: fa, total: 250 });
      await seedMatchingGl({
        referenceType: 'pay_invoices',
        referenceId: invId,
        amount: 999, // wrong
        debitCode: '1100',
        creditCode: '4000',
      });

      await worker.runForTenant(tenantInfoA());

      const rows = await readReconRows();
      const invoiceRow = rows.find((r) => r.check_type === 'INVOICE_AR')!;
      expect(invoiceRow.status).toBe('DISCREPANCIES_FOUND');
      const discreps = JSON.parse(invoiceRow.discrepancies) as Array<{
        sourceId: string;
        issue: string;
        expected?: number;
        actual?: number;
      }>;
      const amountDiscrep = discreps.find((d) => d.issue === 'AMOUNT_MISMATCH');
      expect(amountDiscrep).toBeDefined();
      expect(amountDiscrep!.expected).toBe(500); // expectedDouble = single * 2 = 250 * 2
    });

    it('SENT invoice with legs flipped (DR Revenue / CR AR) → SIGN_MISMATCH', async () => {
      const fa = await seedFamilyAccount();
      const invId = await seedInvoice({ familyAccountId: fa, total: 250 });
      // Flipped: expected DR AR / CR Revenue; actual DR Revenue / CR AR
      await seedMatchingGl({
        referenceType: 'pay_invoices',
        referenceId: invId,
        amount: 250,
        debitCode: '4000', // Revenue debited (wrong)
        creditCode: '1100', // AR credited (wrong)
      });

      await worker.runForTenant(tenantInfoA());

      const rows = await readReconRows();
      const invoiceRow = rows.find((r) => r.check_type === 'INVOICE_AR')!;
      expect(invoiceRow.status).toBe('DISCREPANCIES_FOUND');
      const discreps = JSON.parse(invoiceRow.discrepancies) as Array<{
        sourceId: string;
        issue: string;
      }>;
      const signDiscrep = discreps.find((d) => d.issue === 'SIGN_MISMATCH');
      expect(signDiscrep).toBeDefined();
    });

    it('SENT invoice posted to wrong accounts (DR Cash / CR Supplies) → ACCOUNT_MISMATCH', async () => {
      const fa = await seedFamilyAccount();
      const invId = await seedInvoice({ familyAccountId: fa, total: 250 });
      await seedMatchingGl({
        referenceType: 'pay_invoices',
        referenceId: invId,
        amount: 250,
        debitCode: '1000', // Cash instead of AR
        creditCode: '5000', // Supplies instead of Revenue
      });

      await worker.runForTenant(tenantInfoA());

      const rows = await readReconRows();
      const invoiceRow = rows.find((r) => r.check_type === 'INVOICE_AR')!;
      expect(invoiceRow.status).toBe('DISCREPANCIES_FOUND');
      const discreps = JSON.parse(invoiceRow.discrepancies) as Array<{
        sourceId: string;
        issue: string;
      }>;
      const accountDiscrep = discreps.find((d) => d.issue === 'ACCOUNT_MISMATCH');
      expect(accountDiscrep).toBeDefined();
    });

    it('SENT invoice with GL batch posted under School B → SCHOOL_MISMATCH', async () => {
      const fa = await seedFamilyAccount();
      const invId = await seedInvoice({ familyAccountId: fa, total: 250 });
      // GL batch under School B, referencing the School A invoice
      await seedMatchingGl({
        referenceType: 'pay_invoices',
        referenceId: invId,
        amount: 250,
        debitCode: '1100',
        creditCode: '4000',
        schoolId: TEST_SCHOOL_B_ID,
      });

      await worker.runForTenant(tenantInfoA());

      const rows = await readReconRows();
      const invoiceRow = rows.find((r) => r.check_type === 'INVOICE_AR')!;
      expect(invoiceRow.status).toBe('DISCREPANCIES_FOUND');
      const discreps = JSON.parse(invoiceRow.discrepancies) as Array<{
        sourceId: string;
        issue: string;
        expectedSchoolId?: string;
        actualSchoolId?: string;
      }>;
      const schoolDiscrep = discreps.find((d) => d.issue === 'SCHOOL_MISMATCH');
      expect(schoolDiscrep).toBeDefined();
      expect(schoolDiscrep!.expectedSchoolId).toBe(TEST_SCHOOL_ID);
      expect(schoolDiscrep!.actualSchoolId).toBe(TEST_SCHOOL_B_ID);
    });

    it('DRAFT and CANCELLED invoices are excluded from the source set', async () => {
      const fa = await seedFamilyAccount();
      await seedInvoice({ familyAccountId: fa, total: 100, status: 'DRAFT' });
      await seedInvoice({ familyAccountId: fa, total: 100, status: 'CANCELLED' });
      // One SENT invoice with no GL → 1 source, 1 discrepancy
      await seedInvoice({ familyAccountId: fa, total: 100, status: 'SENT' });

      await worker.runForTenant(tenantInfoA());

      const rows = await readReconRows();
      const invoiceRow = rows.find((r) => r.check_type === 'INVOICE_AR')!;
      expect(Number(invoiceRow.total_source_rows)).toBe(1);
      expect(Number(invoiceRow.discrepancy_count)).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // PAYMENT_CASH check — MISSING_GL_ENTRY
  // ────────────────────────────────────────────────────────────────────
  describe('PAYMENT_CASH check', () => {
    it('COMPLETED payment without matching GL → MISSING_GL_ENTRY', async () => {
      const fa = await seedFamilyAccount();
      const invId = await seedInvoice({ familyAccountId: fa, total: 100 });
      const payId = await seedPayment({
        familyAccountId: fa,
        invoiceId: invId,
        amount: 100,
      });

      await worker.runForTenant(tenantInfoA());

      const rows = await readReconRows();
      const paymentRow = rows.find((r) => r.check_type === 'PAYMENT_CASH')!;
      expect(paymentRow.status).toBe('DISCREPANCIES_FOUND');
      const discreps = JSON.parse(paymentRow.discrepancies) as Array<{
        sourceId: string;
        issue: string;
      }>;
      expect(discreps.find((d) => d.sourceId === payId && d.issue === 'MISSING_GL_ENTRY')).toBeDefined();
    });

    it('COMPLETED payment with correctly-coded GL (DR Cash / CR AR) → CLEAN', async () => {
      const fa = await seedFamilyAccount();
      const invId = await seedInvoice({ familyAccountId: fa, total: 100 });
      const payId = await seedPayment({
        familyAccountId: fa,
        invoiceId: invId,
        amount: 100,
      });
      await seedMatchingGl({
        referenceType: 'pay_payments',
        referenceId: payId,
        amount: 100,
        debitCode: '1000',
        creditCode: '1100',
      });

      await worker.runForTenant(tenantInfoA());

      const rows = await readReconRows();
      const paymentRow = rows.find((r) => r.check_type === 'PAYMENT_CASH')!;
      expect(paymentRow.status).toBe('CLEAN');
    });

    it('PENDING payments are excluded from the source set', async () => {
      const fa = await seedFamilyAccount();
      const invId = await seedInvoice({ familyAccountId: fa, total: 100 });
      await seedPayment({
        familyAccountId: fa,
        invoiceId: invId,
        amount: 100,
        status: 'PENDING',
      });

      await worker.runForTenant(tenantInfoA());

      const rows = await readReconRows();
      const paymentRow = rows.find((r) => r.check_type === 'PAYMENT_CASH')!;
      expect(Number(paymentRow.total_source_rows)).toBe(0);
      expect(paymentRow.status).toBe('CLEAN');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // DUPLICATE_POSTING check
  //
  // Codex review FIX 5: this describe block is the ONLY place in the
  // integration suite that needs the partial UNIQUE index
  // `fin_batches_source_event_uq` dropped — otherwise it's impossible
  // to seed two POSTED batches sharing a source_event_id and exercise
  // the DUPLICATE_POSTING discrepancy path. Previously the drop
  // happened mid-test (try/finally); a crash between drop and CREATE
  // INDEX left the suite-wide schema without the constraint, which
  // could mask real duplicate-posting bugs in subsequent tests of
  // any spec sharing tenant_test.
  //
  // The Option-A pattern here isolates the drop to this describe
  // block via beforeAll/afterAll. Vitest guarantees afterAll runs
  // even when a test inside the block throws, so the index is
  // always restored before the next describe block touches
  // fin_journal_batches.
  //
  // beforeEach DELETEs any duplicate rows seeded by the previous test
  // inside this block (the parent test-file beforeEach already
  // TRUNCATES non-IMMUTABLE tables, but we add an extra targeted
  // delete here so the index restoration in afterAll never fights an
  // existing 23505 violation).
  // ────────────────────────────────────────────────────────────────────
  describe('DUPLICATE_POSTING check', () => {
    beforeAll(async () => {
      await rawClient.$executeRawUnsafe(
        `DROP INDEX IF EXISTS ${TEST_SCHEMA}.fin_batches_source_event_uq`,
      );
    });

    afterAll(async () => {
      // Wipe any duplicate seeds the block left behind so the unique
      // index recreate doesn't error 23505.
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.fin_journal_batches WHERE batch_number LIKE 'DUP-%'`,
      );
      await rawClient.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS fin_batches_source_event_uq ON ${TEST_SCHEMA}.fin_journal_batches (source_event_id) WHERE source_event_id IS NOT NULL`,
      );
    });

    it('two POSTED batches with the same source_event_id → DUPLICATE_POSTING', async () => {
      const eventId = generateId();
      const batchA = generateId();
      const batchB = generateId();
      for (const id of [batchA, batchB]) {
        // Use the full id in batch_number — UUIDv7 ids generated close
        // in time share the first 8 chars (the time-prefix), so
        // id.slice(0,8) collides.
        await rawClient.$executeRawUnsafe(
          `INSERT INTO ${TEST_SCHEMA}.fin_journal_batches
             (id, school_id, batch_number, description, batch_type, source_event_id, accounting_period_id, posted_by, posted_at, status)
           VALUES ($1::uuid, $2::uuid, $3, 'dup', 'AUTO_PAYMENT', $4::uuid, $5::uuid, $6::uuid, now(), 'POSTED')`,
          id,
          TEST_SCHOOL_ID,
          'DUP-' + id,
          eventId,
          TEST_PERIOD_ID,
          TEST_ADMIN_EMPLOYEE_ID,
        );
      }

      await worker.runForTenant(tenantInfoA());

      const rows = await readReconRows();
      const dupRow = rows.find((r) => r.check_type === 'DUPLICATE_POSTING')!;
      expect(dupRow.status).toBe('DISCREPANCIES_FOUND');
      const discreps = JSON.parse(dupRow.discrepancies) as Array<{
        sourceId: string;
        issue: string;
        batchCount: number;
        batchIds: string[];
      }>;
      expect(discreps).toHaveLength(1);
      expect(discreps[0]!.sourceId).toBe(eventId);
      expect(discreps[0]!.issue).toBe('DUPLICATE_POSTING');
      expect(discreps[0]!.batchCount).toBe(2);
      expect(discreps[0]!.batchIds).toHaveLength(2);
    });

    it('single POSTED batch with source_event_id → CLEAN', async () => {
      const eventId = generateId();
      const batchId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.fin_journal_batches
           (id, school_id, batch_number, description, batch_type, source_event_id, accounting_period_id, posted_by, posted_at, status)
         VALUES ($1::uuid, $2::uuid, $3, 'single', 'AUTO_PAYMENT', $4::uuid, $5::uuid, $6::uuid, now(), 'POSTED')`,
        batchId,
        TEST_SCHOOL_ID,
        'OK-' + batchId.slice(0, 8),
        eventId,
        TEST_PERIOD_ID,
        TEST_ADMIN_EMPLOYEE_ID,
      );

      await worker.runForTenant(tenantInfoA());

      const rows = await readReconRows();
      const dupRow = rows.find((r) => r.check_type === 'DUPLICATE_POSTING')!;
      expect(dupRow.status).toBe('CLEAN');
      expect(Number(dupRow.total_source_rows)).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // ORPHAN_GL_ENTRY check
  // ────────────────────────────────────────────────────────────────────
  describe('ORPHAN_GL_ENTRY check', () => {
    it('GL entry with reference_id pointing to a non-existent invoice → ORPHAN_GL_ENTRY', async () => {
      // Seed a GL entry referencing an invoice id that doesn't exist in
      // pay_invoices. The batch + 2 entries form a balanced pair pointing
      // at the missing reference; both legs will surface as orphans.
      const missingInvoiceId = generateId();
      await seedMatchingGl({
        referenceType: 'pay_invoices',
        referenceId: missingInvoiceId,
        amount: 100,
        debitCode: '1100',
        creditCode: '4000',
      });

      await worker.runForTenant(tenantInfoA());

      const rows = await readReconRows();
      const orphanRow = rows.find((r) => r.check_type === 'ORPHAN_GL_ENTRY')!;
      expect(orphanRow.status).toBe('DISCREPANCIES_FOUND');
      const discreps = JSON.parse(orphanRow.discrepancies) as Array<{
        sourceId: string;
        issue: string;
        referenceType: string;
        referenceId: string;
      }>;
      expect(discreps.length).toBeGreaterThan(0);
      const invoiceOrphans = discreps.filter(
        (d) => d.referenceType === 'pay_invoices' && d.referenceId === missingInvoiceId,
      );
      // Two legs (debit + credit) both point at the same missing reference
      expect(invoiceOrphans.length).toBe(2);
    });

    it('GL entry whose reference_id resolves in pay_invoices → CLEAN (not flagged)', async () => {
      const fa = await seedFamilyAccount();
      const invId = await seedInvoice({ familyAccountId: fa, total: 100 });
      await seedMatchingGl({
        referenceType: 'pay_invoices',
        referenceId: invId,
        amount: 100,
        debitCode: '1100',
        creditCode: '4000',
      });

      await worker.runForTenant(tenantInfoA());

      const rows = await readReconRows();
      const orphanRow = rows.find((r) => r.check_type === 'ORPHAN_GL_ENTRY')!;
      expect(orphanRow.status).toBe('CLEAN');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // FAILED status — broken source check should still emit + record
  // ────────────────────────────────────────────────────────────────────
  describe('FAILED status', () => {
    // FINDING — Wave 1: GlReconciliationWorker.SOURCE_CHECK_META uses
    // `amountExpr: 's.amount'` for CREDIT_NOTE and PAYMENT_REVERSAL, but
    // the underlying tables have `credit_amount` and `reversed_amount`
    // respectively. With rows present in those tables, the SELECT errors
    // with "column s.amount does not exist", which the worker catches and
    // records as FAILED + emits a CHECK_QUERY_FAILED alert. Useful
    // signal — but it masks the worker's own bug. Fix is to use
    // `s.credit_amount` and `s.reversed_amount` in the meta.
    it('CREDIT_NOTE check surfaces MISSING_GL_ENTRY when a credit note has no GL row [Finding 4 FIXED]', async () => {
      const fa = await seedFamilyAccount();
      const invId = await seedInvoice({ familyAccountId: fa, total: 100 });
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pay_credit_notes
           (id, school_id, invoice_id, family_account_id, credit_amount, reason, issued_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 50, 'test', $5::uuid)`,
        generateId(),
        TEST_SCHOOL_ID,
        invId,
        fa,
        TEST_ADMIN_EMPLOYEE_ID,
      );

      await worker.runForTenant(tenantInfoA());

      const rows = await readReconRows();
      const cnRow = rows.find((r) => r.check_type === 'CREDIT_NOTE')!;
      // Post-fix: the query parses successfully with `s.credit_amount`.
      // The credit-note seed has no offsetting fin_gl_entries row, so
      // the result is DISCREPANCIES_FOUND with one MISSING_GL_ENTRY
      // discrepancy (not FAILED via CHECK_QUERY_FAILED).
      expect(cnRow.status).toBe('DISCREPANCIES_FOUND');
      const discreps = JSON.parse(cnRow.discrepancies) as Array<{ issue: string }>;
      expect(discreps[0]!.issue).toBe('MISSING_GL_ENTRY');

      const alerts = await readAlertOutbox();
      const cnAlert = alerts.find(
        (a) => JSON.parse(a.envelope).payload.checkType === 'CREDIT_NOTE',
      );
      expect(cnAlert).toBeDefined();
      const env = JSON.parse(cnAlert!.envelope);
      expect(env.payload.status).toBe('DISCREPANCIES_FOUND');
    });

    // The "CLEAN when empty" case can't be tested today — PostgreSQL
    // parses the SELECT list before scanning, so `s.amount` errors at
    // parse time regardless of whether pay_credit_notes has rows.
    // Once Finding 4 is fixed, this becomes a regression test.
    it('CREDIT_NOTE check is CLEAN when source table is empty [Finding 4 FIXED]', async () => {
      await worker.runForTenant(tenantInfoA());
      const rows = await readReconRows();
      const cnRow = rows.find((r) => r.check_type === 'CREDIT_NOTE')!;
      expect(cnRow.status).toBe('CLEAN');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Multi-tenant — runOnce iterates every active school
  // ────────────────────────────────────────────────────────────────────
  describe('runOnce (cross-tenant iteration)', () => {
    it('iterates active schools and writes recon rows per school [Findings 4 + 5 FIXED]', async () => {
      const written = await worker.runOnce();
      // 7 rows per school. Fixture has at least tenant_test (School A
      // and School B share the schema but each loads as a separate
      // school in platform.schools) plus tenant_demo. Expect at least 14.
      expect(written).toBeGreaterThanOrEqual(14);

      const aRows = await readReconRows(TEST_SCHOOL_ID);
      expect(aRows).toHaveLength(7);

      const bRows = await readReconRows(TEST_SCHOOL_B_ID);
      expect(bRows).toHaveLength(7);
      // Post-fix: every check parses cleanly (Finding 4) AND each run
      // filters its source SELECT by tenant.schoolId (Finding 5), so a
      // School B run with no pay_* seed sees CLEAN across all 7 types.
      for (const r of bRows) {
        expect(r.status).toBe('CLEAN');
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // School scope on writes (cross-school isolation)
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('runForTenant for School A writes rpt rows only for School A', async () => {
      await worker.runForTenant(tenantInfoA());
      const aRows = await readReconRows(TEST_SCHOOL_ID);
      const bRows = await readReconRows(TEST_SCHOOL_B_ID);
      expect(aRows).toHaveLength(7);
      expect(bRows).toHaveLength(0);
    });
  });
});
