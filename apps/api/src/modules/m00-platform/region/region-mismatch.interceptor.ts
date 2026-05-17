import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import { HOME_REGION_REQUIRED_KEY } from './home-region-required.decorator';

/**
 * Cycle 32 Step 6 — Region Mismatch Interceptor.
 *
 * For every request that enters a controller marked
 * @HomeRegionRequired() (or a controller whose @PlatformScoped()
 * decorator does NOT exempt it), compares the tenant's home region
 * (from tenant_routing.home_region, populated by
 * TenantResolverMiddleware) against the deployment's region
 * (process.env.AWS_REGION). If they differ, HTTP 421 Misdirected
 * Request — the standard response for "this endpoint exists, but
 * I'm not the right server for your tenant; try a different region".
 *
 * The interceptor runs after the guard chain (Auth → Tenant →
 * Permission) so the tenant context is guaranteed populated when
 * @HomeRegionRequired() routes execute. Public + platform-scoped
 * routes are skipped.
 *
 * Not configuring AWS_REGION (e.g. local dev) skips the check
 * silently — local development should not be coupled to a real AWS
 * region.
 */
@Injectable()
export class RegionMismatchInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RegionMismatchInterceptor.name);

  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    var deployedRegion = process.env.AWS_REGION;
    if (!deployedRegion) {
      // Local dev / test; the cycle-32 region affinity contract
      // does not apply.
      return next.handle();
    }

    var requireHomeRegion = this.reflector.getAllAndOverride<boolean>(HOME_REGION_REQUIRED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requireHomeRegion) {
      return next.handle();
    }

    var tenant: ReturnType<typeof getCurrentTenant>;
    try {
      tenant = getCurrentTenant();
    } catch {
      // No tenant context (public / platform-scoped). The interceptor
      // does not gate these.
      return next.handle();
    }

    if (tenant.homeRegion !== deployedRegion) {
      this.logger.warn(
        `Region mismatch: tenant ${tenant.subdomain} home_region=${tenant.homeRegion} but deployed region=${deployedRegion}`,
      );
      // HTTP 421 Misdirected Request — RFC 7540 §9.1.2.
      // NestJS HttpStatus enum doesn't include 421; use the literal.
      throw new HttpException(
        {
          statusCode: 421,
          error: 'MISDIRECTED_REQUEST',
          message:
            "This tenant's home region does not match the region serving this request. Retry against the tenant's home-region endpoint.",
          tenantHomeRegion: tenant.homeRegion,
          deployedRegion: deployedRegion,
        },
        421,
      );
    }

    return next.handle();
  }
}
