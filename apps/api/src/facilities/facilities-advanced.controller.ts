import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { CleaningRouteService } from './cleaning-route.service';
import { ZoneInspectionService } from './zone-inspection.service';
import { SupplyAuditService } from './supply-audit.service';
import { WorkOrderDepthService } from './work-order-depth.service';
import {
  CleaningCompletionResponseDto,
  CleaningRouteResponseDto,
  CleaningRouteStopResponseDto,
  CompleteStocktakeResponseDto,
  CreateCleaningRouteDto,
  CreateRouteAssignmentDto,
  CreateStocktakeDto,
  CreateSupplyTransactionDto,
  CreateWorkOrderAttachmentDto,
  CreateWorkOrderPartDto,
  CreateZoneInspectionDto,
  RecordStocktakeItemDto,
  RouteAssignmentResponseDto,
  StartRouteCompletionDto,
  StocktakeItemResponseDto,
  StocktakeResponseDto,
  StocktakeStatus,
  StopCompletionResponseDto,
  SupplyTransactionResponseDto,
  SupplyTransactionType,
  UpdateCleaningRouteDto,
  UpdateRouteStopsDto,
  UpdateStopCompletionDto,
  WorkOrderAttachmentResponseDto,
  WorkOrderCostSummaryResponseDto,
  WorkOrderPartResponseDto,
  ZoneInspectionRating,
  ZoneInspectionResponseDto,
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
 * FacilitiesAdvancedController — P2-18a endpoint surface (~24 routes).
 *
 * Cleaning routes + supply audit + work order depth lives in a separate
 * controller from the Cycle 21 FacilitiesController so the cycle's new
 * routes can be reviewed and reasoned about as a single block.
 *
 * Permission codes:
 *   FAC-001 (Maintenance Tickets) — work order attachments + parts
 *   FAC-002 (Preventive Maintenance) — not used in P2-18a
 *   FAC-003 (Custodial Management) — cleaning routes, zone inspections,
 *                                    supply transactions, stocktakes
 */
@ApiTags('Facilities Advanced (P2-18a)')
@Controller()
export class FacilitiesAdvancedController {
  constructor(
    private readonly cleaning: CleaningRouteService,
    private readonly zoneInspections: ZoneInspectionService,
    private readonly supplyAudit: SupplyAuditService,
    private readonly woDepth: WorkOrderDepthService,
    private readonly actors: ActorContextService,
  ) {}

  // ── Cleaning routes ──
  @Get('facilities/cleaning-routes')
  @RequirePermission('fac-003:read')
  @ApiOperation({
    summary: 'List cleaning routes (FAC-003:read). includeInactive=true surfaces retired routes.',
  })
  async listRoutes(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<CleaningRouteResponseDto[]> {
    return this.cleaning.listRoutes(includeInactive === 'true');
  }

  @Get('facilities/cleaning-routes/:id')
  @RequirePermission('fac-003:read')
  async getRoute(@Param('id') id: string): Promise<CleaningRouteResponseDto> {
    return this.cleaning.getRouteById(id);
  }

  @Post('facilities/cleaning-routes')
  @RequirePermission('fac-003:admin')
  async createRoute(
    @Body() body: CreateCleaningRouteDto,
    @Req() req: AuthedRequest,
  ): Promise<CleaningRouteResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.cleaning.createRoute(body, actor);
  }

  @Patch('facilities/cleaning-routes/:id')
  @RequirePermission('fac-003:admin')
  async patchRoute(
    @Param('id') id: string,
    @Body() body: UpdateCleaningRouteDto,
    @Req() req: AuthedRequest,
  ): Promise<CleaningRouteResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.cleaning.patchRoute(id, body, actor);
  }

  @Get('facilities/cleaning-routes/:id/stops')
  @RequirePermission('fac-003:read')
  async listStops(@Param('id') id: string): Promise<CleaningRouteStopResponseDto[]> {
    return this.cleaning.listStops(id);
  }

  @Patch('facilities/cleaning-routes/:id/stops')
  @RequirePermission('fac-003:admin')
  @ApiOperation({
    summary:
      'Bulk-replace the route stops (drag-reorder). DELETEs existing rows + INSERTs the supplied list in one tenant tx.',
  })
  async replaceStops(
    @Param('id') id: string,
    @Body() body: UpdateRouteStopsDto,
    @Req() req: AuthedRequest,
  ): Promise<CleaningRouteResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.cleaning.replaceStops(id, body, actor);
  }

  @Get('facilities/cleaning-routes/:id/assignments')
  @RequirePermission('fac-003:read')
  async listAssignments(@Param('id') id: string): Promise<RouteAssignmentResponseDto[]> {
    return this.cleaning.listAssignments(id);
  }

  @Post('facilities/cleaning-routes/:id/assignments')
  @RequirePermission('fac-003:admin')
  async createAssignment(
    @Param('id') id: string,
    @Body() body: CreateRouteAssignmentDto,
    @Req() req: AuthedRequest,
  ): Promise<RouteAssignmentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.cleaning.createAssignment(id, body, actor);
  }

  // ── Completions ──
  @Get('facilities/cleaning-completions')
  @RequirePermission('fac-003:read')
  async listCompletions(
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('routeId') routeId?: string,
    @Query('employeeId') employeeId?: string,
  ): Promise<CleaningCompletionResponseDto[]> {
    return this.cleaning.listCompletions({ fromDate, toDate, routeId, employeeId });
  }

  @Get('facilities/cleaning-completions/:id')
  @RequirePermission('fac-003:read')
  async getCompletion(@Param('id') id: string): Promise<CleaningCompletionResponseDto> {
    return this.cleaning.getCompletionById(id);
  }

  @Post('facilities/cleaning-completions')
  @RequirePermission('fac-003:write')
  @ApiOperation({
    summary:
      'Start a route run. Creates the completion row in IN_PROGRESS plus one stop_completion row per stop in PENDING — all in one tenant tx.',
  })
  async startCompletion(
    @Body() body: StartRouteCompletionDto,
    @Req() req: AuthedRequest,
  ): Promise<CleaningCompletionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.cleaning.startCompletion(body, actor);
  }

  @Patch('facilities/cleaning-completions/:id/stops/:stopId')
  @RequirePermission('fac-003:write')
  @ApiOperation({
    summary:
      'Update a stop completion (mark COMPLETED/SKIPPED + record tasks + photos + issues). On issuesNoted, emits fac.route_stop.issue_noted so the CleaningIssueTicketConsumer creates a tkt_tickets row.',
  })
  async patchStopCompletion(
    @Param('id') completionId: string,
    @Param('stopId') stopId: string,
    @Body() body: UpdateStopCompletionDto,
    @Req() req: AuthedRequest,
  ): Promise<StopCompletionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.cleaning.patchStopCompletion(completionId, stopId, body, actor);
  }

  // ── Zone inspections ──
  @Get('facilities/zone-inspections')
  @RequirePermission('fac-003:read')
  async listInspections(
    @Query('zoneId') zoneId?: string,
    @Query('rating') rating?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ): Promise<ZoneInspectionResponseDto[]> {
    return this.zoneInspections.list({
      zoneId,
      rating: rating as ZoneInspectionRating | undefined,
      fromDate,
      toDate,
    });
  }

  @Get('facilities/zone-inspections/:id')
  @RequirePermission('fac-003:read')
  async getInspection(@Param('id') id: string): Promise<ZoneInspectionResponseDto> {
    return this.zoneInspections.getById(id);
  }

  @Post('facilities/zone-inspections')
  @RequirePermission('fac-003:admin')
  @ApiOperation({
    summary:
      'Create a zone inspection. On overallRating=FAIL, auto-creates a follow-up fac_work_orders row in the same tenant tx (DEEP_CLEAN, HIGH priority) and back-fills follow_up_work_order_id.',
  })
  async createInspection(
    @Body() body: CreateZoneInspectionDto,
    @Req() req: AuthedRequest,
  ): Promise<ZoneInspectionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.zoneInspections.create(body, actor);
  }

  // ── Supply transactions ──
  @Get('facilities/supply-transactions')
  @RequirePermission('fac-003:read')
  async listSupplyTransactions(
    @Query('inventoryId') inventoryId?: string,
    @Query('buildingId') buildingId?: string,
    @Query('transactionType') transactionType?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ): Promise<SupplyTransactionResponseDto[]> {
    return this.supplyAudit.listTransactions({
      inventoryId,
      buildingId,
      transactionType: transactionType as SupplyTransactionType | undefined,
      fromDate,
      toDate,
    });
  }

  @Post('facilities/supply-transactions')
  @RequirePermission('fac-003:write')
  async createSupplyTransaction(
    @Body() body: CreateSupplyTransactionDto,
    @Req() req: AuthedRequest,
  ): Promise<SupplyTransactionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.supplyAudit.createTransaction(body, actor);
  }

  // ── Stocktakes ──
  @Get('facilities/stocktakes')
  @RequirePermission('fac-003:read')
  async listStocktakes(
    @Query('buildingId') buildingId?: string,
    @Query('status') status?: string,
  ): Promise<StocktakeResponseDto[]> {
    return this.supplyAudit.listStocktakes({
      buildingId,
      status: status as StocktakeStatus | undefined,
    });
  }

  @Get('facilities/stocktakes/:id')
  @RequirePermission('fac-003:read')
  async getStocktake(@Param('id') id: string): Promise<StocktakeResponseDto> {
    return this.supplyAudit.getStocktakeById(id);
  }

  @Post('facilities/stocktakes')
  @RequirePermission('fac-003:admin')
  async createStocktake(
    @Body() body: CreateStocktakeDto,
    @Req() req: AuthedRequest,
  ): Promise<StocktakeResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.supplyAudit.createStocktake(body, actor);
  }

  @Post('facilities/stocktakes/:id/items')
  @RequirePermission('fac-003:write')
  async recordStocktakeItem(
    @Param('id') id: string,
    @Body() body: RecordStocktakeItemDto,
    @Req() req: AuthedRequest,
  ): Promise<StocktakeItemResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.supplyAudit.recordItem(id, body, actor);
  }

  @Post('facilities/stocktakes/:id/complete')
  @RequirePermission('fac-003:admin')
  @ApiOperation({
    summary:
      'Complete a stocktake. Inside one tenant tx flips status=COMPLETED, walks every stocktake_item where actual differs from expected, creates one ADJUSTMENT fac_supply_transactions row per discrepancy, and updates fac_supply_inventory.current_quantity to the actual figure.',
  })
  async completeStocktake(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<CompleteStocktakeResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.supplyAudit.completeStocktake(id, actor);
  }

  // ── Work order depth ──
  @Get('facilities/work-orders/:id/attachments')
  @RequirePermission('fac-001:read')
  async listAttachments(@Param('id') id: string): Promise<WorkOrderAttachmentResponseDto[]> {
    return this.woDepth.listAttachments(id);
  }

  @Post('facilities/work-orders/:id/attachments')
  @RequirePermission('fac-001:write')
  async addAttachment(
    @Param('id') id: string,
    @Body() body: CreateWorkOrderAttachmentDto,
    @Req() req: AuthedRequest,
  ): Promise<WorkOrderAttachmentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.woDepth.addAttachment(id, body, actor);
  }

  @Get('facilities/work-orders/:id/parts')
  @RequirePermission('fac-001:read')
  async listParts(@Param('id') id: string): Promise<WorkOrderPartResponseDto[]> {
    return this.woDepth.listParts(id);
  }

  @Post('facilities/work-orders/:id/parts')
  @RequirePermission('fac-001:write')
  async addPart(
    @Param('id') id: string,
    @Body() body: CreateWorkOrderPartDto,
    @Req() req: AuthedRequest,
  ): Promise<WorkOrderPartResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.woDepth.addPart(id, body, actor);
  }

  @Get('facilities/work-orders/:id/cost-summary')
  @RequirePermission('fac-001:read')
  @ApiOperation({
    summary:
      'Cost summary for a work order — parts total + line count + labour cost (denormalised from fac_work_orders.cost) + grand total.',
  })
  async getCostSummary(@Param('id') id: string): Promise<WorkOrderCostSummaryResponseDto> {
    return this.woDepth.getCostSummary(id);
  }
}
