import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { RepairService } from './repair.service';
import { PartsService } from './parts.service';
import { ComponentService } from './component.service';
import { FuelLogService } from './fuel-log.service';
import { DriverHoursService } from './driver-hours.service';
import { VehicleLifecycleService } from './vehicle-lifecycle.service';
import {
  CompleteDriverHoursDto,
  ComponentResponseDto,
  ComponentStatus,
  CreateComponentDto,
  CreateDriverHoursDto,
  CreateFuelLogDto,
  CreatePartDto,
  CreateRepairCategoryDto,
  CreateRepairDto,
  DriverApproachingLimitRowDto,
  DriverHoursLimitResponseDto,
  DriverHoursResponseDto,
  DriverHoursWeeklySummaryDto,
  FleetFuelSummaryRowDto,
  FleetReplacementRowDto,
  FuelLogResponseDto,
  PartResponseDto,
  RecordDisposalDto,
  RepairCategoryResponseDto,
  RepairResponseDto,
  RestockPartDto,
  UpdateComponentDto,
  UpdateDriverHoursLimitDto,
  UpdatePartDto,
  UpdateRepairCategoryDto,
  UpdateRepairDto,
  UpdateVehicleLifecycleDto,
  VehicleLifecycleResponseDto,
} from './dto/fleet-maintenance.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

/**
 * Fleet Maintenance + Fuel + Driver Hours Controller — P2-11a.
 *
 * 24 endpoints across 6 service files. Gating:
 *   TRN-002 (Fleet Management) — repairs, parts, components, fuel,
 *     vehicle lifecycle.
 *   TRN-003 (Driver Operations) — driver hours read + write and limit
 *     config admin.
 *
 * Generic Staff holds TRN-002:read+write and TRN-003:read+write per
 * the IAM seed. School Admin and Platform Admin pick up admin via
 * everyFunction.
 */
@ApiTags('transport-fleet')
@Controller({ version: '1' })
export class FleetMaintenanceController {
  constructor(
    private readonly repairs: RepairService,
    private readonly parts: PartsService,
    private readonly components: ComponentService,
    private readonly fuel: FuelLogService,
    private readonly hours: DriverHoursService,
    private readonly lifecycle: VehicleLifecycleService,
    private readonly actors: ActorContextService,
  ) {}

  // ── Repair categories ──
  @Get('transport/repair-categories')
  @RequirePermission('trn-002:read')
  @ApiOperation({ summary: 'List repair categories' })
  async listCategories(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<RepairCategoryResponseDto[]> {
    return this.repairs.listCategories(includeInactive === 'true');
  }

  @Post('transport/repair-categories')
  @RequirePermission('trn-002:write')
  @ApiOperation({ summary: 'Create a repair category' })
  async createCategory(
    @Req() req: AuthedRequest,
    @Body() body: CreateRepairCategoryDto,
  ): Promise<RepairCategoryResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.repairs.createCategory(body, actor);
  }

  @Patch('transport/repair-categories/:id')
  @RequirePermission('trn-002:write')
  @ApiOperation({ summary: 'Update a repair category' })
  async patchCategory(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateRepairCategoryDto,
  ): Promise<RepairCategoryResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.repairs.patchCategory(id, body, actor);
  }

  // ── Repairs ──
  @Get('transport/vehicles/:id/repairs')
  @RequirePermission('trn-002:read')
  @ApiOperation({ summary: 'List repairs for a vehicle (newest first)' })
  async listRepairs(@Param('id') vehicleId: string): Promise<RepairResponseDto[]> {
    return this.repairs.listForVehicle(vehicleId);
  }

  @Post('transport/vehicles/:id/repairs')
  @RequirePermission('trn-002:write')
  @ApiOperation({
    summary:
      'Log a repair. Safety-critical repairs that are not COMPLETED flip the vehicle to MAINTENANCE inside the same tenant transaction.',
  })
  async createRepair(
    @Req() req: AuthedRequest,
    @Param('id') vehicleId: string,
    @Body() body: CreateRepairDto,
  ): Promise<RepairResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.repairs.create(vehicleId, body, actor);
  }

  @Patch('transport/repairs/:id')
  @RequirePermission('trn-002:write')
  @ApiOperation({
    summary:
      'Update a repair. Completing a safety-critical repair releases the vehicle back to ACTIVE when no other open safety-critical repairs remain.',
  })
  async patchRepair(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateRepairDto,
  ): Promise<RepairResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.repairs.patch(id, body, actor);
  }

  @Get('transport/repairs/outstanding')
  @RequirePermission('trn-002:read')
  @ApiOperation({
    summary: 'List vehicles with open safety-critical repairs blocking dispatch.',
  })
  async listOutstandingRepairs(): Promise<RepairResponseDto[]> {
    return this.repairs.listOutstandingSafetyCritical();
  }

  // ── Parts ──
  @Get('transport/parts')
  @RequirePermission('trn-002:read')
  @ApiOperation({ summary: 'List parts inventory' })
  async listParts(@Query('lowStockOnly') lowStockOnly?: string): Promise<PartResponseDto[]> {
    return this.parts.list({ lowStockOnly: lowStockOnly === 'true' });
  }

  @Get('transport/parts/low-stock')
  @RequirePermission('trn-002:read')
  @ApiOperation({ summary: 'List parts at or below min_stock_level' })
  async listLowStock(): Promise<PartResponseDto[]> {
    return this.parts.list({ lowStockOnly: true });
  }

  @Post('transport/parts')
  @RequirePermission('trn-002:write')
  @ApiOperation({ summary: 'Create a part inventory row' })
  async createPart(
    @Req() req: AuthedRequest,
    @Body() body: CreatePartDto,
  ): Promise<PartResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.parts.create(body, actor);
  }

  @Patch('transport/parts/:id')
  @RequirePermission('trn-002:write')
  @ApiOperation({ summary: 'Update a part inventory row' })
  async patchPart(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdatePartDto,
  ): Promise<PartResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.parts.patch(id, body, actor);
  }

  @Post('transport/parts/:id/restock')
  @RequirePermission('trn-002:write')
  @ApiOperation({
    summary:
      'Restock or consume parts. Emits trn.parts.low when the running total crosses the configured minimum.',
  })
  async restockPart(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: RestockPartDto,
  ): Promise<PartResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.parts.restock(id, body, actor);
  }

  // ── Components ──
  @Get('transport/vehicles/:id/components')
  @RequirePermission('trn-002:read')
  @ApiOperation({ summary: 'List components installed on a vehicle' })
  async listComponents(
    @Param('id') vehicleId: string,
    @Query('status') status?: ComponentStatus,
  ): Promise<ComponentResponseDto[]> {
    return this.components.listForVehicle(vehicleId, { status });
  }

  @Post('transport/vehicles/:id/components')
  @RequirePermission('trn-002:write')
  @ApiOperation({ summary: 'Install a component on a vehicle' })
  async createComponent(
    @Req() req: AuthedRequest,
    @Param('id') vehicleId: string,
    @Body() body: CreateComponentDto,
  ): Promise<ComponentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.components.create(vehicleId, body, actor);
  }

  @Patch('transport/components/:id')
  @RequirePermission('trn-002:write')
  @ApiOperation({ summary: 'Replace or mark-failed a component' })
  async patchComponent(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateComponentDto,
  ): Promise<ComponentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.components.patch(id, body, actor);
  }

  @Get('transport/components/approaching-end-of-life')
  @RequirePermission('trn-002:read')
  @ApiOperation({
    summary: 'Active components within 90 percent of expected_life_months.',
  })
  async approachingEndOfLife(): Promise<ComponentResponseDto[]> {
    return this.components.listApproachingEndOfLife();
  }

  // ── Fuel logs ──
  @Get('transport/vehicles/:id/fuel')
  @RequirePermission('trn-002:read')
  @ApiOperation({ summary: 'List fuel logs with computed efficiency per row' })
  async listFuel(@Param('id') vehicleId: string): Promise<FuelLogResponseDto[]> {
    return this.fuel.listForVehicle(vehicleId);
  }

  @Post('transport/vehicles/:id/fuel')
  @RequirePermission('trn-002:write')
  @ApiOperation({ summary: 'Log a refuel event' })
  async createFuel(
    @Req() req: AuthedRequest,
    @Param('id') vehicleId: string,
    @Body() body: CreateFuelLogDto,
  ): Promise<FuelLogResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.fuel.create(vehicleId, body, actor);
  }

  @Get('transport/fuel/fleet-summary')
  @RequirePermission('trn-002:read')
  @ApiOperation({
    summary: 'Per-vehicle per-month rollup of cost and quantity for the last 180 days.',
  })
  async fuelFleetSummary(): Promise<FleetFuelSummaryRowDto[]> {
    return this.fuel.fleetSummary();
  }

  // ── Driver hours ──
  @Get('transport/drivers/:id/hours')
  @RequirePermission('trn-003:read')
  @ApiOperation({ summary: 'List driver hours logs (filterable by date range)' })
  async listDriverHours(
    @Param('id') driverId: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ): Promise<DriverHoursResponseDto[]> {
    return this.hours.listForDriver(driverId, { fromDate, toDate });
  }

  @Get('transport/drivers/:id/hours/weekly-summary')
  @RequirePermission('trn-003:read')
  @ApiOperation({
    summary:
      'Weekly summary for the ISO week of today — total driving minutes vs the configured weekly limit.',
  })
  async weeklySummary(@Param('id') driverId: string): Promise<DriverHoursWeeklySummaryDto> {
    return this.hours.weeklySummary(driverId);
  }

  @Post('transport/drivers/:id/hours')
  @RequirePermission('trn-003:write')
  @ApiOperation({ summary: 'Start a duty period' })
  async startDuty(
    @Req() req: AuthedRequest,
    @Param('id') driverId: string,
    @Body() body: CreateDriverHoursDto,
  ): Promise<DriverHoursResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.hours.create(driverId, body, actor);
  }

  @Patch('transport/driver-hours/:id/complete')
  @RequirePermission('trn-003:write')
  @ApiOperation({
    summary:
      'Close a duty period. Recomputes cumulative_weekly_minutes from the ISO week of dutyEndAt and emits trn.driver.hours_approaching_limit on threshold crossing.',
  })
  async completeDuty(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: CompleteDriverHoursDto,
  ): Promise<DriverHoursResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.hours.complete(id, body, actor);
  }

  @Get('transport/drivers/approaching-limit')
  @RequirePermission('trn-003:read')
  @ApiOperation({ summary: 'Drivers within 90 percent of the weekly driving cap.' })
  async approachingLimit(): Promise<DriverApproachingLimitRowDto[]> {
    return this.hours.listApproachingLimit();
  }

  @Get('transport/driver-hours-limits')
  @RequirePermission('trn-003:read')
  @ApiOperation({ summary: 'Read the per-school driver hours limit config (with defaults)' })
  async getLimit(): Promise<DriverHoursLimitResponseDto> {
    return this.hours.getLimit();
  }

  @Patch('transport/driver-hours-limits')
  @RequirePermission('trn-003:admin')
  @ApiOperation({ summary: 'Update the per-school driver hours limit config (school admin only)' })
  async patchLimit(
    @Req() req: AuthedRequest,
    @Body() body: UpdateDriverHoursLimitDto,
  ): Promise<DriverHoursLimitResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.hours.updateLimit(body, actor);
  }

  // ── Vehicle lifecycle ──
  @Get('transport/vehicles/:id/lifecycle')
  @RequirePermission('trn-002:read')
  @ApiOperation({ summary: 'Read lifecycle and book value for a vehicle' })
  async getLifecycle(@Param('id') vehicleId: string): Promise<VehicleLifecycleResponseDto> {
    return this.lifecycle.getForVehicle(vehicleId);
  }

  @Patch('transport/vehicles/:id/lifecycle')
  @RequirePermission('trn-002:write')
  @ApiOperation({ summary: 'Upsert lifecycle and book value for a vehicle' })
  async patchLifecycle(
    @Req() req: AuthedRequest,
    @Param('id') vehicleId: string,
    @Body() body: UpdateVehicleLifecycleDto,
  ): Promise<VehicleLifecycleResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.lifecycle.upsert(vehicleId, body, actor);
  }

  @Post('transport/vehicles/:id/lifecycle/disposal')
  @RequirePermission('trn-002:write')
  @ApiOperation({
    summary: 'Record disposal of a vehicle. Flips trn_vehicles.status to RETIRED in same tx.',
  })
  async recordDisposal(
    @Req() req: AuthedRequest,
    @Param('id') vehicleId: string,
    @Body() body: RecordDisposalDto,
  ): Promise<VehicleLifecycleResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.lifecycle.recordDisposal(vehicleId, body, actor);
  }

  @Get('transport/fleet/replacement-planning')
  @RequirePermission('trn-002:read')
  @ApiOperation({ summary: 'Active vehicles sorted by age — replacement planning view' })
  async replacementPlanning(): Promise<FleetReplacementRowDto[]> {
    return this.lifecycle.replacementPlanning();
  }
}
