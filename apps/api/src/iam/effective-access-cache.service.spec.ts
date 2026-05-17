import { describe, it, expect } from 'vitest';
import { EffectiveAccessCacheService } from './effective-access-cache.service';

/**
 * P2-H4 test coverage uplift — effective-access-cache.service.ts (148 LOC,
 * critical-path Tier 2 ≥95%).
 *
 * EffectiveAccessCacheService maintains iam_effective_access_cache, the
 * authoritative read source for PermissionGuard. Rebuilds collect:
 *   1. The scope hierarchy (this scope + all ancestors via parent_scope_id)
 *   2. Active iam_role_assignment rows in those scopes (effectiveFrom <= now,
 *      effectiveTo NULL or > now)
 *   3. Permission codes for the union of role ids
 *   4. SHA-256 versionHash of assignment ids for staleness detection
 *   5. UPSERT on (accountId, scopeId) composite key
 *
 * When no active assignments are found, the row is DELETEd so the cache is
 * empty rather than stale.
 */

interface PrismaCalls {
  scopeFindUnique: Array<{ where: { id: string }; select: { parentScopeId: boolean } }>;
  assignmentFindMany: Array<{
    where: Record<string, unknown>;
    select?: Record<string, unknown>;
    distinct?: unknown;
  }>;
  rolePermissionFindMany: Array<{ where: { roleId: { in: string[] } }; include: unknown }>;
  cacheUpsert: Array<{
    where: Record<string, unknown>;
    update: Record<string, unknown>;
    create: Record<string, unknown>;
  }>;
  cacheDeleteMany: Array<{ where: { accountId: string; scopeId: string } }>;
}

function makePrisma(
  opts: {
    scopes?: Array<{ id: string; parentScopeId: string | null }>;
    assignments?: Array<{ id: string; roleId: string; scopeId: string; status: string }>;
    rolePerms?: Array<{ roleId: string; permission: { code: string } }>;
  } = {},
) {
  const calls: PrismaCalls = {
    scopeFindUnique: [],
    assignmentFindMany: [],
    rolePermissionFindMany: [],
    cacheUpsert: [],
    cacheDeleteMany: [],
  };
  const prisma = {
    iamScope: {
      findUnique: async (args: { where: { id: string }; select: { parentScopeId: boolean } }) => {
        calls.scopeFindUnique.push(args);
        return (opts.scopes ?? []).find((s) => s.id === args.where.id) ?? null;
      },
    },
    iamRoleAssignment: {
      findMany: async (args: {
        where: { scopeId?: { in: string[] } } & Record<string, unknown>;
        select?: Record<string, unknown>;
        distinct?: unknown;
      }) => {
        calls.assignmentFindMany.push(args);
        const scopeFilter = (args.where.scopeId as { in: string[] } | undefined)?.in;
        const filtered = (opts.assignments ?? []).filter(
          (a) => !scopeFilter || scopeFilter.includes(a.scopeId),
        );
        if (args.distinct) {
          // Distinct by scopeId
          const seen = new Set<string>();
          return filtered.filter((a) =>
            seen.has(a.scopeId) ? false : (seen.add(a.scopeId), true),
          );
        }
        return filtered;
      },
    },
    rolePermission: {
      findMany: async (args: { where: { roleId: { in: string[] } }; include: unknown }) => {
        calls.rolePermissionFindMany.push(args);
        return (opts.rolePerms ?? []).filter((rp) => args.where.roleId.in.includes(rp.roleId));
      },
    },
    iamEffectiveAccessCache: {
      upsert: async (args: {
        where: Record<string, unknown>;
        update: Record<string, unknown>;
        create: Record<string, unknown>;
      }) => {
        calls.cacheUpsert.push(args);
        return args.create;
      },
      deleteMany: async (args: { where: { accountId: string; scopeId: string } }) => {
        calls.cacheDeleteMany.push(args);
        return { count: 1 };
      },
    },
  };
  return { prisma, calls };
}

describe('EffectiveAccessCacheService.rebuildCache', () => {
  it('walks the scope hierarchy (parent_scope_id) up to the root', async () => {
    const { prisma, calls } = makePrisma({
      scopes: [
        { id: 'scope-school', parentScopeId: 'scope-district' },
        { id: 'scope-district', parentScopeId: 'scope-platform' },
        { id: 'scope-platform', parentScopeId: null },
      ],
    });
    const svc = new EffectiveAccessCacheService(prisma as never);
    await svc.rebuildCache('acct-1', 'scope-school');
    // It queried for each ancestor.
    expect(calls.scopeFindUnique.length).toBeGreaterThanOrEqual(3);
    expect(calls.scopeFindUnique[0].where.id).toBe('scope-school');
    // The assignments query unions all hierarchy scope ids.
    const scopeFilter = (calls.assignmentFindMany[0].where.scopeId as { in: string[] }).in;
    expect(scopeFilter).toEqual(['scope-school', 'scope-district', 'scope-platform']);
  });

  it('breaks the hierarchy walk at root (parent_scope_id=null)', async () => {
    const { prisma, calls } = makePrisma({
      scopes: [{ id: 'scope-isolated', parentScopeId: null }],
    });
    const svc = new EffectiveAccessCacheService(prisma as never);
    await svc.rebuildCache('acct-1', 'scope-isolated');
    expect(calls.scopeFindUnique).toHaveLength(1);
    const scopeFilter = (calls.assignmentFindMany[0].where.scopeId as { in: string[] }).in;
    expect(scopeFilter).toEqual(['scope-isolated']);
  });

  it('treats a missing iam_scope row the same as root (no ancestors)', async () => {
    const { prisma, calls } = makePrisma({ scopes: [] });
    const svc = new EffectiveAccessCacheService(prisma as never);
    await svc.rebuildCache('acct-1', 'scope-orphan');
    const scopeFilter = (calls.assignmentFindMany[0].where.scopeId as { in: string[] }).in;
    expect(scopeFilter).toEqual(['scope-orphan']);
  });

  it('caps hierarchy depth at 10 (loop safety)', async () => {
    // Build a 15-deep parent chain — only the first 10 hops + start scope should land in scopeIds.
    const scopes = Array.from({ length: 15 }).map((_, i) => ({
      id: `scope-${i}`,
      parentScopeId: i < 14 ? `scope-${i + 1}` : null,
    }));
    const { prisma, calls } = makePrisma({ scopes });
    const svc = new EffectiveAccessCacheService(prisma as never);
    await svc.rebuildCache('acct-1', 'scope-0');
    expect(calls.scopeFindUnique).toHaveLength(10);
    const scopeFilter = (calls.assignmentFindMany[0].where.scopeId as { in: string[] }).in;
    // start scope + up to 10 parents = 11 entries (first ten walks pushed parent_scope_ids 1..10)
    expect(scopeFilter.length).toBe(11);
    expect(scopeFilter[0]).toBe('scope-0');
  });

  it('DELETEs the cache row when no active assignments exist', async () => {
    const { prisma, calls } = makePrisma({ assignments: [] });
    const svc = new EffectiveAccessCacheService(prisma as never);
    const result = await svc.rebuildCache('acct-1', 'scope-1');
    expect(result).toEqual([]);
    expect(calls.cacheDeleteMany).toHaveLength(1);
    expect(calls.cacheDeleteMany[0].where).toEqual({ accountId: 'acct-1', scopeId: 'scope-1' });
    expect(calls.cacheUpsert).toHaveLength(0);
  });

  it('UPSERTs the cache row with the sorted, deduplicated union of permission codes', async () => {
    const { prisma, calls } = makePrisma({
      assignments: [
        { id: 'a-1', roleId: 'role-teacher', scopeId: 'scope-school', status: 'ACTIVE' },
        { id: 'a-2', roleId: 'role-admin', scopeId: 'scope-school', status: 'ACTIVE' },
        // Duplicate role assignment (same role at a different scope chain) — dedupes
        { id: 'a-3', roleId: 'role-teacher', scopeId: 'scope-school', status: 'ACTIVE' },
      ],
      rolePerms: [
        { roleId: 'role-teacher', permission: { code: 'att-001:write' } },
        { roleId: 'role-teacher', permission: { code: 'tch-001:read' } },
        { roleId: 'role-admin', permission: { code: 'sch-001:admin' } },
        { roleId: 'role-admin', permission: { code: 'att-001:write' } }, // dup across roles
      ],
    });
    const svc = new EffectiveAccessCacheService(prisma as never);
    const result = await svc.rebuildCache('acct-1', 'scope-school');
    // Sorted, deduped union.
    expect(result).toEqual(['att-001:write', 'sch-001:admin', 'tch-001:read']);
    expect(calls.cacheUpsert).toHaveLength(1);
    const args = calls.cacheUpsert[0];
    expect(args.create.permissionCodes).toEqual(['att-001:write', 'sch-001:admin', 'tch-001:read']);
    expect(args.update.permissionCodes).toEqual(['att-001:write', 'sch-001:admin', 'tch-001:read']);
    expect(typeof args.create.assignmentVersionHash).toBe('string');
    // SHA-256 hex = 64 chars
    expect((args.create.assignmentVersionHash as string).length).toBe(64);
  });

  it('produces a STABLE versionHash for the same assignment set regardless of input order', async () => {
    const baseRolePerms = [
      { roleId: 'role-teacher', permission: { code: 'att-001:write' } },
      { roleId: 'role-admin', permission: { code: 'sch-001:admin' } },
    ];
    const assignmentsA = [
      { id: 'a-1', roleId: 'role-teacher', scopeId: 'scope-school', status: 'ACTIVE' },
      { id: 'a-2', roleId: 'role-admin', scopeId: 'scope-school', status: 'ACTIVE' },
    ];
    const assignmentsB = [...assignmentsA].reverse();
    const r1 = makePrisma({ assignments: assignmentsA, rolePerms: baseRolePerms });
    const r2 = makePrisma({ assignments: assignmentsB, rolePerms: baseRolePerms });
    const svc1 = new EffectiveAccessCacheService(r1.prisma as never);
    const svc2 = new EffectiveAccessCacheService(r2.prisma as never);
    await svc1.rebuildCache('acct-1', 'scope-school');
    await svc2.rebuildCache('acct-1', 'scope-school');
    expect(r1.calls.cacheUpsert[0].create.assignmentVersionHash).toBe(
      r2.calls.cacheUpsert[0].create.assignmentVersionHash,
    );
  });

  it('produces a DIFFERENT versionHash when an assignment id changes', async () => {
    const rolePerms = [{ roleId: 'role-1', permission: { code: 'att-001:write' } }];
    const r1 = makePrisma({
      assignments: [{ id: 'a-1', roleId: 'role-1', scopeId: 'scope-1', status: 'ACTIVE' }],
      rolePerms,
    });
    const r2 = makePrisma({
      assignments: [{ id: 'a-2', roleId: 'role-1', scopeId: 'scope-1', status: 'ACTIVE' }],
      rolePerms,
    });
    const svc1 = new EffectiveAccessCacheService(r1.prisma as never);
    const svc2 = new EffectiveAccessCacheService(r2.prisma as never);
    await svc1.rebuildCache('acct-1', 'scope-1');
    await svc2.rebuildCache('acct-1', 'scope-1');
    expect(r1.calls.cacheUpsert[0].create.assignmentVersionHash).not.toBe(
      r2.calls.cacheUpsert[0].create.assignmentVersionHash,
    );
  });

  it('selects all assignments active NOW (effectiveFrom <= now AND (effectiveTo NULL OR > now))', async () => {
    const { prisma, calls } = makePrisma({
      assignments: [{ id: 'a-1', roleId: 'role-1', scopeId: 'scope-1', status: 'ACTIVE' }],
      rolePerms: [{ roleId: 'role-1', permission: { code: 'att-001:write' } }],
    });
    const svc = new EffectiveAccessCacheService(prisma as never);
    await svc.rebuildCache('acct-1', 'scope-1');
    const where = calls.assignmentFindMany[0].where;
    expect(where.accountId).toBe('acct-1');
    expect(where.status).toBe('ACTIVE');
    expect(where.effectiveFrom).toBeDefined();
    expect(where.OR).toBeDefined();
  });
});

describe('EffectiveAccessCacheService.rebuildAllForAccount', () => {
  it('rebuilds the cache for every distinct active scope the account has assignments in', async () => {
    const { prisma, calls } = makePrisma({
      assignments: [
        { id: 'a-1', roleId: 'role-1', scopeId: 'scope-school-1', status: 'ACTIVE' },
        { id: 'a-2', roleId: 'role-2', scopeId: 'scope-platform', status: 'ACTIVE' },
      ],
      rolePerms: [
        { roleId: 'role-1', permission: { code: 'att-001:write' } },
        { roleId: 'role-2', permission: { code: 'sys-001:admin' } },
      ],
    });
    const svc = new EffectiveAccessCacheService(prisma as never);
    await svc.rebuildAllForAccount('acct-1');
    // First findMany (with distinct) selects scopeIds; then rebuildCache fires once per scope.
    expect(calls.cacheUpsert.length).toBe(2);
    const upsertedScopeIds = calls.cacheUpsert.map(
      (u) => (u.where.accountId_scopeId as { scopeId: string }).scopeId,
    );
    expect(upsertedScopeIds).toEqual(expect.arrayContaining(['scope-school-1', 'scope-platform']));
  });

  it('is a no-op when the account has no active assignments', async () => {
    const { prisma, calls } = makePrisma({ assignments: [] });
    const svc = new EffectiveAccessCacheService(prisma as never);
    await svc.rebuildAllForAccount('acct-1');
    expect(calls.cacheUpsert).toHaveLength(0);
  });
});
