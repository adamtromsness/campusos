import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { RouteConstraintService } from './route-constraint.service';
import { RouteGenerationService } from './route-generation.service';
import { AdhocTripService } from './adhoc-trip.service';
import { ContractedRouteService } from './contracted-route.service';
import {
  AdhocTripResponseDto,
  AdhocTripStatus,
  ApproveCandidateDto,
  AssignAdhocTripDto,
  CancelAdhocTripDto,
  ContractedRouteResponseDto,
  CreateAdhocTripDto,
  CreateContractedRouteDto,
  CreateManualCandidateDto,
  CreateRouteConstraintDto,
  GenerationCandidateResponseDto,
  GenerationRequestResponseDto,
  GenerationStatus,
  QueueGenerationRequestDto,
  RejectCandidateDto,
  RouteConstraintResponseDto,
  UpdateContractedRouteDto,
  UpdateRouteConstraintDto,
} from './dto/route-generation.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    personId: string;
    email: string;
    displayName: string;
    sessionId: string;
  };
}

class ApproveTripBodyDto {
  approvalNotes?: string;
}

/**
 * Route Generation + Ad-Hoc Trips + Contracted Routes Controller — P2-11b.
 *
 * ~20 endpoints across 4 service files. Gating:
 *   TRN-001 (Route Management) — constraint profiles, generation
 *     requests, candidates, contracted routes (read + write).
 *   TRN-005 (Field Trips & Special Trips) — ad-hoc trip requests.
 *
 * Generic Staff holds TRN-001:read+write + TRN-005:read+write per the
 * IAM seed. Parents hold TRN-001:read + TRN-005:read+write (the
 * parent-active route-change-request surface from Cycle 19). School
 * Admin and Platform Admin pick up admin via everyFunction.
 */
@ApiTags('transport-routes-advanced')
@Controller({ version: '1' })
export class RouteGenerationController {
  constructor(
    private readonly constraints: RouteConstraintService,
    private readonly generation: RouteGenerationService,
    private readonly adhoc: AdhocTripService,
    private readonly contracted: ContractedRouteService,
    private readonly actors: ActorContextService,
  ) {}

  // ── Route constraints ──
  @Get('transport/route-constraints')
  @RequirePermission('trn-001:read')
  @ApiOperation({ summary: 'List route constraint profiles' })
  async listConstraints(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<RouteConstraintResponseDto[]> {
    return this.constraints.list({ includeInactive: includeInactive === 'true' });
  }

  @Get('transport/route-constraints/:id')
  @RequirePermission('trn-001:read')
  async getConstraint(@Param('id') id: string): Promise<RouteConstraintResponseDto> {
    return this.constraints.getById(id);
  }

  @Post('transport/route-constraints')
  @RequirePermission('trn-001:write')
  async createConstraint(
    @Body() body: CreateRouteConstraintDto,
    @Req() req: AuthedRequest,
  ): Promise<RouteConstraintResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.constraints.create(body, actor);
  }

  @Patch('transport/route-constraints/:id')
  @RequirePermission('trn-001:write')
  async patchConstraint(
    @Param('id') id: string,
    @Body() body: UpdateRouteConstraintDto,
    @Req() req: AuthedRequest,
  ): Promise<RouteConstraintResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.constraints.patch(id, body, actor);
  }

  // ── Route generation ──
  @Get('transport/route-generation')
  @RequirePermission('trn-001:read')
  async listGenerationRequests(
    @Query('status') status?: string,
  ): Promise<GenerationRequestResponseDto[]> {
    return this.generation.listRequests({
      status: (status as GenerationStatus) || undefined,
    });
  }

  @Get('transport/route-generation/:id')
  @RequirePermission('trn-001:read')
  async getGenerationRequest(@Param('id') id: string): Promise<GenerationRequestResponseDto> {
    return this.generation.getRequestById(id);
  }

  @Post('transport/route-generation')
  @RequirePermission('trn-001:write')
  @ApiOperation({
    summary:
      'Queue a generation request. The RouteGenerationWorker invokes the Scheduling Solver when deployed and falls back to manual candidate authoring otherwise.',
  })
  async queueGenerationRequest(
    @Body() body: QueueGenerationRequestDto,
    @Req() req: AuthedRequest,
  ): Promise<GenerationRequestResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.generation.queueRequest(body, actor);
  }

  @Patch('transport/route-generation/:id/cancel')
  @RequirePermission('trn-001:write')
  async cancelGenerationRequest(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<GenerationRequestResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.generation.cancelRequest(id, actor);
  }

  // Manual candidate authoring (solver-fallback path)
  @Post('transport/route-generation/:id/candidates')
  @RequirePermission('trn-001:write')
  @ApiOperation({
    summary:
      'Create a manual candidate against a generation request. Used when the Scheduling Solver extracted service is not deployed.',
  })
  async addManualCandidate(
    @Param('id') id: string,
    @Body() body: CreateManualCandidateDto,
    @Req() req: AuthedRequest,
  ): Promise<GenerationCandidateResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.generation.addManualCandidate(id, body, actor);
  }

  @Patch('transport/route-generation/:id/complete')
  @RequirePermission('trn-001:write')
  @ApiOperation({
    summary:
      'Mark a generation request COMPLETED. Emits trn.generation.completed with the candidate counts and coverage totals.',
  })
  async completeGenerationRequest(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<GenerationRequestResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.generation.markRequestCompleted(id, actor);
  }

  // Candidates
  @Get('transport/route-generation/candidates/:id')
  @RequirePermission('trn-001:read')
  async getCandidate(@Param('id') id: string): Promise<GenerationCandidateResponseDto> {
    return this.generation.getCandidateById(id);
  }

  @Post('transport/route-generation/candidates/:id/approve')
  @RequirePermission('trn-001:write')
  @ApiOperation({
    summary:
      'Approve a candidate. Atomically materialises a live trn_routes row + trn_stops rows + trn_student_assignments rows from the candidate.',
  })
  async approveCandidate(
    @Param('id') id: string,
    @Body() body: ApproveCandidateDto,
    @Req() req: AuthedRequest,
  ): Promise<GenerationCandidateResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.generation.approveCandidate(id, body, actor);
  }

  @Post('transport/route-generation/candidates/:id/reject')
  @RequirePermission('trn-001:write')
  async rejectCandidate(
    @Param('id') id: string,
    @Body() body: RejectCandidateDto,
    @Req() req: AuthedRequest,
  ): Promise<GenerationCandidateResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.generation.rejectCandidate(id, body, actor);
  }

  // ── Ad-hoc trips ──
  @Get('transport/adhoc-trips')
  @RequirePermission('trn-005:read')
  async listAdhocTrips(
    @Req() req: AuthedRequest,
    @Query('status') status?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ): Promise<AdhocTripResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.adhoc.list(actor, {
      status: (status as AdhocTripStatus) || undefined,
      fromDate,
      toDate,
    });
  }

  @Get('transport/adhoc-trips/:id')
  @RequirePermission('trn-005:read')
  async getAdhocTrip(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<AdhocTripResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.adhoc.getById(id, actor);
  }

  @Post('transport/adhoc-trips')
  @RequirePermission('trn-005:write')
  @ApiOperation({
    summary:
      'Submit a new ad-hoc trip request. The trip routes through wsk_approval_requests via the Cycle 7 workflow engine when a TRN_ADHOC_TRIP template is configured.',
  })
  async submitAdhocTrip(
    @Body() body: CreateAdhocTripDto,
    @Req() req: AuthedRequest,
  ): Promise<AdhocTripResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.adhoc.submit(body, actor);
  }

  @Patch('transport/adhoc-trips/:id/approve')
  @RequirePermission('trn-005:write')
  async approveAdhocTrip(
    @Param('id') id: string,
    @Body() body: ApproveTripBodyDto,
    @Req() req: AuthedRequest,
  ): Promise<AdhocTripResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.adhoc.approve(id, body.approvalNotes ?? null, actor);
  }

  @Patch('transport/adhoc-trips/:id/assign')
  @RequirePermission('trn-005:write')
  async assignAdhocTrip(
    @Param('id') id: string,
    @Body() body: AssignAdhocTripDto,
    @Req() req: AuthedRequest,
  ): Promise<AdhocTripResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.adhoc.assign(id, body, actor);
  }

  @Patch('transport/adhoc-trips/:id/complete')
  @RequirePermission('trn-005:write')
  async completeAdhocTrip(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<AdhocTripResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.adhoc.complete(id, actor);
  }

  @Patch('transport/adhoc-trips/:id/cancel')
  @RequirePermission('trn-005:write')
  async cancelAdhocTrip(
    @Param('id') id: string,
    @Body() body: CancelAdhocTripDto,
    @Req() req: AuthedRequest,
  ): Promise<AdhocTripResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.adhoc.cancel(id, body, actor);
  }

  // ── Contracted routes ──
  @Get('transport/contracted-routes')
  @RequirePermission('trn-001:read')
  async listContractedRoutes(
    @Query('activeOnly') activeOnly?: string,
  ): Promise<ContractedRouteResponseDto[]> {
    return this.contracted.list({ activeOnly: activeOnly === 'true' });
  }

  @Get('transport/contracted-routes/:id')
  @RequirePermission('trn-001:read')
  async getContractedRoute(@Param('id') id: string): Promise<ContractedRouteResponseDto> {
    return this.contracted.getById(id);
  }

  @Post('transport/contracted-routes')
  @RequirePermission('trn-001:write')
  async createContractedRoute(
    @Body() body: CreateContractedRouteDto,
    @Req() req: AuthedRequest,
  ): Promise<ContractedRouteResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.contracted.create(body, actor);
  }

  @Patch('transport/contracted-routes/:id')
  @RequirePermission('trn-001:write')
  async patchContractedRoute(
    @Param('id') id: string,
    @Body() body: UpdateContractedRouteDto,
    @Req() req: AuthedRequest,
  ): Promise<ContractedRouteResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.contracted.patch(id, body, actor);
  }
}
