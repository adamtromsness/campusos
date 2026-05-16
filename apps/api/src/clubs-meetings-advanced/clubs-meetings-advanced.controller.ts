import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { ClubBudgetService } from './club-budget.service';
import { FieldTripEvalService } from './field-trip-eval.service';
import { ServicePartnerService } from './service-partner.service';
import { MeetingTemplateService } from './meeting-template.service';
import { AIMinutesService } from './ai-minutes.service';
import {
  AIMinutesResponseDto,
  ClubBudgetResponseDto,
  ClubBudgetTransactionResponseDto,
  CreateClubBudgetDto,
  CreateFieldTripEvaluationDto,
  CreateMeetingFromTemplateDto,
  CreateMeetingTemplateDto,
  CreateServicePartnerOrgDto,
  FieldTripEvaluationResponseDto,
  FieldTripEvaluationSummaryDto,
  GenerateAIMinutesDto,
  MeetingTemplateResponseDto,
  RecordBudgetTransactionDto,
  ServicePartnerOrgResponseDto,
  UpdateClubBudgetDto,
  UpdateMeetingTemplateDto,
  UpdateServicePartnerOrgDto,
} from './dto/clubs-meetings-advanced.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Clubs + Meetings Advanced (P2-28b)')
@Controller()
export class ClubsMeetingsAdvancedController {
  constructor(
    private readonly budgets: ClubBudgetService,
    private readonly trips: FieldTripEvalService,
    private readonly partners: ServicePartnerService,
    private readonly templates: MeetingTemplateService,
    private readonly minutes: AIMinutesService,
    private readonly actors: ActorContextService,
  ) {}

  /* ── Club budgets (6 endpoints) ── */

  @Get('clubs/budgets')
  @RequirePermission('clb-001:read')
  @ApiOperation({ summary: 'List club budgets (optionally filtered by activity)' })
  async listBudgets(
    @Query('activityId') activityId: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<ClubBudgetResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.budgets.list(actor, activityId);
  }

  @Get('clubs/budgets/:id')
  @RequirePermission('clb-001:read')
  @ApiOperation({ summary: 'Get a single club budget' })
  async getBudget(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<ClubBudgetResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.budgets.getById(id, actor);
  }

  @Post('clubs/budgets')
  @RequirePermission('clb-001:admin')
  @ApiOperation({ summary: 'Create a new club budget for an (activity, academic year)' })
  async createBudget(
    @Body() dto: CreateClubBudgetDto,
    @Req() req: AuthedRequest,
  ): Promise<ClubBudgetResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.budgets.create(dto, actor);
  }

  @Patch('clubs/budgets/:id')
  @RequirePermission('clb-001:admin')
  @ApiOperation({ summary: 'Update club budget allocated amount or notes' })
  async patchBudget(
    @Param('id') id: string,
    @Body() dto: UpdateClubBudgetDto,
    @Req() req: AuthedRequest,
  ): Promise<ClubBudgetResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.budgets.patch(id, dto, actor);
  }

  @Post('clubs/budgets/:id/transactions')
  @RequirePermission('clb-001:admin')
  @ApiOperation({
    summary:
      'Record a budget transaction (atomic spent_amount adjustment inside the same tenant tx as the ledger INSERT)',
  })
  async recordTransaction(
    @Param('id') id: string,
    @Body() dto: RecordBudgetTransactionDto,
    @Req() req: AuthedRequest,
  ): Promise<ClubBudgetTransactionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.budgets.recordTransaction(id, dto, actor);
  }

  @Get('clubs/budgets/:id/transactions')
  @RequirePermission('clb-001:read')
  @ApiOperation({ summary: 'List transactions for a budget (newest-first)' })
  async listTransactions(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<ClubBudgetTransactionResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.budgets.listTransactions(id, actor);
  }

  /* ── Field trip evaluations (3 endpoints) ── */

  @Get('clubs/field-trips/:tripId/evaluations')
  @RequirePermission('clb-003:read')
  @ApiOperation({ summary: 'List staff evaluations for a field trip' })
  async listEvaluations(
    @Param('tripId') tripId: string,
    @Req() req: AuthedRequest,
  ): Promise<FieldTripEvaluationResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.trips.listForTrip(tripId, actor);
  }

  @Get('clubs/field-trips/:tripId/evaluations/summary')
  @RequirePermission('clb-003:read')
  @ApiOperation({ summary: 'Aggregate summary of evaluations (averages + recommend count)' })
  async evaluationsSummary(
    @Param('tripId') tripId: string,
    @Req() req: AuthedRequest,
  ): Promise<FieldTripEvaluationSummaryDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.trips.summary(tripId, actor);
  }

  @Post('clubs/field-trips/:tripId/evaluations')
  @RequirePermission('clb-003:write')
  @ApiOperation({
    summary:
      'Submit a post-trip evaluation (1..5 ratings, UNIQUE per evaluator — second attempt PATCH-redirects)',
  })
  async createEvaluation(
    @Param('tripId') tripId: string,
    @Body() dto: CreateFieldTripEvaluationDto,
    @Req() req: AuthedRequest,
  ): Promise<FieldTripEvaluationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.trips.create(tripId, dto, actor);
  }

  /* ── Service partner orgs (4 endpoints) ── */

  @Get('clubs/service-partners')
  @RequirePermission('clb-003:read')
  @ApiOperation({ summary: 'List service-learning partner organisations' })
  async listPartners(
    @Query('includeInactive') includeInactive: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<ServicePartnerOrgResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.partners.list(actor, includeInactive === 'true');
  }

  @Get('clubs/service-partners/:id')
  @RequirePermission('clb-003:read')
  @ApiOperation({ summary: 'Get a single service partner org' })
  async getPartner(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<ServicePartnerOrgResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.partners.getById(id, actor);
  }

  @Post('clubs/service-partners')
  @RequirePermission('clb-003:write')
  @ApiOperation({ summary: 'Create a new service partner org' })
  async createPartner(
    @Body() dto: CreateServicePartnerOrgDto,
    @Req() req: AuthedRequest,
  ): Promise<ServicePartnerOrgResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.partners.create(dto, actor);
  }

  @Patch('clubs/service-partners/:id')
  @RequirePermission('clb-003:write')
  @ApiOperation({
    summary: 'Update a service partner org (also soft-deactivate via isActive=false)',
  })
  async patchPartner(
    @Param('id') id: string,
    @Body() dto: UpdateServicePartnerOrgDto,
    @Req() req: AuthedRequest,
  ): Promise<ServicePartnerOrgResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.partners.patch(id, dto, actor);
  }

  /* ── Meeting templates (5 endpoints) ── */

  @Get('meetings/templates')
  @RequirePermission('mtg-001:read')
  @ApiOperation({ summary: 'List meeting templates' })
  async listTemplates(
    @Query('includeInactive') includeInactive: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<MeetingTemplateResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.templates.list(actor, includeInactive === 'true');
  }

  @Get('meetings/templates/:id')
  @RequirePermission('mtg-001:read')
  @ApiOperation({ summary: 'Get a single meeting template' })
  async getTemplate(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<MeetingTemplateResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.templates.getById(id, actor);
  }

  @Post('meetings/templates')
  @RequirePermission('mtg-001:admin')
  @ApiOperation({ summary: 'Create a meeting template (with optional default agenda items)' })
  async createTemplate(
    @Body() dto: CreateMeetingTemplateDto,
    @Req() req: AuthedRequest,
  ): Promise<MeetingTemplateResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.templates.create(dto, actor);
  }

  @Patch('meetings/templates/:id')
  @RequirePermission('mtg-001:admin')
  @ApiOperation({ summary: 'Update a meeting template (also soft-deactivate via isActive=false)' })
  async patchTemplate(
    @Param('id') id: string,
    @Body() dto: UpdateMeetingTemplateDto,
    @Req() req: AuthedRequest,
  ): Promise<MeetingTemplateResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.templates.patch(id, dto, actor);
  }

  @Post('meetings/templates/:id/create-meeting')
  @RequirePermission('mtg-001:admin')
  @ApiOperation({
    summary:
      'Create a meeting from a template (atomically materialises mtg_meetings + agenda items in one tenant tx)',
  })
  async createMeetingFromTemplate(
    @Param('id') id: string,
    @Body() dto: CreateMeetingFromTemplateDto,
    @Req() req: AuthedRequest,
  ): Promise<{ meetingId: string; agendaItemsCreated: number }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.templates.createMeetingFromTemplate(id, dto, actor);
  }

  /* ── AI minutes (4 endpoints) ── */

  @Get('meetings/:meetingId/ai-minutes')
  @RequirePermission('mtg-001:read')
  @ApiOperation({ summary: 'Get AI minutes for a meeting (null when not yet generated)' })
  async getMinutesForMeeting(
    @Param('meetingId') meetingId: string,
    @Req() req: AuthedRequest,
  ): Promise<AIMinutesResponseDto | null> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.minutes.getForMeeting(meetingId, actor);
  }

  @Post('meetings/:meetingId/ai-minutes/generate')
  @RequirePermission('mtg-001:admin')
  @ApiOperation({
    summary:
      'Generate AI minutes via the stub (P3-A1 AI Inference replaces the stub with a real model call)',
  })
  async generateMinutes(
    @Param('meetingId') meetingId: string,
    @Body() dto: GenerateAIMinutesDto,
    @Req() req: AuthedRequest,
  ): Promise<AIMinutesResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.minutes.generate(meetingId, dto, actor);
  }

  @Patch('ai-minutes/:id/regenerate')
  @RequirePermission('mtg-001:admin')
  @ApiOperation({
    summary: 'Regenerate stub content for GENERATED minutes (refused once APPROVED)',
  })
  async regenerateMinutes(
    @Param('id') id: string,
    @Body() dto: GenerateAIMinutesDto,
    @Req() req: AuthedRequest,
  ): Promise<AIMinutesResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.minutes.regenerate(id, dto, actor);
  }

  @Patch('ai-minutes/:id/approve')
  @RequirePermission('mtg-001:admin')
  @ApiOperation({
    summary:
      'Approve AI minutes (flips GENERATED to APPROVED with approver + timestamp populated atomically per schema lockstep)',
  })
  async approveMinutes(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<AIMinutesResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.minutes.approve(id, actor);
  }
}
