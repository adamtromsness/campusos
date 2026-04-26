import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { getCurrentTenant } from './tenant.context';

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
 */
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
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
          message: 'This school is currently in maintenance mode. Read operations are available. Write operations will resume shortly.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return true;
  }
}
