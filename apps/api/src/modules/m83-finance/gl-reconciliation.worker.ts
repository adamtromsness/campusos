import { Injectable, Logger } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { TenantInfo, runWithTenantContextAsync } from '@shared/tenant/tenant.context';
import { OutboxService } from '@shared/kafka/outbox.service';

/**
 * P2-H3 Step 3 + P2-H5 DEFECT 5 — GLReconciliationWorker.
 *
 * Daily reconciliation pass: verifies every financial source row has a
 * matching, correctly-shaped GL trail and that no GL entry is orphaned or
 * duplicated. Each check materialises one rpt_gl_reconciliation row per
 * (school, run, check_type).
 *
 * Original five checks (per P2-H3):
 *   INVOICE_AR        every non-DRAFT non-CANCELLED pay_invoice has a GL
 *                     entry with reference_type = pay_invoices.
 *   PAYMENT_CASH      every COMPLETED/REFUNDED pay_payment has a GL
 *                     entry with reference_type = pay_payments.
 *   REFUND_REVERSAL   every COMPLETED pay_refund has a GL entry.
 *   CREDIT_NOTE       every pay_credit_note row has a GL entry.
 *   PAYMENT_REVERSAL  every pay_payment_reversal row has a GL entry.
 *
 * P2-H5 additions:
 *   - AMOUNT_MISMATCH discrepancies inline in each check: source amount vs
 *     SUM(debit + credit) on the matching GL entries.
 *   - DUPLICATE_POSTING new check: fin_journal_batches with the same
 *     source_event_id appearing more than once (Kafka redelivery slipping
 *     past consumer idempotency).
 *   - ORPHAN_GL_ENTRY new check: fin_gl_entries with reference_id that
 *     does not resolve in the named source table.
 *   - FAILED status emits fin.gl_reconciliation.discrepancy too so SRE
 *     pages on a broken check query, not just on discovered discrepancies.
 *
 * The worker emits via the durable outbox; the alert consumer wired in
 * GlReconciliationAlertConsumer fans out to school admins so a missed
 * SRE page does not silently drop the signal.
 */
@Injectable()
export class GlReconciliationWorker {
  private readonly logger = new Logger(GlReconciliationWorker.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Run the full reconciliation pass across every active school. Returns
   * the count of rpt_gl_reconciliation rows written.
   */
  async runOnce(): Promise<number> {
    const schools = await this.loadActiveSchools();
    let written = 0;
    for (const tenant of schools) {
      try {
        const count = await this.runForTenant(tenant);
        written += count;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn('gl-reconciliation: tenant=' + tenant.subdomain + ' error=' + msg);
      }
    }
    return written;
  }

  /**
   * Run all 7 reconciliation checks for a single tenant.
   */
  async runForTenant(tenant: TenantInfo): Promise<number> {
    let written = 0;
    await runWithTenantContextAsync({ tenant }, async () => {
      written += await this.runCheck(tenant, 'INVOICE_AR');
      written += await this.runCheck(tenant, 'PAYMENT_CASH');
      written += await this.runCheck(tenant, 'REFUND_REVERSAL');
      written += await this.runCheck(tenant, 'CREDIT_NOTE');
      written += await this.runCheck(tenant, 'PAYMENT_REVERSAL');
      written += await this.runCheck(tenant, 'DUPLICATE_POSTING');
      written += await this.runCheck(tenant, 'ORPHAN_GL_ENTRY');
    });
    return written;
  }

  private async runCheck(tenant: TenantInfo, checkType: ReconCheckType): Promise<number> {
    try {
      const result = await this.executeCheck(checkType);
      if (result === null) {
        // Source table missing in this tenant — record FAILED row and
        // ALERT. Pre-fix a missing source surface looked CLEAN; that
        // hid both unimplemented modules AND broken schema migrations.
        const runId = await this.recordRun(tenant.schoolId, checkType, 0, 0, [], 'FAILED');
        await this.emitAlert(runId, tenant.schoolId, checkType, 0, 'FAILED', [
          { sourceId: null, sourceTable: null, issue: 'SOURCE_TABLE_MISSING' },
        ]);
        return 1;
      }
      const { totalSource, matched, discrepancies } = result;
      const status: ReconStatus = discrepancies.length > 0 ? 'DISCREPANCIES_FOUND' : 'CLEAN';
      // Cap the JSONB payload at 100 entries — the audit chain has the rest
      // in the source-vs-GL diff query the runbook re-runs from a row id.
      const payload = discrepancies.slice(0, 100);
      const runId = await this.recordRun(
        tenant.schoolId,
        checkType,
        totalSource,
        matched,
        payload,
        status,
      );
      if (status === 'DISCREPANCIES_FOUND') {
        await this.emitAlert(
          runId,
          tenant.schoolId,
          checkType,
          discrepancies.length,
          status,
          payload,
        );
      }
      return 1;
    } catch (e: unknown) {
      // FAILED checks emit an alert too — a broken reconciliation query is
      // an SRE signal regardless of discovered discrepancies.
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn('gl-reconciliation: check=' + checkType + ' error=' + msg);
      const runId = await this.recordRun(tenant.schoolId, checkType, 0, 0, [], 'FAILED');
      await this.emitAlert(runId, tenant.schoolId, checkType, 0, 'FAILED', [
        { sourceId: null, sourceTable: null, issue: 'CHECK_QUERY_FAILED', error: msg },
      ]);
      return 1;
    }
  }

  /**
   * Compute the discrepancy list + matched/source counts for one check
   * type. Returns null when the source surface is not provisioned in this
   * tenant (e.g. credit-notes table missing in a pre-Cycle-26 schema). The
   * single composite check combines:
   *   (a) MISSING_GL_ENTRY  — source row has no matching GL row.
   *   (b) AMOUNT_MISMATCH    — source row total ≠ SUM(debit+credit) on its
   *       matching GL rows.
   * The DUPLICATE_POSTING + ORPHAN_GL_ENTRY checks have their own shapes.
   */
  private async executeCheck(
    checkType: ReconCheckType,
  ): Promise<{ totalSource: number; matched: number; discrepancies: DiscrepancyEntry[] } | null> {
    if (checkType === 'DUPLICATE_POSTING') return this.checkDuplicatePostings();
    if (checkType === 'ORPHAN_GL_ENTRY') return this.checkOrphanGlEntries();
    return this.checkSourceVsGl(checkType);
  }

  /**
   * P2-H5 DEFECT 5 + P2-H6 FIX 2: source-vs-GL check that detects MISSING
   * entries, AMOUNT mismatches, ACCOUNT mismatches (wrong chart-of-accounts
   * code on the debit or credit leg), SIGN mismatches (debit/credit legs
   * flipped — e.g. an invoice that should DR AR / CR Revenue but instead
   * CR AR / DR Revenue), SCHOOL mismatches (GL batch posted under a
   * different school than the source row's tenant), and reserves CURRENCY
   * mismatches as a forward-compatible no-op (the financial path is
   * single-currency-per-school today; the framework lands so adding a
   * `currency` column to `fin_gl_entries` and pay_* tables is a one-line
   * service-side change).
   *
   * The GL aggregate query JOINs:
   *   - fin_chart_of_accounts → account_code so the debit / credit legs
   *     can be matched against the expected code per source type.
   *   - fin_journal_batches → school_id so a cross-school posting (a GL
   *     batch under school B referencing a source row in school A) is
   *     flagged as SCHOOL_MISMATCH.
   * Adding both to GROUP BY ensures the aggregate is keyed at
   * (reference_id, account_code, batch_school_id) — the finest grain
   * needed to detect every defect class.
   */
  private async checkSourceVsGl(
    checkType: SourceCheckType,
  ): Promise<{ totalSource: number; matched: number; discrepancies: DiscrepancyEntry[] } | null> {
    const meta = SOURCE_CHECK_META[checkType];
    // Probe for the source table — a missing table returns null up the
    // chain so the worker records a FAILED row with SOURCE_TABLE_MISSING.
    const exists = await this.tableExists(meta.sourceTable);
    if (!exists) return null;

    const filter = meta.sourceFilter;
    const filterClause = filter ? ` WHERE ${filter}` : '';
    const sourceSchoolCol = meta.sourceSchoolColumn ?? 's.school_id';
    const sourceRows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<
        Array<{
          id: string;
          amount: string | number | null;
          school_id: string | null;
          currency: string | null;
        }>
      >(
        `SELECT s.id::text AS id, ${meta.amountExpr} AS amount, ` +
          `${sourceSchoolCol}::text AS school_id, ` +
          // CampusOS pay_* tables do not carry a currency column today
          // (single-currency-per-school). Surface a NULL placeholder so
          // the CURRENCY_MISMATCH branch is a deterministic no-op until
          // the multi-currency schema migration lands.
          `NULL::text AS currency ` +
          `FROM ${meta.sourceTable} s${filterClause}`,
      ),
    )) as Array<{
      id: string;
      amount: string | number | null;
      school_id: string | null;
      currency: string | null;
    }>;

    const totalSource = sourceRows.length;
    if (totalSource === 0) {
      return { totalSource: 0, matched: 0, discrepancies: [] };
    }

    // Pull the GL aggregate keyed by (reference_id, account_code,
    // batch_school_id) in one shot for every source row. The JOINs are
    // load-bearing: account_code comes from fin_chart_of_accounts, and
    // batch_school_id comes from fin_journal_batches. GROUP BY all three
    // so a row split across multiple batches or multiple accounts shows up
    // as multiple aggregate rows we can analyse per-leg.
    const sourceIds = sourceRows.map((r) => r.id);
    const glRows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<
        Array<{
          reference_id: string;
          account_code: string;
          batch_school_id: string;
          debit_total: string | number;
          credit_total: string | number;
          line_count: number;
        }>
      >(
        'SELECT g.reference_id::text AS reference_id, ' +
          'acc.account_code AS account_code, ' +
          'b.school_id::text AS batch_school_id, ' +
          'SUM(g.debit)::text AS debit_total, ' +
          'SUM(g.credit)::text AS credit_total, ' +
          'COUNT(*)::int AS line_count ' +
          'FROM fin_gl_entries g ' +
          'JOIN fin_journal_batches b ON b.id = g.batch_id ' +
          'JOIN fin_chart_of_accounts acc ON acc.id = g.account_id ' +
          'WHERE g.reference_type = $1 AND g.reference_id = ANY($2::uuid[]) ' +
          'GROUP BY g.reference_id, acc.account_code, b.school_id',
        meta.referenceType,
        sourceIds,
      ),
    )) as Array<{
      reference_id: string;
      account_code: string;
      batch_school_id: string;
      debit_total: string | number;
      credit_total: string | number;
      line_count: number;
    }>;

    interface LegAggregate {
      debit: number;
      credit: number;
      lineCount: number;
    }
    interface RefAggregate {
      // account_code → leg totals
      legs: Map<string, LegAggregate>;
      // distinct batch school ids touched by this reference
      batchSchoolIds: Set<string>;
      // total of debit + credit across every account
      total: number;
    }
    const glMap = new Map<string, RefAggregate>();
    for (const r of glRows) {
      let agg = glMap.get(r.reference_id);
      if (!agg) {
        agg = { legs: new Map(), batchSchoolIds: new Set(), total: 0 };
        glMap.set(r.reference_id, agg);
      }
      const debit = Number(r.debit_total);
      const credit = Number(r.credit_total);
      agg.legs.set(r.account_code, {
        debit,
        credit,
        lineCount: Number(r.line_count),
      });
      agg.batchSchoolIds.add(r.batch_school_id);
      agg.total += debit + credit;
    }

    const cents = (v: number) => Math.round(v * 100);
    const discrepancies: DiscrepancyEntry[] = [];
    let matched = 0;
    for (const s of sourceRows) {
      const gl = glMap.get(s.id);
      if (!gl) {
        discrepancies.push({
          sourceId: s.id,
          sourceTable: meta.sourceTable,
          issue: 'MISSING_GL_ENTRY',
        });
        continue;
      }

      const sourceAmount = Number(s.amount ?? 0);
      const expectedSingle = Math.abs(sourceAmount);
      const expectedDouble = expectedSingle * 2;
      const glTotalCents = cents(gl.total);
      const matchesSingle = glTotalCents === cents(expectedSingle);
      const matchesDouble = glTotalCents === cents(expectedDouble);
      let dropped = false;

      // ── AMOUNT_MISMATCH ──
      if (!matchesSingle && !matchesDouble) {
        discrepancies.push({
          sourceId: s.id,
          sourceTable: meta.sourceTable,
          issue: 'AMOUNT_MISMATCH',
          expected: expectedDouble,
          actual: gl.total,
        });
        dropped = true;
      }

      // ── SCHOOL_MISMATCH ──
      // Source row's school_id vs each GL batch's school_id. Any mismatch
      // (or a GL batch under a different school than the source row) is a
      // cross-school posting hazard.
      if (s.school_id) {
        for (const batchSchoolId of gl.batchSchoolIds) {
          if (batchSchoolId !== s.school_id) {
            discrepancies.push({
              sourceId: s.id,
              sourceTable: meta.sourceTable,
              issue: 'SCHOOL_MISMATCH',
              expectedSchoolId: s.school_id,
              actualSchoolId: batchSchoolId,
            });
            dropped = true;
            break;
          }
        }
      }

      // ── ACCOUNT_MISMATCH + SIGN_MISMATCH ──
      // Compare the actual debit/credit legs against the expected codes.
      // A balanced double-entry posting carries exactly one debit leg on
      // the expected debit account AND one credit leg on the expected
      // credit account. If the expected debit account exists in the GL
      // but on the credit side (or vice versa), that's a SIGN_MISMATCH.
      // If the expected account is missing entirely (and there's no sign
      // flip), that's an ACCOUNT_MISMATCH.
      const expectedDebitCode = meta.expectedDebitAccountCode;
      const expectedCreditCode = meta.expectedCreditAccountCode;
      const debitLeg = gl.legs.get(expectedDebitCode);
      const creditLeg = gl.legs.get(expectedCreditCode);
      const debitOnExpectedAccount = debitLeg ? cents(debitLeg.debit) > 0 : false;
      const creditOnExpectedAccount = creditLeg ? cents(creditLeg.credit) > 0 : false;
      // Sign flip: the expected debit account is being credited, or the
      // expected credit account is being debited.
      const expectedDebitGotCredited = debitLeg ? cents(debitLeg.credit) > 0 : false;
      const expectedCreditGotDebited = creditLeg ? cents(creditLeg.debit) > 0 : false;
      if (expectedDebitGotCredited || expectedCreditGotDebited) {
        discrepancies.push({
          sourceId: s.id,
          sourceTable: meta.sourceTable,
          issue: 'SIGN_MISMATCH',
          expectedDebitAccount: expectedDebitCode,
          expectedCreditAccount: expectedCreditCode,
          actualLegs: Array.from(gl.legs.entries()).map(([code, leg]) => ({
            accountCode: code,
            debit: leg.debit,
            credit: leg.credit,
          })),
        });
        dropped = true;
      } else if (!debitOnExpectedAccount || !creditOnExpectedAccount) {
        // The expected debit OR credit account isn't being posted to with
        // any positive amount — the legs landed on a different account.
        // Skip when the GL total is zero (already caught as AMOUNT_MISMATCH
        // above) to avoid double-reporting.
        if (gl.total > 0) {
          discrepancies.push({
            sourceId: s.id,
            sourceTable: meta.sourceTable,
            issue: 'ACCOUNT_MISMATCH',
            expectedDebitAccount: expectedDebitCode,
            expectedCreditAccount: expectedCreditCode,
            actualAccountCodes: Array.from(gl.legs.keys()),
          });
          dropped = true;
        }
      }

      // ── CURRENCY_MISMATCH ──
      // CampusOS is single-currency-per-school today (no `currency` column
      // on fin_gl_entries or pay_*). The check is a structured no-op until
      // the multi-currency migration adds the column; the framework lands
      // here so the only thing future-cycle work needs to do is widen the
      // SELECT projection above. When source.currency is non-null AND
      // doesn't match the GL currency, this branch will fire.
      if (s.currency != null) {
        // Future: pull GL currency from fin_journal_batches.currency once
        // the column exists, and compare. No-op today.
      }

      if (!dropped) matched += 1;
    }
    return { totalSource, matched, discrepancies };
  }

  /**
   * P2-H5 DEFECT 5: DUPLICATE_POSTING check. Detects any fin_journal_batches
   * with a non-null source_event_id appearing in more than one POSTED batch
   * — Kafka redelivery slipping past consumer idempotency would land two
   * GL batches with the same event_id.
   */
  private async checkDuplicatePostings(): Promise<{
    totalSource: number;
    matched: number;
    discrepancies: DiscrepancyEntry[];
  } | null> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<
        Array<{ source_event_id: string; batch_count: number; batch_ids: string[] }>
      >(
        'SELECT source_event_id::text AS source_event_id, COUNT(*)::int AS batch_count, ' +
          'array_agg(id::text) AS batch_ids ' +
          'FROM fin_journal_batches ' +
          "WHERE source_event_id IS NOT NULL AND status = 'POSTED' " +
          'GROUP BY source_event_id ' +
          'HAVING COUNT(*) > 1',
      ),
    )) as Array<{ source_event_id: string; batch_count: number; batch_ids: string[] }>;
    const total = await this.countDistinctPostedEvents();
    const discrepancies: DiscrepancyEntry[] = rows.map((r) => ({
      sourceId: r.source_event_id,
      sourceTable: 'fin_journal_batches',
      issue: 'DUPLICATE_POSTING',
      batchCount: Number(r.batch_count),
      batchIds: r.batch_ids,
    }));
    return {
      totalSource: total,
      matched: total - discrepancies.length,
      discrepancies,
    };
  }

  /**
   * P2-H5 DEFECT 5: ORPHAN_GL_ENTRY check. Detects any fin_gl_entries row
   * whose reference_id does NOT resolve in the named source table. Probes
   * each of the five known source surfaces; entries with an unknown
   * reference_type or missing source row are flagged.
   */
  private async checkOrphanGlEntries(): Promise<{
    totalSource: number;
    matched: number;
    discrepancies: DiscrepancyEntry[];
  }> {
    const discrepancies: DiscrepancyEntry[] = [];
    let totalSource = 0;
    for (const meta of ORPHAN_PROBES) {
      const exists = await this.tableExists(meta.sourceTable);
      if (!exists) continue;
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
        client.$queryRawUnsafe<Array<{ id: string; reference_id: string }>>(
          'SELECT g.id::text AS id, g.reference_id::text AS reference_id ' +
            'FROM fin_gl_entries g ' +
            'WHERE g.reference_type = $1 AND g.reference_id IS NOT NULL ' +
            'AND NOT EXISTS (' +
            `SELECT 1 FROM ${meta.sourceTable} src WHERE src.id = g.reference_id` +
            ')',
          meta.referenceType,
        ),
      )) as Array<{ id: string; reference_id: string }>;
      const countRows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
        client.$queryRawUnsafe<Array<{ n: number }>>(
          'SELECT COUNT(*)::int AS n FROM fin_gl_entries WHERE reference_type = $1',
          meta.referenceType,
        ),
      )) as Array<{ n: number }>;
      totalSource += countRows[0]?.n ?? 0;
      for (const r of rows) {
        discrepancies.push({
          sourceId: r.id,
          sourceTable: 'fin_gl_entries',
          issue: 'ORPHAN_GL_ENTRY',
          referenceType: meta.referenceType,
          referenceId: r.reference_id,
        });
      }
    }
    return {
      totalSource,
      matched: totalSource - discrepancies.length,
      discrepancies,
    };
  }

  private async countDistinctPostedEvents(): Promise<number> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<{ n: number }>>(
        "SELECT COUNT(DISTINCT source_event_id)::int AS n FROM fin_journal_batches WHERE source_event_id IS NOT NULL AND status = 'POSTED'",
      ),
    )) as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  }

  private async tableExists(table: string): Promise<boolean> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM information_schema.tables WHERE table_name = $1 AND table_schema = current_schema() LIMIT 1',
        table,
      ),
    )) as Array<{ ok: number }>;
    return rows.length > 0;
  }

  private async recordRun(
    schoolId: string,
    checkType: string,
    totalSource: number,
    matched: number,
    discrepancies: DiscrepancyEntry[],
    status: ReconStatus,
  ): Promise<string> {
    const id = generateId();
    const discrepancyCount = totalSource - matched;
    // counts_chk requires matched=source AND discrepancy=0 on FAILED — coerce
    // so the row lands; the discrepancies JSONB preserves the truth for the
    // runbook.
    const safeMatched = status === 'FAILED' ? totalSource : matched;
    const safeDiscrepancyCount = status === 'FAILED' ? 0 : discrepancyCount;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO rpt_gl_reconciliation ' +
          '(id, school_id, check_type, total_source_rows, total_matched_rows, discrepancy_count, discrepancies, status) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8)',
        id,
        schoolId,
        checkType,
        totalSource,
        safeMatched,
        safeDiscrepancyCount,
        JSON.stringify(discrepancies),
        status,
      );
    });
    return id;
  }

  /**
   * P2-H5 DEFECT 5: emit fin.gl_reconciliation.discrepancy on every
   * DISCREPANCIES_FOUND or FAILED run. Pre-fix only DISCREPANCIES_FOUND
   * emitted, so a broken reconciliation query was a silent log line. The
   * payload includes the discrepancy list (capped to 100 entries) so the
   * Cycle 14 NotificationConsumer can render the alert with specific
   * row ids.
   */
  private async emitAlert(
    runId: string,
    schoolId: string,
    checkType: string,
    discrepancyCount: number,
    status: ReconStatus,
    discrepancies: DiscrepancyEntry[],
  ): Promise<void> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await this.outbox.enqueueInTx(tx, {
        topic: 'fin.gl_reconciliation.discrepancy',
        key: runId,
        sourceModule: 'finance',
        payload: {
          reconciliationRunId: runId,
          schoolId,
          checkType,
          discrepancyCount,
          status,
          severity: 'URGENT',
          discrepancies,
          detectedAt: new Date().toISOString(),
        },
      });
    });
  }

  private async loadActiveSchools(): Promise<TenantInfo[]> {
    try {
      const client = this.tenantPrisma.getPlatformClient();
      const rows = await client.$queryRawUnsafe<
        Array<{
          id: string;
          subdomain: string;
          schema_name: string;
          organisation_id: string | null;
        }>
      >(
        'SELECT id::text AS id, subdomain, schema_name, organisation_id::text AS organisation_id ' +
          'FROM platform.schools WHERE is_active = true',
      );
      return rows.map((r) => ({
        schoolId: r.id,
        subdomain: r.subdomain,
        schemaName: r.schema_name,
        organisationId: r.organisation_id,
        isFrozen: false,
        planTier: 'STANDARD' as const,
        homeRegion: process.env.AWS_REGION ?? 'us-east-1',
      }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn('gl-reconciliation: could not load schools: ' + msg);
      return [];
    }
  }
}

// ─── Types and metadata ────────────────────────────────────────────────

type ReconStatus = 'CLEAN' | 'DISCREPANCIES_FOUND' | 'FAILED';

type ReconCheckType =
  | 'INVOICE_AR'
  | 'PAYMENT_CASH'
  | 'REFUND_REVERSAL'
  | 'CREDIT_NOTE'
  | 'PAYMENT_REVERSAL'
  | 'DUPLICATE_POSTING'
  | 'ORPHAN_GL_ENTRY';

type SourceCheckType =
  | 'INVOICE_AR'
  | 'PAYMENT_CASH'
  | 'REFUND_REVERSAL'
  | 'CREDIT_NOTE'
  | 'PAYMENT_REVERSAL';

interface DiscrepancyEntry {
  sourceId: string | null;
  sourceTable: string | null;
  issue: string;
  expected?: number;
  actual?: string | number;
  batchCount?: number;
  batchIds?: string[];
  referenceType?: string;
  referenceId?: string;
  error?: string;
  // P2-H6 FIX 2 — account / sign / school mismatch payloads.
  expectedDebitAccount?: string;
  expectedCreditAccount?: string;
  actualLegs?: Array<{ accountCode: string; debit: number; credit: number }>;
  actualAccountCodes?: string[];
  expectedSchoolId?: string;
  actualSchoolId?: string;
}

interface SourceCheckMeta {
  sourceTable: string;
  referenceType: string;
  amountExpr: string;
  sourceFilter: string | null;
  // P2-H6 FIX 2 — expected chart-of-accounts codes for the balanced
  // double-entry posting. The reconciliation worker compares actual
  // GL legs against these codes to detect SIGN_MISMATCH (legs flipped)
  // and ACCOUNT_MISMATCH (wrong code entirely). Source-vs-GLConsumer
  // mapping documented at apps/api/src/finance/gl.consumer.ts:236-344.
  expectedDebitAccountCode: string;
  expectedCreditAccountCode: string;
  // Optional override for the column on the source table that carries
  // the school binding. Most pay_* tables use `s.school_id`; the
  // reversal table references the parent payment instead.
  sourceSchoolColumn?: string;
}

const SOURCE_CHECK_META: Record<SourceCheckType, SourceCheckMeta> = {
  INVOICE_AR: {
    sourceTable: 'pay_invoices',
    referenceType: 'pay_invoices',
    amountExpr: 's.total_amount',
    sourceFilter: "s.status NOT IN ('DRAFT', 'CANCELLED')",
    // Invoice issuance: DR AR (1100), CR Tuition Revenue (4000).
    expectedDebitAccountCode: '1100',
    expectedCreditAccountCode: '4000',
  },
  PAYMENT_CASH: {
    sourceTable: 'pay_payments',
    referenceType: 'pay_payments',
    amountExpr: 's.amount',
    sourceFilter: "s.status IN ('COMPLETED', 'REFUNDED')",
    // Payment receipt: DR Cash (1000), CR AR (1100).
    expectedDebitAccountCode: '1000',
    expectedCreditAccountCode: '1100',
  },
  REFUND_REVERSAL: {
    sourceTable: 'pay_refunds',
    referenceType: 'pay_refunds',
    amountExpr: 's.amount',
    sourceFilter: "s.status = 'COMPLETED'",
    // Refund issuance: DR AR (1100, refund-credit owed back to family),
    // CR Cash (1000).
    expectedDebitAccountCode: '1100',
    expectedCreditAccountCode: '1000',
  },
  CREDIT_NOTE: {
    sourceTable: 'pay_credit_notes',
    referenceType: 'pay_credit_notes',
    amountExpr: 's.amount',
    sourceFilter: null,
    // Credit note: DR Tuition Revenue (4000), CR AR (1100) — reverses
    // the original invoice's revenue recognition.
    expectedDebitAccountCode: '4000',
    expectedCreditAccountCode: '1100',
  },
  PAYMENT_REVERSAL: {
    sourceTable: 'pay_payment_reversals',
    referenceType: 'pay_payment_reversals',
    amountExpr: 's.amount',
    sourceFilter: null,
    // Payment reversal: DR AR (1100), CR Cash (1000) — mirrors the
    // refund leg, restoring AR while cash flows out.
    expectedDebitAccountCode: '1100',
    expectedCreditAccountCode: '1000',
    // Reversal table doesn't carry school_id directly; derived via the
    // parent payment in tests. Default behaviour falls back to
    // `s.school_id` when present in the table, so leave the column
    // override unset and let the SELECT inherit the table's column.
  },
};

const ORPHAN_PROBES: Array<{ sourceTable: string; referenceType: string }> = [
  { sourceTable: 'pay_invoices', referenceType: 'pay_invoices' },
  { sourceTable: 'pay_payments', referenceType: 'pay_payments' },
  { sourceTable: 'pay_refunds', referenceType: 'pay_refunds' },
  { sourceTable: 'pay_credit_notes', referenceType: 'pay_credit_notes' },
  { sourceTable: 'pay_payment_reversals', referenceType: 'pay_payment_reversals' },
];
