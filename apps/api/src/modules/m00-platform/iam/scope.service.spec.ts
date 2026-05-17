import { describe, it, expect } from 'vitest';
import { ScopeService } from './scope.service';

/**
 * P2-H4 test coverage uplift — scope.service.ts (67 LOC, critical-path Tier 2 ≥95%).
 *
 * ScopeService is the catalogue layer over platform.iam_scope. iam_scope rows
 * are the join target for role assignments (iam_role_assignment.scope_id) and
 * are resolved by PermissionCheckService.resolveScopeChain on every request.
 * The service is a thin Prisma wrapper; spec covers:
 *   - createScope: scope-type lookup + scope row creation + parent linkage
 *   - findByEntity: scope-type lookup + composite-key query
 *   - getChildren: parent-id query with isActive filter
 */

function makePrisma(
  opts: {
    scopeTypes?: Array<{ id: string; code: string }>;
    children?: Array<Record<string, unknown>>;
    existingScopes?: Array<Record<string, unknown>>;
  } = {},
) {
  const calls = {
    scopeTypeFindUnique: [] as Array<{ where: { code: string } }>,
    scopeCreate: [] as Array<{ data: Record<string, unknown> }>,
    scopeFindUnique: [] as Array<{
      where: { scopeTypeId_entityId: { scopeTypeId: string; entityId: string } };
    }>,
    scopeFindMany: [] as Array<{
      where: { parentScopeId: string; isActive: boolean };
      include: { scopeType: boolean };
    }>,
  };
  const prisma = {
    iamScopeType: {
      findUnique: async (args: { where: { code: string } }) => {
        calls.scopeTypeFindUnique.push(args);
        return (opts.scopeTypes ?? []).find((t) => t.code === args.where.code) ?? null;
      },
    },
    iamScope: {
      create: async (args: { data: Record<string, unknown> }) => {
        calls.scopeCreate.push(args);
        return args.data;
      },
      findUnique: async (args: {
        where: { scopeTypeId_entityId: { scopeTypeId: string; entityId: string } };
      }) => {
        calls.scopeFindUnique.push(args);
        return (
          (opts.existingScopes ?? []).find(
            (s) =>
              s.scopeTypeId === args.where.scopeTypeId_entityId.scopeTypeId &&
              s.entityId === args.where.scopeTypeId_entityId.entityId,
          ) ?? null
        );
      },
      findMany: async (args: {
        where: { parentScopeId: string; isActive: boolean };
        include: { scopeType: boolean };
      }) => {
        calls.scopeFindMany.push(args);
        return (opts.children ?? []).filter(
          (c) => c.parentScopeId === args.where.parentScopeId && c.isActive === args.where.isActive,
        );
      },
    },
  };
  return { prisma, calls };
}

describe('ScopeService.createScope', () => {
  it('looks up the scope type by code, mints an id, and creates the scope row', async () => {
    const { prisma, calls } = makePrisma({ scopeTypes: [{ id: 'st-school', code: 'SCHOOL' }] });
    const svc = new ScopeService(prisma as never);
    const result = await svc.createScope({
      scopeTypeCode: 'SCHOOL',
      entityId: 'school-1',
      entityTable: 'platform.schools',
      label: 'Lincoln Academy',
    });
    expect(calls.scopeTypeFindUnique[0].where.code).toBe('SCHOOL');
    expect(calls.scopeCreate).toHaveLength(1);
    const created = calls.scopeCreate[0].data;
    expect(created.scopeTypeId).toBe('st-school');
    expect(created.entityId).toBe('school-1');
    expect(created.entityTable).toBe('platform.schools');
    expect(created.label).toBe('Lincoln Academy');
    expect(created.parentScopeId).toBeUndefined();
    expect(created.id).toBeTruthy(); // generateId() ran
    expect(result.entityId).toBe('school-1');
  });

  it('propagates parentScopeId when supplied (org → school hierarchy)', async () => {
    const { prisma, calls } = makePrisma({ scopeTypes: [{ id: 'st-school', code: 'SCHOOL' }] });
    const svc = new ScopeService(prisma as never);
    await svc.createScope({
      scopeTypeCode: 'SCHOOL',
      entityId: 'school-1',
      entityTable: 'platform.schools',
      label: 'Lincoln',
      parentScopeId: 'org-scope-1',
    });
    expect(calls.scopeCreate[0].data.parentScopeId).toBe('org-scope-1');
  });

  it('throws when the scope type code is unknown', async () => {
    const { prisma, calls } = makePrisma({ scopeTypes: [] });
    const svc = new ScopeService(prisma as never);
    await expect(
      svc.createScope({
        scopeTypeCode: 'BOGUS',
        entityId: 'school-1',
        entityTable: 'platform.schools',
        label: 'Lincoln',
      }),
    ).rejects.toThrow('Unknown scope type: BOGUS');
    // Scope row creation must NOT fire if scope type lookup failed.
    expect(calls.scopeCreate).toHaveLength(0);
  });
});

describe('ScopeService.findByEntity', () => {
  it('returns null when the scope type is unknown (no DB scope lookup)', async () => {
    const { prisma, calls } = makePrisma({ scopeTypes: [] });
    const svc = new ScopeService(prisma as never);
    expect(await svc.findByEntity('BOGUS', 'school-1')).toBeNull();
    expect(calls.scopeFindUnique).toHaveLength(0);
  });

  it('queries iam_scope by (scopeTypeId, entityId) composite key when type resolves', async () => {
    const { prisma, calls } = makePrisma({
      scopeTypes: [{ id: 'st-school', code: 'SCHOOL' }],
      existingScopes: [{ id: 's-1', scopeTypeId: 'st-school', entityId: 'school-1' }],
    });
    const svc = new ScopeService(prisma as never);
    const result = await svc.findByEntity('SCHOOL', 'school-1');
    expect(result?.id).toBe('s-1');
    expect(calls.scopeFindUnique[0].where.scopeTypeId_entityId.scopeTypeId).toBe('st-school');
    expect(calls.scopeFindUnique[0].where.scopeTypeId_entityId.entityId).toBe('school-1');
  });

  it('returns null when scope type resolves but no scope row matches the entityId', async () => {
    const { prisma } = makePrisma({
      scopeTypes: [{ id: 'st-school', code: 'SCHOOL' }],
      existingScopes: [],
    });
    const svc = new ScopeService(prisma as never);
    expect(await svc.findByEntity('SCHOOL', 'school-999')).toBeNull();
  });
});

describe('ScopeService.getChildren', () => {
  it('returns active children of the parent with scopeType included', async () => {
    const { prisma, calls } = makePrisma({
      children: [
        { id: 'c-1', parentScopeId: 'parent-1', isActive: true },
        { id: 'c-2', parentScopeId: 'parent-1', isActive: true },
        { id: 'c-3', parentScopeId: 'parent-1', isActive: false }, // inactive — should NOT be returned
      ],
    });
    const svc = new ScopeService(prisma as never);
    const result = await svc.getChildren('parent-1');
    expect(result).toHaveLength(2);
    expect(calls.scopeFindMany[0].where.parentScopeId).toBe('parent-1');
    expect(calls.scopeFindMany[0].where.isActive).toBe(true);
    expect(calls.scopeFindMany[0].include.scopeType).toBe(true);
  });

  it('returns [] when the parent has no children', async () => {
    const { prisma } = makePrisma({ children: [] });
    const svc = new ScopeService(prisma as never);
    expect(await svc.getChildren('lonely-parent')).toEqual([]);
  });
});
