import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Cycle 31 Step 9 — Platform Admin Service.
 *
 * Read-only cross-tenant operational reporting. Backs the Platform
 * launchpad tile (gated on sys-001:admin). Three surfaces:
 *
 *   - tenants     : per-school summary (subdomain, schema, frozen flag,
 *                   base table count, pending DLQ count). The base
 *                   table count is a sentinel — schools that drift
 *                   from the canonical count have either been hand-
 *                   migrated or had a Prisma generate fail, both of
 *                   which surface here.
 *   - partitions  : RANGE-partitioned table inventory. Surfaces every
 *                   leaf partition with its bound + row count + size.
 *                   Partition activation runbook lives in
 *                   infra/partition-activation-runbook.md.
 *   - migrations  : merged platform + tenant migration history,
 *                   newest-first. Reads platform's _prisma_migrations
 *                   plus a sampling of tenant_*._prisma_migrations
 *                   tables (tenant migration deploys today are SQL-
 *                   driven via provision-tenant.ts so this returns the
 *                   platform table only — tenant SQL state is tracked
 *                   in source via the numbered files in
 *                   packages/database/prisma/tenant/migrations/).
 */
@Injectable()
export class PlatformAdminService {
  private readonly logger = new Logger(PlatformAdminService.name);

  constructor(private readonly platform: PrismaClient) {}

  async listTenants(): Promise<TenantSummary[]> {
    // platform.schools is the canonical tenant register; platform_tenant_routing
    // pins each school to its tenant subdomain + schema name.
    const rows = await this.platform.$queryRawUnsafe<
      Array<{
        school_id: string;
        subdomain: string;
        schema_name: string;
        name: string;
        is_frozen: boolean;
      }>
    >(`
      SELECT s.id AS school_id,
             ptr.subdomain,
             ptr.schema_name,
             s.name,
             COALESCE(sc.is_frozen, false) AS is_frozen
        FROM platform.schools s
        JOIN platform.platform_tenant_routing ptr ON ptr.school_id = s.id
        LEFT JOIN LATERAL (
          SELECT is_frozen FROM platform.school_config WHERE school_id = s.id LIMIT 1
        ) sc ON true
       ORDER BY ptr.subdomain ASC
    `);

    // Per-tenant pending DLQ count via a single aggregate.
    const dlqByTenant = await this.platform.$queryRawUnsafe<
      Array<{ tenant_id: string | null; cnt: bigint }>
    >(`
      SELECT tenant_id, COUNT(*)::bigint AS cnt
        FROM platform.platform_dlq_messages
       WHERE resolved_at IS NULL
       GROUP BY tenant_id
    `);
    const dlqMap = new Map<string, number>();
    for (const r of dlqByTenant) {
      if (r.tenant_id) dlqMap.set(r.tenant_id, Number(r.cnt));
    }

    const summaries: TenantSummary[] = [];
    for (const row of rows) {
      let baseTableCount: number | null = null;
      try {
        const result = await this.platform.$queryRawUnsafe<Array<{ cnt: bigint }>>(
          `SELECT COUNT(*)::bigint AS cnt
             FROM information_schema.tables
            WHERE table_schema = $1
              AND table_type = 'BASE TABLE'
              AND table_name NOT LIKE '\\_prisma\\_%'`,
          row.schema_name,
        );
        baseTableCount = Number(result[0]?.cnt ?? 0);
      } catch (err) {
        this.logger.warn(
          `Failed to count base tables for ${row.schema_name}: ${(err as Error).message}`,
        );
      }
      summaries.push({
        schoolId: row.school_id,
        subdomain: row.subdomain,
        schemaName: row.schema_name,
        name: row.name,
        isFrozen: row.is_frozen,
        baseTableCount,
        pendingDlqCount: dlqMap.get(row.school_id) ?? 0,
      });
    }
    return summaries;
  }

  async listPartitions(parentTable?: string): Promise<PartitionRow[]> {
    // pg_partitioned_table is the canonical catalog; the LATERAL join
    // pulls every leaf and its FROM/TO bound.
    const rows = await this.platform.$queryRawUnsafe<
      Array<{
        parent_schema: string;
        parent_table: string;
        partition_schema: string;
        partition_name: string;
        partition_bound: string;
        row_count: bigint | null;
        size_bytes: bigint | null;
      }>
    >(
      `
      SELECT pn.nspname            AS parent_schema,
             pt.relname            AS parent_table,
             cn.nspname            AS partition_schema,
             c.relname             AS partition_name,
             pg_get_expr(c.relpartbound, c.oid) AS partition_bound,
             pgst.n_live_tup       AS row_count,
             pg_total_relation_size(c.oid) AS size_bytes
        FROM pg_inherits i
        JOIN pg_class pt ON pt.oid = i.inhparent
        JOIN pg_namespace pn ON pn.oid = pt.relnamespace
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_namespace cn ON cn.oid = c.relnamespace
        LEFT JOIN pg_stat_user_tables pgst ON pgst.relid = c.oid
       WHERE pt.relkind = 'p'
         AND ($1::text IS NULL OR pt.relname = $1)
       ORDER BY pn.nspname, pt.relname, c.relname
    `,
      parentTable ?? null,
    );

    return rows.map((r) => {
      const { from, to } = parseRangeBound(r.partition_bound);
      return {
        parentTable: `${r.parent_schema}.${r.parent_table}`,
        partitionName: `${r.partition_schema}.${r.partition_name}`,
        rangeFrom: from,
        rangeTo: to,
        rowCount: r.row_count !== null ? Number(r.row_count) : null,
        sizeMb:
          r.size_bytes !== null
            ? Math.round((Number(r.size_bytes) / (1024 * 1024)) * 100) / 100
            : null,
      };
    });
  }

  async listMigrations(args?: {
    scope?: 'platform' | 'tenant';
    limit?: number;
  }): Promise<MigrationRow[]> {
    const limit = Math.min(args?.limit ?? 100, 500);
    const out: MigrationRow[] = [];

    if (args?.scope !== 'tenant') {
      try {
        const platformRows = await this.platform.$queryRawUnsafe<
          Array<{ migration_name: string; finished_at: Date | null }>
        >(
          `
          SELECT migration_name, finished_at
            FROM public._prisma_migrations
           WHERE finished_at IS NOT NULL
           ORDER BY finished_at DESC
           LIMIT $1
        `,
          limit,
        );
        for (const r of platformRows) {
          out.push({
            scope: 'platform',
            schemaName: null,
            migrationName: r.migration_name,
            appliedAt: (r.finished_at ?? new Date()).toISOString(),
          });
        }
      } catch (err) {
        this.logger.warn(`Failed to read platform migration history: ${(err as Error).message}`);
      }
    }

    // Tenant migrations are SQL-driven via provision-tenant.ts and are
    // NOT recorded in _prisma_migrations. Source-of-truth is the
    // numbered files in packages/database/prisma/tenant/migrations/.
    // The dashboard surfaces a hint for operators rather than fabricate
    // a synthetic history.
    if (args?.scope !== 'platform') {
      out.push({
        scope: 'tenant',
        schemaName: null,
        migrationName:
          '(tenant migrations are tracked in source via packages/database/prisma/tenant/migrations/*.sql)',
        appliedAt: new Date().toISOString(),
      });
    }

    return out.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt)).slice(0, limit);
  }
}

export interface TenantSummary {
  schoolId: string;
  subdomain: string;
  schemaName: string;
  name: string;
  isFrozen: boolean;
  baseTableCount: number | null;
  pendingDlqCount: number;
}

export interface PartitionRow {
  parentTable: string;
  partitionName: string;
  rangeFrom: string;
  rangeTo: string;
  rowCount: number | null;
  sizeMb: number | null;
}

export interface MigrationRow {
  scope: 'platform' | 'tenant';
  schemaName: string | null;
  migrationName: string;
  appliedAt: string;
}

/**
 * Parse a Postgres RANGE partition bound expression into FROM/TO
 * strings. Bound looks like:
 *   FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')
 * or
 *   FOR VALUES FROM (1) TO (5)
 * or
 *   FOR VALUES WITH (modulus 8, remainder 0)   -- HASH partition
 */
function parseRangeBound(bound: string): { from: string; to: string } {
  const m = bound.match(/FROM \((.+?)\) TO \((.+?)\)/);
  if (m && m[1] && m[2]) return { from: m[1].replace(/'/g, ''), to: m[2].replace(/'/g, '') };
  const hashMatch = bound.match(/WITH \((.+?)\)/);
  if (hashMatch && hashMatch[1]) return { from: `WITH ${hashMatch[1]}`, to: '' };
  return { from: bound, to: '' };
}
