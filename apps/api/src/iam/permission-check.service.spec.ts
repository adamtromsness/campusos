import { describe, it, expect } from 'vitest';
import { PermissionCheckService } from './permission-check.service';

/**
 * P2-H4 test coverage uplift — permission-check.service.ts (178 LOC,
 * critical-path Tier 2 ≥95%).
 *
 * The hot-path permission lookup hit by every @RequirePermission gate.
 * Per ADR-036, direct JOINs across role_assignment→role→permission are
 * FORBIDDEN on the request path — only the iam_effective_access_cache
 * (and its Redis layer) may be read.
 *
 * Cycle 31 Step 6 introduced Redis caching at iam:access:{accountId}:{scopeId}
 * with a 5-minute TTL. The cache miss path falls back to the DB row.
 * REVIEW-CYCLE31 BLOCKING 2 added resolvePlatformScope for @PlatformScoped
 * routes.
 *
 * REVIEW-CYCLE2 fix: hasAnyPermissionInTenant was introduced to replace the
 * broken cross-scope helper that let a Platform Admin or a school A teacher
 * activate admin behaviour while serving a school B request.
 */

interface PrismaStub {
  cacheRows: Array<{ accountId: string; scopeId: string; permissionCodes: string[] }>;
  scopes: Array<{ id: string; entityId?: string; scopeTypeCode: string; isActive: boolean }>;
  cacheReads: number;
  scopeReads: number;
}

function makePrisma(stub: Partial<PrismaStub> = {}) {
  const state: PrismaStub = {
    cacheRows: stub.cacheRows ?? [],
    scopes: stub.scopes ?? [],
    cacheReads: 0,
    scopeReads: 0,
  };
  const prisma = {
    iamEffectiveAccessCache: {
      findUnique: async (args: {
        where: { accountId_scopeId: { accountId: string; scopeId: string } };
      }) => {
        state.cacheReads += 1;
        const { accountId, scopeId } = args.where.accountId_scopeId;
        return (
          state.cacheRows.find((r) => r.accountId === accountId && r.scopeId === scopeId) ?? null
        );
      },
    },
    iamScope: {
      findFirst: async (args: {
        where: { entityId?: string; scopeType: { code: string }; isActive: boolean };
      }) => {
        state.scopeReads += 1;
        const wanted = args.where;
        return (
          state.scopes.find(
            (s) =>
              s.scopeTypeCode === wanted.scopeType.code &&
              s.isActive === wanted.isActive &&
              (wanted.entityId === undefined || s.entityId === wanted.entityId),
          ) ?? null
        );
      },
    },
  };
  return { prisma, state };
}

interface RedisStub {
  store: Map<string, unknown>;
  gets: number;
  sets: number;
  invalidations: number;
  cacheGet: <T>(key: string) => Promise<T | null>;
  cacheSet: <T>(key: string, value: T, ttl: number) => Promise<void>;
  cacheInvalidate: (key: string) => Promise<void>;
}

function makeRedis(initial: Record<string, unknown> = {}): RedisStub {
  const stub: RedisStub = {
    store: new Map(Object.entries(initial)),
    gets: 0,
    sets: 0,
    invalidations: 0,
    cacheGet: async <T>(key: string) => {
      stub.gets += 1;
      return stub.store.has(key) ? (stub.store.get(key) as T) : null;
    },
    cacheSet: async <T>(key: string, value: T) => {
      stub.sets += 1;
      stub.store.set(key, value);
    },
    cacheInvalidate: async (key: string) => {
      stub.invalidations += 1;
      stub.store.delete(key);
    },
  };
  return stub;
}

function makeMetrics() {
  const hits: string[] = [];
  const misses: string[] = [];
  return {
    metrics: {
      redisCacheHits: { labels: (l: string) => ({ inc: () => hits.push(l) }) },
      redisCacheMisses: { labels: (l: string) => ({ inc: () => misses.push(l) }) },
    },
    hits,
    misses,
  };
}

const ACCOUNT = 'acct-1';
const SCHOOL_SCOPE = 'school-scope-1';
const PLATFORM_SCOPE = 'platform-scope-1';

describe('PermissionCheckService.loadEffectiveCodes (via hasPermission)', () => {
  it('returns codes from DB when no Redis is configured', async () => {
    const { prisma, state } = makePrisma({
      cacheRows: [
        {
          accountId: ACCOUNT,
          scopeId: SCHOOL_SCOPE,
          permissionCodes: ['att-001:read', 'att-001:write'],
        },
      ],
    });
    const svc = new PermissionCheckService(prisma as never);
    expect(await svc.hasPermission(ACCOUNT, SCHOOL_SCOPE, 'att-001:write')).toBe(true);
    expect(await svc.hasPermission(ACCOUNT, SCHOOL_SCOPE, 'att-001:admin')).toBe(false);
    expect(state.cacheReads).toBe(2);
  });

  it('returns false when the DB row does not exist', async () => {
    const { prisma } = makePrisma({ cacheRows: [] });
    const svc = new PermissionCheckService(prisma as never);
    expect(await svc.hasPermission(ACCOUNT, SCHOOL_SCOPE, 'att-001:write')).toBe(false);
  });

  it('reads from Redis cache and skips the DB on a hit', async () => {
    const { prisma, state } = makePrisma();
    const redis = makeRedis({
      [`iam:access:${ACCOUNT}:${SCHOOL_SCOPE}`]: ['att-001:write'],
    });
    const m = makeMetrics();
    const svc = new PermissionCheckService(prisma as never, redis as never, m.metrics as never);
    expect(await svc.hasPermission(ACCOUNT, SCHOOL_SCOPE, 'att-001:write')).toBe(true);
    expect(redis.gets).toBe(1);
    expect(state.cacheReads).toBe(0);
    expect(m.hits).toEqual(['iam_access']);
    expect(m.misses).toEqual([]);
  });

  it('on cache miss: reads DB, then writes back to Redis with 5-min TTL', async () => {
    const { prisma, state } = makePrisma({
      cacheRows: [
        { accountId: ACCOUNT, scopeId: SCHOOL_SCOPE, permissionCodes: ['att-001:write'] },
      ],
    });
    const redis = makeRedis();
    const m = makeMetrics();
    const svc = new PermissionCheckService(prisma as never, redis as never, m.metrics as never);
    expect(await svc.hasPermission(ACCOUNT, SCHOOL_SCOPE, 'att-001:write')).toBe(true);
    expect(redis.gets).toBe(1);
    expect(state.cacheReads).toBe(1);
    expect(redis.sets).toBe(1);
    expect(redis.store.get(`iam:access:${ACCOUNT}:${SCHOOL_SCOPE}`)).toEqual(['att-001:write']);
    expect(m.misses).toEqual(['iam_access']);
    expect(m.hits).toEqual([]);
  });

  it('caches empty-codes result on a DB miss (negative cache)', async () => {
    const { prisma } = makePrisma({ cacheRows: [] });
    const redis = makeRedis();
    const svc = new PermissionCheckService(prisma as never, redis as never);
    await svc.hasPermission(ACCOUNT, SCHOOL_SCOPE, 'att-001:write');
    expect(redis.store.get(`iam:access:${ACCOUNT}:${SCHOOL_SCOPE}`)).toEqual([]);
  });
});

describe('PermissionCheckService.hasAnyPermission', () => {
  it('returns true when ANY of the requested codes is held', async () => {
    const { prisma } = makePrisma({
      cacheRows: [
        { accountId: ACCOUNT, scopeId: SCHOOL_SCOPE, permissionCodes: ['att-001:write'] },
      ],
    });
    const svc = new PermissionCheckService(prisma as never);
    const result = await svc.hasAnyPermission(ACCOUNT, SCHOOL_SCOPE, [
      'att-001:admin',
      'att-001:write',
    ]);
    expect(result).toBe(true);
  });

  it('returns false when none of the requested codes is held', async () => {
    const { prisma } = makePrisma({
      cacheRows: [{ accountId: ACCOUNT, scopeId: SCHOOL_SCOPE, permissionCodes: ['att-001:read'] }],
    });
    const svc = new PermissionCheckService(prisma as never);
    const result = await svc.hasAnyPermission(ACCOUNT, SCHOOL_SCOPE, [
      'att-001:admin',
      'att-001:write',
    ]);
    expect(result).toBe(false);
  });

  it('returns false for an empty permissions array', async () => {
    const { prisma } = makePrisma({
      cacheRows: [{ accountId: ACCOUNT, scopeId: SCHOOL_SCOPE, permissionCodes: ['att-001:read'] }],
    });
    const svc = new PermissionCheckService(prisma as never);
    expect(await svc.hasAnyPermission(ACCOUNT, SCHOOL_SCOPE, [])).toBe(false);
  });
});

describe('PermissionCheckService.getPermissions', () => {
  it('returns the full code list for the (account, scope) pair', async () => {
    const { prisma } = makePrisma({
      cacheRows: [
        {
          accountId: ACCOUNT,
          scopeId: SCHOOL_SCOPE,
          permissionCodes: ['att-001:read', 'att-001:write'],
        },
      ],
    });
    const svc = new PermissionCheckService(prisma as never);
    expect(await svc.getPermissions(ACCOUNT, SCHOOL_SCOPE)).toEqual([
      'att-001:read',
      'att-001:write',
    ]);
  });

  it('returns [] when no row exists', async () => {
    const { prisma } = makePrisma({ cacheRows: [] });
    const svc = new PermissionCheckService(prisma as never);
    expect(await svc.getPermissions(ACCOUNT, SCHOOL_SCOPE)).toEqual([]);
  });
});

describe('PermissionCheckService.invalidate', () => {
  it('drops the Redis key for the (account, scope) pair', async () => {
    const redis = makeRedis({
      [`iam:access:${ACCOUNT}:${SCHOOL_SCOPE}`]: ['att-001:write'],
    });
    const svc = new PermissionCheckService(makePrisma().prisma as never, redis as never);
    await svc.invalidate(ACCOUNT, SCHOOL_SCOPE);
    expect(redis.invalidations).toBe(1);
    expect(redis.store.has(`iam:access:${ACCOUNT}:${SCHOOL_SCOPE}`)).toBe(false);
  });

  it('is a no-op when Redis is not configured', async () => {
    const svc = new PermissionCheckService(makePrisma().prisma as never);
    await expect(svc.invalidate(ACCOUNT, SCHOOL_SCOPE)).resolves.toBeUndefined();
  });
});

describe('PermissionCheckService.resolveScopeChain', () => {
  it('returns [school, platform] when both scopes exist', async () => {
    const { prisma } = makePrisma({
      scopes: [
        { id: SCHOOL_SCOPE, entityId: 'school-1', scopeTypeCode: 'SCHOOL', isActive: true },
        { id: PLATFORM_SCOPE, scopeTypeCode: 'PLATFORM', isActive: true },
      ],
    });
    const svc = new PermissionCheckService(prisma as never);
    const ids = await svc.resolveScopeChain('school-1');
    expect(ids).toEqual([SCHOOL_SCOPE, PLATFORM_SCOPE]);
  });

  it('returns [platform] when the school has no scope row (e.g. unprovisioned)', async () => {
    const { prisma } = makePrisma({
      scopes: [{ id: PLATFORM_SCOPE, scopeTypeCode: 'PLATFORM', isActive: true }],
    });
    const svc = new PermissionCheckService(prisma as never);
    expect(await svc.resolveScopeChain('school-1')).toEqual([PLATFORM_SCOPE]);
  });

  it('returns [school] when the platform scope row is inactive / missing', async () => {
    const { prisma } = makePrisma({
      scopes: [{ id: SCHOOL_SCOPE, entityId: 'school-1', scopeTypeCode: 'SCHOOL', isActive: true }],
    });
    const svc = new PermissionCheckService(prisma as never);
    expect(await svc.resolveScopeChain('school-1')).toEqual([SCHOOL_SCOPE]);
  });

  it('returns [] when neither scope is configured', async () => {
    const { prisma } = makePrisma({ scopes: [] });
    const svc = new PermissionCheckService(prisma as never);
    expect(await svc.resolveScopeChain('school-1')).toEqual([]);
  });
});

describe('PermissionCheckService.resolvePlatformScope (REVIEW-CYCLE31 BLOCKING 2)', () => {
  it('returns the active platform scope id', async () => {
    const { prisma } = makePrisma({
      scopes: [{ id: PLATFORM_SCOPE, scopeTypeCode: 'PLATFORM', isActive: true }],
    });
    const svc = new PermissionCheckService(prisma as never);
    expect(await svc.resolvePlatformScope()).toBe(PLATFORM_SCOPE);
  });

  it('returns null when no active platform scope exists', async () => {
    const { prisma } = makePrisma({ scopes: [] });
    const svc = new PermissionCheckService(prisma as never);
    expect(await svc.resolvePlatformScope()).toBeNull();
  });
});

describe('PermissionCheckService.hasAnyPermissionInTenant (REVIEW-CYCLE2 fix)', () => {
  it('walks SCHOOL then PLATFORM and short-circuits on the first scope that grants', async () => {
    const { prisma } = makePrisma({
      cacheRows: [
        { accountId: ACCOUNT, scopeId: SCHOOL_SCOPE, permissionCodes: ['att-001:write'] },
      ],
      scopes: [
        { id: SCHOOL_SCOPE, entityId: 'school-1', scopeTypeCode: 'SCHOOL', isActive: true },
        { id: PLATFORM_SCOPE, scopeTypeCode: 'PLATFORM', isActive: true },
      ],
    });
    const svc = new PermissionCheckService(prisma as never);
    expect(await svc.hasAnyPermissionInTenant(ACCOUNT, 'school-1', ['att-001:write'])).toBe(true);
  });

  it('inherits PLATFORM admin permission when the SCHOOL scope misses', async () => {
    const { prisma } = makePrisma({
      cacheRows: [
        { accountId: ACCOUNT, scopeId: PLATFORM_SCOPE, permissionCodes: ['sys-001:admin'] },
      ],
      scopes: [
        { id: SCHOOL_SCOPE, entityId: 'school-1', scopeTypeCode: 'SCHOOL', isActive: true },
        { id: PLATFORM_SCOPE, scopeTypeCode: 'PLATFORM', isActive: true },
      ],
    });
    const svc = new PermissionCheckService(prisma as never);
    expect(await svc.hasAnyPermissionInTenant(ACCOUNT, 'school-1', ['sys-001:admin'])).toBe(true);
  });

  it('returns false when neither scope grants the requested code (the post-fix safety guarantee)', async () => {
    const { prisma } = makePrisma({
      // permission held at a DIFFERENT scope (e.g. school B) — must NOT leak into school A's request
      cacheRows: [
        { accountId: ACCOUNT, scopeId: 'other-school-scope', permissionCodes: ['att-001:write'] },
      ],
      scopes: [
        { id: SCHOOL_SCOPE, entityId: 'school-1', scopeTypeCode: 'SCHOOL', isActive: true },
        { id: PLATFORM_SCOPE, scopeTypeCode: 'PLATFORM', isActive: true },
      ],
    });
    const svc = new PermissionCheckService(prisma as never);
    expect(await svc.hasAnyPermissionInTenant(ACCOUNT, 'school-1', ['att-001:write'])).toBe(false);
  });

  it('returns false when the school has no scope row at all', async () => {
    const { prisma } = makePrisma({ scopes: [] });
    const svc = new PermissionCheckService(prisma as never);
    expect(await svc.hasAnyPermissionInTenant(ACCOUNT, 'school-1', ['att-001:write'])).toBe(false);
  });
});
