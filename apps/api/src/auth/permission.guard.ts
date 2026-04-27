import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from './require-permission.decorator';
import { PermissionCheckService } from '../iam/permission-check.service';
import { getCurrentTenant } from '../tenant/tenant.context';

/**
 * PermissionGuard
 *
 * Enforces @RequirePermission on controller methods.
 * Reads the authenticated user from request.user (set by AuthGuard)
 * and checks the effective access cache for the required permissions.
 *
 * Guard chain (final position):
 * TenantResolverMiddleware -> AuthGuard -> TenantGuard -> **PermissionGuard**
 *
 * If no @RequirePermission is set on the endpoint, the guard passes
 * (the endpoint only requires authentication, not a specific permission).
 *
 * If @RequirePermission specifies multiple codes, ANY match is sufficient.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionCheckService: PermissionCheckService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Get required permissions from decorator metadata
    var requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @RequirePermission → endpoint only needs auth (which already passed)
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    // Get authenticated user from request (set by AuthGuard).
    // AuthGuard must run before this guard — registration order is enforced
    // explicitly in AppModule. Failing open here was a previous bug that let
    // any tenant-scoped request through @RequirePermission gates.
    var request = context.switchToHttp().getRequest();
    var user = request.user;

    if (!user || !user.sub) {
      throw new ForbiddenException('Authentication context missing');
    }

    // Get current tenant scope
    var tenant: any;
    try {
      tenant = getCurrentTenant();
    } catch (e) {
      // No tenant context — might be a platform-scoped endpoint
      // For now, deny access without a scope
      throw new ForbiddenException('No tenant scope for permission check');
    }

    // Resolve the scope chain for this request. Platform Admins are assigned
    // at PLATFORM scope, school-scoped roles at SCHOOL scope, and so on. We
    // check from most-specific (school) to least-specific (platform) so a
    // Platform Admin acting against a tenant inherits their platform-level
    // permissions, while school-scoped users are bounded to their school.
    var scopeIds = await this.resolveScopeChain(tenant.schoolId);

    if (scopeIds.length === 0) {
      throw new ForbiddenException('No IAM scope configured for this request');
    }

    var hasPermission = false;
    for (var s = 0; s < scopeIds.length; s++) {
      var ok = await this.permissionCheckService.hasAnyPermission(
        user.sub,
        scopeIds[s]!,
        requiredPermissions,
      );
      if (ok) {
        hasPermission = true;
        break;
      }
    }

    if (!hasPermission) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'INSUFFICIENT_PERMISSIONS',
        message: 'You do not have the required permission for this action',
        required: requiredPermissions,
      });
    }

    return true;
  }

  /**
   * Resolve scope ids the request can satisfy, ordered most-specific first.
   * For a school-tenant request that's [school, platform]; a platform admin
   * is checked at PLATFORM after their school assignment misses (or as a
   * fallback when no school scope exists).
   */
  private async resolveScopeChain(schoolId: string): Promise<string[]> {
    var prisma = (this.permissionCheckService as any).prisma;
    var ids: string[] = [];

    var schoolScope = await prisma.iamScope.findFirst({
      where: { entityId: schoolId, scopeType: { code: 'SCHOOL' }, isActive: true },
      select: { id: true },
    });
    if (schoolScope) ids.push(schoolScope.id);

    var platformScope = await prisma.iamScope.findFirst({
      where: { scopeType: { code: 'PLATFORM' }, isActive: true },
      select: { id: true },
    });
    if (platformScope) ids.push(platformScope.id);

    return ids;
  }
}
