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
    var requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No @RequirePermission → endpoint only needs auth (which already passed)
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    // Get authenticated user from request (set by AuthGuard)
    var request = context.switchToHttp().getRequest();
    var user = request.user;

    if (!user || !user.sub) {
      throw new ForbiddenException('No authenticated user context');
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

    // Find the scope for this tenant
    // The scope ID is looked up from iam_scope by school entity
    var scopeId = await this.resolveScopeId(tenant.schoolId);

    if (!scopeId) {
      throw new ForbiddenException('No IAM scope configured for this school');
    }

    // Check if user has ANY of the required permissions
    var hasPermission = await this.permissionCheckService.hasAnyPermission(
      user.sub,
      scopeId,
      requiredPermissions,
    );

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
   * Resolve the IAM scope ID for a school.
   * Looks up iam_scope where entity_id = schoolId and scope type = SCHOOL.
   */
  private async resolveScopeId(schoolId: string): Promise<string | null> {
    // Use the permission check service's prisma client
    var scope = await (this.permissionCheckService as any).prisma.iamScope.findFirst({
      where: {
        entityId: schoolId,
        scopeType: { code: 'SCHOOL' },
        isActive: true,
      },
      select: { id: true },
    });

    // If no school scope, try platform scope (for platform admins)
    if (!scope) {
      var platformScope = await (this.permissionCheckService as any).prisma.iamScope.findFirst({
        where: {
          scopeType: { code: 'PLATFORM' },
          isActive: true,
        },
        select: { id: true },
      });
      return platformScope ? platformScope.id : null;
    }

    return scope.id;
  }
}
