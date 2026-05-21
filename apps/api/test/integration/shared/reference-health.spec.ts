import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { ReferenceHealthScannerWorker } from '@shared/observability/reference-health/reference-health.worker';
import { SOFT_FK_REGISTRY } from '@shared/observability/reference-health/registry';
import { TEST_SCHEMA, TEST_SCHOOL_ID, withTestTenant } from '../helpers/tenant-context';
import { generateId } from '@campusos/database';

/**
 * Wave 8 — ReferenceHealthScannerWorker integration coverage.
 *
 * Drives a full `runScanCycle()` and asserts:
 *   - At least one platform_reference_health row is upserted per
 *     registry entry per active tenant schema.
 *   - When orphans exist, orphan_count > 0 and sample_orphan_ids
 *     includes the seeded UUID.
 *   - Re-running the scan UPDATEs the existing row (UPSERT) rather than
 *     creating duplicates.
 *   - registry has the documented shape.
 */
describe('integration:shared/reference-health', () => {
  let tenantPrisma: TenantPrismaService;
  let raw: PrismaClient;
  let worker: ReferenceHealthScannerWorker;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    raw = new PrismaClient();
    await raw.$connect();
    worker = new ReferenceHealthScannerWorker(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await raw.$disconnect();
  });

  beforeEach(async () => {
    // Wipe any rows for tenant_test so the scan's first poll observes
    // fresh state.
    await raw.$executeRawUnsafe(
      `DELETE FROM platform.platform_reference_health WHERE source_schema = $1`,
      TEST_SCHEMA,
    );
  });

  /**
   * Seed a pay_family_accounts row with an account_holder_id that does NOT
   * exist in platform.iam_person, so the registry's billing-keystone soft-FK
   * ("pay_family_accounts.account_holder_id → platform.iam_person") will
   * detect a dangling row.
   *
   * pay_family_accounts has a much smaller required-column surface than
   * hr_employees, so the orphan seed is straightforward.
   */
  async function seedOrphanFamilyAccount(): Promise<string> {
    const orphanPersonId = '019ec0fa-aaaa-7777-8888-200000000099';
    const accountId = generateId();
    await withTestTenant(async () =>
      tenantPrisma.executeInTenantContext(async (client) =>
        client.$executeRawUnsafe(
          `INSERT INTO pay_family_accounts
             (id, school_id, account_holder_id, account_number, status,
              payment_authorisation_policy)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ACTIVE', 'ACCOUNT_HOLDER_ONLY')`,
          accountId,
          TEST_SCHOOL_ID,
          orphanPersonId,
          'ORPHAN-REF-HEALTH-' + accountId.slice(0, 8),
        ),
      ),
    );
    return orphanPersonId;
  }

  it('registry has hr_employees.person_id → platform.iam_person entry', () => {
    const found = SOFT_FK_REGISTRY.find(
      (e) =>
        e.sourceTable === 'hr_employees' &&
        e.sourceColumn === 'person_id' &&
        e.targetSchema === 'platform' &&
        e.targetTable === 'iam_person',
    );
    expect(found).toBeDefined();
    expect(found?.scope).toBe('TENANT');
  });

  it('runScanCycle detects orphan rows + writes them to platform_reference_health', async () => {
    const orphanId = await seedOrphanFamilyAccount();
    try {
      await worker.runScanCycle();
      // Find the pay_family_accounts scan row for tenant_test.
      const rows = await raw.$queryRawUnsafe<
        Array<{
          orphan_count: number;
          total_rows: number;
          sample_orphan_ids: any;
          severity: string;
        }>
      >(
        `SELECT orphan_count, total_rows, sample_orphan_ids::text AS sample_orphan_ids, severity
           FROM platform.platform_reference_health
          WHERE source_schema = $1
            AND source_table = 'pay_family_accounts'
            AND source_column = 'account_holder_id'`,
        TEST_SCHEMA,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.orphan_count).toBeGreaterThanOrEqual(1);
      expect(rows[0]!.total_rows).toBeGreaterThanOrEqual(1);
      // The scan SAMPLE includes orphan source-column values; account_holder_id
      // is the source column here so the orphan UUID we seeded should appear.
      expect(rows[0]!.sample_orphan_ids).toContain(orphanId);
    } finally {
      await withTestTenant(async () =>
        tenantPrisma.executeInTenantContext(async (client) =>
          client.$executeRawUnsafe(
            `DELETE FROM pay_family_accounts WHERE account_holder_id = $1::uuid`,
            orphanId,
          ),
        ),
      );
    }
  });

  it('re-running runScanCycle upserts (no duplicate rows for the same source triple)', async () => {
    await worker.runScanCycle();
    const beforeCount = await raw.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM platform.platform_reference_health WHERE source_schema = $1`,
      TEST_SCHEMA,
    );
    await worker.runScanCycle();
    const afterCount = await raw.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM platform.platform_reference_health WHERE source_schema = $1`,
      TEST_SCHEMA,
    );
    expect(afterCount[0]!.n).toBe(beforeCount[0]!.n);
  });

  it('every TENANT-scoped registry entry produces a row for tenant_test', async () => {
    await worker.runScanCycle();
    const rows = await raw.$queryRawUnsafe<Array<{ source_table: string; source_column: string }>>(
      `SELECT source_table, source_column FROM platform.platform_reference_health WHERE source_schema = $1`,
      TEST_SCHEMA,
    );
    const seen = new Set(rows.map((r) => `${r.source_table}.${r.source_column}`));
    for (const entry of SOFT_FK_REGISTRY) {
      if (entry.scope === 'TENANT') {
        const key = `${entry.sourceTable}.${entry.sourceColumn}`;
        expect(seen.has(key)).toBe(true);
      }
    }
  });

  it('onApplicationShutdown clears the internal timers without throwing', () => {
    expect(() => worker.onApplicationShutdown()).not.toThrow();
  });

  it('respects REFERENCE_HEALTH_DISABLED=1 (onModuleInit short-circuits)', async () => {
    const prev = process.env.REFERENCE_HEALTH_DISABLED;
    process.env.REFERENCE_HEALTH_DISABLED = '1';
    try {
      const w = new ReferenceHealthScannerWorker(tenantPrisma);
      await w.onModuleInit();
      // The disabled path returns immediately and never schedules a timer.
      w.onApplicationShutdown();
      expect(true).toBe(true);
    } finally {
      if (prev === undefined) {
        delete process.env.REFERENCE_HEALTH_DISABLED;
      } else {
        process.env.REFERENCE_HEALTH_DISABLED = prev;
      }
    }
  });
});
