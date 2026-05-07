import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/require-permission.decorator';
import { PlatformAdminService } from './platform-admin.service';

/**
 * Cycle 31 Step 9 — Platform Admin Controller.
 *
 * Read-only cross-tenant operational dashboard. Every route is gated
 * on sys-001:admin (Platform Admin only). School Admins do NOT reach
 * this surface; the data crosses school boundaries.
 *
 * Routes mounted under /api/v1/admin/platform/* so the audience is
 * explicit alongside the Cycle 31 Step 7 DLQ controller at
 * /api/v1/admin/dlq/*.
 */
@ApiTags('Platform Admin')
@Controller('admin/platform')
export class PlatformAdminController {
  constructor(private readonly svc: PlatformAdminService) {}

  @Get('tenants')
  @RequirePermission('sys-001:admin')
  @ApiOperation({
    summary:
      'List every tenant with schema name + frozen flag + base table count + pending DLQ rows.',
  })
  tenants() {
    return this.svc.listTenants();
  }

  @Get('partitions')
  @RequirePermission('sys-001:admin')
  @ApiOperation({
    summary: 'Enumerate every RANGE/HASH partition leaf with row count + size.',
  })
  partitions(@Query('parentTable') parentTable?: string) {
    return this.svc.listPartitions(parentTable);
  }

  @Get('migrations')
  @RequirePermission('sys-001:admin')
  @ApiOperation({
    summary:
      'Merged migration history. Platform via _prisma_migrations; tenant via source-of-truth note.',
  })
  migrations(@Query('scope') scope?: 'platform' | 'tenant', @Query('limit') limit?: string) {
    return this.svc.listMigrations({
      scope,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
