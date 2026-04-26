import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { getRequestContext } from '../tenant/tenant.context';

export var IS_PUBLIC_KEY = 'isPublic';

/**
 * AuthGuard — JWT Validation
 *
 * Validates the JWT access token on every protected request.
 * Extracts user context and attaches it to the request object.
 *
 * Guard chain position:
 * TenantResolverMiddleware → **AuthGuard** → TenantGuard → PermissionGuard
 *
 * Use @Public() decorator to skip authentication on specific endpoints.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if endpoint is marked as public
    var isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    var request = context.switchToHttp().getRequest();
    var token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('No access token provided');
    }

    var payload = this.authService.verifyToken(token);

    if (!payload) {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    // Attach user info to request
    request.user = payload;

    // Also update the tenant context with user info
    var ctx = getRequestContext();
    if (ctx) {
      ctx.userId = payload.sub;
      ctx.personId = payload.personId;
      ctx.sessionId = payload.sessionId;
    }

    return true;
  }

  private extractToken(request: any): string | null {
    var authHeader = request.headers?.authorization;
    if (!authHeader) return null;

    var parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') return null;

    return parts[1] || null;
  }
}
