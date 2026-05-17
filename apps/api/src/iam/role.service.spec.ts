import { describe, it, expect } from 'vitest';
import { RoleService } from './role.service';

/**
 * P2-H4 test coverage uplift — role.service.ts (82 LOC, critical-path Tier 2 ≥95%).
 *
 * RoleService is a thin wrapper around the platform.roles + platform.permissions
 * + platform.role_permissions tables. Every call delegates straight to Prisma,
 * so coverage focuses on ensuring the documented query shapes are emitted and
 * the public surface is exercised end-to-end.
 */

interface PrismaCalls {
  roleFindMany: unknown[];
  roleFindUnique: unknown[];
  roleFindFirst: unknown[];
  roleCreate: unknown[];
  permissionFindUnique: unknown[];
  permissionFindMany: unknown[];
  rolePermissionCreateMany: unknown[];
}

function makePrisma(
  overrides: {
    roles?: Array<Record<string, unknown>>;
    rolesByName?: Record<string, Record<string, unknown>>;
    permissions?: Array<Record<string, unknown>>;
  } = {},
) {
  const calls: PrismaCalls = {
    roleFindMany: [],
    roleFindUnique: [],
    roleFindFirst: [],
    roleCreate: [],
    permissionFindUnique: [],
    permissionFindMany: [],
    rolePermissionCreateMany: [],
  };
  const prisma = {
    role: {
      findMany: async (args: unknown) => {
        calls.roleFindMany.push(args);
        return overrides.roles ?? [];
      },
      findUnique: async (args: { where: { id: string } }) => {
        calls.roleFindUnique.push(args);
        return (overrides.roles ?? []).find((r) => r.id === args.where.id) ?? null;
      },
      findFirst: async (args: { where: { name: string; schoolId: string | null } }) => {
        calls.roleFindFirst.push(args);
        const key = `${args.where.name}|${args.where.schoolId ?? ''}`;
        return overrides.rolesByName?.[key] ?? null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        calls.roleCreate.push(args);
        return args.data;
      },
    },
    permission: {
      findUnique: async (args: { where: { code: string } }) => {
        calls.permissionFindUnique.push(args);
        return (overrides.permissions ?? []).find((p) => p.code === args.where.code) ?? null;
      },
      findMany: async (args: unknown) => {
        calls.permissionFindMany.push(args);
        return overrides.permissions ?? [];
      },
    },
    rolePermission: {
      createMany: async (args: { data: unknown[]; skipDuplicates: boolean }) => {
        calls.rolePermissionCreateMany.push(args);
        return { count: args.data.length };
      },
    },
  };
  return { prisma, calls };
}

describe('RoleService.findAll', () => {
  it('includes rolePermissions+permission and orders by name asc', async () => {
    const { prisma, calls } = makePrisma({
      roles: [
        { id: '1', name: 'Teacher' },
        { id: '2', name: 'Admin' },
      ],
    });
    const svc = new RoleService(prisma as never);
    const result = await svc.findAll();
    expect(result).toHaveLength(2);
    expect(calls.roleFindMany).toHaveLength(1);
    const arg = calls.roleFindMany[0] as {
      include: { rolePermissions: { include: { permission: boolean } } };
      orderBy: { name: string };
    };
    expect(arg.include.rolePermissions.include.permission).toBe(true);
    expect(arg.orderBy).toEqual({ name: 'asc' });
  });
});

describe('RoleService.findById', () => {
  it('queries by id with includes', async () => {
    const { prisma, calls } = makePrisma({ roles: [{ id: 'role-1', name: 'Teacher' }] });
    const svc = new RoleService(prisma as never);
    const result = await svc.findById('role-1');
    expect(result).toEqual({ id: 'role-1', name: 'Teacher' });
    expect((calls.roleFindUnique[0] as { where: { id: string } }).where.id).toBe('role-1');
  });

  it('returns null when role does not exist', async () => {
    const { prisma } = makePrisma({ roles: [] });
    const svc = new RoleService(prisma as never);
    expect(await svc.findById('missing')).toBeNull();
  });
});

describe('RoleService.findByName', () => {
  it('queries platform-scope (schoolId=null) when no schoolId is supplied', async () => {
    const { prisma, calls } = makePrisma({
      rolesByName: { 'Teacher|': { id: 'r-1', name: 'Teacher', schoolId: null } },
    });
    const svc = new RoleService(prisma as never);
    const result = await svc.findByName('Teacher');
    expect(result).toEqual({ id: 'r-1', name: 'Teacher', schoolId: null });
    const where = (calls.roleFindFirst[0] as { where: { schoolId: string | null } }).where;
    expect(where.schoolId).toBeNull();
  });

  it('queries school-scope when schoolId is supplied', async () => {
    const { prisma, calls } = makePrisma({
      rolesByName: {
        'Counsellor|school-1': { id: 'r-2', name: 'Counsellor', schoolId: 'school-1' },
      },
    });
    const svc = new RoleService(prisma as never);
    const result = await svc.findByName('Counsellor', 'school-1');
    expect(result?.id).toBe('r-2');
    expect((calls.roleFindFirst[0] as { where: { schoolId: string | null } }).where.schoolId).toBe(
      'school-1',
    );
  });
});

describe('RoleService.create', () => {
  it('mints a fresh id and persists the supplied fields', async () => {
    const { prisma, calls } = makePrisma();
    const svc = new RoleService(prisma as never);
    const result = await svc.create({ name: 'Librarian', description: 'Library staff' });
    expect(result.name).toBe('Librarian');
    expect(result.description).toBe('Library staff');
    expect(result.id).toBeTruthy(); // generateId() ran
    expect(typeof (result as { id: string }).id).toBe('string');
    expect(calls.roleCreate).toHaveLength(1);
  });

  it('defaults isSystem=false and propagates schoolId when supplied', async () => {
    const { prisma } = makePrisma();
    const svc = new RoleService(prisma as never);
    const a = await svc.create({ name: 'School Admin', schoolId: 'school-1' });
    expect(a.isSystem).toBe(false);
    expect(a.schoolId).toBe('school-1');

    const b = await svc.create({ name: 'Platform Admin', isSystem: true });
    expect(b.isSystem).toBe(true);
  });
});

describe('RoleService.assignPermissions', () => {
  it('createMany with skipDuplicates and one row per (role, permission) pair', async () => {
    const { prisma, calls } = makePrisma();
    const svc = new RoleService(prisma as never);
    const result = await svc.assignPermissions('role-1', ['perm-1', 'perm-2', 'perm-3']);
    expect((result as { count: number }).count).toBe(3);
    const args = calls.rolePermissionCreateMany[0] as { data: unknown[]; skipDuplicates: boolean };
    expect(args.skipDuplicates).toBe(true);
    expect(args.data).toHaveLength(3);
    expect(
      args.data.map((d) => (d as { roleId: string; permissionId: string }).permissionId),
    ).toEqual(['perm-1', 'perm-2', 'perm-3']);
    // Every row carries the same roleId and a fresh id.
    for (const row of args.data) {
      const r = row as { roleId: string; id: string };
      expect(r.roleId).toBe('role-1');
      expect(r.id).toBeTruthy();
    }
  });

  it('accepts an empty array as a no-op', async () => {
    const { prisma, calls } = makePrisma();
    const svc = new RoleService(prisma as never);
    const result = await svc.assignPermissions('role-1', []);
    expect((result as { count: number }).count).toBe(0);
    expect((calls.rolePermissionCreateMany[0] as { data: unknown[] }).data).toEqual([]);
  });
});

describe('RoleService.getPermissionByCode', () => {
  it('returns the permission row for a known code', async () => {
    const { prisma } = makePrisma({ permissions: [{ id: 'p-1', code: 'att-001:write' }] });
    const svc = new RoleService(prisma as never);
    expect(await svc.getPermissionByCode('att-001:write')).toEqual({
      id: 'p-1',
      code: 'att-001:write',
    });
  });

  it('returns null for an unknown code', async () => {
    const { prisma } = makePrisma({ permissions: [] });
    const svc = new RoleService(prisma as never);
    expect(await svc.getPermissionByCode('ghost:read')).toBeNull();
  });
});

describe('RoleService.getAllPermissions', () => {
  it('returns the full catalogue ordered by code asc', async () => {
    const { prisma, calls } = makePrisma({
      permissions: [{ code: 'att-001:read' }, { code: 'att-001:write' }],
    });
    const svc = new RoleService(prisma as never);
    const result = await svc.getAllPermissions();
    expect(result).toHaveLength(2);
    expect((calls.permissionFindMany[0] as { orderBy: { code: string } }).orderBy).toEqual({
      code: 'asc',
    });
  });
});
