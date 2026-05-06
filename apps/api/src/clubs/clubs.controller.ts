import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { ActivityService } from './activity.service';
import { MembershipService } from './membership.service';
import { ScheduleService } from './schedule.service';
import { FieldTripService } from './field-trip.service';
import { ConsentService } from './consent.service';
import { ChaperoneService } from './chaperone.service';
import { ElectionService } from './election.service';
import { VoteService } from './vote.service';
import { ServiceProgrammeService } from './service-programme.service';
import { ServiceHourService } from './service-hour.service';
import {
  ActivityMemberDto,
  ActivityResponseDto,
  ActivityScheduleDto,
  ActivityTypeResponseDto,
  AddChaperoneDto,
  AddMemberDto,
  AddTripParticipantDto,
  ApproveHourDto,
  CanVoteResponseDto,
  CandidateDto,
  CastVoteDto,
  CreateActivityDto,
  CreateActivityTypeDto,
  CreateElectionDto,
  CreateFieldTripDto,
  CreateScheduleDto,
  CreateServiceProgrammeDto,
  ElectionResponseDto,
  ElectionResultsResponseDto,
  FieldTripChaperoneDto,
  FieldTripConsentDto,
  FieldTripParticipantDto,
  FieldTripResponseDto,
  JoinActivityDto,
  LogServiceHourDto,
  RegisterCandidateDto,
  ServiceHourDto,
  ServiceProgrammeDto,
  ServiceProgressDto,
  SignConsentDto,
  UpdateActivityDto,
  UpdateChaperoneDto,
  UpdateElectionDto,
  UpdateFieldTripDto,
  UpdateMemberDto,
  UpdateScheduleDto,
} from './dto/clubs.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Clubs & Student Life')
@Controller()
export class ClubsController {
  constructor(
    private readonly activities: ActivityService,
    private readonly memberships: MembershipService,
    private readonly schedules: ScheduleService,
    private readonly fieldTrips: FieldTripService,
    private readonly consent: ConsentService,
    private readonly chaperones: ChaperoneService,
    private readonly elections: ElectionService,
    private readonly votes: VoteService,
    private readonly programmes: ServiceProgrammeService,
    private readonly hours: ServiceHourService,
    private readonly actors: ActorContextService,
  ) {}

  // ── Activity Types ──

  @Get('clubs/activity-types')
  @RequirePermission('clb-001:read')
  @ApiOperation({ summary: 'List activity types (catalogue) for the school' })
  async listTypes(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<ActivityTypeResponseDto[]> {
    return this.activities.listTypes(includeInactive === 'true');
  }

  @Post('clubs/activity-types')
  @RequirePermission('clb-001:write')
  @ApiOperation({ summary: 'Create an activity type. Staff/admin only.' })
  async createType(
    @Body() body: CreateActivityTypeDto,
    @Req() req: AuthedRequest,
  ): Promise<ActivityTypeResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.activities.createType(body, actor);
  }

  // ── Activities ──

  @Get('clubs/activities')
  @RequirePermission('clb-001:read')
  @ApiOperation({ summary: 'Browse activities for the school' })
  async listActivities(
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('academicYearId') academicYearId?: string,
  ): Promise<ActivityResponseDto[]> {
    return this.activities.list({ category, status, academicYearId });
  }

  @Get('clubs/activities/:id')
  @RequirePermission('clb-001:read')
  @ApiOperation({ summary: 'Get activity with members + schedule inlined' })
  async getActivity(@Param('id') id: string): Promise<ActivityResponseDto> {
    return this.activities.getById(id);
  }

  @Post('clubs/activities')
  @RequirePermission('clb-001:write')
  @ApiOperation({ summary: 'Create an activity. Staff/admin only.' })
  async createActivity(
    @Body() body: CreateActivityDto,
    @Req() req: AuthedRequest,
  ): Promise<ActivityResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.activities.create(body, actor);
  }

  @Patch('clubs/activities/:id')
  @RequirePermission('clb-001:write')
  @ApiOperation({ summary: 'Update an activity. Staff/admin only.' })
  async patchActivity(
    @Param('id') id: string,
    @Body() body: UpdateActivityDto,
    @Req() req: AuthedRequest,
  ): Promise<ActivityResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.activities.patch(id, body, actor);
  }

  // ── Membership ──

  @Post('clubs/activities/:id/join')
  @RequirePermission('clb-001:read')
  @ApiOperation({
    summary:
      'STUDENT SELF-REGISTRATION: locks the activity row + validates max_participants + UNIQUE(activity, student) catches double-join. The actual access boundary is the actor.personType=STUDENT check at the service layer.',
  })
  async joinActivity(
    @Param('id') id: string,
    @Body() body: JoinActivityDto,
    @Req() req: AuthedRequest,
  ): Promise<ActivityMemberDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.memberships.joinAsStudent(id, body, actor);
  }

  @Post('clubs/activities/:id/members')
  @RequirePermission('clb-001:write')
  @ApiOperation({ summary: 'Staff adds a student to an activity' })
  async addMember(
    @Param('id') id: string,
    @Body() body: AddMemberDto,
    @Req() req: AuthedRequest,
  ): Promise<ActivityMemberDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.memberships.addMember(id, body, actor);
  }

  @Patch('clubs/activity-members/:id')
  @RequirePermission('clb-001:write')
  @ApiOperation({ summary: 'Update member role / leave date / active flag' })
  async patchMember(
    @Param('id') id: string,
    @Body() body: UpdateMemberDto,
    @Req() req: AuthedRequest,
  ): Promise<ActivityMemberDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.memberships.patchMember(id, body, actor);
  }

  @Get('clubs/my-activities')
  @RequirePermission('clb-001:read')
  @ApiOperation({ summary: "Calling student's active memberships" })
  async listMyActivities(@Req() req: AuthedRequest): Promise<ActivityMemberDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.memberships.listMyActivities(actor);
  }

  // ── Schedule ──

  @Get('clubs/activities/:id/schedule')
  @RequirePermission('clb-001:read')
  @ApiOperation({ summary: 'List schedule entries for an activity' })
  async listSchedule(@Param('id') id: string): Promise<ActivityScheduleDto[]> {
    return this.schedules.listForActivity(id);
  }

  @Post('clubs/activities/:id/schedule')
  @RequirePermission('clb-001:write')
  @ApiOperation({ summary: 'Add a schedule entry. Staff/admin only.' })
  async createSchedule(
    @Param('id') id: string,
    @Body() body: CreateScheduleDto,
    @Req() req: AuthedRequest,
  ): Promise<ActivityScheduleDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.schedules.create(id, body, actor);
  }

  @Patch('clubs/activity-schedules/:id')
  @RequirePermission('clb-001:write')
  @ApiOperation({ summary: 'Update a schedule entry. Staff/admin only.' })
  async patchSchedule(
    @Param('id') id: string,
    @Body() body: UpdateScheduleDto,
    @Req() req: AuthedRequest,
  ): Promise<ActivityScheduleDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.schedules.patch(id, body, actor);
  }

  @Delete('clubs/activity-schedules/:id')
  @HttpCode(204)
  @RequirePermission('clb-001:write')
  @ApiOperation({ summary: 'Delete a schedule entry. Staff/admin only.' })
  async removeSchedule(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.schedules.remove(id, actor);
  }

  // ── Field Trips ──

  @Get('clubs/field-trips')
  @RequirePermission('clb-003:read')
  @ApiOperation({
    summary:
      'List field trips. Admin/Staff see all; guardian sees only trips where own children are participants; everyone else gets [].',
  })
  async listFieldTrips(@Req() req: AuthedRequest): Promise<FieldTripResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.fieldTrips.list(actor);
  }

  @Get('clubs/field-trips/:id')
  @RequirePermission('clb-003:read')
  @ApiOperation({
    summary:
      'Get a field trip with participants + chaperones. Admin/Staff all; guardian only when own child is a participant.',
  })
  async getFieldTrip(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<FieldTripResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.fieldTrips.getById(id, actor);
  }

  @Post('clubs/field-trips')
  @RequirePermission('clb-003:write')
  @ApiOperation({ summary: 'Plan a field trip. Staff/admin only.' })
  async createFieldTrip(
    @Body() body: CreateFieldTripDto,
    @Req() req: AuthedRequest,
  ): Promise<FieldTripResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.fieldTrips.create(body, actor);
  }

  @Patch('clubs/field-trips/:id')
  @RequirePermission('clb-003:write')
  @ApiOperation({ summary: 'Update a field trip (status transitions, etc.). Staff/admin only.' })
  async patchFieldTrip(
    @Param('id') id: string,
    @Body() body: UpdateFieldTripDto,
    @Req() req: AuthedRequest,
  ): Promise<FieldTripResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.fieldTrips.patch(id, body, actor);
  }

  @Post('clubs/field-trips/:id/participants')
  @RequirePermission('clb-003:write')
  @ApiOperation({ summary: 'Add a student as a trip participant. Staff/admin only.' })
  async addParticipant(
    @Param('id') id: string,
    @Body() body: AddTripParticipantDto,
    @Req() req: AuthedRequest,
  ): Promise<FieldTripParticipantDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.fieldTrips.addParticipant(id, body, actor);
  }

  @Get('clubs/field-trips/:id/consent-status')
  @RequirePermission('clb-003:read')
  @ApiOperation({ summary: 'Per-student signed/pending consent status. Staff/admin only.' })
  async getConsentStatus(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<
    Array<{
      studentId: string;
      studentName: string | null;
      consentSigned: boolean;
      consentGiven: boolean | null;
      signedAt: string | null;
    }>
  > {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.fieldTrips.getConsentStatus(id, actor);
  }

  // ── Consent ──

  @Post('clubs/field-trips/:id/consent')
  @RequirePermission('clb-003:read')
  @ApiOperation({
    summary:
      'PARENT CONSENT KEYSTONE. Guardian signs for own child. Stamps signed_at, ip_address, guardian_person_id from the actor. Emits ext.consent.received after commit.',
  })
  async signConsent(
    @Param('id') id: string,
    @Body() body: SignConsentDto,
    @Req() req: AuthedRequest,
  ): Promise<FieldTripConsentDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    var ip =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      req.socket?.remoteAddress ??
      null;
    return this.consent.sign(id, body, ip, actor);
  }

  @Get('clubs/field-trips/:id/my-consent')
  @RequirePermission('clb-003:read')
  @ApiOperation({ summary: "Calling guardian's own consent record for a (trip, student) pair" })
  async getMyConsent(
    @Param('id') id: string,
    @Query('studentId') studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<FieldTripConsentDto | null> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.consent.getMyConsent(id, studentId, actor);
  }

  // ── Chaperones ──

  @Post('clubs/field-trips/:id/chaperones')
  @RequirePermission('clb-003:write')
  @ApiOperation({ summary: 'Assign a staff or parent volunteer as chaperone. Staff/admin only.' })
  async addChaperone(
    @Param('id') id: string,
    @Body() body: AddChaperoneDto,
    @Req() req: AuthedRequest,
  ): Promise<FieldTripChaperoneDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.chaperones.add(id, body, actor);
  }

  @Patch('clubs/field-trip-chaperones/:id')
  @RequirePermission('clb-003:write')
  @ApiOperation({
    summary: 'Update chaperone (background check status, confirmed). Staff/admin only.',
  })
  async patchChaperone(
    @Param('id') id: string,
    @Body() body: UpdateChaperoneDto,
    @Req() req: AuthedRequest,
  ): Promise<FieldTripChaperoneDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.chaperones.patch(id, body, actor);
  }

  // ── Elections ──

  @Get('clubs/elections')
  @RequirePermission('clb-002:read')
  @ApiOperation({ summary: 'List elections for the school' })
  async listElections(): Promise<ElectionResponseDto[]> {
    return this.elections.list();
  }

  @Get('clubs/elections/:id')
  @RequirePermission('clb-002:read')
  @ApiOperation({
    summary:
      'Get an election with candidates inlined. Vote counts inlined only when status=RESULTS_PUBLISHED.',
  })
  async getElection(@Param('id') id: string): Promise<ElectionResponseDto> {
    return this.elections.getById(id);
  }

  @Post('clubs/elections')
  @RequirePermission('clb-002:write')
  @ApiOperation({ summary: 'Create an election. Admin only.' })
  async createElection(
    @Body() body: CreateElectionDto,
    @Req() req: AuthedRequest,
  ): Promise<ElectionResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.elections.create(body, actor);
  }

  @Patch('clubs/elections/:id')
  @RequirePermission('clb-002:write')
  @ApiOperation({
    summary:
      'Update election (open/close/publish-results). Admin only. Status transitions are sequential (DRAFT->OPEN->CLOSED->RESULTS_PUBLISHED).',
  })
  async patchElection(
    @Param('id') id: string,
    @Body() body: UpdateElectionDto,
    @Req() req: AuthedRequest,
  ): Promise<ElectionResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.elections.patch(id, body, actor);
  }

  @Post('clubs/elections/:id/candidates')
  @RequirePermission('clb-002:read')
  @ApiOperation({
    summary:
      'Register a candidate. Students self-register (is_approved=false until admin patches it true), admins register on behalf with auto-approve.',
  })
  async registerCandidate(
    @Param('id') id: string,
    @Body() body: RegisterCandidateDto,
    @Req() req: AuthedRequest,
  ): Promise<CandidateDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.elections.registerCandidate(id, body, actor);
  }

  @Get('clubs/elections/:id/can-vote')
  @RequirePermission('clb-002:read')
  @ApiOperation({
    summary: "Calling student's eligibility + has-voted status (no vote data leaked)",
  })
  async canVote(@Param('id') id: string, @Req() req: AuthedRequest): Promise<CanVoteResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.votes.canVote(id, actor);
  }

  @Post('clubs/elections/:id/vote')
  @RequirePermission('clb-002:read')
  @ApiOperation({
    summary:
      'ANONYMITY KEYSTONE. Cast an anonymous ballot. Inside one tx, INSERT ext_election_voter_check (PK prevents double-vote) + INSERT ext_votes (NO voter identity). The two writes touch separate tables with no JOIN path.',
  })
  async castVote(
    @Param('id') id: string,
    @Body() body: CastVoteDto,
    @Req() req: AuthedRequest,
  ): Promise<{ status: 'CAST'; votedAt: string }> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.votes.cast(id, body, actor);
  }

  @Get('clubs/elections/:id/results')
  @RequirePermission('clb-002:read')
  @ApiOperation({
    summary:
      'Aggregate vote counts per (position, candidate). Counts available only when status=RESULTS_PUBLISHED.',
  })
  async getResults(@Param('id') id: string): Promise<ElectionResultsResponseDto> {
    return this.elections.getResults(id);
  }

  // ── Service Programmes ──

  @Get('clubs/service-programmes')
  @RequirePermission('clb-004:read')
  @ApiOperation({ summary: 'List service programmes for the school' })
  async listProgrammes(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<ServiceProgrammeDto[]> {
    return this.programmes.list(includeInactive === 'true');
  }

  @Get('clubs/service-programmes/:id')
  @RequirePermission('clb-004:read')
  @ApiOperation({ summary: 'Get a service programme' })
  async getProgramme(@Param('id') id: string): Promise<ServiceProgrammeDto> {
    return this.programmes.getById(id);
  }

  @Post('clubs/service-programmes')
  @RequirePermission('clb-004:write')
  @ApiOperation({ summary: 'Create a service programme. Staff/admin only.' })
  async createProgramme(
    @Body() body: CreateServiceProgrammeDto,
    @Req() req: AuthedRequest,
  ): Promise<ServiceProgrammeDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.programmes.create(body, actor);
  }

  @Get('clubs/service-programmes/:id/leaderboard')
  @RequirePermission('clb-004:read')
  @ApiOperation({
    summary:
      'Per-programme leaderboard sorted by approved hours desc. Admin / staff only — student-name leaderboard data is restricted (REVIEW-CYCLE17 MAJOR 6).',
  })
  async leaderboard(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<ServiceProgressDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.programmes.getLeaderboard(id, actor);
  }

  // ── Service Hours (student-input keystone) ──

  @Get('clubs/service-hours')
  @RequirePermission('clb-004:read')
  @ApiOperation({ summary: 'List service hours. Student row-scoped to own; staff sees all.' })
  async listHours(@Req() req: AuthedRequest): Promise<ServiceHourDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.hours.list(actor);
  }

  @Post('clubs/service-hours')
  @RequirePermission('clb-004:write')
  @ApiOperation({
    summary:
      'STUDENT-INPUT KEYSTONE. Student logs own hours. Auto-creates a PENDING approval row. Updates pending_hours on ext_service_progress when programme set.',
  })
  async logHours(
    @Body() body: LogServiceHourDto,
    @Req() req: AuthedRequest,
  ): Promise<ServiceHourDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.hours.log(body, actor);
  }

  @Patch('clubs/service-hour-approvals/:id')
  @RequirePermission('clb-004:write')
  @ApiOperation({
    summary:
      'Approve / reject service hours. Staff/admin only. On APPROVED auto-credits ext_service_progress.approved_hours and recomputes is_complete vs target_hours.',
  })
  async reviewApproval(
    @Param('id') id: string,
    @Body() body: ApproveHourDto,
    @Req() req: AuthedRequest,
  ): Promise<ServiceHourDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.hours.review(id, body, actor);
  }

  @Get('clubs/my-service-progress')
  @RequirePermission('clb-004:read')
  @ApiOperation({ summary: "Calling student's progress across all service programmes" })
  async myProgress(@Req() req: AuthedRequest): Promise<ServiceProgressDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.hours.myProgress(actor);
  }
}
