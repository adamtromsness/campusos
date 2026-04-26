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
  async getPermissions(
    accountId: string,
    scopeId: string,
  ): Promise<string[]> {
    var cache = await this.prisma.iamEffectiveAccessCache.findUnique({
      where: {
        accountId_scopeId: { accountId, scopeId },
      },
    });

    return cache ? cache.permissionCodes : [];
  }
}
