import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * PermissionCheckService — Hot-path permission lookup
 *
 * This is the service that @RequirePermission calls on every request.
 * It checks the iam_effective_access_cache for a given account+scope.
 *
 * ADR-036: Direct JOINs across role_assignment→role→permission
 * are FORBIDDEN on the request path. Cache only.
 *
 * Flow: Redis (5-min TTL) → iam_effective_access_cache table → 403
 */
@Injectable()
export class PermissionCheckService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Check if an account has a specific permission in a scope.
   * This is the hot path — called on every protected request.
   */
  async hasPermission(
    accountId: string,
    scopeId: string,
    permissionCode: string,
  ): Promise<boolean> {
    // TODO: Check Redis first (Step 7+ when Redis service is wired)

    // Fall back to database cache
    var cache = await this.prisma.iamEffectiveAccessCache.findUnique({
      where: {
        accountId_scopeId: { accountId, scopeId },
      },
    });

    if (!cache) {
      return false;
    }

    return cache.permissionCodes.includes(permissionCode);
  }

  /**
   * Check if an account has ANY of the given permissions in a scope.
   */
  async hasAnyPermission(
    accountId: string,
    scopeId: string,
    permissionCodes: string[],
  ): Promise<boolean> {
    var cache = await this.prisma.iamEffectiveAccessCache.findUnique({
      where: {
        accountId_scopeId: { accountId, scopeId },
      },
    });

    if (!cache) {
      return false;
    }

    for (var i = 0; i < permissionCodes.length; i++) {
      if (cache.permissionCodes.includes(permissionCodes[i] as string)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get all permissions for an account in a scope.
   */
  async getPermissions(accountId: string, scopeId: string): Promise<string[]> {
    var cache = await this.prisma.iamEffectiveAccessCache.findUnique({
      where: {
        accountId_scopeId: { accountId, scopeId },
      },
    });

    return cache ? cache.permissionCodes : [];
  }

  /**
   * Does this account hold any of the given codes within the SCHOOL scope
   * chain (school → platform) for the given school?
   *
   * Used by controllers to gate behavior on the requested tenant only —
   * never on permissions held at some other tenant. (The previous
   * `hasAnyPermissionAcrossScopes` helper was unsafe: a Platform Admin or
   * a teacher at school A could activate "admin behavior" while serving
   * a request scoped to school B simply by holding the code in any cache
   * row. We now restrict the check to the tenant of the active request.)
   */
  async hasAnyPermissionInTenant(
    accountId: string,
    schoolId: string,
    permissionCodes: string[],
  ): Promise<boolean> {
    var scopeIds = await this.resolveScopeChain(schoolId);
    for (var s = 0; s < scopeIds.length; s++) {
      var ok = await this.hasAnyPermission(accountId, scopeIds[s]!, permissionCodes);
      if (ok) return true;
    }
    return false;
  }

  /**
   * Resolve scope ids the request can satisfy, ordered most-specific first.
   * For a school-tenant request that's [school, platform]; a platform admin
   * is checked at PLATFORM after their school assignment misses (or as a
   * fallback when no school scope exists).
   *
   * Shared by PermissionGuard and hasAnyPermissionInTenant so the same
   * scope traversal is enforced everywhere.
   */
  async resolveScopeChain(schoolId: string): Promise<string[]> {
    var ids: string[] = [];

    var schoolScope = await this.prisma.iamScope.findFirst({
      where: { entityId: schoolId, scopeType: { code: 'SCHOOL' }, isActive: true },
      select: { id: true },
    });
    if (schoolScope) ids.push(schoolScope.id);

    var platformScope = await this.prisma.iamScope.findFirst({
      where: { scopeType: { code: 'PLATFORM' }, isActive: true },
      select: { id: true },
    });
    if (platformScope) ids.push(platformScope.id);

    return ids;
  }
}
