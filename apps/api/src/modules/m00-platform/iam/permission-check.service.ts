import { Injectable, Optional } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { RedisService } from '@shared/cache/redis.service';
import { MetricsService } from '@shared/observability/metrics.service';

/**
 * PermissionCheckService — Hot-path permission lookup
 *
 * This is the service that @RequirePermission calls on every request.
 * It checks the iam_effective_access_cache for a given account+scope.
 *
 * ADR-036: Direct JOINs across role_assignment→role→permission
 * are FORBIDDEN on the request path. Cache only.
 *
 * Flow (Cycle 31 Step 6): Redis (5-min TTL) → iam_effective_access_cache table → 403.
 *
 * Cache contract:
 *   key   : iam:access:{accountId}:{scopeId}
 *   value : string[] (permission codes)
 *   TTL   : 300 seconds
 *   invalidation : iam.role_assignment.changed + iam.account.suspended
 *                  Kafka events trigger explicit DEL via the IAM
 *                  invalidation consumer (Phase 2 — sub-second
 *                  invalidation). The 5-min TTL is the worst-case
 *                  staleness bound when the consumer is offline.
 */
const IAM_CACHE_TTL_SECONDS = 5 * 60;
const IAM_CACHE_LABEL = 'iam_access';

@Injectable()
export class PermissionCheckService {
  constructor(
    private readonly prisma: PrismaClient,
    @Optional() private readonly redis?: RedisService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  private cacheKey(accountId: string, scopeId: string): string {
    return `iam:access:${accountId}:${scopeId}`;
  }

  /**
   * Cycle 31 Step 6 — Redis-backed effective access lookup. Returns
   * the cached permission codes for (account, scope), or fetches +
   * caches the DB row on a miss. Returns [] when no cache row exists
   * (no permissions in this scope).
   */
  private async loadEffectiveCodes(accountId: string, scopeId: string): Promise<string[]> {
    if (this.redis) {
      const cached = await this.redis.cacheGet<string[]>(this.cacheKey(accountId, scopeId));
      if (cached !== null) {
        this.metrics?.redisCacheHits.labels(IAM_CACHE_LABEL).inc();
        return cached;
      }
      this.metrics?.redisCacheMisses.labels(IAM_CACHE_LABEL).inc();
    }
    const row = await this.prisma.iamEffectiveAccessCache.findUnique({
      where: { accountId_scopeId: { accountId, scopeId } },
    });
    const codes = row?.permissionCodes ?? [];
    if (this.redis) {
      await this.redis.cacheSet(this.cacheKey(accountId, scopeId), codes, IAM_CACHE_TTL_SECONDS);
    }
    return codes;
  }

  /**
   * Check if an account has a specific permission in a scope.
   * This is the hot path — called on every protected request.
   */
  async hasPermission(
    accountId: string,
    scopeId: string,
    permissionCode: string,
  ): Promise<boolean> {
    const codes = await this.loadEffectiveCodes(accountId, scopeId);
    return codes.includes(permissionCode);
  }

  /**
   * Check if an account has ANY of the given permissions in a scope.
   */
  async hasAnyPermission(
    accountId: string,
    scopeId: string,
    permissionCodes: string[],
  ): Promise<boolean> {
    const codes = await this.loadEffectiveCodes(accountId, scopeId);
    for (const c of permissionCodes) {
      if (codes.includes(c)) return true;
    }
    return false;
  }

  /**
   * Get all permissions for an account in a scope.
   */
  async getPermissions(accountId: string, scopeId: string): Promise<string[]> {
    return this.loadEffectiveCodes(accountId, scopeId);
  }

  /**
   * Cycle 31 Step 6 — explicit invalidation hook for the IAM
   * invalidation consumer (or admin tooling). Drops the cached
   * codes for one (account, scope) pair so the next request re-reads
   * the DB row.
   */
  async invalidate(accountId: string, scopeId: string): Promise<void> {
    if (!this.redis) return;
    await this.redis.cacheInvalidate(this.cacheKey(accountId, scopeId));
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

  /**
   * REVIEW-CYCLE31 BLOCKING 2 — resolve only the PLATFORM IAM scope.
   * Used by PermissionGuard for routes marked `@PlatformScoped()`
   * (e.g. /admin/platform/*, /admin/dlq/*) so the gate is solely
   * the PLATFORM-scope role assignment — a school admin cannot reach
   * these surfaces by piggy-backing on a school scope chain.
   */
  async resolvePlatformScope(): Promise<string | null> {
    var platformScope = await this.prisma.iamScope.findFirst({
      where: { scopeType: { code: 'PLATFORM' }, isActive: true },
      select: { id: true },
    });
    return platformScope?.id ?? null;
  }
}
