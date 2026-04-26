import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { RequirePermission } from './auth/require-permission.decorator';
import { Public } from './auth/public.decorator';

/**
 * Guard Test Controller
 *
 * Endpoints to verify the full guard chain:
 * TenantResolverMiddleware -> AuthGuard -> TenantGuard -> PermissionGuard
 *
 * Test with curl:
 *   # 1. Get a token
 *   TOKEN=$(curl -s -X POST http://localhost:4000/api/v1/auth/dev-login \
 *     -H "Content-Type: application/json" \
 *     -H "X-Tenant-Subdomain: demo" \
 *     -d '{"email":"admin@demo.campusos.dev"}' | jq -r '.accessToken')
 *
 *   # 2. Test public endpoint (no auth needed)
 *   curl http://localhost:4000/api/v1/guard-test/public
 *
 *   # 3. Test auth-only endpoint (needs token, no specific permission)
 *   curl http://localhost:4000/api/v1/guard-test/auth-only \
 *     -H "Authorization: Bearer $TOKEN" \
 *     -H "X-Tenant-Subdomain: demo"
 *
 *   # 4. Test permission-protected endpoint
 *   curl http://localhost:4000/api/v1/guard-test/attendance \
 *     -H "Authorization: Bearer $TOKEN" \
 *     -H "X-Tenant-Subdomain: demo"
 *
 * Remove this controller before production.
 */
@ApiTags('Guard Test')
@Controller('guard-test')
export class GuardTestController {

  @Public()
  @Get('public')
  @ApiOperation({ summary: 'Public endpoint — no auth required' })
  publicEndpoint() {
    return { status: 'ok', guard: 'none', message: 'This endpoint is public' };
  }

  @Get('auth-only')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Auth-only — needs token, no specific permission' })
  authOnly() {
    return { status: 'ok', guard: 'AuthGuard', message: 'You are authenticated' };
  }

  @Get('attendance')
  @ApiBearerAuth()
  @RequirePermission('att-001:read')
  @ApiOperation({ summary: 'Requires att-001:read permission' })
  attendanceRead() {
    return { status: 'ok', guard: 'PermissionGuard', permission: 'att-001:read', message: 'You can view attendance' };
  }

  @Get('grades')
  @ApiBearerAuth()
  @RequirePermission('tch-003:write')
  @ApiOperation({ summary: 'Requires tch-003:write permission' })
  gradesWrite() {
    return { status: 'ok', guard: 'PermissionGuard', permission: 'tch-003:write', message: 'You can write grades' };
  }

  @Get('admin-only')
  @ApiBearerAuth()
  @RequirePermission('sys-001:admin')
  @ApiOperation({ summary: 'Requires sys-001:admin — admin only' })
  adminOnly() {
    return { status: 'ok', guard: 'PermissionGuard', permission: 'sys-001:admin', message: 'You have admin access' };
  }
}
