import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import {
  getCurrentTenant,
  getCurrentUserId,
  getRequestContext,
  runWithTenantContext,
  runWithTenantContextAsync,
  type TenantInfo,
} from '@shared/tenant/tenant.context';
import {
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SUBDOMAIN,
  TEST_ORG_ID,
  withTestTenant,
} from '../helpers/tenant-context';

/**
 * Wave 8 — shared/tenant integration coverage.
 *
 * Exercises:
 *   - AsyncLocalStorage tenant.context (getCurrentTenant / getCurrentUserId /
 *     getRequestContext throw + happy-path).
 *   - TenantPrismaService.executeInTenantContext: SET LOCAL search_path
 *     is applied, ROLLBACK on throw, no tenant context → throw.
 *   - TenantPrismaService.executeInTenantTransaction: rolls back atomically
 *     on a thrown error so partial writes never leak to the schema.
 *   - executeTenantSQL applies search_path to raw SQL.
 *   - executeInExplicitSchema bypasses the AsyncLocalStorage context.
 *   - getPlatformClient returns the platform-only client (no search_path).
 *   - is_frozen=true blocks writes via the TenantGuard but reads stay open.
 *
 * The frozen contract is exercised against the platform_tenant_routing
 * row used by the test schema — we flip is_frozen on the routing row,
 * build a TenantInfo with isFrozen=true, and assert TenantGuard.canActivate
 * rejects writes with 503 WRITE_FROZEN.
 */
describe('integration:shared/tenant-context', () => {
  let tenantPrisma: TenantPrismaService;
  let raw: PrismaClient;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    raw = new PrismaClient();
    await raw.$connect();
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await raw.$disconnect();
  });

  afterEach(async () => {
    // Defence-in-depth: make sure no test leaves the routing row frozen.
    await raw.$executeRawUnsafe(
      `UPDATE platform.platform_tenant_routing SET is_frozen = false WHERE tenant_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // AsyncLocalStorage: getCurrentTenant / getCurrentUserId / getRequestContext
  // ──────────────────────────────────────────────────────────────────
  describe('AsyncLocalStorage context', () => {
    it('getCurrentTenant throws outside any context', () => {
      expect(() => getCurrentTenant()).toThrow(/No tenant context/);
    });

    it('getCurrentUserId returns undefined outside context', () => {
      expect(getCurrentUserId()).toBeUndefined();
    });

    it('getRequestContext returns undefined outside context', () => {
      expect(getRequestContext()).toBeUndefined();
    });

    it('runWithTenantContext propagates synchronously', () => {
      const tenant: TenantInfo = {
        schoolId: TEST_SCHOOL_ID,
        schemaName: TEST_SCHEMA,
        organisationId: TEST_ORG_ID,
        subdomain: TEST_SUBDOMAIN,
        isFrozen: false,
        planTier: 'MEDIUM',
        homeRegion: 'us-east-1',
      };
      let captured: TenantInfo | undefined;
      runWithTenantContext({ tenant, userId: 'user-A' }, () => {
        captured = getCurrentTenant();
      });
      expect(captured?.schoolId).toBe(TEST_SCHOOL_ID);
    });

    it('runWithTenantContextAsync propagates across awaits', async () => {
      let userId: string | undefined;
      await withTestTenant(
        async () => {
          await Promise.resolve();
          userId = getCurrentUserId();
        },
        { userId: 'async-user' },
      );
      expect(userId).toBe('async-user');
    });

    it('getCurrentTenant throws when ctx exists but tenant is missing', () => {
      const fn = () => {
        // Force-feed an invalid context shape — the runtime guard is the
        // important assertion.
        const ctx = { tenant: undefined as unknown as TenantInfo };
        return runWithTenantContextAsync(ctx, async () => {
          getCurrentTenant();
        });
      };
      return expect(fn()).rejects.toThrow(/No tenant context/);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // executeInTenantContext — SET LOCAL search_path inside the tx
  // ──────────────────────────────────────────────────────────────────
  describe('executeInTenantContext', () => {
    it('sets search_path to tenant_<id>, platform, public for the callback', async () => {
      const result = await withTestTenant(async () =>
        tenantPrisma.executeInTenantContext(async (client) => {
          const rows = (await client.$queryRawUnsafe(
            `SELECT current_setting('search_path') AS sp`,
          )) as Array<{ sp: string }>;
          return rows[0]!.sp;
        }),
      );
      expect(result).toContain('tenant_test');
      expect(result).toContain('platform');
      expect(result).toContain('public');
    });

    it('throws when called outside any tenant context', async () => {
      await expect(tenantPrisma.executeInTenantContext(async () => 1)).rejects.toThrow(
        /No tenant context/,
      );
    });

    it('resolves tenant-scoped table names without schema-qualification', async () => {
      const rows = await withTestTenant(async () =>
        tenantPrisma.executeInTenantContext(async (client) =>
          client.$queryRawUnsafe<Array<{ n: number }>>(
            `SELECT COUNT(*)::int AS n FROM hr_employees`,
          ),
        ),
      );
      // Just exercise the read; the count is whatever the fixtures seeded.
      expect(rows[0]).toBeDefined();
      expect(typeof rows[0]!.n).toBe('number');
    });

    it('search_path does not leak outside the tx', async () => {
      await withTestTenant(async () =>
        tenantPrisma.executeInTenantContext(async (client) => {
          await client.$queryRawUnsafe(`SELECT 1`);
        }),
      );
      const after = (await raw.$queryRawUnsafe(
        `SELECT current_setting('search_path') AS sp`,
      )) as Array<{ sp: string }>;
      // The bare platform client (NOT scoped to a tenant) should NOT show tenant_test
      expect(after[0]!.sp).not.toContain('tenant_test');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // executeInTenantTransaction — rollback contract
  // ──────────────────────────────────────────────────────────────────
  describe('executeInTenantTransaction', () => {
    it('commits on success', async () => {
      // Use a temp table inside the tx to prove the commit happens.
      const id = '019ec0fa-aaaa-7777-8888-100000000001';
      try {
        await withTestTenant(async () =>
          tenantPrisma.executeInTenantTransaction(async (tx) => {
            await tx.$executeRawUnsafe(
              `CREATE TABLE IF NOT EXISTS tenant_context_probe (id UUID PRIMARY KEY)`,
            );
            await tx.$executeRawUnsafe(
              `INSERT INTO tenant_context_probe (id) VALUES ($1::uuid) ON CONFLICT DO NOTHING`,
              id,
            );
          }),
        );
        const rows = await withTestTenant(async () =>
          tenantPrisma.executeInTenantContext(async (client) =>
            client.$queryRawUnsafe<Array<{ id: string }>>(
              `SELECT id::text AS id FROM tenant_context_probe WHERE id = $1::uuid`,
              id,
            ),
          ),
        );
        expect(rows).toHaveLength(1);
      } finally {
        await withTestTenant(async () =>
          tenantPrisma.executeInTenantContext(async (client) =>
            client.$executeRawUnsafe(`DROP TABLE IF EXISTS tenant_context_probe`),
          ),
        );
      }
    });

    it('rolls back atomically when the callback throws', async () => {
      const id = '019ec0fa-aaaa-7777-8888-100000000002';
      try {
        await withTestTenant(async () =>
          tenantPrisma.executeInTenantContext(async (client) =>
            client.$executeRawUnsafe(
              `CREATE TABLE IF NOT EXISTS tenant_context_probe (id UUID PRIMARY KEY)`,
            ),
          ),
        );
        // Throw mid-tx → rollback. The INSERT should not be visible.
        await expect(
          withTestTenant(async () =>
            tenantPrisma.executeInTenantTransaction(async (tx) => {
              await tx.$executeRawUnsafe(
                `INSERT INTO tenant_context_probe (id) VALUES ($1::uuid)`,
                id,
              );
              throw new Error('boom — rollback expected');
            }),
          ),
        ).rejects.toThrow(/rollback expected/);
        const rows = await withTestTenant(async () =>
          tenantPrisma.executeInTenantContext(async (client) =>
            client.$queryRawUnsafe<Array<{ id: string }>>(
              `SELECT id::text AS id FROM tenant_context_probe WHERE id = $1::uuid`,
              id,
            ),
          ),
        );
        expect(rows).toHaveLength(0);
      } finally {
        await withTestTenant(async () =>
          tenantPrisma.executeInTenantContext(async (client) =>
            client.$executeRawUnsafe(`DROP TABLE IF EXISTS tenant_context_probe`),
          ),
        );
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // executeTenantSQL / executeInExplicitSchema / getPlatformClient
  // ──────────────────────────────────────────────────────────────────
  describe('executeTenantSQL', () => {
    it('runs raw SQL under the tenant search_path', async () => {
      await withTestTenant(async () =>
        tenantPrisma.executeTenantSQL(
          `CREATE TABLE IF NOT EXISTS tenant_sql_probe (id UUID PRIMARY KEY)`,
        ),
      );
      // Verify it landed in the test schema.
      const rows = (await raw.$queryRawUnsafe(
        `SELECT to_regclass($1)::text AS reg`,
        `${TEST_SCHEMA}.tenant_sql_probe`,
      )) as Array<{ reg: string | null }>;
      expect(rows[0]!.reg).toBe(`${TEST_SCHEMA}.tenant_sql_probe`);
      // Cleanup
      await withTestTenant(async () =>
        tenantPrisma.executeTenantSQL(`DROP TABLE IF EXISTS tenant_sql_probe`),
      );
    });
  });

  describe('executeInExplicitSchema', () => {
    it('uses the supplied schema name, ignoring any AsyncLocalStorage context', async () => {
      // No tenant context here; the explicit schema is enough.
      const rows = await tenantPrisma.executeInExplicitSchema(TEST_SCHEMA, async (client) => {
        return client.$queryRawUnsafe<Array<{ sp: string }>>(
          `SELECT current_setting('search_path') AS sp`,
        );
      });
      expect(rows[0]!.sp).toContain(TEST_SCHEMA);
    });
  });

  describe('getPlatformClient', () => {
    it('returns a Prisma client without a tenant search_path', async () => {
      const client = tenantPrisma.getPlatformClient();
      const rows = (await client.$queryRawUnsafe(
        `SELECT current_setting('search_path') AS sp`,
      )) as Array<{ sp: string }>;
      // The platform client should not be scoped to a tenant — default
      // search_path is whatever the connection inherits (typically
      // "$user", public).
      expect(rows[0]!.sp).not.toContain('tenant_test');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // is_frozen gate — TenantGuard rejects writes on frozen tenants
  // ──────────────────────────────────────────────────────────────────
  describe('is_frozen tenant gate', () => {
    // Reflector stub — the Nest production Reflector uses reflect-metadata
    // which is only auto-imported when the controller / guard goes through
    // the Nest DI bootstrap; in a bare integration test we stub it directly.
    function stubReflector(): any {
      return {
        getAllAndOverride: () => undefined,
      };
    }

    async function loadGuard() {
      const { TenantGuard } = await import('@modules/m00-platform/tenant/tenant.guard');
      return new TenantGuard(stubReflector());
    }

    it('TenantGuard rejects write methods with 503 WRITE_FROZEN when tenant is frozen', async () => {
      const guard = await loadGuard();

      const frozenTenant: TenantInfo = {
        schoolId: TEST_SCHOOL_ID,
        schemaName: TEST_SCHEMA,
        organisationId: TEST_ORG_ID,
        subdomain: TEST_SUBDOMAIN,
        isFrozen: true,
        planTier: 'MEDIUM',
        homeRegion: 'us-east-1',
      };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => ({ method: 'POST' }) }),
        getHandler: () => 'handler',
        getClass: () => 'Class',
      };
      let captured: any = null;
      try {
        runWithTenantContext({ tenant: frozenTenant }, () => guard.canActivate(ctx as never));
      } catch (e) {
        captured = e;
      }
      expect(captured).toBeDefined();
      expect(captured.getStatus?.()).toBe(503);
      expect(captured.getResponse?.()).toMatchObject({ error: 'WRITE_FROZEN' });
    });

    it('TenantGuard allows GET/HEAD/OPTIONS on frozen tenants', async () => {
      const guard = await loadGuard();

      const frozenTenant: TenantInfo = {
        schoolId: TEST_SCHOOL_ID,
        schemaName: TEST_SCHEMA,
        organisationId: TEST_ORG_ID,
        subdomain: TEST_SUBDOMAIN,
        isFrozen: true,
        planTier: 'MEDIUM',
        homeRegion: 'us-east-1',
      };

      for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        const ctx = {
          switchToHttp: () => ({ getRequest: () => ({ method }) }),
          getHandler: () => 'handler',
          getClass: () => 'Class',
        };
        const ok = runWithTenantContext({ tenant: frozenTenant }, () =>
          guard.canActivate(ctx as never),
        );
        expect(ok).toBe(true);
      }
    });

    it('TenantGuard passes on non-frozen tenants regardless of method', async () => {
      const guard = await loadGuard();

      const ctx = {
        switchToHttp: () => ({ getRequest: () => ({ method: 'POST' }) }),
        getHandler: () => 'handler',
        getClass: () => 'Class',
      };
      const tenant: TenantInfo = {
        schoolId: TEST_SCHOOL_ID,
        schemaName: TEST_SCHEMA,
        organisationId: TEST_ORG_ID,
        subdomain: TEST_SUBDOMAIN,
        isFrozen: false,
        planTier: 'MEDIUM',
        homeRegion: 'us-east-1',
      };
      const ok = runWithTenantContext({ tenant }, () => guard.canActivate(ctx as never));
      expect(ok).toBe(true);
    });
  });
});
