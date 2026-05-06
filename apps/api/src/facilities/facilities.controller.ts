import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { BookingService, BuildingService, ClosureService, SpaceService } from './buildings.service';
import {
  MaintenancePlanService,
  MaintenanceTaskService,
  WorkOrderService,
} from './work-orders.service';
import {
  InspectionService,
  SupplyService,
  ViolationService,
  ZoneService,
} from './inspections.service';
import {
  AddWorkOrderCommentDto,
  AdjustSupplyDto,
  BookingResponseDto,
  BuildingResponseDto,
  ChecklistResultResponseDto,
  ClosureResponseDto,
  CreateBookingDto,
  CreateBuildingDto,
  CreateClosureDto,
  CreateInspectionDto,
  CreateInspectionTypeDto,
  CreatePmPlanDto,
  CreateSpaceDto,
  CreateSupplyDto,
  CreateViolationDto,
  CreateWorkOrderDto,
  CreateZoneAssignmentDto,
  CreateZoneDto,
  GeneratePmTasksDto,
  InspectionResponseDto,
  InspectionTypeResponseDto,
  PmPlanResponseDto,
  PmTaskResponseDto,
  PmTaskStatus,
  ResolveViolationDto,
  SpaceResponseDto,
  SubmitChecklistResultsDto,
  SupplyResponseDto,
  UpdateBookingDto,
  UpdateBuildingDto,
  UpdateClosureDto,
  UpdatePmPlanDto,
  UpdatePmTaskDto,
  UpdateSpaceDto,
  UpdateWorkOrderDto,
  UpdateZoneAssignmentDto,
  ViolationResponseDto,
  ViolationSeverity,
  WorkOrderActivityResponseDto,
  WorkOrderPriority,
  WorkOrderResponseDto,
  WorkOrderStatus,
  ZoneResponseDto,
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

@ApiTags('Facilities')
@Controller()
export class FacilitiesController {
  constructor(
    private readonly buildings: BuildingService,
    private readonly spaces: SpaceService,
    private readonly bookings: BookingService,
    private readonly closures: ClosureService,
    private readonly workOrders: WorkOrderService,
    private readonly plans: MaintenancePlanService,
    private readonly tasks: MaintenanceTaskService,
    private readonly inspections: InspectionService,
    private readonly violations: ViolationService,
    private readonly zones: ZoneService,
    private readonly supply: SupplyService,
    private readonly actors: ActorContextService,
  ) {}

  // ── Buildings ──
  @Get('facilities/buildings')
  @RequirePermission('fac-001:read')
  async listBuildings(): Promise<BuildingResponseDto[]> {
    return this.buildings.list();
  }

  @Get('facilities/buildings/:id')
  @RequirePermission('fac-001:read')
  async getBuilding(@Param('id') id: string): Promise<BuildingResponseDto> {
    return this.buildings.getById(id);
  }

  @Post('facilities/buildings')
  @RequirePermission('fac-001:write')
  async createBuilding(
    @Body() body: CreateBuildingDto,
    @Req() req: AuthedRequest,
  ): Promise<BuildingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.buildings.create(body, actor);
  }

  @Patch('facilities/buildings/:id')
  @RequirePermission('fac-001:write')
  async patchBuilding(
    @Param('id') id: string,
    @Body() body: UpdateBuildingDto,
    @Req() req: AuthedRequest,
  ): Promise<BuildingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.buildings.patch(id, body, actor);
  }

  // ── Spaces ──
  @Get('facilities/buildings/:id/spaces')
  @RequirePermission('fac-001:read')
  async listSpaces(@Param('id') id: string): Promise<SpaceResponseDto[]> {
    return this.spaces.listForBuilding(id);
  }

  @Get('facilities/spaces/:id')
  @RequirePermission('fac-001:read')
  async getSpace(@Param('id') id: string): Promise<SpaceResponseDto> {
    return this.spaces.getById(id);
  }

  @Post('facilities/buildings/:id/spaces')
  @RequirePermission('fac-001:write')
  async createSpace(
    @Param('id') id: string,
    @Body() body: CreateSpaceDto,
    @Req() req: AuthedRequest,
  ): Promise<SpaceResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.spaces.create(id, body, actor);
  }

  @Patch('facilities/spaces/:id')
  @RequirePermission('fac-001:write')
  async patchSpace(
    @Param('id') id: string,
    @Body() body: UpdateSpaceDto,
    @Req() req: AuthedRequest,
  ): Promise<SpaceResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.spaces.patch(id, body, actor);
  }

  // ── Bookings ──
  @Get('facilities/spaces/:id/bookings')
  @RequirePermission('fac-001:read')
  async listSpaceBookings(
    @Param('id') id: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ): Promise<BookingResponseDto[]> {
    return this.bookings.listForSpace(id, { fromDate, toDate });
  }

  @Get('facilities/bookings/my')
  @RequirePermission('fac-001:read')
  async listMyBookings(@Req() req: AuthedRequest): Promise<BookingResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.bookings.listMine(actor);
  }

  @Post('facilities/spaces/:id/bookings')
  @RequirePermission('fac-001:write')
  @ApiOperation({
    summary:
      'Create a CONFIRMED booking. EXCLUDE USING gist on (space_id, tstzrange(starts_at, ends_at)) WHERE status=CONFIRMED returns 409 on overlap.',
  })
  async createBooking(
    @Param('id') id: string,
    @Body() body: CreateBookingDto,
    @Req() req: AuthedRequest,
  ): Promise<BookingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.bookings.create(id, body, actor);
  }

  @Patch('facilities/bookings/:id')
  @RequirePermission('fac-001:write')
  async patchBooking(
    @Param('id') id: string,
    @Body() body: UpdateBookingDto,
    @Req() req: AuthedRequest,
  ): Promise<BookingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.bookings.patch(id, body, actor);
  }

  // ── Closures ──
  @Get('facilities/closures')
  @RequirePermission('fac-001:read')
  async listClosures(@Query('activeOnly') activeOnly?: string): Promise<ClosureResponseDto[]> {
    return this.closures.list({ activeOnly: activeOnly === 'true' });
  }

  @Post('facilities/closures')
  @RequirePermission('fac-001:write')
  async createClosure(
    @Body() body: CreateClosureDto,
    @Req() req: AuthedRequest,
  ): Promise<ClosureResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.closures.create(body, actor);
  }

  @Patch('facilities/closures/:id')
  @RequirePermission('fac-001:write')
  async patchClosure(
    @Param('id') id: string,
    @Body() body: UpdateClosureDto,
    @Req() req: AuthedRequest,
  ): Promise<ClosureResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.closures.patch(id, body, actor);
  }

  // ── Work Orders ──
  @Get('facilities/work-orders')
  @RequirePermission('fac-001:read')
  async listWorkOrders(
    @Query('status') status?: string,
    @Query('priority') priority?: string,
    @Query('buildingId') buildingId?: string,
    @Query('assignedToId') assignedToId?: string,
  ): Promise<WorkOrderResponseDto[]> {
    return this.workOrders.list({
      status: (status as WorkOrderStatus) || undefined,
      priority: (priority as WorkOrderPriority) || undefined,
      buildingId,
      assignedToId,
    });
  }

  @Get('facilities/work-orders/:id')
  @RequirePermission('fac-001:read')
  async getWorkOrder(@Param('id') id: string): Promise<WorkOrderResponseDto> {
    return this.workOrders.getById(id);
  }

  @Get('facilities/work-orders/:id/activity')
  @RequirePermission('fac-001:read')
  async listWorkOrderActivity(@Param('id') id: string): Promise<WorkOrderActivityResponseDto[]> {
    return this.workOrders.listActivity(id);
  }

  @Post('facilities/work-orders')
  @RequirePermission('fac-001:write')
  async createWorkOrder(
    @Body() body: CreateWorkOrderDto,
    @Req() req: AuthedRequest,
  ): Promise<WorkOrderResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.workOrders.create(body, actor);
  }

  @Patch('facilities/work-orders/:id')
  @RequirePermission('fac-001:write')
  async patchWorkOrder(
    @Param('id') id: string,
    @Body() body: UpdateWorkOrderDto,
    @Req() req: AuthedRequest,
  ): Promise<WorkOrderResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.workOrders.patch(id, body, actor);
  }

  @Post('facilities/work-orders/:id/comment')
  @RequirePermission('fac-001:write')
  async commentWorkOrder(
    @Param('id') id: string,
    @Body() body: AddWorkOrderCommentDto,
    @Req() req: AuthedRequest,
  ): Promise<WorkOrderResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.workOrders.addComment(id, body, actor);
  }

  // ── PM Plans ──
  @Get('facilities/pm-plans')
  @RequirePermission('fac-002:read')
  async listPmPlans(): Promise<PmPlanResponseDto[]> {
    return this.plans.list();
  }

  @Get('facilities/pm-plans/:id')
  @RequirePermission('fac-002:read')
  async getPmPlan(@Param('id') id: string): Promise<PmPlanResponseDto> {
    return this.plans.getById(id);
  }

  @Post('facilities/pm-plans')
  @RequirePermission('fac-002:write')
  async createPmPlan(
    @Body() body: CreatePmPlanDto,
    @Req() req: AuthedRequest,
  ): Promise<PmPlanResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.plans.create(body, actor);
  }

  @Patch('facilities/pm-plans/:id')
  @RequirePermission('fac-002:write')
  async patchPmPlan(
    @Param('id') id: string,
    @Body() body: UpdatePmPlanDto,
    @Req() req: AuthedRequest,
  ): Promise<PmPlanResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.plans.patch(id, body, actor);
  }

  @Post('facilities/pm-plans/:id/generate-tasks')
  @RequirePermission('fac-002:write')
  async generatePmTasks(
    @Param('id') id: string,
    @Body() body: GeneratePmTasksDto,
    @Req() req: AuthedRequest,
  ): Promise<{ created: number; skipped: number; firstId: string | null }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.plans.generateTasks(id, body, actor);
  }

  // ── PM Tasks ──
  @Get('facilities/pm-tasks')
  @RequirePermission('fac-002:read')
  async listPmTasks(
    @Query('planId') planId?: string,
    @Query('status') status?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ): Promise<PmTaskResponseDto[]> {
    return this.tasks.list({
      planId,
      status: (status as PmTaskStatus) || undefined,
      fromDate,
      toDate,
    });
  }

  @Get('facilities/pm-tasks/:id')
  @RequirePermission('fac-002:read')
  async getPmTask(@Param('id') id: string): Promise<PmTaskResponseDto> {
    return this.tasks.getById(id);
  }

  @Patch('facilities/pm-tasks/:id')
  @RequirePermission('fac-002:write')
  async patchPmTask(
    @Param('id') id: string,
    @Body() body: UpdatePmTaskDto,
    @Req() req: AuthedRequest,
  ): Promise<PmTaskResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tasks.patch(id, body, actor);
  }

  @Get('facilities/pm-tasks/:id/results')
  @RequirePermission('fac-002:read')
  async listChecklistResults(@Param('id') id: string): Promise<ChecklistResultResponseDto[]> {
    return this.tasks.listResults(id);
  }

  @Post('facilities/pm-tasks/:id/results')
  @RequirePermission('fac-002:write')
  @ApiOperation({
    summary:
      'Submit checklist results for a PM task. Results are IMMUTABLE; a passed=false result auto-creates a follow-up REPAIR work order in the same tenant tx.',
  })
  async submitResults(
    @Param('id') id: string,
    @Body() body: SubmitChecklistResultsDto,
    @Req() req: AuthedRequest,
  ): Promise<{ task: PmTaskResponseDto; followUpWorkOrders: string[] }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tasks.submitResults(id, body, actor);
  }

  // ── Inspection Types ──
  @Get('facilities/inspection-types')
  @RequirePermission('fac-004:read')
  async listInspectionTypes(): Promise<InspectionTypeResponseDto[]> {
    return this.inspections.listTypes();
  }

  @Post('facilities/inspection-types')
  @RequirePermission('fac-004:write')
  async createInspectionType(
    @Body() body: CreateInspectionTypeDto,
    @Req() req: AuthedRequest,
  ): Promise<InspectionTypeResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.inspections.createType(body, actor);
  }

  // ── Inspections ──
  @Get('facilities/inspections')
  @RequirePermission('fac-004:read')
  async listInspections(
    @Query('buildingId') buildingId?: string,
  ): Promise<InspectionResponseDto[]> {
    return this.inspections.list({ buildingId });
  }

  @Get('facilities/inspections/:id')
  @RequirePermission('fac-004:read')
  async getInspection(@Param('id') id: string): Promise<InspectionResponseDto> {
    return this.inspections.getById(id);
  }

  @Post('facilities/inspections')
  @RequirePermission('fac-004:write')
  async createInspection(
    @Body() body: CreateInspectionDto,
    @Req() req: AuthedRequest,
  ): Promise<InspectionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.inspections.create(body, actor);
  }

  // ── Violations ──
  @Get('facilities/inspections/:id/violations')
  @RequirePermission('fac-004:read')
  async listInspectionViolations(@Param('id') id: string): Promise<ViolationResponseDto[]> {
    return this.violations.listForInspection(id);
  }

  @Get('facilities/violations')
  @RequirePermission('fac-004:read')
  async listActiveViolations(
    @Query('severity') severity?: string,
  ): Promise<ViolationResponseDto[]> {
    return this.violations.listActive({
      severity: (severity as ViolationSeverity) || undefined,
    });
  }

  @Post('facilities/inspections/:id/violations')
  @RequirePermission('fac-004:write')
  async createViolation(
    @Param('id') id: string,
    @Body() body: CreateViolationDto,
    @Req() req: AuthedRequest,
  ): Promise<ViolationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.violations.create(id, body, actor);
  }

  @Patch('facilities/violations/:id/resolve')
  @RequirePermission('fac-004:write')
  async resolveViolation(
    @Param('id') id: string,
    @Body() body: ResolveViolationDto,
    @Req() req: AuthedRequest,
  ): Promise<ViolationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.violations.resolve(id, body, actor);
  }

  @Post('facilities/violations/scan-overdue')
  @RequirePermission('fac-004:admin')
  @ApiOperation({
    summary:
      'Manual sweep — emits fac.inspection_violation.overdue per unresolved past-due violation. The cron should run this daily.',
  })
  async scanOverdueViolations(): Promise<{ emitted: number }> {
    return this.violations.emitOverdue();
  }

  // ── Zones ──
  @Get('facilities/zones')
  @RequirePermission('fac-003:read')
  async listZones(): Promise<ZoneResponseDto[]> {
    return this.zones.list();
  }

  @Post('facilities/zones')
  @RequirePermission('fac-003:write')
  async createZone(
    @Body() body: CreateZoneDto,
    @Req() req: AuthedRequest,
  ): Promise<ZoneResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.zones.create(body, actor);
  }

  @Post('facilities/zones/:id/assignments')
  @RequirePermission('fac-003:write')
  async createZoneAssignment(
    @Param('id') id: string,
    @Body() body: CreateZoneAssignmentDto,
    @Req() req: AuthedRequest,
  ) {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.zones.createAssignment(id, body, actor);
  }

  @Patch('facilities/zone-assignments/:id')
  @RequirePermission('fac-003:write')
  async patchZoneAssignment(
    @Param('id') id: string,
    @Body() body: UpdateZoneAssignmentDto,
    @Req() req: AuthedRequest,
  ) {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.zones.patchAssignment(id, body, actor);
  }

  // ── Supply ──
  @Get('facilities/buildings/:id/supply')
  @RequirePermission('fac-003:read')
  async listBuildingSupply(@Param('id') id: string): Promise<SupplyResponseDto[]> {
    return this.supply.listForBuilding(id);
  }

  @Post('facilities/supply')
  @RequirePermission('fac-003:write')
  async createSupply(
    @Body() body: CreateSupplyDto,
    @Req() req: AuthedRequest,
  ): Promise<SupplyResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.supply.create(body, actor);
  }

  @Patch('facilities/supply/:id')
  @RequirePermission('fac-003:write')
  async adjustSupply(
    @Param('id') id: string,
    @Body() body: AdjustSupplyDto,
    @Req() req: AuthedRequest,
  ): Promise<SupplyResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.supply.adjust(id, body, actor);
  }
}
