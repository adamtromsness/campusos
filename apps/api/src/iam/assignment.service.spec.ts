import { describe, it, expect } from 'vitest';
import { AssignmentService } from './assignment.service';

/**
 * P2-H4 test coverage uplift — assignment.service.ts (128 LOC, critical-path
 * Tier 2 ≥95%).
 *
 * AssignmentService owns the platform.iam_role_assignment lifecycle. Each
 * mutation:
 *   - writes the assignment row
 *   - appends a history row to iam_role_assignment_history
 *   - emits an iam_access_change_event row (ROLE_GRANTED / ROLE_REVOKED)
 *   - rebuilds the EffectiveAccessCache for the (account, scope) pair
 *
 * Spec covers the documented audit trail + cache invalidation in each path.
 */

interface PrismaCalls {
  assignmentCreate: Array<{ data: Record<string, unknown> }>;
  assignmentUpdate: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  assignmentFindMany: Array<unknown>;
  historyCreate: Array<{ data: Record<string, unknown> }>;
  changeEventCreate: Array<{ data: Record<string, unknown> }>;
}

interface CacheCalls {
  rebuilds: Array<{ accountId: string; scopeId: string }>;
}

function makePrisma(
  overrides: {
    existingAssignment?: { id: string; accountId: string; scopeId: string; roleId: string };
  } = {},
) {
  const calls: PrismaCalls = {
    assignmentCreate: [],
    assignmentUpdate: [],
    assignmentFindMany: [],
    historyCreate: [],
    changeEventCreate: [],
  };
  const prisma = {
    iamRoleAssignment: {
      create: async (args: { data: Record<string, unknown> }) => {
        calls.assignmentCreate.push(args);
        return args.data;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.assignmentUpdate.push(args);
        // Simulate Prisma returning the updated row joined with the original fields.
        return {
          ...(overrides.existingAssignment ?? {
            id: args.where.id,
            accountId: 'acct-a',
            scopeId: 'scope-a',
            roleId: 'role-a',
          }),
          ...args.data,
        };
      },
      findMany: async (args: unknown) => {
        calls.assignmentFindMany.push(args);
        return [];
      },
    },
    iamRoleAssignmentHistory: {
      create: async (args: { data: Record<string, unknown> }) => {
        calls.historyCreate.push(args);
        return args.data;
      },
    },
    iamAccessChangeEvent: {
      create: async (args: { data: Record<string, unknown> }) => {
        calls.changeEventCreate.push(args);
        return args.data;
      },
    },
  };
  return { prisma, calls };
}

function makeCacheService() {
  const calls: CacheCalls = { rebuilds: [] };
  const cache = {
    rebuildCache: async (accountId: string, scopeId: string) => {
      calls.rebuilds.push({ accountId, scopeId });
    },
  };
  return { cache, calls };
}

describe('AssignmentService.grantRole', () => {
  it('creates an ACTIVE assignment with all supplied fields', async () => {
    const { prisma, calls } = makePrisma();
    const { cache } = makeCacheService();
    const svc = new AssignmentService(prisma as never, cache as never);
    const effectiveTo = new Date('2026-12-31');
    const result = await svc.grantRole({
      accountId: 'acct-1',
      roleId: 'role-teacher',
      scopeId: 'scope-school',
      source: 'MANUAL' as never,
      assignedBy: 'admin-1',
      effectiveTo,
      notes: 'Promoted from substitute pool',
    });
    expect(calls.assignmentCreate).toHaveLength(1);
    const data = calls.assignmentCreate[0].data;
    expect(data.accountId).toBe('acct-1');
    expect(data.roleId).toBe('role-teacher');
    expect(data.scopeId).toBe('scope-school');
    expect(data.source).toBe('MANUAL');
    expect(data.status).toBe('ACTIVE');
    expect(data.assignedBy).toBe('admin-1');
    expect(data.effectiveTo).toBe(effectiveTo);
    expect(data.notes).toBe('Promoted from substitute pool');
    expect(data.id).toBeTruthy(); // generateId() fired
    expect(result.accountId).toBe('acct-1');
  });

  it('appends a CREATED history row referencing the new assignment', async () => {
    const { prisma, calls } = makePrisma();
    const { cache } = makeCacheService();
    const svc = new AssignmentService(prisma as never, cache as never);
    await svc.grantRole({
      accountId: 'acct-1',
      roleId: 'role-1',
      scopeId: 'scope-1',
      source: 'MANUAL' as never,
      assignedBy: 'admin-1',
    });
    expect(calls.historyCreate).toHaveLength(1);
    const data = calls.historyCreate[0].data;
    expect(data.assignmentId).toBe(calls.assignmentCreate[0].data.id);
    expect(data.changeType).toBe('CREATED');
    expect(data.newStatus).toBe('ACTIVE');
    expect(data.changedBy).toBe('admin-1');
    expect(data.changedAt).toBeInstanceOf(Date);
  });

  it('records a ROLE_GRANTED access-change event', async () => {
    const { prisma, calls } = makePrisma();
    const { cache } = makeCacheService();
    const svc = new AssignmentService(prisma as never, cache as never);
    await svc.grantRole({
      accountId: 'acct-1',
      roleId: 'role-1',
      scopeId: 'scope-1',
      source: 'MANUAL' as never,
      assignedBy: 'admin-1',
    });
    expect(calls.changeEventCreate).toHaveLength(1);
    const data = calls.changeEventCreate[0].data;
    expect(data.accountId).toBe('acct-1');
    expect(data.eventType).toBe('ROLE_GRANTED');
    expect(data.actorId).toBe('admin-1');
    expect(data.scopeId).toBe('scope-1');
    expect(data.roleId).toBe('role-1');
    expect(data.assignmentId).toBe(calls.assignmentCreate[0].data.id);
  });

  it('rebuilds the EffectiveAccessCache for the affected (account, scope)', async () => {
    const { prisma } = makePrisma();
    const { cache, calls: cacheCalls } = makeCacheService();
    const svc = new AssignmentService(prisma as never, cache as never);
    await svc.grantRole({
      accountId: 'acct-1',
      roleId: 'role-1',
      scopeId: 'scope-1',
      source: 'MANUAL' as never,
    });
    expect(cacheCalls.rebuilds).toEqual([{ accountId: 'acct-1', scopeId: 'scope-1' }]);
  });

  it('grants are allowed with no assignedBy / effectiveTo / notes (system-driven)', async () => {
    const { prisma, calls } = makePrisma();
    const { cache } = makeCacheService();
    const svc = new AssignmentService(prisma as never, cache as never);
    await svc.grantRole({
      accountId: 'acct-1',
      roleId: 'role-1',
      scopeId: 'scope-1',
      source: 'SYSTEM' as never,
    });
    const data = calls.assignmentCreate[0].data;
    expect(data.assignedBy).toBeUndefined();
    expect(data.effectiveTo).toBeUndefined();
    expect(data.notes).toBeUndefined();
  });
});

describe('AssignmentService.revokeAssignment', () => {
  it('flips status to REVOKED on the existing assignment row', async () => {
    const { prisma, calls } = makePrisma({
      existingAssignment: { id: 'a-1', accountId: 'acct-1', scopeId: 'scope-1', roleId: 'role-1' },
    });
    const { cache } = makeCacheService();
    const svc = new AssignmentService(prisma as never, cache as never);
    await svc.revokeAssignment('a-1', 'admin-1', 'No longer required');
    expect(calls.assignmentUpdate).toHaveLength(1);
    expect(calls.assignmentUpdate[0].where.id).toBe('a-1');
    expect(calls.assignmentUpdate[0].data.status).toBe('REVOKED');
  });

  it('appends a REVOKED history row carrying the reason + actor + status transition', async () => {
    const { prisma, calls } = makePrisma({
      existingAssignment: { id: 'a-1', accountId: 'acct-1', scopeId: 'scope-1', roleId: 'role-1' },
    });
    const { cache } = makeCacheService();
    const svc = new AssignmentService(prisma as never, cache as never);
    await svc.revokeAssignment('a-1', 'admin-1', 'Resigned');
    expect(calls.historyCreate).toHaveLength(1);
    const data = calls.historyCreate[0].data;
    expect(data.assignmentId).toBe('a-1');
    expect(data.changedBy).toBe('admin-1');
    expect(data.changeType).toBe('REVOKED');
    expect(data.previousStatus).toBe('ACTIVE');
    expect(data.newStatus).toBe('REVOKED');
    expect(data.reason).toBe('Resigned');
  });

  it('records a ROLE_REVOKED access-change event referencing the original (account, scope, role)', async () => {
    const { prisma, calls } = makePrisma({
      existingAssignment: { id: 'a-1', accountId: 'acct-1', scopeId: 'scope-1', roleId: 'role-1' },
    });
    const { cache } = makeCacheService();
    const svc = new AssignmentService(prisma as never, cache as never);
    await svc.revokeAssignment('a-1', 'admin-1');
    expect(calls.changeEventCreate).toHaveLength(1);
    const data = calls.changeEventCreate[0].data;
    expect(data.eventType).toBe('ROLE_REVOKED');
    expect(data.accountId).toBe('acct-1');
    expect(data.scopeId).toBe('scope-1');
    expect(data.roleId).toBe('role-1');
    expect(data.assignmentId).toBe('a-1');
    expect(data.actorId).toBe('admin-1');
  });

  it('rebuilds the cache for the revoked (account, scope) pair', async () => {
    const { prisma } = makePrisma({
      existingAssignment: { id: 'a-1', accountId: 'acct-1', scopeId: 'scope-1', roleId: 'role-1' },
    });
    const { cache, calls: cacheCalls } = makeCacheService();
    const svc = new AssignmentService(prisma as never, cache as never);
    await svc.revokeAssignment('a-1');
    expect(cacheCalls.rebuilds).toEqual([{ accountId: 'acct-1', scopeId: 'scope-1' }]);
  });

  it('accepts revokes without a revokedBy / reason (system-driven)', async () => {
    const { prisma, calls } = makePrisma({
      existingAssignment: { id: 'a-1', accountId: 'acct-1', scopeId: 'scope-1', roleId: 'role-1' },
    });
    const { cache } = makeCacheService();
    const svc = new AssignmentService(prisma as never, cache as never);
    await svc.revokeAssignment('a-1');
    expect(calls.historyCreate[0].data.changedBy).toBeUndefined();
    expect(calls.historyCreate[0].data.reason).toBeUndefined();
  });
});

describe('AssignmentService.getAssignmentsForAccount', () => {
  it('returns only ACTIVE assignments, joined to role + scope', async () => {
    const { prisma, calls } = makePrisma();
    const { cache } = makeCacheService();
    const svc = new AssignmentService(prisma as never, cache as never);
    await svc.getAssignmentsForAccount('acct-1');
    expect(calls.assignmentFindMany).toHaveLength(1);
    const arg = calls.assignmentFindMany[0] as {
      where: { accountId: string; status: string };
      include: { role: boolean; scope: boolean };
    };
    expect(arg.where.accountId).toBe('acct-1');
    expect(arg.where.status).toBe('ACTIVE');
    expect(arg.include.role).toBe(true);
    expect(arg.include.scope).toBe(true);
  });
});
