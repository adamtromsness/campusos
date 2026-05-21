import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';

import { TEST_SCHOOL_ID, TEST_SCHOOL_B_ID } from '../helpers/tenant-context';
import {
  TEST_ADMIN_ACCOUNT_ID,
  TEST_OFFICER_ACCOUNT_ID,
  TEST_TEACHER_ACCOUNT_ID,
  TEST_PARENT_ACCOUNT_ID,
} from '../helpers/actor';

/**
 * Wave 2 — DB-backed integration tests for PermissionCheckService.
 * Replaces apps/api/src/modules/m00-platform/iam/permission-check.service.spec.ts.
 *
 * The hot path on every protected request — checked by @RequirePermission
 * AND by every service that calls assertFinanceAdmin / hasAnyPermissionInTenant.
 * Cache contract (Redis 5-min TTL → iam_effective_access_cache table) is
 * exercised via the table path (no Redis needed — RedisService is optional).
 *
 * Strategy doc Wave 2 contracts:
 *   - Direct permission check via cached codes
 *   - Inherited platform→school scope chain (school scope first, platform fallback)
 *   - Cross-school: code held at School A scope does NOT satisfy School B request
 *   - Platform Admin (only PLATFORM-scope assignment) satisfies any school request
 *   - resolveScopeChain returns [school, platform] in correct order
 *   - resolvePlatformScope returns only the PLATFORM scope (used by
 *     @PlatformScoped() routes — school admins cannot piggy-back)
 */
describe('integration:m00-platform/permission-resolution', () => {
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;

  beforeAll(async () => {
    rawClient = new PrismaClient();
    await rawClient.$connect();
    // No Redis — service treats it as optional. The cache lookup falls
    // straight through to iam_effective_access_cache.
    permCheck = new PermissionCheckService(rawClient);
  });

  afterAll(async () => {
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Wipe any iam_effective_access_cache rows the prior test seeded for
    // the test actors. Production cache rows for other accounts (e.g.
    // demo seed) are left alone.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = ANY($1::uuid[])`,
      [
        TEST_ADMIN_ACCOUNT_ID,
        TEST_OFFICER_ACCOUNT_ID,
        TEST_TEACHER_ACCOUNT_ID,
        TEST_PARENT_ACCOUNT_ID,
      ],
    );
  });

  /**
   * Resolve a fresh iam_scope id for the given school (or PLATFORM if
   * schoolId is null). Used to seed cache rows.
   */
  async function lookupScopeId(opts: { schoolId?: string }): Promise<string> {
    if (opts.schoolId) {
      const rows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT s.id::text AS id FROM platform.iam_scope s
           JOIN platform.iam_scope_type st ON st.id = s.scope_type_id
          WHERE s.entity_id = $1::uuid AND st.code = 'SCHOOL' AND s.is_active = true`,
        opts.schoolId,
      );
      if (rows.length === 0) throw new Error('No SCHOOL scope for ' + opts.schoolId);
      return rows[0]!.id;
    }
    const rows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT s.id::text AS id FROM platform.iam_scope s
         JOIN platform.iam_scope_type st ON st.id = s.scope_type_id
        WHERE st.code = 'PLATFORM' AND s.is_active = true LIMIT 1`,
    );
    if (rows.length === 0) throw new Error('No PLATFORM scope seeded');
    return rows[0]!.id;
  }

  async function seedCacheRow(opts: {
    accountId: string;
    scopeId: string;
    codes: string[];
  }): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      opts.accountId,
      opts.scopeId,
      opts.codes,
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // resolveScopeChain + resolvePlatformScope
  // ────────────────────────────────────────────────────────────────────
  describe('scope resolution', () => {
    it('resolveScopeChain returns [SCHOOL, PLATFORM] for a school request', async () => {
      const chain = await permCheck.resolveScopeChain(TEST_SCHOOL_ID);
      expect(chain).toHaveLength(2);

      const schoolScopeId = await lookupScopeId({ schoolId: TEST_SCHOOL_ID });
      const platformScopeId = await lookupScopeId({});
      expect(chain[0]).toBe(schoolScopeId);
      expect(chain[1]).toBe(platformScopeId);
    });

    it('resolveScopeChain returns [PLATFORM] when no SCHOOL scope exists for the school', async () => {
      const chain = await permCheck.resolveScopeChain('00000000-0000-0000-0000-000000000001');
      const platformScopeId = await lookupScopeId({});
      expect(chain).toEqual([platformScopeId]);
    });

    it('resolvePlatformScope returns the PLATFORM scope id', async () => {
      const id = await permCheck.resolvePlatformScope();
      const platformScopeId = await lookupScopeId({});
      expect(id).toBe(platformScopeId);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // hasPermission / hasAnyPermission / getPermissions
  // ────────────────────────────────────────────────────────────────────
  describe('hasPermission (direct cache lookup)', () => {
    it('returns true when the cache row contains the code', async () => {
      const schoolScope = await lookupScopeId({ schoolId: TEST_SCHOOL_ID });
      await seedCacheRow({
        accountId: TEST_TEACHER_ACCOUNT_ID,
        scopeId: schoolScope,
        codes: ['att-001:read', 'tch-003:read'],
      });
      const ok = await permCheck.hasPermission(
        TEST_TEACHER_ACCOUNT_ID,
        schoolScope,
        'att-001:read',
      );
      expect(ok).toBe(true);
    });

    it('returns false when the cache row does NOT contain the code', async () => {
      const schoolScope = await lookupScopeId({ schoolId: TEST_SCHOOL_ID });
      await seedCacheRow({
        accountId: TEST_TEACHER_ACCOUNT_ID,
        scopeId: schoolScope,
        codes: ['att-001:read'],
      });
      const ok = await permCheck.hasPermission(
        TEST_TEACHER_ACCOUNT_ID,
        schoolScope,
        'fin-005:admin',
      );
      expect(ok).toBe(false);
    });

    it('returns false when NO cache row exists (missing assignment)', async () => {
      const schoolScope = await lookupScopeId({ schoolId: TEST_SCHOOL_ID });
      const ok = await permCheck.hasPermission(
        TEST_OFFICER_ACCOUNT_ID,
        schoolScope,
        'att-001:read',
      );
      expect(ok).toBe(false);
    });
  });

  describe('hasAnyPermission', () => {
    it('returns true when ANY of the requested codes is in the cache row', async () => {
      const schoolScope = await lookupScopeId({ schoolId: TEST_SCHOOL_ID });
      await seedCacheRow({
        accountId: TEST_TEACHER_ACCOUNT_ID,
        scopeId: schoolScope,
        codes: ['att-001:read'],
      });
      const ok = await permCheck.hasAnyPermission(TEST_TEACHER_ACCOUNT_ID, schoolScope, [
        'fin-005:admin',
        'att-001:read',
      ]);
      expect(ok).toBe(true);
    });

    it('returns false when NONE of the requested codes is in the cache row', async () => {
      const schoolScope = await lookupScopeId({ schoolId: TEST_SCHOOL_ID });
      await seedCacheRow({
        accountId: TEST_TEACHER_ACCOUNT_ID,
        scopeId: schoolScope,
        codes: ['att-001:read'],
      });
      const ok = await permCheck.hasAnyPermission(TEST_TEACHER_ACCOUNT_ID, schoolScope, [
        'fin-005:admin',
        'fin-006:write',
      ]);
      expect(ok).toBe(false);
    });

    it('returns false on empty codes list', async () => {
      const schoolScope = await lookupScopeId({ schoolId: TEST_SCHOOL_ID });
      const ok = await permCheck.hasAnyPermission(TEST_TEACHER_ACCOUNT_ID, schoolScope, []);
      expect(ok).toBe(false);
    });
  });

  describe('getPermissions', () => {
    it('returns the full cached codes list', async () => {
      const schoolScope = await lookupScopeId({ schoolId: TEST_SCHOOL_ID });
      await seedCacheRow({
        accountId: TEST_OFFICER_ACCOUNT_ID,
        scopeId: schoolScope,
        codes: ['fin-005:read', 'fin-006:read', 'fin-005:write'],
      });
      const codes = await permCheck.getPermissions(TEST_OFFICER_ACCOUNT_ID, schoolScope);
      expect(codes.sort()).toEqual(['fin-005:read', 'fin-005:write', 'fin-006:read']);
    });

    it('returns empty array when no cache row exists', async () => {
      const schoolScope = await lookupScopeId({ schoolId: TEST_SCHOOL_ID });
      const codes = await permCheck.getPermissions(TEST_OFFICER_ACCOUNT_ID, schoolScope);
      expect(codes).toEqual([]);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // hasAnyPermissionInTenant — KEYSTONE scope inheritance + cross-school
  // ────────────────────────────────────────────────────────────────────
  describe('hasAnyPermissionInTenant (scope chain SCHOOL → PLATFORM)', () => {
    it('SCHOOL-scoped code satisfies the tenant check (no PLATFORM lookup needed)', async () => {
      const schoolScope = await lookupScopeId({ schoolId: TEST_SCHOOL_ID });
      await seedCacheRow({
        accountId: TEST_OFFICER_ACCOUNT_ID,
        scopeId: schoolScope,
        codes: ['fin-005:write'],
      });
      const ok = await permCheck.hasAnyPermissionInTenant(TEST_OFFICER_ACCOUNT_ID, TEST_SCHOOL_ID, [
        'fin-005:write',
      ]);
      expect(ok).toBe(true);
    });

    it('PLATFORM-scoped code satisfies the tenant check (inheritance — platform admin path)', async () => {
      // Seed ONLY a PLATFORM-scope cache row; no SCHOOL-scope assignment.
      const platformScope = await lookupScopeId({});
      await seedCacheRow({
        accountId: TEST_ADMIN_ACCOUNT_ID,
        scopeId: platformScope,
        codes: ['fin-005:admin'],
      });
      // Calling for ANY school — both should pass because PLATFORM scope
      // is in the chain.
      const okA = await permCheck.hasAnyPermissionInTenant(TEST_ADMIN_ACCOUNT_ID, TEST_SCHOOL_ID, [
        'fin-005:admin',
      ]);
      const okB = await permCheck.hasAnyPermissionInTenant(
        TEST_ADMIN_ACCOUNT_ID,
        TEST_SCHOOL_B_ID,
        ['fin-005:admin'],
      );
      expect(okA).toBe(true);
      expect(okB).toBe(true);
    });

    it('CROSS-SCHOOL: a code held at School A SCHOOL scope does NOT satisfy a School B tenant check', async () => {
      const schoolAScope = await lookupScopeId({ schoolId: TEST_SCHOOL_ID });
      await seedCacheRow({
        accountId: TEST_OFFICER_ACCOUNT_ID,
        scopeId: schoolAScope,
        codes: ['fin-005:write'],
      });
      const okA = await permCheck.hasAnyPermissionInTenant(
        TEST_OFFICER_ACCOUNT_ID,
        TEST_SCHOOL_ID,
        ['fin-005:write'],
      );
      expect(okA).toBe(true); // School A check matches the SCHOOL-A cache row

      const okB = await permCheck.hasAnyPermissionInTenant(
        TEST_OFFICER_ACCOUNT_ID,
        TEST_SCHOOL_B_ID,
        ['fin-005:write'],
      );
      expect(okB).toBe(false); // School B's scope chain doesn't include SCHOOL-A
    });

    it('returns false when no code is present in either SCHOOL or PLATFORM scope rows', async () => {
      const schoolScope = await lookupScopeId({ schoolId: TEST_SCHOOL_ID });
      await seedCacheRow({
        accountId: TEST_TEACHER_ACCOUNT_ID,
        scopeId: schoolScope,
        codes: ['att-001:read'],
      });
      const ok = await permCheck.hasAnyPermissionInTenant(TEST_TEACHER_ACCOUNT_ID, TEST_SCHOOL_ID, [
        'fin-005:admin',
        'fin-006:admin',
      ]);
      expect(ok).toBe(false);
    });

    it('SCHOOL-scope ANY-OF: requests with one matching code return true', async () => {
      const schoolScope = await lookupScopeId({ schoolId: TEST_SCHOOL_ID });
      await seedCacheRow({
        accountId: TEST_OFFICER_ACCOUNT_ID,
        scopeId: schoolScope,
        codes: ['fin-005:read'],
      });
      const ok = await permCheck.hasAnyPermissionInTenant(TEST_OFFICER_ACCOUNT_ID, TEST_SCHOOL_ID, [
        'fin-005:read',
        'fin-005:write',
        'fin-005:admin',
      ]);
      expect(ok).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // invalidate (best-effort no-op when Redis is absent)
  // ────────────────────────────────────────────────────────────────────
  describe('invalidate', () => {
    it('does not throw when Redis is absent (best-effort no-op)', async () => {
      const schoolScope = await lookupScopeId({ schoolId: TEST_SCHOOL_ID });
      await expect(
        permCheck.invalidate(TEST_OFFICER_ACCOUNT_ID, schoolScope),
      ).resolves.toBeUndefined();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cache-row semantics
  // ────────────────────────────────────────────────────────────────────
  describe('iam_effective_access_cache row semantics', () => {
    it('changing the cache row changes the answer on the next call (no in-memory cache when Redis absent)', async () => {
      const schoolScope = await lookupScopeId({ schoolId: TEST_SCHOOL_ID });
      await seedCacheRow({
        accountId: TEST_OFFICER_ACCOUNT_ID,
        scopeId: schoolScope,
        codes: ['fin-005:read'],
      });
      expect(
        await permCheck.hasPermission(TEST_OFFICER_ACCOUNT_ID, schoolScope, 'fin-005:read'),
      ).toBe(true);

      // Drop the code from the cache row
      await seedCacheRow({
        accountId: TEST_OFFICER_ACCOUNT_ID,
        scopeId: schoolScope,
        codes: ['fin-006:read'],
      });
      expect(
        await permCheck.hasPermission(TEST_OFFICER_ACCOUNT_ID, schoolScope, 'fin-005:read'),
      ).toBe(false);
    });

    it('UNIQUE(account_id, scope_id) prevents duplicate cache rows', async () => {
      const schoolScope = await lookupScopeId({ schoolId: TEST_SCHOOL_ID });
      await seedCacheRow({
        accountId: TEST_OFFICER_ACCOUNT_ID,
        scopeId: schoolScope,
        codes: ['a'],
      });
      await seedCacheRow({
        accountId: TEST_OFFICER_ACCOUNT_ID,
        scopeId: schoolScope,
        codes: ['b', 'c'],
      });
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid AND scope_id = $2::uuid`,
        TEST_OFFICER_ACCOUNT_ID,
        schoolScope,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(1);
      const codes = await permCheck.getPermissions(TEST_OFFICER_ACCOUNT_ID, schoolScope);
      expect(codes.sort()).toEqual(['b', 'c']);
    });
  });
});
