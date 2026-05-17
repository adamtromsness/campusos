import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { ScheduleGenerationService } from './schedule-generation.service';
import {
  ActivateCandidateResponseDto,
  ActivationLogResponseDto,
  CandidateSlotResponseDto,
  CreateSchedulingConstraintsDto,
  CreateSchedulingRequestDto,
  ResolveClashDto,
  ReviewCandidateDto,
  SchedulingCandidateResponseDto,
  SchedulingConstraintsResponseDto,
  SchedulingRequestResponseDto,
} from './dto/scheduling-advanced.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Scheduling — Constraints')
@ApiBearerAuth()
@Controller('scheduling/constraints')
export class SchedulingConstraintsController {
  constructor(
    private readonly gen: ScheduleGenerationService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('sch-001:read')
  @ApiOperation({ summary: 'List constraint profiles for the current school.' })
  async list(): Promise<SchedulingConstraintsResponseDto[]> {
    return this.gen.listConstraints();
  }

  @Post()
  @RequirePermission('sch-001:admin')
  @ApiOperation({
    summary:
      'Create a constraint profile (admin only). hard_constraints + soft_constraints must be arrays.',
  })
  async create(
    @Body() body: CreateSchedulingConstraintsDto,
    @Req() req: AuthedRequest,
  ): Promise<SchedulingConstraintsResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.gen.createConstraints(body, actor);
  }
}

@ApiTags('Scheduling — Generation')
@ApiBearerAuth()
@Controller('scheduling/requests')
export class SchedulingRequestController {
  constructor(private readonly gen: ScheduleGenerationService) {}

  @Get()
  @RequirePermission('sch-001:read')
  @ApiOperation({
    summary: 'List scheduling requests for the current school. Optional ?status= filter.',
  })
  async list(@Query('status') status?: string): Promise<SchedulingRequestResponseDto[]> {
    return this.gen.listRequests({ status });
  }

  @Get(':id')
  @RequirePermission('sch-001:read')
  @ApiOperation({ summary: 'Get a scheduling request with inlined candidates.' })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<SchedulingRequestResponseDto> {
    return this.gen.getRequest(id);
  }
}

@ApiTags('Scheduling — Generation')
@ApiBearerAuth()
@Controller('scheduling/generate')
export class SchedulingGenerateController {
  constructor(
    private readonly gen: ScheduleGenerationService,
    private readonly actors: ActorContextService,
  ) {}

  @Post()
  @RequirePermission('sch-001:admin')
  @ApiOperation({
    summary:
      'Queue a scheduling request. ADR-060 picks CP_SAT when sectionCount ≤ 300, HEURISTIC > 300. solverAlgorithm override allowed. Emits sch.generation.completed on COMPLETED.',
  })
  async submit(
    @Body() body: CreateSchedulingRequestDto,
    @Req() req: AuthedRequest,
  ): Promise<SchedulingRequestResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.gen.submitRequest(body, actor);
  }
}

@ApiTags('Scheduling — Candidates')
@ApiBearerAuth()
@Controller('scheduling/candidates')
export class SchedulingCandidateController {
  constructor(
    private readonly gen: ScheduleGenerationService,
    private readonly actors: ActorContextService,
  ) {}

  @Get(':id')
  @RequirePermission('sch-001:read')
  @ApiOperation({ summary: 'Get a single candidate row.' })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<SchedulingCandidateResponseDto> {
    return this.gen.getCandidate(id);
  }

  @Get(':id/slots')
  @RequirePermission('sch-001:read')
  @ApiOperation({ summary: 'List candidate slots — supports clash review.' })
  async slots(@Param('id', ParseUUIDPipe) id: string): Promise<CandidateSlotResponseDto[]> {
    return this.gen.listCandidateSlots(id);
  }

  @Post(':id/approve')
  @RequirePermission('sch-001:admin')
  @ApiOperation({ summary: 'Approve a candidate. Required before activation.' })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewCandidateDto,
    @Req() req: AuthedRequest,
  ): Promise<SchedulingCandidateResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.gen.approveCandidate(id, body, actor);
  }

  @Post(':id/reject')
  @RequirePermission('sch-001:admin')
  @ApiOperation({ summary: 'Reject a candidate.' })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewCandidateDto,
    @Req() req: AuthedRequest,
  ): Promise<SchedulingCandidateResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.gen.rejectCandidate(id, body, actor);
  }

  @Post(':id/resolve-clash')
  @RequirePermission('sch-001:admin')
  @ApiOperation({
    summary:
      'Resolve / update / clear a single slot clash. Omit clashDescription to clear; set non-empty to update.',
  })
  async resolveClash(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ResolveClashDto,
    @Req() req: AuthedRequest,
  ): Promise<CandidateSlotResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.gen.resolveClash(id, body, actor);
  }

  @Post(':id/activate')
  @RequirePermission('sch-001:admin')
  @ApiOperation({
    summary:
      'Promote an APPROVED candidate to sch_timetable_slots. Refuses if any has_clash=true rows remain. Emits sch.timetable.updated.',
  })
  async activate(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ActivateCandidateResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.gen.activateCandidate(id, actor);
  }

  @Get(':id/activations')
  @RequirePermission('sch-001:read')
  @ApiOperation({ summary: 'List activation log entries for the candidate.' })
  async activations(@Param('id', ParseUUIDPipe) id: string): Promise<ActivationLogResponseDto[]> {
    return this.gen.listActivationLogs(id);
  }
}
