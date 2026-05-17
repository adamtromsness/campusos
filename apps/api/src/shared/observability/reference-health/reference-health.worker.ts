import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { SoftFkEntry, SOFT_FK_REGISTRY } from './registry';

/**
 * REVIEW-FINAL P4 — ReferenceHealthScannerWorker.
 *
 * Periodic worker that walks `SOFT_FK_REGISTRY`, counts orphan rows
 * for each registered soft FK pattern, and writes one
 * `platform_reference_health` row per scan + entry. Operators query
 * the table via the platform admin dashboard (Cycle 31 platform-admin
 * surface) to see drift over time and investigate spikes.
 *
 * Trigger model:
 *   - On `onModuleInit`, a one-shot scan runs after a 60s warmup so
 *     the boot sequence isn't blocked by a slow scan.
 *   - After that, scans run every `REFERENCE_HEALTH_SCAN_INTERVAL_MS`
 *     ms (default 1 hour). Configurable for staging where a tighter
 *     loop is useful for testing.
 *   - The interval timer is cleared on shutdown so the API can stop
 *     cleanly.
 *
 * Scope handling:
 *   - PLATFORM-scoped entries scan once per cycle.
 *   - TENANT-scoped entries scan once per active tenant per cycle —
 *     the worker enumerates active rows from `platform.schools` +
 *     `platform_tenant_routing` and enters each tenant's schema via
 *     `executeInExplicitSchema` to run the scan query.
 *
 * Sample queries:
 *   - Orphan count:
 *       SELECT COUNT(*) FROM tenant_X.hr_employees s
 *       LEFT JOIN platform.iam_person t ON t.id = s.person_id
 *       WHERE t.id IS NULL;
 *   - Sample 20 orphan ids for operator triage:
 *       SELECT s.id::text FROM ... LIMIT 20;
 *
 * Failure handling: a scan failure on one entry logs and continues
 * to the next entry. The worker never throws to the host — partial
 * scan output is better than no scan output.
 */
@Injectable()
export class ReferenceHealthScannerWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ReferenceHealthScannerWorker.name);
  private intervalHandle: NodeJS.Timeout | null = null;
  private warmupHandle: NodeJS.Timeout | null = null;

  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async onModuleInit(): Promise<void> {
    if (process.env.REFERENCE_HEALTH_DISABLED === '1') {
      this.logger.log('Reference-health scanner disabled via REFERENCE_HEALTH_DISABLED=1');
      return;
    }
    const intervalMs = Number(process.env.REFERENCE_HEALTH_SCAN_INTERVAL_MS || 3600_000);
    const warmupMs = Number(process.env.REFERENCE_HEALTH_WARMUP_MS || 60_000);

    this.warmupHandle = setTimeout(() => {
      this.runScanCycle().catch((e) => {
        this.logger.error('Reference-health scan failed: ' + (e?.stack || e?.message || e));
      });
      this.intervalHandle = setInterval(() => {
        this.runScanCycle().catch((e) => {
          this.logger.error('Reference-health scan failed: ' + (e?.stack || e?.message || e));
        });
      }, intervalMs);
    }, warmupMs);

    this.logger.log(
      `ReferenceHealthScannerWorker scheduled (warmup=${warmupMs}ms, interval=${intervalMs}ms, registry=${SOFT_FK_REGISTRY.length})`,
    );
  }

  onApplicationShutdown(): void {
    if (this.warmupHandle) clearTimeout(this.warmupHandle);
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  /**
   * One cycle = walk every registry entry once. Tenant-scoped entries
   * are scanned per-active-tenant; platform-scoped entries are
   * scanned once.
   */
  async runScanCycle(): Promise<void> {
    const platform = this.tenantPrisma.getPlatformClient();
    // Active tenants — `is_frozen=false` is the canonical "this
    // school is operational" filter.
    const tenantRows = (await platform.$queryRawUnsafe(
      `SELECT s.id::text AS school_id, r.subdomain
         FROM platform.schools s
         JOIN platform.platform_tenant_routing r ON r.school_id = s.id
        WHERE s.is_frozen = false`,
    )) as Array<{ school_id: string; subdomain: string }>;

    for (const entry of SOFT_FK_REGISTRY) {
      try {
        if (entry.scope === 'PLATFORM') {
          await this.scanOnce(entry, 'platform');
        } else {
          for (const t of tenantRows) {
            const schemaName = 'tenant_' + t.subdomain;
            await this.scanOnce(entry, schemaName);
          }
        }
      } catch (e: any) {
        this.logger.error(`Scan failed for ${entry.name}: ${e?.stack || e?.message || e}`);
      }
    }
  }

  /**
   * Run one scan against one source schema for one registry entry.
   * Writes the result row directly to platform_reference_health.
   */
  private async scanOnce(entry: SoftFkEntry, sourceSchema: string): Promise<void> {
    const targetColumn = entry.targetColumn ?? 'id';
    const where = entry.where ? ' WHERE ' + entry.where : '';
    const startedAt = Date.now();

    const totalSql = `SELECT COUNT(*)::int AS n FROM "${sourceSchema}"."${entry.sourceTable}"${where}`;
    // REVIEW-P2C1 ROUND 4 hardening (CodeQL js/identity-replacement) —
    // dropped a `.replace(/\bs\b/g, 's')` no-op on entry.where. The
    // string was being replaced with itself which had no effect; the
    // canonical sampleSql below uses entry.where verbatim, so this
    // branch now does the same.
    const orphanSql =
      `SELECT COUNT(*)::int AS n FROM "${sourceSchema}"."${entry.sourceTable}" s ` +
      `LEFT JOIN "${entry.targetSchema}"."${entry.targetTable}" t ` +
      `  ON t."${targetColumn}" = s."${entry.sourceColumn}" ` +
      `WHERE t."${targetColumn}" IS NULL` +
      (entry.where ? ' AND ' + entry.where : '');
    const sampleSql =
      `SELECT s."${entry.sourceColumn}"::text AS orphan_id ` +
      `FROM "${sourceSchema}"."${entry.sourceTable}" s ` +
      `LEFT JOIN "${entry.targetSchema}"."${entry.targetTable}" t ` +
      `  ON t."${targetColumn}" = s."${entry.sourceColumn}" ` +
      `WHERE t."${targetColumn}" IS NULL` +
      (entry.where ? ' AND ' + entry.where : '') +
      ` LIMIT 20`;

    // The platform Prisma client is fine for both platform and
    // tenant queries when we schema-qualify the table names — no
    // search_path manipulation required.
    const platform = this.tenantPrisma.getPlatformClient();

    const totalRows = (await platform.$queryRawUnsafe(totalSql)) as Array<{ n: number }>;
    const orphanRows = (await platform.$queryRawUnsafe(orphanSql)) as Array<{ n: number }>;
    const total = totalRows[0]?.n ?? 0;
    const orphanCount = orphanRows[0]?.n ?? 0;

    let sampleIds: string[] = [];
    if (orphanCount > 0) {
      const sampleRows = (await platform.$queryRawUnsafe(sampleSql)) as Array<{
        orphan_id: string;
      }>;
      sampleIds = sampleRows.map((r) => r.orphan_id);
    }

    const durationMs = Date.now() - startedAt;
    // P2-H2 Step 5 — registry-shape UPSERT (one row per registered
    // reference) rather than event-log-per-scan. The UNIQUE constraint
    // on (source_schema, source_table, source_column) from the
    // accompanying Prisma migration backs the ON CONFLICT clause.
    // scanned_at is refreshed on every scan via the EXCLUDED row.
    await platform.$executeRawUnsafe(
      `INSERT INTO platform.platform_reference_health
         (id, source_schema, source_table, source_column, target_schema, target_table,
          target_column, target_module, severity, total_rows, orphan_count,
          sample_orphan_ids, scan_duration_ms, scanned_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, now())
       ON CONFLICT ON CONSTRAINT platform_reference_health_source_uq DO UPDATE SET
         target_schema = EXCLUDED.target_schema,
         target_table = EXCLUDED.target_table,
         target_column = EXCLUDED.target_column,
         target_module = EXCLUDED.target_module,
         severity = EXCLUDED.severity,
         total_rows = EXCLUDED.total_rows,
         orphan_count = EXCLUDED.orphan_count,
         sample_orphan_ids = EXCLUDED.sample_orphan_ids,
         scan_duration_ms = EXCLUDED.scan_duration_ms,
         scanned_at = now()`,
      generateId(),
      sourceSchema,
      entry.sourceTable,
      entry.sourceColumn,
      entry.targetSchema,
      entry.targetTable,
      targetColumn,
      entry.targetModule ?? 'platform',
      entry.severity ?? 'WARNING',
      total,
      orphanCount,
      JSON.stringify(sampleIds),
      durationMs,
    );

    // P2-H2 Step 5 — alert by severity. CRITICAL refs page on any
    // orphan; WARNING pages on > 5; INFO never pages. The logger
    // levels (error / warn / debug) drive the downstream Cycle 31
    // SLO alerting pipeline.
    const severity = entry.severity ?? 'WARNING';
    if (orphanCount > 0) {
      const shouldPage = severity === 'CRITICAL' || (severity === 'WARNING' && orphanCount > 5);
      if (shouldPage) {
        this.logger.error(
          `[reference-health] PAGE severity=${severity} ${entry.name} (${sourceSchema}) — ${orphanCount}/${total} orphans (${durationMs}ms)`,
        );
      } else {
        this.logger.warn(
          `[reference-health] ${entry.name} (${sourceSchema}) — ${orphanCount}/${total} orphans (${durationMs}ms)`,
        );
      }
    } else {
      this.logger.debug(
        `[reference-health] ${entry.name} (${sourceSchema}) — clean (${total} rows, ${durationMs}ms)`,
      );
    }
  }
}
