import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import { TEST_PARENT_PERSON_ID } from '../helpers/actor';

/**
 * Wave 2 — DB-backed integration tests for TenantPrismaService.
 *
 * Strategy doc Wave 2 contracts:
 *   - executeInTenantContext sets search_path correctly so unqualified
 *     table references resolve to the tenant schema
 *   - executeInTenantTransaction rolls back on failure
 *   - Concurrent requests use SET LOCAL (not session SET) so
 *     search_path cannot leak across simultaneous tenants
 *   - No tenant context → query rejected (never defaults to public/platform)
 *   - executeInExplicitSchema bypasses AsyncLocalStorage (used by
 *     cross-tenant search endpoints)
 *   - getPlatformClient() returns the un-pinned platform client
 */
describe('integration:m00-platform/tenant-isolation', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Wipe any test-created family-account rows from prior runs.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.pay_family_accounts WHERE account_number LIKE 'TI-TEST-%'`,
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // executeInTenantContext — sets search_path
  // ────────────────────────────────────────────────────────────────────
  describe('executeInTenantContext', () => {
    it('sets search_path to the tenant schema; unqualified pay_family_accounts resolves', async () => {
      // Seed a fixture row via the explicit schema reference, then query
      // it via the unqualified name through the service.
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pay_family_accounts
           (id, school_id, account_holder_id, account_number, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ACTIVE')`,
        id,
        TEST_SCHOOL_ID,
        TEST_PARENT_PERSON_ID,
        'TI-TEST-' + id,
      );

      const rows = await withTestTenant(async () =>
        tenantPrisma.executeInTenantContext(async (client) =>
          client.$queryRawUnsafe<Array<{ id: string }>>(
            // No schema qualifier — relies on search_path
            `SELECT id::text AS id FROM pay_family_accounts WHERE id = $1::uuid`,
            id,
          ),
        ),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(id);
    });

    it('search_path is FIRST set to tenant_test BEFORE the callback runs (SHOW search_path verifies)', async () => {
      const setting = await withTestTenant(async () =>
        tenantPrisma.executeInTenantContext(async (client) => {
          const r = (await client.$queryRawUnsafe(
            `SHOW search_path`,
          )) as Array<{ search_path: string }>;
          return r[0]!.search_path;
        }),
      );
      // The exact format is `"tenant_test", platform, public`
      expect(setting).toContain('tenant_test');
      expect(setting).toContain('platform');
      expect(setting).toContain('public');
      // Verify ordering: tenant first
      expect(setting.indexOf('tenant_test')).toBeLessThan(setting.indexOf('platform'));
    });

    it('without tenant context → throws "No tenant context"', async () => {
      await expect(
        tenantPrisma.executeInTenantContext(async () => undefined),
      ).rejects.toThrowError(/No tenant context/);
    });

    it('search_path does NOT leak between sequential withTestTenant + withTestTenantB calls', async () => {
      // School A → search_path schema is tenant_test (with TEST_SCHOOL_ID context)
      const ctxA = await withTestTenant(async () =>
        tenantPrisma.executeInTenantContext(async (client) => {
          const r = (await client.$queryRawUnsafe(
            `SELECT current_setting('search_path') AS sp`,
          )) as Array<{ sp: string }>;
          return r[0]!.sp;
        }),
      );
      // School B with same schema but different schoolId
      const ctxB = await withTestTenantB(async () =>
        tenantPrisma.executeInTenantContext(async (client) => {
          const r = (await client.$queryRawUnsafe(
            `SELECT current_setting('search_path') AS sp`,
          )) as Array<{ sp: string }>;
          return r[0]!.sp;
        }),
      );
      // Both contexts get the same schema_name (TEST_SCHEMA), the
      // school-tier scoping is via tenant.schoolId (not search_path).
      // The point of the test: each call individually saw its own
      // tenant_test search_path; neither leaked.
      expect(ctxA).toContain('tenant_test');
      expect(ctxB).toContain('tenant_test');
    });

    it('SET LOCAL is per-tx: a fresh query outside any executeInTenantContext does NOT see tenant_test (default = platform per DATABASE_URL)', async () => {
      // Use the SAME platformClient instance the service uses, but
      // outside a tx. The pooled connection should NOT carry the
      // tenant_test search_path because SET LOCAL is tx-scoped.
      const platformClient = tenantPrisma.getPlatformClient();
      const r = (await platformClient.$queryRawUnsafe(
        `SHOW search_path`,
      )) as Array<{ search_path: string }>;
      const sp = r[0]!.search_path;
      // The platform client is initialized with DATABASE_URL `?schema=platform`,
      // so the default search_path is `"$user", platform` (or similar). The
      // critical assertion: NO `tenant_test` should leak from a prior tx.
      expect(sp).not.toContain('tenant_test');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // executeInTenantTransaction — atomic rollback semantics
  // ────────────────────────────────────────────────────────────────────
  describe('executeInTenantTransaction', () => {
    it('callback that throws → tx rolls back, no rows persist', async () => {
      const id = generateId();
      await expect(
        withTestTenant(async () =>
          tenantPrisma.executeInTenantTransaction(async (tx) => {
            await tx.$executeRawUnsafe(
              `INSERT INTO pay_family_accounts
                 (id, school_id, account_holder_id, account_number, status)
               VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ACTIVE')`,
              id,
              TEST_SCHOOL_ID,
              TEST_PARENT_PERSON_ID,
              'TI-TEST-' + id,
            );
            throw new Error('boom — rollback expected');
          }),
        ),
      ).rejects.toThrow(/boom/);

      // Row must not have landed
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pay_family_accounts WHERE id = $1::uuid`,
        id,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(0);
    });

    it('callback that resolves → tx commits, rows persist', async () => {
      const id = generateId();
      await withTestTenant(async () =>
        tenantPrisma.executeInTenantTransaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO pay_family_accounts
               (id, school_id, account_holder_id, account_number, status)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ACTIVE')`,
            id,
            TEST_SCHOOL_ID,
            TEST_PARENT_PERSON_ID,
            'TI-TEST-' + id,
          );
        }),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pay_family_accounts WHERE id = $1::uuid`,
        id,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(1);
    });

    it('multi-statement tx: failure on second statement rolls back the first', async () => {
      const id1 = generateId();
      const id2 = generateId();
      await expect(
        withTestTenant(async () =>
          tenantPrisma.executeInTenantTransaction(async (tx) => {
            await tx.$executeRawUnsafe(
              `INSERT INTO pay_family_accounts (id, school_id, account_holder_id, account_number, status)
               VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ACTIVE')`,
              id1,
              TEST_SCHOOL_ID,
              TEST_PARENT_PERSON_ID,
              'TI-TEST-' + id1,
            );
            // Second statement violates CHECK on status — should abort tx
            await tx.$executeRawUnsafe(
              `INSERT INTO pay_family_accounts (id, school_id, account_holder_id, account_number, status)
               VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'INVALID_STATUS')`,
              id2,
              TEST_SCHOOL_ID,
              TEST_PARENT_PERSON_ID,
              'TI-TEST-' + id2,
            );
          }),
        ),
      ).rejects.toThrow();

      // Neither row should have landed
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pay_family_accounts WHERE id IN ($1::uuid, $2::uuid)`,
        id1,
        id2,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(0);
    });

    it('without tenant context → throws "No tenant context"', async () => {
      await expect(
        tenantPrisma.executeInTenantTransaction(async () => undefined),
      ).rejects.toThrowError(/No tenant context/);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // executeTenantSQL — raw SQL helper
  // ────────────────────────────────────────────────────────────────────
  describe('executeTenantSQL', () => {
    it('runs a raw SQL string in the tenant search_path', async () => {
      const id = generateId();
      await withTestTenant(async () =>
        tenantPrisma.executeTenantSQL(
          `INSERT INTO pay_family_accounts (id, school_id, account_holder_id, account_number, status)
           VALUES ('${id}'::uuid, '${TEST_SCHOOL_ID}'::uuid, '${TEST_PARENT_PERSON_ID}'::uuid, 'TI-TEST-${id}', 'ACTIVE')`,
        ),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pay_family_accounts WHERE id = $1::uuid`,
        id,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // executeInExplicitSchema — bypasses AsyncLocalStorage
  // ────────────────────────────────────────────────────────────────────
  describe('executeInExplicitSchema', () => {
    it('runs against the supplied schema WITHOUT a tenant context', async () => {
      // No withTestTenant wrapper — explicit schema only.
      const rows = await tenantPrisma.executeInExplicitSchema(TEST_SCHEMA, async (client) =>
        client.$queryRawUnsafe<Array<{ search_path: string }>>(`SHOW search_path`),
      );
      expect(rows[0]!.search_path).toContain('tenant_test');
    });

    it('supplied schema overrides any active tenant context', async () => {
      // Even inside withTestTenant, an explicit-schema call uses the
      // supplied name.
      const rows = await withTestTenant(async () =>
        tenantPrisma.executeInExplicitSchema('tenant_demo', async (client) =>
          client.$queryRawUnsafe<Array<{ search_path: string }>>(`SHOW search_path`),
        ),
      );
      expect(rows[0]!.search_path).toContain('tenant_demo');
      expect(rows[0]!.search_path).not.toContain('tenant_test');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Concurrent isolation — SET LOCAL never leaks between simultaneous txs
  // ────────────────────────────────────────────────────────────────────
  describe('concurrent isolation (SET LOCAL, not session SET)', () => {
    it('parallel executeInTenantContext calls each see their own search_path (no leak)', async () => {
      // Run N parallel calls, each capturing its own search_path. Even
      // under contention, every call must see its requested schema.
      const N = 10;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          // Alternate between TEST_SCHEMA (tenant_test) and tenant_demo
          // via explicit-schema (bypassing AsyncLocalStorage so we can
          // run concurrent flips against the same shared platformClient).
          tenantPrisma.executeInExplicitSchema(
            i % 2 === 0 ? 'tenant_test' : 'tenant_demo',
            async (client) => {
              const r = (await client.$queryRawUnsafe(
                `SELECT current_setting('search_path') AS sp`,
              )) as Array<{ sp: string }>;
              return { i, sp: r[0]!.sp };
            },
          ),
        ),
      );
      // Verify each call saw the right schema
      for (const r of results) {
        if (r.i % 2 === 0) {
          expect(r.sp).toContain('tenant_test');
          expect(r.sp).not.toContain('tenant_demo');
        } else {
          expect(r.sp).toContain('tenant_demo');
          expect(r.sp).not.toContain('tenant_test');
        }
      }
    });

    it('after a tx completes, the next non-tx query on the same pool does NOT inherit the SET LOCAL', async () => {
      // Run a tenant tx
      await withTestTenant(async () =>
        tenantPrisma.executeInTenantContext(async (client) => {
          await client.$executeRawUnsafe(`SELECT 1`);
        }),
      );
      // Run a query directly on the platform client (no $transaction)
      const r = (await tenantPrisma
        .getPlatformClient()
        .$queryRawUnsafe(`SHOW search_path`)) as Array<{ search_path: string }>;
      expect(r[0]!.search_path).not.toContain('tenant_test');
    });

    it('cross-school school_id under shared search_path: an INSERT with TEST_SCHOOL_B_ID lands and is visible to direct SQL', async () => {
      const id = generateId();
      await withTestTenantB(async () =>
        tenantPrisma.executeInTenantContext(async (client) => {
          await client.$executeRawUnsafe(
            `INSERT INTO pay_family_accounts (id, school_id, account_holder_id, account_number, status)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ACTIVE')`,
            id,
            TEST_SCHOOL_B_ID,
            TEST_PARENT_PERSON_ID,
            'TI-TEST-' + id,
          );
        }),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT school_id::text AS school_id FROM ${TEST_SCHEMA}.pay_family_accounts WHERE id = $1::uuid`,
        id,
      )) as Array<{ school_id: string }>;
      expect(rows[0]!.school_id).toBe(TEST_SCHOOL_B_ID);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // getPlatformClient — un-pinned platform access
  // ────────────────────────────────────────────────────────────────────
  describe('getPlatformClient', () => {
    it('returns a PrismaClient that resolves platform.* tables without SET LOCAL', async () => {
      const platform = tenantPrisma.getPlatformClient();
      const rows = (await platform.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM platform.iam_person WHERE id = $1::uuid`,
        TEST_PARENT_PERSON_ID,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(1);
    });

    it('returns the SAME instance across calls (singleton-per-service)', async () => {
      const a = tenantPrisma.getPlatformClient();
      const b = tenantPrisma.getPlatformClient();
      expect(a).toBe(b);
    });
  });
});
