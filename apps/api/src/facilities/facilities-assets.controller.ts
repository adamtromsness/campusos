import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { FireDrillService } from './fire-drill.service';
import { AssetService } from './asset.service';
import { EnergyService } from './energy.service';
import { SpaceUtilisationService } from './space-utilisation.service';
import { SustainabilityService } from './sustainability.service';
import {
  AssetCategoryResponseDto,
  AssetDisposalResponseDto,
  AssetMaintenanceResponseDto,
  AssetResponseDto,
  AssetStatus,
  CreateAssetCategoryDto,
  CreateAssetDto,
  CreateAssetMaintenanceDto,
  CreateEnergyReadingDto,
  CreateEnergyTargetDto,
  CreateFireDrillDto,
  CreateSpaceUtilisationDto,
  CreateSustainabilityInitiativeDto,
  CreateUtilityMeterDto,
  DecommissionAssetDto,
  DisposeAssetDto,
  EnergyReadingResponseDto,
  EnergySummaryRowDto,
  EnergyTargetResponseDto,
  EnergyTrendResponseDto,
  FireDrillComplianceRowDto,
  FireDrillResponseDto,
  MaintenanceOverdueRowDto,
  ReplacementPlanningRowDto,
  SpaceUtilisationResponseDto,
  SustainabilityCategory,
  SustainabilityInitiativeResponseDto,
  SustainabilityStatus,
  UnderusedSpaceRowDto,
  UpdateAssetCategoryDto,
  UpdateAssetDto,
  UpdateSustainabilityInitiativeDto,
  UpdateUtilityMeterDto,
  UtilityMeterResponseDto,
  UtilityType,
} from './dto/facilities.dto';

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
 * FacilitiesAssetsController — P2-18b endpoint surface (~22 routes).
 *
 * Fire drills, asset lifecycle (categories + assets + maintenance +
 * decommission + dispose + dashboards), energy (meters + readings +
 * targets + trend + summary), space utilisation (record + per-space +
 * underused), and sustainability initiatives.
 *
 * Permission codes per the FAC catalogue:
 *   FAC-004 (Building Safety & Compliance) — fire drills, assets,
 *                                            maintenance, dashboards
 *   FAC-005 (Energy & Sustainability)      — meters, readings,
 *                                            targets, utilisation,
 *                                            sustainability
 */
@ApiTags('Facilities Assets + Energy (P2-18b)')
@Controller()
export class FacilitiesAssetsController {
  constructor(
    private readonly drills: FireDrillService,
    private readonly assets: AssetService,
    private readonly energy: EnergyService,
    private readonly utilisation: SpaceUtilisationService,
    private readonly sustainability: SustainabilityService,
    private readonly actors: ActorContextService,
  ) {}

  // ── Fire drills ──

  @Get('facilities/fire-drills')
  @RequirePermission('fac-004:read')
  @ApiOperation({
    summary: 'List fire drills (FAC-004:read). Optional building / date-range filters.',
  })
  async listDrills(
    @Query('buildingId') buildingId?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ): Promise<FireDrillResponseDto[]> {
    return this.drills.list({ buildingId, fromDate, toDate });
  }

  @Get('facilities/fire-drills/compliance')
  @RequirePermission('fac-004:read')
  @ApiOperation({
    summary:
      'Building-by-building fire drill compliance — flags buildings with no drill in the trailing 90 days. Emits fac.fire_drill.overdue per overdue row.',
  })
  async drillCompliance(): Promise<FireDrillComplianceRowDto[]> {
    return this.drills.compliance();
  }

  @Get('facilities/fire-drills/:id')
  @RequirePermission('fac-004:read')
  async getDrill(@Param('id') id: string): Promise<FireDrillResponseDto> {
    return this.drills.getById(id);
  }

  @Post('facilities/fire-drills')
  @RequirePermission('fac-004:write')
  @ApiOperation({
    summary:
      'Log a fire drill (FAC-004:write). met_target is computed from target_evacuation_seconds at insert time.',
  })
  async createDrill(
    @Body() body: CreateFireDrillDto,
    @Req() req: AuthedRequest,
  ): Promise<FireDrillResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.drills.create(body, actor);
  }

  // ── Asset categories ──

  @Get('facilities/asset-categories')
  @RequirePermission('fac-004:read')
  async listAssetCategories(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<AssetCategoryResponseDto[]> {
    return this.assets.listCategories(includeInactive === 'true');
  }

  @Post('facilities/asset-categories')
  @RequirePermission('fac-004:write')
  async createAssetCategory(
    @Body() body: CreateAssetCategoryDto,
    @Req() req: AuthedRequest,
  ): Promise<AssetCategoryResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.assets.createCategory(body, actor);
  }

  @Patch('facilities/asset-categories/:id')
  @RequirePermission('fac-004:write')
  async patchAssetCategory(
    @Param('id') id: string,
    @Body() body: UpdateAssetCategoryDto,
    @Req() req: AuthedRequest,
  ): Promise<AssetCategoryResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.assets.patchCategory(id, body, actor);
  }

  // ── Assets ──

  @Get('facilities/assets')
  @RequirePermission('fac-004:read')
  async listAssets(
    @Query('status') status?: AssetStatus,
    @Query('categoryId') categoryId?: string,
    @Query('buildingId') buildingId?: string,
  ): Promise<AssetResponseDto[]> {
    return this.assets.listAssets({ status, categoryId, buildingId });
  }

  @Get('facilities/assets/maintenance-overdue')
  @RequirePermission('fac-004:read')
  @ApiOperation({
    summary:
      'Assets whose most-recent maintenance record carries next_maintenance_date < CURRENT_DATE. ACTIVE + UNDER_MAINTENANCE only.',
  })
  async maintenanceOverdue(): Promise<MaintenanceOverdueRowDto[]> {
    return this.assets.maintenanceOverdue();
  }

  @Get('facilities/assets/replacement-planning')
  @RequirePermission('fac-004:read')
  @ApiOperation({
    summary:
      'ACTIVE assets sorted by replacement_priority then projected end-of-life ascending (CRITICAL items nearing lifespan end first).',
  })
  async replacementPlanning(): Promise<ReplacementPlanningRowDto[]> {
    return this.assets.replacementPlanning();
  }

  @Get('facilities/assets/:id')
  @RequirePermission('fac-004:read')
  async getAsset(@Param('id') id: string): Promise<AssetResponseDto> {
    return this.assets.getAsset(id);
  }

  @Post('facilities/assets')
  @RequirePermission('fac-004:write')
  async createAsset(
    @Body() body: CreateAssetDto,
    @Req() req: AuthedRequest,
  ): Promise<AssetResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.assets.createAsset(body, actor);
  }

  @Patch('facilities/assets/:id')
  @RequirePermission('fac-004:write')
  async patchAsset(
    @Param('id') id: string,
    @Body() body: UpdateAssetDto,
    @Req() req: AuthedRequest,
  ): Promise<AssetResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.assets.patchAsset(id, body, actor);
  }

  @Patch('facilities/assets/:id/decommission')
  @RequirePermission('fac-004:write')
  @ApiOperation({
    summary:
      'Flip an asset to DECOMMISSIONED. Stamps decommissioned_at + decommissioned_by atomically with the status flip.',
  })
  async decommissionAsset(
    @Param('id') id: string,
    @Body() body: DecommissionAssetDto,
    @Req() req: AuthedRequest,
  ): Promise<AssetResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.assets.decommission(id, body, actor);
  }

  @Post('facilities/assets/:id/dispose')
  @RequirePermission('fac-004:write')
  @ApiOperation({
    summary:
      'KEYSTONE — Dispose of a DECOMMISSIONED asset. Refuses if status is not DECOMMISSIONED. UNIQUE(asset_id) on fac_asset_disposals catches double-dispose.',
  })
  async disposeAsset(
    @Param('id') id: string,
    @Body() body: DisposeAssetDto,
    @Req() req: AuthedRequest,
  ): Promise<AssetDisposalResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.assets.dispose(id, body, actor);
  }

  // ── Asset maintenance ──

  @Get('facilities/assets/:id/maintenance')
  @RequirePermission('fac-004:read')
  async listMaintenance(@Param('id') id: string): Promise<AssetMaintenanceResponseDto[]> {
    return this.assets.listMaintenance(id);
  }

  @Post('facilities/assets/:id/maintenance')
  @RequirePermission('fac-004:write')
  async recordMaintenance(
    @Param('id') id: string,
    @Body() body: CreateAssetMaintenanceDto,
    @Req() req: AuthedRequest,
  ): Promise<AssetMaintenanceResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.assets.recordMaintenance(id, body, actor);
  }

  // ── Energy meters ──

  @Get('facilities/utility-meters')
  @RequirePermission('fac-005:read')
  async listMeters(
    @Query('utilityType') utilityType?: UtilityType,
    @Query('buildingId') buildingId?: string,
    @Query('includeInactive') includeInactive?: string,
  ): Promise<UtilityMeterResponseDto[]> {
    return this.energy.listMeters({
      utilityType,
      buildingId,
      includeInactive: includeInactive === 'true',
    });
  }

  @Post('facilities/utility-meters')
  @RequirePermission('fac-005:write')
  async createMeter(
    @Body() body: CreateUtilityMeterDto,
    @Req() req: AuthedRequest,
  ): Promise<UtilityMeterResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.energy.createMeter(body, actor);
  }

  @Patch('facilities/utility-meters/:id')
  @RequirePermission('fac-005:write')
  async patchMeter(
    @Param('id') id: string,
    @Body() body: UpdateUtilityMeterDto,
    @Req() req: AuthedRequest,
  ): Promise<UtilityMeterResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.energy.patchMeter(id, body, actor);
  }

  // ── Energy readings ──

  @Post('facilities/energy-readings')
  @RequirePermission('fac-005:write')
  @ApiOperation({
    summary:
      'KEYSTONE — Record an energy reading. consumption is auto-computed at insert time inside one tenant tx by subtracting the most-recent earlier reading on the same meter. UNIQUE(meter_id, reading_date) catches duplicate-day inserts.',
  })
  async recordReading(
    @Body() body: CreateEnergyReadingDto,
    @Req() req: AuthedRequest,
  ): Promise<EnergyReadingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.energy.recordReading(body, actor);
  }

  @Get('facilities/energy/:meterId/trend')
  @RequirePermission('fac-005:read')
  @ApiOperation({
    summary:
      'Per-meter consumption trend — readings ordered oldest-first with running totalConsumption + totalCost.',
  })
  async energyTrend(
    @Param('meterId') meterId: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ): Promise<EnergyTrendResponseDto> {
    return this.energy.trend(meterId, { fromDate, toDate });
  }

  @Get('facilities/energy/summary')
  @RequirePermission('fac-005:read')
  @ApiOperation({
    summary:
      'School-wide energy summary — trailing 30 days actual consumption by utility type vs MONTHLY target (variancePercent computed).',
  })
  async energySummary(): Promise<EnergySummaryRowDto[]> {
    return this.energy.summary();
  }

  // ── Energy targets ──

  @Get('facilities/energy-targets')
  @RequirePermission('fac-005:read')
  async listTargets(): Promise<EnergyTargetResponseDto[]> {
    return this.energy.listTargets();
  }

  @Post('facilities/energy-targets')
  @RequirePermission('fac-005:write')
  async createTarget(
    @Body() body: CreateEnergyTargetDto,
    @Req() req: AuthedRequest,
  ): Promise<EnergyTargetResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.energy.createTarget(body, actor);
  }

  // ── Space utilisation ──

  @Post('facilities/space-utilisation')
  @RequirePermission('fac-005:write')
  @ApiOperation({
    summary:
      'Record a space utilisation snapshot. utilisation_rate is materialised at insert time as (occupancy_count / capacity).',
  })
  async recordUtilisation(
    @Body() body: CreateSpaceUtilisationDto,
    @Req() req: AuthedRequest,
  ): Promise<SpaceUtilisationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.utilisation.record(body, actor);
  }

  @Get('facilities/space-utilisation/underused')
  @RequirePermission('fac-005:read')
  @ApiOperation({
    summary:
      'Spaces whose trailing-30-day average utilisation_rate is strictly less than 0.5 — opportunities for consolidation.',
  })
  async underusedSpaces(): Promise<UnderusedSpaceRowDto[]> {
    return this.utilisation.underused();
  }

  @Get('facilities/space-utilisation/:spaceId')
  @RequirePermission('fac-005:read')
  async utilisationForSpace(
    @Param('spaceId') spaceId: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ): Promise<SpaceUtilisationResponseDto[]> {
    return this.utilisation.listForSpace(spaceId, { fromDate, toDate });
  }

  // ── Sustainability ──

  @Get('facilities/sustainability/dashboard')
  @RequirePermission('fac-005:read')
  @ApiOperation({ summary: 'ACTIVE sustainability initiatives ordered by start_date DESC.' })
  async sustainabilityDashboard(): Promise<SustainabilityInitiativeResponseDto[]> {
    return this.sustainability.dashboard();
  }

  @Get('facilities/sustainability')
  @RequirePermission('fac-005:read')
  async listInitiatives(
    @Query('status') status?: SustainabilityStatus,
    @Query('category') category?: SustainabilityCategory,
  ): Promise<SustainabilityInitiativeResponseDto[]> {
    return this.sustainability.list({ status, category });
  }

  @Post('facilities/sustainability')
  @RequirePermission('fac-005:write')
  async createInitiative(
    @Body() body: CreateSustainabilityInitiativeDto,
    @Req() req: AuthedRequest,
  ): Promise<SustainabilityInitiativeResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.sustainability.create(body, actor);
  }

  @Patch('facilities/sustainability/:id')
  @RequirePermission('fac-005:write')
  async patchInitiative(
    @Param('id') id: string,
    @Body() body: UpdateSustainabilityInitiativeDto,
    @Req() req: AuthedRequest,
  ): Promise<SustainabilityInitiativeResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.sustainability.patch(id, body, actor);
  }
}
