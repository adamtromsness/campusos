import { SetMetadata } from '@nestjs/common';

/**
 * REVIEW-CYCLE31 BLOCKING 2 — Platform-scoped route marker.
 *
 * Apply at controller (or method) level on routes that operate
 * cross-tenant, e.g. the Cycle 31 Step 7 DLQ admin surface and the
 * Cycle 31 Step 9 Platform Admin dashboard. Platform-scoped routes:
 *
 *   - skip TenantGuard entirely (no tenant context required, no
 *     frozen-tenant check applies),
 *   - have PermissionGuard resolve permissions against the PLATFORM
 *     IAM scope only, not the school → platform scope chain.
 *
 * Routes that are platform-scoped MUST also be exempted from
 * TenantResolverMiddleware in `tenant-resolver.middleware.ts` so the
 * caller doesn't need to send `X-Tenant-Subdomain`. Both surfaces
 * shipped in Cycle 31 (`/api/v1/admin/platform/*` and
 * `/api/v1/admin/dlq/*`) are exempted there.
 */
export const PLATFORM_SCOPED_KEY = 'isPlatformScoped';
export const PlatformScoped = () => SetMetadata(PLATFORM_SCOPED_KEY, true);
