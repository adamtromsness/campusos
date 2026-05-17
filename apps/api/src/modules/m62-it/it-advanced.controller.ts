import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import {
  DeviceUsageService,
  InventoryAuditService,
  LicenceRenewalService,
  RemoteActionService,
} from './remote-actions.service';
import {
  ConfigDocumentationService,
  InfrastructureExtensionService,
  MonitoringService,
  PhoneExtensionService,
} from './voip-monitoring.service';
import {
  AcknowledgeAlertDto,
  AssignPhoneExtensionDto,
  ConfigDocCategory,
  ConfigDocDto,
  CreateConfigDocDto,
  CreateDeviceUsageDto,
  CreateInventoryAuditDto,
  CreateLicenceRenewalDto,
  CreateMonitoringCheckDto,
  CreatePhoneExtensionDto,
  CreateRemoteActionDto,
  DeviceUsageDto,
  InventoryAuditDto,
  InventoryAuditItemDto,
  InventoryAuditReportDto,
  LicenceRenewalDto,
  MonitoringAlertDto,
  MonitoringCheckDto,
  PhoneExtensionDto,
  RecordCheckResultDto,
  RemoteActionDto,
  ScanAuditItemDto,
  UpdateConfigDocDto,
  PatchInfrastructureItemDto,
  UpdateMonitoringCheckDto,
  UpdatePhoneExtensionDto,
  UpdateRemoteActionStatusDto,
} from './dto/it.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    personId: string;
    email: string;
    displayName: string;
    sessionId: string;
  };
}

/**
 * P2-20a — IT Advanced controller. Distinct from the Cycle 22
 * ItController to keep the surface boundary clear. Mounts under the
 * same /it/* path prefix.
 */
@ApiTags('IT Advanced')
@Controller()
export class ItAdvancedController {
  constructor(
    private readonly remoteActions: RemoteActionService,
    private readonly audits: InventoryAuditService,
    private readonly renewals: LicenceRenewalService,
    private readonly usage: DeviceUsageService,
    private readonly extensions: PhoneExtensionService,
    private readonly docs: ConfigDocumentationService,
    private readonly monitoring: MonitoringService,
    private readonly infraExtension: InfrastructureExtensionService,
    private readonly actors: ActorContextService,
  ) {}

  private async resolveActor(req: AuthedRequest) {
    if (!req.user) {
      throw new Error('Unauthenticated request reached IT Advanced controller');
    }
    return this.actors.resolveActor(req.user.sub, req.user.personId);
  }

  // ── Remote MDM actions (IMMUTABLE) ──

  @Get('it/devices/:assetId/remote-actions')
  @RequirePermission('it-002:read')
  @ApiOperation({
    summary: 'List remote MDM action history for an asset — IT admins only',
  })
  async listRemoteActions(
    @Param('assetId') assetId: string,
    @Req() req: AuthedRequest,
  ): Promise<RemoteActionDto[]> {
    return this.remoteActions.listForAsset(assetId, await this.resolveActor(req));
  }

  @Post('it/devices/:assetId/remote-action')
  @RequirePermission('it-002:write')
  @ApiOperation({
    summary:
      'Issue a remote MDM action — IMMUTABLE audit row with mandatory justification (>= 20 chars). WIPE + COMPLETED auto-resets tech_assets.status to AVAILABLE.',
  })
  async createRemoteAction(
    @Param('assetId') assetId: string,
    @Body() dto: CreateRemoteActionDto,
    @Req() req: AuthedRequest,
  ): Promise<RemoteActionDto> {
    return this.remoteActions.create(assetId, dto, await this.resolveActor(req));
  }

  @Patch('it/remote-actions/:id/status')
  @RequirePermission('it-002:write')
  @ApiOperation({
    summary:
      'MDM callback — update remote action status (PENDING/SENT/COMPLETED/FAILED). The IMMUTABLE invariant means only lifecycle fields are mutated. WIPE + COMPLETED also flips tech_assets.status to AVAILABLE inside one tenant tx.',
  })
  async updateRemoteActionStatus(
    @Param('id') id: string,
    @Body() dto: UpdateRemoteActionStatusDto,
    @Req() req: AuthedRequest,
  ): Promise<RemoteActionDto> {
    return this.remoteActions.updateStatus(id, dto, await this.resolveActor(req));
  }

  // ── Inventory audits ──

  @Get('it/inventory-audits')
  @RequirePermission('it-002:read')
  async listAudits(@Req() req: AuthedRequest): Promise<InventoryAuditDto[]> {
    return this.audits.list(await this.resolveActor(req));
  }

  @Get('it/inventory-audits/:id')
  @RequirePermission('it-002:read')
  async getAudit(@Param('id') id: string, @Req() req: AuthedRequest): Promise<InventoryAuditDto> {
    return this.audits.getById(id, await this.resolveActor(req));
  }

  @Post('it/inventory-audits')
  @RequirePermission('it-002:write')
  @ApiOperation({
    summary:
      'Start an inventory audit. Computes total_assets_expected from active tech_assets in scope.',
  })
  async createAudit(
    @Body() dto: CreateInventoryAuditDto,
    @Req() req: AuthedRequest,
  ): Promise<InventoryAuditDto> {
    return this.audits.create(dto, await this.resolveActor(req));
  }

  @Post('it/inventory-audits/:id/scan')
  @RequirePermission('it-002:write')
  @ApiOperation({
    summary:
      'Record a per-asset scan. Unknown asset tags land with asset_id=null and count as unrecorded.',
  })
  async scanAuditItem(
    @Param('id') id: string,
    @Body() dto: ScanAuditItemDto,
    @Req() req: AuthedRequest,
  ): Promise<InventoryAuditItemDto> {
    return this.audits.scan(id, dto, await this.resolveActor(req));
  }

  @Get('it/inventory-audits/:id/items')
  @RequirePermission('it-002:read')
  async listAuditItems(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<InventoryAuditItemDto[]> {
    return this.audits.listItems(id, await this.resolveActor(req));
  }

  @Post('it/inventory-audits/:id/complete')
  @RequirePermission('it-002:write')
  @ApiOperation({
    summary:
      'Finalize an audit. Computes totals from tech_inventory_audit_items and stamps completed_at inside one locked tenant tx.',
  })
  async completeAudit(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<InventoryAuditDto> {
    return this.audits.complete(id, await this.resolveActor(req));
  }

  @Get('it/inventory-audits/:id/report')
  @RequirePermission('it-002:read')
  @ApiOperation({
    summary:
      'Discrepancy report — lists missing assets, unrecorded assets, and condition observations from the audit roster.',
  })
  async auditReport(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<InventoryAuditReportDto> {
    return this.audits.report(id, await this.resolveActor(req));
  }

  // ── Licence renewals ──

  @Get('it/licences/:id/renewals')
  @RequirePermission('it-004:read')
  async listRenewals(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<LicenceRenewalDto[]> {
    return this.renewals.listForLicence(id, await this.resolveActor(req));
  }

  @Post('it/licences/:id/renew')
  @RequirePermission('it-004:write')
  @ApiOperation({
    summary:
      'Renew a software licence. Atomically records the renewal and updates tech_software_licences.expiry_date in one tenant tx.',
  })
  async renewLicence(
    @Param('id') id: string,
    @Body() dto: CreateLicenceRenewalDto,
    @Req() req: AuthedRequest,
  ): Promise<LicenceRenewalDto> {
    return this.renewals.renew(id, dto, await this.resolveActor(req));
  }

  // ── Device usage ──

  @Get('it/devices/:assetId/usage')
  @RequirePermission('it-002:read')
  async listUsage(
    @Param('assetId') assetId: string,
    @Req() req: AuthedRequest,
  ): Promise<DeviceUsageDto[]> {
    return this.usage.listForAsset(assetId, await this.resolveActor(req));
  }

  @Get('it/device-usage/flagged')
  @RequirePermission('it-002:read')
  async listFlaggedUsage(@Req() req: AuthedRequest): Promise<DeviceUsageDto[]> {
    return this.usage.listFlagged(await this.resolveActor(req));
  }

  @Post('it/devices/:assetId/usage')
  @RequirePermission('it-002:write')
  @ApiOperation({
    summary:
      'Record a daily usage summary. flagged_activity=true emits tech.usage.flagged for IT admin notification.',
  })
  async recordUsage(
    @Param('assetId') assetId: string,
    @Body() dto: CreateDeviceUsageDto,
    @Req() req: AuthedRequest,
  ): Promise<DeviceUsageDto> {
    return this.usage.record(assetId, dto, await this.resolveActor(req));
  }

  // ── Phone extensions ──

  @Get('it/phone-extensions')
  @RequirePermission('it-007:read')
  async listExtensions(
    @Req() req: AuthedRequest,
    @Query('search') search?: string,
    @Query('department') department?: string,
    @Query('includeInactive') includeInactive?: string,
  ): Promise<PhoneExtensionDto[]> {
    return this.extensions.list(await this.resolveActor(req), {
      search,
      department,
      includeInactive: includeInactive === 'true',
    });
  }

  @Get('it/phone-extensions/:id')
  @RequirePermission('it-007:read')
  async getExtension(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<PhoneExtensionDto> {
    return this.extensions.getById(id, await this.resolveActor(req));
  }

  @Post('it/phone-extensions')
  @RequirePermission('it-007:write')
  async createExtension(
    @Body() dto: CreatePhoneExtensionDto,
    @Req() req: AuthedRequest,
  ): Promise<PhoneExtensionDto> {
    return this.extensions.create(dto, await this.resolveActor(req));
  }

  @Patch('it/phone-extensions/:id')
  @RequirePermission('it-007:write')
  async patchExtension(
    @Param('id') id: string,
    @Body() dto: UpdatePhoneExtensionDto,
    @Req() req: AuthedRequest,
  ): Promise<PhoneExtensionDto> {
    return this.extensions.patch(id, dto, await this.resolveActor(req));
  }

  @Post('it/phone-extensions/:id/assign')
  @RequirePermission('it-007:write')
  async assignExtension(
    @Param('id') id: string,
    @Body() dto: AssignPhoneExtensionDto,
    @Req() req: AuthedRequest,
  ): Promise<PhoneExtensionDto> {
    return this.extensions.assign(id, dto, await this.resolveActor(req));
  }

  @Post('it/phone-extensions/:id/unassign')
  @RequirePermission('it-007:write')
  async unassignExtension(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<PhoneExtensionDto> {
    return this.extensions.unassign(id, await this.resolveActor(req));
  }

  // ── Configuration documentation ──

  @Get('it/documentation')
  @RequirePermission('it-009:read')
  async listDocs(
    @Req() req: AuthedRequest,
    @Query('category') category?: ConfigDocCategory,
  ): Promise<ConfigDocDto[]> {
    return this.docs.list(await this.resolveActor(req), category);
  }

  @Get('it/documentation/:id')
  @RequirePermission('it-009:read')
  async getDoc(@Param('id') id: string, @Req() req: AuthedRequest): Promise<ConfigDocDto> {
    return this.docs.getById(id, await this.resolveActor(req));
  }

  @Post('it/documentation')
  @RequirePermission('it-009:write')
  async createDoc(
    @Body() dto: CreateConfigDocDto,
    @Req() req: AuthedRequest,
  ): Promise<ConfigDocDto> {
    return this.docs.create(dto, await this.resolveActor(req));
  }

  @Patch('it/documentation/:id')
  @RequirePermission('it-009:write')
  @ApiOperation({
    summary:
      'Update IT documentation. Locked-row pattern auto-increments version inside one tenant tx so concurrent updates do not collide on the same version number.',
  })
  async patchDoc(
    @Param('id') id: string,
    @Body() dto: UpdateConfigDocDto,
    @Req() req: AuthedRequest,
  ): Promise<ConfigDocDto> {
    return this.docs.patch(id, dto, await this.resolveActor(req));
  }

  // ── Monitoring ──

  @Get('it/monitoring')
  @RequirePermission('it-006:read')
  async listMonitoringChecks(@Req() req: AuthedRequest): Promise<MonitoringCheckDto[]> {
    return this.monitoring.listChecks(await this.resolveActor(req));
  }

  @Get('it/monitoring/:id')
  @RequirePermission('it-006:read')
  async getMonitoringCheck(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<MonitoringCheckDto> {
    return this.monitoring.getCheckById(id, await this.resolveActor(req));
  }

  @Post('it/monitoring')
  @RequirePermission('it-006:write')
  async createMonitoringCheck(
    @Body() dto: CreateMonitoringCheckDto,
    @Req() req: AuthedRequest,
  ): Promise<MonitoringCheckDto> {
    return this.monitoring.createCheck(dto, await this.resolveActor(req));
  }

  @Patch('it/monitoring/:id')
  @RequirePermission('it-006:write')
  async patchMonitoringCheck(
    @Param('id') id: string,
    @Body() dto: UpdateMonitoringCheckDto,
    @Req() req: AuthedRequest,
  ): Promise<MonitoringCheckDto> {
    return this.monitoring.patchCheck(id, dto, await this.resolveActor(req));
  }

  @Post('it/monitoring/:id/result')
  @RequirePermission('it-006:write')
  @ApiOperation({
    summary:
      'Record a check result (HEALTHY / DEGRADED / DOWN). Crossing the consecutive_failures_to_alert threshold creates a tech_monitoring_alerts row and emits tech.monitoring.alert. HEALTHY after DOWN resolves the active alert and inserts a RECOVERED row.',
  })
  async recordCheckResult(
    @Param('id') id: string,
    @Body() dto: RecordCheckResultDto,
    @Req() req: AuthedRequest,
  ): Promise<MonitoringCheckDto> {
    return this.monitoring.recordResult(id, dto, await this.resolveActor(req));
  }

  @Get('it/monitoring-alerts')
  @RequirePermission('it-006:read')
  async listMonitoringAlerts(
    @Req() req: AuthedRequest,
    @Query('activeOnly') activeOnly?: string,
  ): Promise<MonitoringAlertDto[]> {
    return this.monitoring.listAlerts(await this.resolveActor(req), activeOnly === 'true');
  }

  @Patch('it/monitoring-alerts/:id/acknowledge')
  @RequirePermission('it-006:write')
  async acknowledgeAlert(
    @Param('id') id: string,
    @Body() dto: AcknowledgeAlertDto,
    @Req() req: AuthedRequest,
  ): Promise<MonitoringAlertDto> {
    return this.monitoring.acknowledgeAlert(id, dto, await this.resolveActor(req));
  }

  // ── Infrastructure extension (P2-20 layer on Cycle 22) ──

  @Get('it/infrastructure/warranty-expiring')
  @RequirePermission('it-007:read')
  async warrantyExpiring(
    @Req() req: AuthedRequest,
    @Query('days') days?: string,
  ): Promise<
    Array<{
      id: string;
      itemName: string;
      itemType: string;
      location: string;
      warrantyExpiry: string;
      daysUntilExpiry: number;
    }>
  > {
    const daysAhead = days ? Math.max(1, parseInt(days, 10)) : 30;
    return this.infraExtension.warrantyExpiring(await this.resolveActor(req), daysAhead);
  }

  @Patch('it/infrastructure/:id/check')
  @RequirePermission('it-007:write')
  @ApiOperation({
    summary: 'Mark an infrastructure item as checked — stamps last_checked_at to now().',
  })
  async markInfrastructureChecked(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<{ id: string; lastCheckedAt: string }> {
    return this.infraExtension.markChecked(id, await this.resolveActor(req));
  }

  @Patch('it/infrastructure/:id')
  @RequirePermission('it-007:write')
  async patchInfrastructure(
    @Param('id') id: string,
    @Body() dto: PatchInfrastructureItemDto,
    @Req() req: AuthedRequest,
  ): Promise<{ id: string }> {
    return this.infraExtension.patch(id, dto, await this.resolveActor(req));
  }
}
