import { Injectable, NestMiddleware, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { runWithTenantContext, RequestContext, TenantInfo } from './tenant.context';

/**
 * TenantResolverMiddleware
 *
 * Runs on every request. Extracts the tenant from, in order:
 * 1. The `X-Tenant-Subdomain` header (used by local dev + the web client,
 *    which always sends `demo` regardless of the deployed hostname).
 * 2. The hostname's first DNS segment (e.g. `demo.campusos.com` → `demo`)
 *    when the request did not arrive via `localhost` / `127.0.0.1`.
 *
 * If neither yields a subdomain → 400 Bad Request. No fallback. No default.
 *
 * Note (REVIEW-CYCLE6 issue 12): the `X-Tenant-Subdomain` header is
 * accepted in every environment — production currently relies on it from
 * the web client. Tightening to dev/test-only is a Phase 2 hardening item
 * once the production frontend can pin to subdomain routing.
 *
 * Architecture (Dev Plan Section 18, Layer 1):
 * - Resolved tenant stored in AsyncLocalStorage
 * - Available to every service without parameter passing
 * - Prisma middleware reads from this context
 */
@Injectable()
export class TenantResolverMiddleware implements NestMiddleware {
  constructor(private readonly prisma: PrismaClient) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    // Express + Nest with a global prefix strip the prefix from req.path before
    // middleware runs, so we match against the originalUrl (which keeps it).
    var fullPath = (req.originalUrl || req.url || req.path).split('?')[0] || req.path;
    if (this.isExemptPath(fullPath)) {
      next();
      return;
    }

    var subdomain = this.extractSubdomain(req);

    if (!subdomain) {
      throw new HttpException(
        'Tenant resolution failed — no subdomain or tenant header provided',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Look up school by subdomain
    // TODO: Check Redis cache first (ADR-042, 500ms TTL)
    var school = await this.prisma.school.findUnique({
      where: { subdomain: subdomain },
      include: { routing: true },
    });

    if (!school || !school.isActive) {
      throw new HttpException('Unknown or inactive tenant: ' + subdomain, HttpStatus.BAD_REQUEST);
    }

    if (!school.routing) {
      throw new HttpException(
        'Tenant routing not configured for: ' + subdomain,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    var tenantInfo: TenantInfo = {
      schoolId: school.id,
      schemaName: school.routing.schemaName,
      organisationId: school.organisationId,
      subdomain: school.subdomain,
      isFrozen: school.routing.isFrozen,
      planTier: school.planTier,
    };

    var context: RequestContext = {
      tenant: tenantInfo,
    };

    // Wrap the rest of the request in the tenant context
    runWithTenantContext(context, function () {
      next();
    });
  }

  /**
   * Extract subdomain from the request.
   * Supports: subdomain routing, X-Tenant-Subdomain header (dev), localhost.
   */
  private extractSubdomain(req: Request): string | null {
    // 1. Check explicit header (for local dev and testing)
    var headerSubdomain = req.headers['x-tenant-subdomain'] as string | undefined;
    if (headerSubdomain) {
      return headerSubdomain;
    }

    // 2. Extract from hostname (e.g. demo.campusos.com → demo)
    var host = req.hostname || req.headers.host || '';
    // Remove port if present
    host = host.split(':')[0] || '';

    // Skip localhost / IP addresses
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') {
      // In local dev, require the header
      return null;
    }

    // Extract first subdomain segment
    var parts = host.split('.');
    if (parts.length >= 3) {
      return parts[0] || null;
    }

    return null;
  }

  /**
   * Paths that don't require tenant resolution.
   *
   * `/api/v1/health` is matched exactly because Cycle 10 introduces
   * tenant-scoped `/api/v1/health/students/:studentId` (M23 health
   * record) routes that share the prefix but DO require a tenant.
   * Everything else still uses startsWith so /auth/callback?code=...
   * and /api/docs/* keep working without a tenant context.
   */
  private isExemptPath(path: string): boolean {
    if (path === '/api/v1/health') return true;

    var exemptPrefixes = [
      '/api/v1/auth/login',
      '/api/v1/auth/callback',
      '/api/docs',
      '/api/v1/guard-test/public',
      // Phase 2 polish — public school discovery endpoint. Cross-tenant by
      // design, queried from the marketing surface before any subdomain is
      // known.
      '/api/v1/enrollment/search',
    ];

    for (var i = 0; i < exemptPrefixes.length; i++) {
      if (path.startsWith(exemptPrefixes[i] as string)) {
        return true;
      }
    }
    return false;
  }
}
