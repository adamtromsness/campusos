import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { generateId } from '@campusos/database';

/**
 * EffectiveAccessCacheService — Cache Rebuild
 *
 * Rebuilds iam_effective_access_cache for a given account+scope
 * by traversing the scope hierarchy and unioning all active
 * role assignments with their permission codes.
 *
 * ADR-036: Cache staleness SLA = 500ms maximum.
 * ADR-043: Pre-warm on login via IAMCachePrewarmWorker.
 *
 * Triggered by: iam.role.assigned, iam.role.revoked Kafka events.
 */
@Injectable()
export class EffectiveAccessCacheService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Rebuild the effective access cache for an account in a scope.
   * Traverses parent scopes upward and unions all permissions.
   */
  async rebuildCache(accountId: string, scopeId: string): Promise<string[]> {
    // 1. Collect all scope IDs in the hierarchy (this scope + all parents)
    var scopeIds = await this.getScopeHierarchy(scopeId);

    // 2. Find all active role assignments for this account across all scopes
    var assignments = await this.prisma.iamRoleAssignment.findMany({
      where: {
        accountId: accountId,
        scopeId: { in: scopeIds },
        status: 'ACTIVE',
        effectiveFrom: { lte: new Date() },
        OR: [
          { effectiveTo: null },
          { effectiveTo: { gt: new Date() } },
        ],
      },
      select: {
        id: true,
        roleId: true,
        status: true,
      },
    });

    if (assignments.length === 0) {
      // No active assignments — delete any existing cache entry
      await this.prisma.iamEffectiveAccessCache.deleteMany({
        where: { accountId, scopeId },
      });
      return [];
    }

    // 3. Collect all role IDs
    var roleIds = assignments.map(function(a: any) { return a.roleId; });
    var uniqueRoleIds = Array.from(new Set(roleIds));

    // 4. Get all permission codes for these roles
    var rolePermissions = await this.prisma.rolePermission.findMany({
      where: { roleId: { in: uniqueRoleIds } },
      include: { permission: { select: { code: true } } },
    });

    var permissionCodes = Array.from(
      new Set(rolePermissions.map(function(rp: any) { return rp.permission.code; }))
    ).sort();

    // 5. Compute version hash for staleness detection
    var assignmentIds = assignments.map(function(a) { return a.id + ':' + a.status; }).sort();
    var versionHash = createHash('sha256').update(assignmentIds.join(',')).digest('hex');

    // 6. Upsert the cache entry
    await this.prisma.iamEffectiveAccessCache.upsert({
      where: {
        accountId_scopeId: { accountId, scopeId },
      },
      update: {
        permissionCodes: permissionCodes,
        computedAt: new Date(),
        assignmentVersionHash: versionHash,
      },
      create: {
        id: generateId(),
        accountId: accountId,
        scopeId: scopeId,
        permissionCodes: permissionCodes,
        computedAt: new Date(),
        assignmentVersionHash: versionHash,
      },
    });

    return permissionCodes;
  }

  /**
   * Rebuild cache for ALL scopes an account has assignments in.
   * Called on login (pre-warm) or bulk role changes.
   */
  async rebuildAllForAccount(accountId: string): Promise<void> {
    // Find all unique scopes this account has assignments in
    var assignments = await this.prisma.iamRoleAssignment.findMany({
      where: { accountId, status: 'ACTIVE' },
      select: { scopeId: true },
      distinct: ['scopeId'],
    });

    for (var i = 0; i < assignments.length; i++) {
      var a = assignments[i]!;
      await this.rebuildCache(accountId, a.scopeId);
    }
  }

  /**
   * Get the scope hierarchy: this scope + all ancestor scopes.
   * Traverses parent_scope_id upward until reaching root (null parent).
   */
  private async getScopeHierarchy(scopeId: string): Promise<string[]> {
    var result: string[] = [scopeId];
    var currentId: string | null = scopeId;

    // Walk up the tree (max 10 levels to prevent infinite loops)
    for (var depth = 0; depth < 10; depth++) {
      var scope: any = await this.prisma.iamScope.findUnique({
        where: { id: currentId as string },
        select: { parentScopeId: true },
      });

      if (!scope || !scope.parentScopeId) {
        break;
      }

      result.push(scope.parentScopeId);
      currentId = scope.parentScopeId;
    }

    return result;
  }
}
