import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ConfigurationService, SetupStatusResponseDto } from './configuration.service';

/**
 * School Configuration Admin (per docs/campusos-school-configuration-admin.html).
 *
 * Step 1 — Configuration Hub backend. The hub at /admin/configuration
 * needs a single read endpoint to render its setup-completeness
 * checklist. Steps 2-7 layer the tree views (facility / academic /
 * position), the connections summary, the bulk imports, and the
 * grade-bands config on top of this module.
 *
 * Per-tenant — every endpoint resolves under the calling tenant's
 * schema. NOT @PlatformScoped() (that would be wrong here — schools
 * configure their OWN data; this is not a cross-tenant ops surface
 * like the platform-admin module).
 *
 * Gated on sys-001:admin which both the Platform Admin and School
 * Admin roles hold (per the seed-iam.ts everyFunction grant on
 * School Admin).
 */
@ApiTags('Configuration Admin')
@Controller('admin/configuration')
export class ConfigurationController {
  constructor(private readonly svc: ConfigurationService) {}

  @Get('setup-status')
  @RequirePermission('sys-001:admin')
  @ApiOperation({
    summary:
      'Setup-completeness checklist computed live from existing tenant data. ' +
      'Returns the 7-item checklist (buildings, rooms, academic year, classes, ' +
      'positions, staff assigned, classes in rooms) with DONE / PARTIAL / ' +
      'NOT_STARTED status per item.',
  })
  setupStatus(): Promise<SetupStatusResponseDto> {
    return this.svc.getSetupStatus();
  }
}
