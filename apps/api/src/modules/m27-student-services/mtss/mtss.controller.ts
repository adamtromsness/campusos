import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { MtssTierService } from './mtss-tier.service';
import { InterventionService } from '../counselling/intervention.service';
import {
  AttachTeamMeetingStudentDto,
  CreateInterventionDto,
  CreateMtssTierDto,
  CreateTeamMeetingDto,
  InterventionProgressEntryDto,
  InterventionResponseDto,
  ListMtssTiersQueryDto,
  LogProgressDto,
  MtssDashboardDto,
  MtssTierResponseDto,
  TeamMeetingResponseDto,
  TeamMeetingStudentResponseDto,
  UpdateInterventionDto,
  UpdateMtssTierDto,
} from '../counselling/dto/counselling.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Counselling MTSS / RTI')
@ApiBearerAuth()
@Controller('counselling/mtss')
export class MtssController {
  constructor(
    private readonly tiers: MtssTierService,
    private readonly interventions: InterventionService,
    private readonly actors: ActorContextService,
  ) {}

  // ─── Tiers ────────────────────────────────────────────────────

  @Get('tiers')
  @RequirePermission('cou-003:read')
  @ApiOperation({
    summary:
      'List MTSS tiers. Counsellors see their caseload-linked students; admins see school-wide. Filters: tier, domain, status, academicYearId, studentId.',
  })
  async listTiers(
    @Query() query: ListMtssTiersQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<MtssTierResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tiers.list(query, actor);
  }

  @Get('dashboard')
  @RequirePermission('cou-003:admin')
  @ApiOperation({
    summary:
      'Admin-only school-wide tier-distribution rollup. Returns counts grouped by (tier, domain) for ACTIVE rows + totalActive scalar.',
  })
  async dashboard(@Req() req: AuthedRequest): Promise<MtssDashboardDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tiers.dashboard(actor);
  }

  @Get('tiers/:id')
  @RequirePermission('cou-003:read')
  @ApiOperation({ summary: 'Fetch a single MTSS tier.' })
  async getTier(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<MtssTierResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tiers.getById(id, actor);
  }

  @Post('tiers')
  @RequirePermission('cou-003:write')
  @ApiOperation({
    summary:
      'Assign an MTSS tier. Counsellor or admin only. Pre-flights the partial UNIQUE keystone on (student, year, domain) WHERE status=ACTIVE. Emits svc.tier.changed.',
  })
  async createTier(
    @Body() body: CreateMtssTierDto,
    @Req() req: AuthedRequest,
  ): Promise<MtssTierResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tiers.create(body, actor);
  }

  @Patch('tiers/:id')
  @RequirePermission('cou-003:write')
  @ApiOperation({
    summary:
      'Update an MTSS tier (promote/demote/exit). Locked-row tx; re-emits svc.tier.changed on tier value change.',
  })
  async patchTier(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateMtssTierDto,
    @Req() req: AuthedRequest,
  ): Promise<MtssTierResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tiers.patch(id, body, actor);
  }

  // ─── Team meetings ────────────────────────────────────────────

  @Get('team-meetings')
  @RequirePermission('cou-003:read')
  @ApiOperation({ summary: 'List MTSS team meetings.' })
  async listMeetings(
    @Query('fromDate') fromDate: string | undefined,
    @Query('toDate') toDate: string | undefined,
    @Query('academicYearId') academicYearId: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<TeamMeetingResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tiers.listMeetings({ fromDate, toDate, academicYearId }, actor);
  }

  @Get('team-meetings/:id')
  @RequirePermission('cou-003:read')
  @ApiOperation({ summary: 'Fetch a team meeting with the inlined students list.' })
  async getMeeting(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<TeamMeetingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tiers.getMeetingById(id, actor);
  }

  @Post('team-meetings')
  @RequirePermission('cou-003:write')
  @ApiOperation({
    summary: 'Record an MTSS team meeting with date + facilitator (= caller) + notes.',
  })
  async createMeeting(
    @Body() body: CreateTeamMeetingDto,
    @Req() req: AuthedRequest,
  ): Promise<TeamMeetingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tiers.createMeeting(body, actor);
  }

  @Post('team-meetings/:id/students')
  @RequirePermission('cou-003:write')
  @ApiOperation({
    summary:
      'Attach a student outcome to a team meeting. UNIQUE(team_meeting_id, student_id) catches duplicates.',
  })
  async attachMeetingStudent(
    @Param('id', ParseUUIDPipe) meetingId: string,
    @Body() body: AttachTeamMeetingStudentDto,
    @Req() req: AuthedRequest,
  ): Promise<TeamMeetingStudentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tiers.attachMeetingStudent(meetingId, body, actor);
  }

  // ─── Interventions ────────────────────────────────────────────

  @Get('tiers/:id/interventions')
  @RequirePermission('cou-003:read')
  @ApiOperation({
    summary: 'List interventions for a tier with the latest progress entry inlined.',
  })
  async listInterventions(
    @Param('id', ParseUUIDPipe) tierId: string,
    @Req() req: AuthedRequest,
  ): Promise<InterventionResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.interventions.listForTier(tierId, actor);
  }

  @Post('tiers/:id/interventions')
  @RequirePermission('cou-003:write')
  @ApiOperation({ summary: 'Add a new intervention under a tier.' })
  async createIntervention(
    @Param('id', ParseUUIDPipe) tierId: string,
    @Body() body: CreateInterventionDto,
    @Req() req: AuthedRequest,
  ): Promise<InterventionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.interventions.create(tierId, body, actor);
  }

  @Patch('interventions/:id')
  @RequirePermission('cou-003:write')
  @ApiOperation({
    summary: 'Update intervention status / frequency / endDate / description.',
  })
  async patchIntervention(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateInterventionDto,
    @Req() req: AuthedRequest,
  ): Promise<InterventionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.interventions.patch(id, body, actor);
  }

  @Post('interventions/:id/progress')
  @RequirePermission('cou-003:write')
  @ApiOperation({
    summary:
      'Append a progress data point. Append-only (no UPDATE / no DELETE methods at the service layer). Stamps recorded_by from actor.employeeId.',
  })
  async logProgress(
    @Param('id', ParseUUIDPipe) interventionId: string,
    @Body() body: LogProgressDto,
    @Req() req: AuthedRequest,
  ): Promise<InterventionProgressEntryDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.interventions.logProgress(interventionId, body, actor);
  }

  @Get('interventions/:id/progress')
  @RequirePermission('cou-003:read')
  @ApiOperation({
    summary: 'Time-series of progress entries for an intervention, oldest-first.',
  })
  async listProgress(
    @Param('id', ParseUUIDPipe) interventionId: string,
    @Req() req: AuthedRequest,
  ): Promise<InterventionProgressEntryDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.interventions.listProgress(interventionId, actor);
  }
}
