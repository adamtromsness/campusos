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
import { RestorativeJusticeService } from './restorative-justice.service';
import { PeerMediationService } from './peer-mediation.service';
import { PositiveBehaviourService } from './positive-behaviour.service';
import { CategoryConfigService } from './category-config.service';
import {
  BipFeedbackService,
  RequestBipFeedbackDto,
  SubmitBipFeedbackDto,
  BipFeedbackResponseDto,
} from './bip-feedback.service';
import {
  AwardPointsDto,
  BehaviourRewardResponseDto,
  CompleteRjActionDto,
  CreatePeerMediationDto,
  CreateRewardDto,
  CreateRjActionDto,
  CreateRjConferenceDto,
  PeerMediationResponseDto,
  PeerMediationStatus,
  PointsBalanceResponseDto,
  PointsTransactionResponseDto,
  PositiveCategoryConfig,
  RedeemRewardDto,
  RedemptionResponseDto,
  RjActionResponseDto,
  RjConferenceResponseDto,
  UpdatePeerMediationDto,
  UpdatePositiveCategoriesDto,
  UpdateRewardDto,
  UpdateRjConferenceDto,
} from './dto/behaviour-advanced.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Behaviour Advanced')
@ApiBearerAuth()
@Controller('behaviour')
export class BehaviourAdvancedController {
  constructor(
    private readonly rj: RestorativeJusticeService,
    private readonly mediation: PeerMediationService,
    private readonly positive: PositiveBehaviourService,
    private readonly categories: CategoryConfigService,
    private readonly bipFeedback: BipFeedbackService,
    private readonly actors: ActorContextService,
  ) {}

  // ── Restorative Justice ────────────────────────────────────────

  @Get('rj-conferences')
  @RequirePermission('beh-001:read')
  @ApiOperation({
    summary: 'List restorative justice conferences in the calling tenant.',
  })
  async listConferences(@Req() req: AuthedRequest): Promise<RjConferenceResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rj.listConferences(actor);
  }

  @Get('rj-conferences/:id')
  @RequirePermission('beh-001:read')
  async getConference(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<RjConferenceResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rj.getConferenceById(id, actor);
  }

  @Post('rj-conferences')
  @RequirePermission('beh-001:write')
  @ApiOperation({
    summary:
      'Initiate a restorative justice conference. Counsellor/admin only. Links to a Cycle 9 sis_discipline_incidents row.',
  })
  async createConference(
    @Body() body: CreateRjConferenceDto,
    @Req() req: AuthedRequest,
  ): Promise<RjConferenceResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rj.createConference(body, actor);
  }

  @Patch('rj-conferences/:id')
  @RequirePermission('beh-001:write')
  async updateConference(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateRjConferenceDto,
    @Req() req: AuthedRequest,
  ): Promise<RjConferenceResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rj.updateConference(id, body, actor);
  }

  @Get('rj-conferences/:id/actions')
  @RequirePermission('beh-001:read')
  async listActions(@Param('id', ParseUUIDPipe) id: string): Promise<RjActionResponseDto[]> {
    return this.rj.listActionsForConference(id);
  }

  @Post('rj-conferences/:id/actions')
  @RequirePermission('beh-001:write')
  async addAction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateRjActionDto,
    @Req() req: AuthedRequest,
  ): Promise<RjActionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rj.addAction(id, body, actor);
  }

  @Patch('rj-actions/:id/complete')
  @RequirePermission('beh-001:write')
  @ApiOperation({
    summary:
      'Mark an agreement action COMPLETED with evidence. If every action on the parent conference is now COMPLETED, the conference auto-transitions to RESOLVED_SUCCESSFULLY and beh.rj_conference.resolved emits via the durable outbox.',
  })
  async completeAction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CompleteRjActionDto,
    @Req() req: AuthedRequest,
  ): Promise<{ action: RjActionResponseDto; conferenceResolved: boolean }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rj.completeAction(id, body, actor);
  }

  // ── Peer Mediation ─────────────────────────────────────────────

  @Get('peer-mediations')
  @RequirePermission('beh-001:read')
  async listMediations(
    @Req() req: AuthedRequest,
    @Query('status') status?: PeerMediationStatus,
  ): Promise<PeerMediationResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.mediation.list(actor, status);
  }

  @Get('peer-mediations/:id')
  @RequirePermission('beh-001:read')
  async getMediation(@Param('id', ParseUUIDPipe) id: string): Promise<PeerMediationResponseDto> {
    return this.mediation.getById(id);
  }

  @Post('peer-mediations')
  @RequirePermission('beh-001:write')
  async createMediation(
    @Body() body: CreatePeerMediationDto,
    @Req() req: AuthedRequest,
  ): Promise<PeerMediationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.mediation.create(body, actor);
  }

  @Patch('peer-mediations/:id')
  @RequirePermission('beh-001:write')
  async updateMediation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePeerMediationDto,
    @Req() req: AuthedRequest,
  ): Promise<PeerMediationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.mediation.update(id, body, actor);
  }

  @Get('peer-mediators')
  @RequirePermission('beh-001:read')
  async listTrainedMediators(): Promise<Array<{ studentId: string; studentName: string | null }>> {
    return this.mediation.listTrainedMediators();
  }

  // ── Positive Behaviour ─────────────────────────────────────────

  @Post('positive-points')
  @RequirePermission('beh-001:write')
  async awardPoints(
    @Body() body: AwardPointsDto,
    @Req() req: AuthedRequest,
  ): Promise<PointsTransactionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.positive.award(body, actor);
  }

  @Get('positive-points/:studentId')
  @RequirePermission('beh-001:read')
  @ApiOperation({
    summary:
      'Read a student point balance + history. Actor-aware row scope: admin all, teacher own-class students, student self, guardian linked children. Anyone else: 403.',
  })
  async getStudentBalance(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<PointsBalanceResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.positive.getStudentBalance(studentId, actor);
  }

  @Get('rewards')
  @RequirePermission('beh-001:read')
  async listRewards(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<BehaviourRewardResponseDto[]> {
    return this.positive.listRewards(includeInactive === 'true');
  }

  @Post('rewards')
  @RequirePermission('beh-001:admin')
  async createReward(
    @Body() body: CreateRewardDto,
    @Req() req: AuthedRequest,
  ): Promise<BehaviourRewardResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.positive.createReward(body, actor);
  }

  @Patch('rewards/:id')
  @RequirePermission('beh-001:admin')
  async updateReward(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateRewardDto,
    @Req() req: AuthedRequest,
  ): Promise<BehaviourRewardResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.positive.updateReward(id, body, actor);
  }

  @Post('rewards/:id/redeem')
  @RequirePermission('beh-001:read')
  @ApiOperation({
    summary:
      'Redeem a reward. Validates balance >= points_cost + decrements quantity_available inside a locked tenant tx. Students can redeem own; admins can redeem on behalf.',
  })
  async redeemReward(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RedeemRewardDto,
    @Req() req: AuthedRequest,
  ): Promise<RedemptionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.positive.redeem(id, body, actor);
  }

  // ── Category configuration ─────────────────────────────────────

  @Get('positive-categories')
  @RequirePermission('beh-001:read')
  async listCategories(): Promise<PositiveCategoryConfig[]> {
    return this.categories.list();
  }

  @Patch('positive-categories')
  @RequirePermission('beh-001:admin')
  async updateCategories(
    @Body() body: UpdatePositiveCategoriesDto,
    @Req() req: AuthedRequest,
  ): Promise<PositiveCategoryConfig[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.categories.update(body, actor);
  }

  // ── BIP teacher feedback (extends Cycle 11 svc_bip_teacher_feedback) ──

  @Get('bip/:planId/feedback')
  @RequirePermission('beh-002:read')
  async listBipFeedback(
    @Param('planId', ParseUUIDPipe) planId: string,
  ): Promise<BipFeedbackResponseDto[]> {
    return this.bipFeedback.listForPlan(planId);
  }

  @Post('bip/:planId/request-feedback')
  @RequirePermission('beh-002:write')
  async requestBipFeedback(
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() body: RequestBipFeedbackDto,
    @Req() req: AuthedRequest,
  ): Promise<BipFeedbackResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.bipFeedback.requestFeedback(planId, body, actor);
  }

  @Patch('bip-feedback/:id')
  @RequirePermission('beh-002:read')
  @ApiOperation({
    summary:
      'Submit BIP teacher feedback. The assigned teacher (or counsellor/admin override) can submit. Once submitted, the partial UNIQUE on (plan_id, teacher_id) WHERE submitted_at IS NULL releases automatically.',
  })
  async submitBipFeedback(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SubmitBipFeedbackDto,
    @Req() req: AuthedRequest,
  ): Promise<BipFeedbackResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.bipFeedback.submit(id, body, actor);
  }
}
