import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getCurrentTenant } from './tenant.context';
import { IS_PUBLIC_KEY } from '../auth/auth.guard';

/**
 * TenantGuard
 *
 * Validates that:
 * 1. A tenant context exists (set by TenantResolverMiddleware)
 * 2. The tenant is not frozen (ADR-031 write gate)
 *
 * Applied after AuthGuard in the guard chain:
 * TenantResolverMiddleware → AuthGuard → TenantGuard → PermissionGuard
 *
 * For write operations on frozen tenants, returns 503 WRITE_FROZEN.
 *
 * Skipped on endpoints marked @Public() — those routes are exempt from
 * tenant resolution by the middleware so getCurrentTenant() would throw.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    var isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    var tenant = getCurrentTenant();

    // Check frozen state for write operations
    if (tenant.isFrozen) {
      var request = context.switchToHttp().getRequest();
      var method = request.method;

      // Read operations are allowed on frozen tenants
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        return true;
      }

      // Write operations are blocked
      throw new HttpException(
        {
          statusCode: 503,
          error: 'WRITE_FROZEN',
          message:
            'This school is currently in maintenance mode. Read operations are available. Write operations will resume shortly.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return true;
  }
}
