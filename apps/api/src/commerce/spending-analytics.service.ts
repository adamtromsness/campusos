import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { generateId, getPlatformClient } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { assertProcurementReader } from './access';
import type { SpendingAnalyticsFilterDto, SpendingAnalyticsRowDto } from './dto/commerce.dto';

interface AnalyticsRow {
  id: string;
  school_id: string;
  period: string;
  vendor_id: string | null;
  category: string | null;
  department: string | null;
  total_spend: string | number;
  po_count: number;
  avg_lead_time_days: string | number | null;
}

/**
 * P2-29a — SpendingAnalyticsService.
 *
 * Read surface over `prc_spending_analytics`, the monthly materialised
 * rollup of procurement spend by (vendor, category, department).
 *
 * Maintained by the companion `ProcurementAnalyticsWorker` which runs
 * monthly (default first day of the month) per tenant. The worker
 * aggregates `prc_purchase_orders` joined to `prc_goods_receipts` for
 * the previous calendar month and UPSERTs into prc_spending_analytics
 * keyed on (school, period, vendor, category, department) — the
 * COALESCE-sentinel UNIQUE on the table accommodates NULL vendor /
 * category / department dimensions.
 */
@Injectable()
export class SpendingAnalyticsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private toDto(row: AnalyticsRow): SpendingAnalyticsRowDto {
    return {
      id: row.id,
      period: row.period,
      vendorId: row.vendor_id,
      category: row.category,
      department: row.department,
      totalSpend: Number(row.total_spend),
      poCount: Number(row.po_count),
      avgLeadTimeDays: row.avg_lead_time_days === null ? null : Number(row.avg_lead_time_days),
    };
  }

  async list(
    actor: ResolvedActor,
    filter: SpendingAnalyticsFilterDto,
  ): Promise<SpendingAnalyticsRowDto[]> {
    await assertProcurementReader(actor, this.permCheck, 'Spending analytics');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const args: unknown[] = [tenant.schoolId];
      const where: string[] = [];
      if (filter.fromPeriod) {
        args.push(filter.fromPeriod);
        where.push(`period >= $${args.length}::date`);
      }
      if (filter.toPeriod) {
        args.push(filter.toPeriod);
        where.push(`period <= $${args.length}::date`);
      }
      if (filter.vendorId) {
        args.push(filter.vendorId);
        where.push(`vendor_id = $${args.length}::uuid`);
      }
      if (filter.category) {
        args.push(filter.category);
        where.push(`category = $${args.length}`);
      }
      if (filter.department) {
        args.push(filter.department);
        where.push(`department = $${args.length}`);
      }
      const extra = where.length ? ' AND ' + where.join(' AND ') : '';
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, period::text AS period,
                vendor_id::text AS vendor_id, category, department,
                total_spend, po_count, avg_lead_time_days
           FROM prc_spending_analytics
          WHERE school_id = $1::uuid${extra}
          ORDER BY period DESC, total_spend DESC NULLS LAST`,
        ...args,
      )) as AnalyticsRow[];
      return rows.map((r) => this.toDto(r));
    });
  }
}

/**
 * ProcurementAnalyticsWorker — monthly materialisation of
 * prc_spending_analytics from prc_purchase_orders and
 * prc_goods_receipts. Polls hourly so any tenant whose monthly
 * window has rolled over gets re-materialised promptly. Idempotent
 * via UPSERT on the (school, period, vendor, category, department)
 * COALESCE-sentinel UNIQUE.
 *
 * Worker is best-effort. Errors per tenant are logged and skipped so
 * one tenant's misconfiguration does not abort the sweep.
 */
@Injectable()
export class ProcurementAnalyticsWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProcurementAnalyticsWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;

  constructor(private readonly tenantPrisma: TenantPrismaService) {
    this.intervalMs = Number(process.env.PRC_ANALYTICS_INTERVAL_MS) || 60 * 60 * 1000;
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => {
        this.logger.error('ProcurementAnalyticsWorker.runOnce failed', err);
      });
    }, this.intervalMs);
    this.logger.log(
      'ProcurementAnalyticsWorker scheduled — sweep every ' +
        Math.round(this.intervalMs / 60 / 1000) +
        ' minute(s)',
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<{ tenantsScanned: number; rowsUpserted: number }> {
    const platform = getPlatformClient();
    const schools = await platform.school.findMany({ where: { isActive: true } });
    let upserted = 0;
    let scanned = 0;
    for (const school of schools) {
      if (!school.schemaName) continue;
      scanned += 1;
      try {
        upserted += await this.tickForSchool(school.schemaName, school.id);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn('ProcurementAnalyticsWorker failed for ' + school.schemaName + ': ' + msg);
      }
    }
    return { tenantsScanned: scanned, rowsUpserted: upserted };
  }

  async tickForSchool(schemaName: string, schoolId: string): Promise<number> {
    return this.tenantPrisma.executeInExplicitSchema(schemaName, async (client) => {
      const target = new Date();
      target.setUTCDate(1);
      target.setUTCHours(0, 0, 0, 0);
      target.setUTCMonth(target.getUTCMonth() - 1);
      const period = target.toISOString().slice(0, 10);
      const nextMonth = new Date(target);
      nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
      const nextPeriod = nextMonth.toISOString().slice(0, 10);

      // Aggregate by vendor + category (department dimension is left
      // null until prc_purchase_orders carries a department column;
      // forward-compatible).
      const aggregated = (await client.$queryRawUnsafe(
        `SELECT po.vendor_id::text AS vendor_id,
                NULL::text AS category,
                NULL::text AS department,
                COALESCE(SUM(po.total_amount), 0)::text AS total_spend,
                COUNT(*)::int AS po_count,
                NULL::numeric AS avg_lead_time_days
           FROM prc_purchase_orders po
          WHERE po.school_id = $1::uuid
            AND po.issued_at IS NOT NULL
            AND po.issued_at >= $2::timestamptz
            AND po.issued_at < $3::timestamptz
          GROUP BY po.vendor_id`,
        schoolId,
        period,
        nextPeriod,
      )) as Array<{
        vendor_id: string | null;
        category: string | null;
        department: string | null;
        total_spend: string;
        po_count: number;
        avg_lead_time_days: string | null;
      }>;

      let count = 0;
      for (const r of aggregated) {
        const id = generateId();
        await client.$executeRawUnsafe(
          `INSERT INTO prc_spending_analytics
             (id, school_id, period, vendor_id, category, department,
              total_spend, po_count, avg_lead_time_days, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::date, $4::uuid, $5, $6,
                   $7::numeric, $8, $9::numeric, now(), now())
           ON CONFLICT (school_id, period, COALESCE(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid),
                        COALESCE(category, ''), COALESCE(department, ''))
           DO UPDATE SET total_spend = EXCLUDED.total_spend,
                         po_count = EXCLUDED.po_count,
                         avg_lead_time_days = EXCLUDED.avg_lead_time_days,
                         updated_at = now()`,
          id,
          schoolId,
          period,
          r.vendor_id,
          r.category,
          r.department,
          r.total_spend,
          r.po_count,
          r.avg_lead_time_days,
        );
        count += 1;
      }
      if (count > 0) {
        this.logger.log(
          'ProcurementAnalyticsWorker UPSERTed ' +
            count +
            ' analytics row(s) for ' +
            schemaName +
            ' period=' +
            period,
        );
      }
      return count;
    });
  }
}
