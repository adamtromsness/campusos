import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService, type ResolvedActor } from '../iam/actor-context.service';
import type { Request } from 'express';
import {
  CreateActionPlanDto,
  CreateAdoptionDto,
  CreateCustomFrameworkDto,
  CreateEvidenceDto,
  CreateSelfStudyRatingDto,
  CreateSiteVisitPrepDto,
  ReviewEvidenceDto,
  UpdateActionPlanDto,
  UpdateSiteVisitPrepDto,
  UpdateSubActionDto,
} from './dto/accreditation.dto';
import { FrameworkService } from './framework.service';
import { EvidenceService } from './evidence.service';
import { SelfStudyService } from './self-study.service';
import { ActionPlanService } from './action-plan.service';
import { SiteVisitService } from './site-visit.service';

interface AuthRequest extends Request {
  user?: { accountId: string; personId: string };
}

@ApiTags('Accreditation')
@Controller('accreditation')
export class AccreditationController {
  constructor(
    private readonly actorContext: ActorContextService,
    private readonly frameworks: FrameworkService,
    private readonly evidence: EvidenceService,
    private readonly selfStudy: SelfStudyService,
    private readonly actionPlans: ActionPlanService,
    private readonly siteVisits: SiteVisitService,
  ) {}

  private async resolve(req: AuthRequest): Promise<ResolvedActor> {
    return this.actorContext.resolveActor(req.user!.accountId, req.user!.personId);
  }

  // ── Frameworks + Adoptions ─────────────────────────────────────

  @Get('frameworks')
  @RequirePermission('tch-008:read')
  @ApiOperation({
    summary: 'List accreditation frameworks (platform + tenant custom)',
    description:
      'Returns platform frameworks (AdvancED, IB MYP, CIS) tagged with isAdopted plus the school-custom acc_frameworks rows. Restricted to staff/admin even though the gate-tier tch-008:read is held by parents/students for the curriculum surface.',
  })
  async listFrameworks(@Req() req: AuthRequest) {
    return this.frameworks.listFrameworks(await this.resolve(req));
  }

  @Get('adoptions')
  @RequirePermission('tch-008:read')
  @ApiOperation({ summary: 'List the schools adopted platform frameworks' })
  async listAdoptions(@Req() req: AuthRequest) {
    return this.frameworks.listAdoptions(await this.resolve(req));
  }

  @Post('adoptions')
  @RequirePermission('acr-001:write')
  @ApiOperation({ summary: 'Adopt a platform framework for this school' })
  async createAdoption(@Req() req: AuthRequest, @Body() body: CreateAdoptionDto) {
    return this.frameworks.createAdoption(await this.resolve(req), body);
  }

  @Post('custom-frameworks')
  @RequirePermission('acr-001:write')
  @ApiOperation({ summary: 'Create a school-custom accreditation framework' })
  async createCustomFramework(@Req() req: AuthRequest, @Body() body: CreateCustomFrameworkDto) {
    return this.frameworks.createCustomFramework(await this.resolve(req), body);
  }

  @Get('standards/:frameworkId')
  @RequirePermission('tch-008:read')
  @ApiOperation({
    summary: 'List standards for a framework (platform OR tenant custom)',
  })
  async listStandards(
    @Req() req: AuthRequest,
    @Param('frameworkId', new ParseUUIDPipe()) frameworkId: string,
  ) {
    return this.frameworks.listStandardsForFramework(await this.resolve(req), frameworkId);
  }

  @Get('standards/by-id/:standardId')
  @RequirePermission('tch-008:read')
  @ApiOperation({
    summary: 'Resolve a standard via SOFT INTEGRITY (platform OR tenant custom)',
  })
  async getStandardById(
    @Req() req: AuthRequest,
    @Param('standardId', new ParseUUIDPipe()) standardId: string,
  ) {
    return this.frameworks.getStandardById(await this.resolve(req), standardId);
  }

  // ── Evidence ──────────────────────────────────────────────────

  @Get('evidence/:standardId')
  @RequirePermission('tch-008:read')
  @ApiOperation({ summary: 'List evidence linked to a standard' })
  async listEvidenceForStandard(
    @Req() req: AuthRequest,
    @Param('standardId', new ParseUUIDPipe()) standardId: string,
  ) {
    return this.evidence.listForStandard(await this.resolve(req), standardId);
  }

  @Get('evidence/by-status')
  @RequirePermission('tch-008:read')
  @ApiOperation({ summary: 'Coordinator queue: list evidence filtered by status' })
  async listEvidenceByStatus(@Req() req: AuthRequest, @Query('status') status?: string) {
    return this.evidence.listByStatus(await this.resolve(req), status);
  }

  @Get('evidence/item/:id')
  @RequirePermission('tch-008:read')
  @ApiOperation({ summary: 'Read a single evidence item' })
  async getEvidence(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.evidence.getById(await this.resolve(req), id);
  }

  @Post('evidence')
  @RequirePermission('acr-001:write')
  @ApiOperation({
    summary: 'Submit evidence linked to a standard (DRAFT) — type-shape validated',
  })
  async createEvidence(@Req() req: AuthRequest, @Body() body: CreateEvidenceDto) {
    return this.evidence.create(await this.resolve(req), body);
  }

  @Patch('evidence/:id/review')
  @RequirePermission('acr-001:write')
  @ApiOperation({
    summary:
      'Lifecycle transition: DRAFT→SUBMITTED (any staff) or SUBMITTED→APPROVED|REJECTED (coordinator only)',
  })
  async reviewEvidence(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ReviewEvidenceDto,
  ) {
    return this.evidence.review(await this.resolve(req), id, body);
  }

  // ── Self-Study Ratings ───────────────────────────────────────

  @Get('self-study/:cycleId')
  @RequirePermission('tch-008:read')
  @ApiOperation({ summary: 'List self-study ratings for a cycle' })
  async listSelfStudy(@Req() req: AuthRequest, @Param('cycleId') cycleId: string) {
    return this.selfStudy.listForCycle(await this.resolve(req), cycleId);
  }

  @Get('self-study/:cycleId/summary')
  @RequirePermission('tch-008:read')
  @ApiOperation({ summary: 'Cycle summary: rating distribution + per-domain breakdown' })
  async selfStudySummary(@Req() req: AuthRequest, @Param('cycleId') cycleId: string) {
    return this.selfStudy.summary(await this.resolve(req), cycleId);
  }

  @Post('self-study-ratings')
  @RequirePermission('acr-001:write')
  @ApiOperation({
    summary:
      'Submit a self-study rating (UNIQUE per (standard, school, cycle) — re-rating returns 409)',
  })
  async createSelfStudyRating(@Req() req: AuthRequest, @Body() body: CreateSelfStudyRatingDto) {
    return this.selfStudy.create(await this.resolve(req), body);
  }

  // ── Action Plans ─────────────────────────────────────────────

  @Get('action-plans')
  @RequirePermission('tch-008:read')
  @ApiOperation({ summary: 'List action plans (optional ?status= filter)' })
  async listActionPlans(@Req() req: AuthRequest, @Query('status') status?: string) {
    return this.actionPlans.list(await this.resolve(req), status);
  }

  @Get('action-plans/:id')
  @RequirePermission('tch-008:read')
  @ApiOperation({ summary: 'Read a single action plan' })
  async getActionPlan(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.actionPlans.getById(await this.resolve(req), id);
  }

  @Post('action-plans')
  @RequirePermission('acr-001:write')
  @ApiOperation({ summary: 'Create an action plan for a standard' })
  async createActionPlan(@Req() req: AuthRequest, @Body() body: CreateActionPlanDto) {
    return this.actionPlans.create(await this.resolve(req), body);
  }

  @Patch('action-plans/:id')
  @RequirePermission('acr-001:write')
  @ApiOperation({ summary: 'Update an action plan (status transitions enforced)' })
  async updateActionPlan(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateActionPlanDto,
  ) {
    return this.actionPlans.update(await this.resolve(req), id, body);
  }

  @Patch('action-plans/:id/actions')
  @RequirePermission('acr-001:write')
  @ApiOperation({
    summary:
      'Update one sub-action by index. Auto-completes the parent plan when all sub-actions are COMPLETED.',
  })
  async updateSubAction(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateSubActionDto,
  ) {
    return this.actionPlans.updateSubAction(await this.resolve(req), id, body);
  }

  @Delete('action-plans/:id')
  @RequirePermission('acr-001:write')
  @ApiOperation({ summary: 'Delete a non-COMPLETE action plan' })
  async deleteActionPlan(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.actionPlans.delete(await this.resolve(req), id);
    return { ok: true };
  }

  // ── Site Visit Prep ──────────────────────────────────────────

  @Get('site-visit')
  @RequirePermission('tch-008:read')
  @ApiOperation({ summary: 'List site visit preparations for the school' })
  async listSiteVisits(@Req() req: AuthRequest) {
    return this.siteVisits.list(await this.resolve(req));
  }

  @Get('site-visit/:id')
  @RequirePermission('tch-008:read')
  @ApiOperation({ summary: 'Read a single site visit preparation' })
  async getSiteVisit(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.siteVisits.getById(await this.resolve(req), id);
  }

  @Post('site-visit')
  @RequirePermission('acr-001:write')
  @ApiOperation({ summary: 'Schedule a site visit preparation (status=PREPARING)' })
  async createSiteVisit(@Req() req: AuthRequest, @Body() body: CreateSiteVisitPrepDto) {
    return this.siteVisits.create(await this.resolve(req), body);
  }

  @Patch('site-visit/:id')
  @RequirePermission('acr-001:write')
  @ApiOperation({
    summary: 'Update a site visit preparation (PREPARING → READY → VISIT_COMPLETE)',
  })
  async updateSiteVisit(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateSiteVisitPrepDto,
  ) {
    return this.siteVisits.update(await this.resolve(req), id, body);
  }

  @Get('site-visit/:id/readiness')
  @RequirePermission('tch-008:read')
  @ApiOperation({
    summary:
      'Compute the readiness score (% of adopted standards with rating + APPROVED evidence) and return the gap list',
  })
  async siteVisitReadiness(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.siteVisits.readinessForVisit(await this.resolve(req), id);
  }
}
