import { Injectable, NestMiddleware, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { runWithTenantContext, RequestContext, TenantInfo } from './tenant.context';

/**
 * TenantResolverMiddleware
 *
 * Runs on every request. Extracts the tenant from:
 * 1. Subdomain (e.g. demo.campusos.com → school "demo")
 * 2. X-Tenant-ID header (for service-to-service calls only)
 * 3. localhost:4000 with X-Tenant-Subdomain header (for local dev)
 *
 * If resolution fails → 400 Bad Request. No fallback. No default.
 *
 * Architecture (Dev Plan Section 18, Layer 1):
 * - Resolved tenant stored in AsyncLocalStorage
 * - Available to every service without parameter passing
 * - Prisma middleware reads from this context
 */
@Injectable()
export class TenantResolverMiddleware implements NestMiddleware {
  constructor(private readonly prisma: PrismaClient) {}

  async use(req: Request, res: Response, next: NextFunction) {
    // Skip tenant resolution for health checks and auth endpoints
    if (this.isExemptPath(req.path)) {
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
      throw new HttpException(
        'Unknown or inactive tenant: ' + subdomain,
        HttpStatus.BAD_REQUEST,
      );
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
    runWithTenantContext(context, function() {
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
   */
  private isExemptPath(path: string): boolean {
    var exemptPaths = [
      '/api/v1/health',
      '/api/v1/auth/login',
      '/api/v1/auth/callback',
      '/api/docs',
    ];

    for (var i = 0; i < exemptPaths.length; i++) {
      if (path.startsWith(exemptPaths[i] as string)) {
        return true;
      }
    }
    return false;
  }
}
