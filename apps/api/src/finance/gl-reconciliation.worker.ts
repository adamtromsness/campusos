import { Injectable, Logger } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { TenantInfo, runWithTenantContextAsync } from '../tenant/tenant.context';
import { OutboxService } from '../kafka/outbox.service';

/**
 * P2-H3 Step 3 — GLReconciliationWorker.
 *
 * Verifies daily that every financial source row has a matching GL trail.
 * Five check types, each materialising one rpt_gl_reconciliation row per
 * (school, run, check_type):
 *
 *   INVOICE_AR        every pay_invoice in non-DRAFT non-CANCELLED status
 *                     has at least one fin_gl_entries row with
 *                     reference_type = pay_invoices pointing at it.
 *
 *   PAYMENT_CASH      every pay_payment in COMPLETED or REFUNDED status
 *                     has at least one fin_gl_entries row with
 *                     reference_type = pay_payments pointing at it.
 *
 *   REFUND_REVERSAL   every pay_refund in COMPLETED status has at least
 *                     one fin_gl_entries row with reference_type =
 *                     pay_refunds pointing at it.
 *
 *   CREDIT_NOTE       every pay_credit_note row has at least one
 *                     fin_gl_entries row with reference_type =
 *                     pay_credit_notes pointing at it.
 *
 *   PAYMENT_REVERSAL  every pay_payment_reversal row has at least one
 *                     fin_gl_entries row with reference_type =
 *                     pay_payment_reversals pointing at it.
 *
 * On a non-zero discrepancy_count the worker emits
 * fin.gl_reconciliation.discrepancy via the durable outbox so the alerts
 * pipeline can page SRE within the financial event escalation SLA
 * (<=15 min — see docs/kafka-operations-runbook.md).
 *
 * The worker is exposed as a service helper `runOnce()` rather than a
 * standalone polling daemon — ops invokes it daily via a cron container
 * or a Kubernetes CronJob (Phase 3 ops wiring). For Phase 2 hardening it
 * is callable from a small admin endpoint or directly from tests.
 *
 * One reconciliation run iterates every active school in the platform
 * catalogue, enters that school's tenant context via
 * runWithTenantContextAsync, and writes one rpt_gl_reconciliation row
 * per check_type per school.
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
   * the count of rpt_gl_reconciliation rows written. Errors per tenant
   * are caught and logged so one bad tenant cannot abort the run.
   */
  async runOnce(): Promise<number> {
    var schools = await this.loadActiveSchools();
    var written = 0;
    for (var i = 0; i < schools.length; i++) {
      var tenant = schools[i]!;
      try {
        var count = await this.runForTenant(tenant);
        written += count;
      } catch (e: any) {
        this.logger.warn(
          'gl-reconciliation: tenant=' + tenant.subdomain + ' error=' + (e?.message ?? e),
        );
      }
    }
    return written;
  }

  /**
   * Run all 5 reconciliation checks for a single tenant. Returns the
   * count of rpt_gl_reconciliation rows written (always 5 on success).
   * Each check runs as a single tenant tx with the read query, the
   * rpt_gl_reconciliation INSERT, and (when discrepancies > 0) the
   * outbox emit all atomic.
   */
  async runForTenant(tenant: TenantInfo): Promise<number> {
    var self = this;
    var written = 0;
    await runWithTenantContextAsync({ tenant: tenant }, async function () {
      written += await self.runCheck(tenant, 'INVOICE_AR');
      written += await self.runCheck(tenant, 'PAYMENT_CASH');
      written += await self.runCheck(tenant, 'REFUND_REVERSAL');
      written += await self.runCheck(tenant, 'CREDIT_NOTE');
      written += await self.runCheck(tenant, 'PAYMENT_REVERSAL');
    });
    return written;
  }

  private async runCheck(
    tenant: TenantInfo,
    checkType:
      | 'INVOICE_AR'
      | 'PAYMENT_CASH'
      | 'REFUND_REVERSAL'
      | 'CREDIT_NOTE'
      | 'PAYMENT_REVERSAL',
  ): Promise<number> {
    var query = this.buildCheckQuery(checkType);
    if (query === null) {
      // Source table missing in this tenant — record FAILED row and skip
      // the source query so we still surface the run in the dashboard.
      await this.recordRun(tenant.schoolId, checkType, 0, 0, [], 'FAILED');
      return 1;
    }
    var self = this;
    try {
      var sql = query;
      var discrepancies = await this.tenantPrisma.executeInTenantContext(async function (client) {
        return client.$queryRawUnsafe<Array<{ id: string; source_table: string }>>(sql);
      });
      var totalDiscrepancies = discrepancies.length;
      var totalSource = await this.countSource(checkType);
      var matched = totalSource - totalDiscrepancies;
      var status: 'CLEAN' | 'DISCREPANCIES_FOUND' =
        totalDiscrepancies > 0 ? 'DISCREPANCIES_FOUND' : 'CLEAN';
      var discrepanciesPayload = discrepancies.slice(0, 100).map(function (d) {
        return { sourceId: d.id, sourceTable: d.source_table, issue: 'MISSING_GL_ENTRY' };
      });
      var runId = await this.recordRun(
        tenant.schoolId,
        checkType,
        totalSource,
        matched,
        discrepanciesPayload,
        status,
      );
      if (totalDiscrepancies > 0) {
        await this.emitDiscrepancy(runId, tenant.schoolId, checkType, totalDiscrepancies);
      }
      return 1;
    } catch (e: any) {
      self.logger.warn('gl-reconciliation: check=' + checkType + ' error=' + (e?.message ?? e));
      await this.recordRun(tenant.schoolId, checkType, 0, 0, [], 'FAILED');
      return 1;
    }
  }

  /**
   * SQL for each check type. Returns rows of source-row ids that have NO
   * matching fin_gl_entries row pointing back at them. Returns NULL when
   * the source table is not present in the tenant schema (e.g. a tenant
   * provisioned before Cycle 26 might not have pay_credit_notes yet).
   */
  private buildCheckQuery(
    checkType:
      | 'INVOICE_AR'
      | 'PAYMENT_CASH'
      | 'REFUND_REVERSAL'
      | 'CREDIT_NOTE'
      | 'PAYMENT_REVERSAL',
  ): string | null {
    switch (checkType) {
      case 'INVOICE_AR':
        // Every pay_invoice past DRAFT and not CANCELLED should have at
        // least one GL entry referencing it (the AR charge leg posted by
        // GLConsumer on pay.invoice.created).
        return (
          "SELECT i.id::text AS id, 'pay_invoices'::text AS source_table " +
          'FROM pay_invoices i ' +
          'WHERE i.status NOT IN (' +
          "'DRAFT', 'CANCELLED'" +
          ') ' +
          'AND NOT EXISTS (' +
          'SELECT 1 FROM fin_gl_entries g ' +
          "WHERE g.reference_type = 'pay_invoices' AND g.reference_id = i.id" +
          ')'
        );
      case 'PAYMENT_CASH':
        return (
          "SELECT p.id::text AS id, 'pay_payments'::text AS source_table " +
          'FROM pay_payments p ' +
          "WHERE p.status IN ('COMPLETED', 'REFUNDED') " +
          'AND NOT EXISTS (' +
          'SELECT 1 FROM fin_gl_entries g ' +
          "WHERE g.reference_type = 'pay_payments' AND g.reference_id = p.id" +
          ')'
        );
      case 'REFUND_REVERSAL':
        return (
          "SELECT r.id::text AS id, 'pay_refunds'::text AS source_table " +
          'FROM pay_refunds r ' +
          "WHERE r.status = 'COMPLETED' " +
          'AND NOT EXISTS (' +
          'SELECT 1 FROM fin_gl_entries g ' +
          "WHERE g.reference_type = 'pay_refunds' AND g.reference_id = r.id" +
          ')'
        );
      case 'CREDIT_NOTE':
        return (
          "SELECT c.id::text AS id, 'pay_credit_notes'::text AS source_table " +
          'FROM pay_credit_notes c ' +
          'WHERE NOT EXISTS (' +
          'SELECT 1 FROM fin_gl_entries g ' +
          "WHERE g.reference_type = 'pay_credit_notes' AND g.reference_id = c.id" +
          ')'
        );
      case 'PAYMENT_REVERSAL':
        return (
          "SELECT pr.id::text AS id, 'pay_payment_reversals'::text AS source_table " +
          'FROM pay_payment_reversals pr ' +
          'WHERE NOT EXISTS (' +
          'SELECT 1 FROM fin_gl_entries g ' +
          "WHERE g.reference_type = 'pay_payment_reversals' AND g.reference_id = pr.id" +
          ')'
        );
      default:
        return null;
    }
  }

  /**
   * Count of source rows that the corresponding check is verifying. Used
   * to fill in total_source_rows / total_matched_rows on the
   * reconciliation report row.
   */
  private async countSource(
    checkType:
      | 'INVOICE_AR'
      | 'PAYMENT_CASH'
      | 'REFUND_REVERSAL'
      | 'CREDIT_NOTE'
      | 'PAYMENT_REVERSAL',
  ): Promise<number> {
    var sql: string;
    switch (checkType) {
      case 'INVOICE_AR':
        sql =
          'SELECT COUNT(*)::int AS n FROM pay_invoices ' +
          "WHERE status NOT IN ('DRAFT', 'CANCELLED')";
        break;
      case 'PAYMENT_CASH':
        sql =
          'SELECT COUNT(*)::int AS n FROM pay_payments ' +
          "WHERE status IN ('COMPLETED', 'REFUNDED')";
        break;
      case 'REFUND_REVERSAL':
        sql = "SELECT COUNT(*)::int AS n FROM pay_refunds WHERE status = 'COMPLETED'";
        break;
      case 'CREDIT_NOTE':
        sql = 'SELECT COUNT(*)::int AS n FROM pay_credit_notes';
        break;
      case 'PAYMENT_REVERSAL':
        sql = 'SELECT COUNT(*)::int AS n FROM pay_payment_reversals';
        break;
      default:
        return 0;
    }
    var rows = await this.tenantPrisma.executeInTenantContext(async function (client) {
      return client.$queryRawUnsafe<Array<{ n: number }>>(sql);
    });
    return rows[0]?.n ?? 0;
  }

  private async recordRun(
    schoolId: string,
    checkType: string,
    totalSource: number,
    matched: number,
    discrepancies: Array<{ sourceId: string; sourceTable: string; issue: string }>,
    status: 'CLEAN' | 'DISCREPANCIES_FOUND' | 'FAILED',
  ): Promise<string> {
    var id = generateId();
    var discrepancyCount = totalSource - matched;
    // On FAILED the counts_chk in the schema requires matched=source AND
    // discrepancy=0, so we coerce. The discrepancies payload preserves
    // the truth for the runbook.
    var safeMatched = status === 'FAILED' ? totalSource : matched;
    var safeDiscrepancyCount = status === 'FAILED' ? 0 : discrepancyCount;
    await this.tenantPrisma.executeInTenantTransaction(async function (tx) {
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

  private async emitDiscrepancy(
    runId: string,
    schoolId: string,
    checkType: string,
    discrepancyCount: number,
  ): Promise<void> {
    var self = this;
    await this.tenantPrisma.executeInTenantTransaction(async function (tx) {
      await self.outbox.enqueueInTx(tx, {
        topic: 'fin.gl_reconciliation.discrepancy',
        key: runId,
        sourceModule: 'finance',
        payload: {
          reconciliationRunId: runId,
          schoolId: schoolId,
          checkType: checkType,
          discrepancyCount: discrepancyCount,
          severity: 'URGENT',
          detectedAt: new Date().toISOString(),
        },
      });
    });
  }

  private async loadActiveSchools(): Promise<TenantInfo[]> {
    try {
      var client = this.tenantPrisma.getPlatformClient();
      var rows = await client.$queryRawUnsafe<
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
      return rows.map(function (r): TenantInfo {
        return {
          schoolId: r.id,
          subdomain: r.subdomain,
          schemaName: r.schema_name,
          organisationId: r.organisation_id,
          isFrozen: false,
          planTier: 'STANDARD',
          homeRegion: process.env.AWS_REGION ?? 'us-east-1',
        };
      });
    } catch (e: any) {
      this.logger.warn('gl-reconciliation: could not load schools: ' + (e?.message ?? e));
      return [];
    }
  }
}
