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
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { TranslationService } from '../messaging/translation.service';
import { LanguagePreferenceService } from '../messaging/language-preference.service';
import { TemplateService } from '../messaging/template.service';
import { BroadcastSegmentService } from '../broadcasts/broadcast-segment.service';
import { BroadcastAnalyticsService } from '../broadcasts/broadcast-analytics.service';
import { ModerationService } from '../moderation/ai-moderation-aggregate.service';
import { AppealService } from '../moderation/appeal.service';
import { AIModerationService } from '../moderation/ai-moderation.service';
import { PushCampaignService } from '../push/push-campaign.service';
import {
  AiAnalyzeRequestDto,
  AiModerationResultDto,
  AppealDto,
  AppealStatus,
  BroadcastAnalyticsDto,
  BroadcastSegmentDto,
  CreateAppealDto,
  CreateBroadcastSegmentDto,
  CreateModerationRuleDto,
  CreatePushCampaignDto,
  CreateTemplateDto,
  LanguagePreferenceDto,
  ModerationActionDto,
  ModerationRuleDto,
  PatchAppealDto,
  PatchModerationActionDto,
  PushAnalyticsDto,
  PushCampaignDto,
  PushCampaignStatus,
  PushDeviceTokenDto,
  RegisterPushDeviceDto,
  RenderTemplateDto,
  RenderedTemplateDto,
  ReviewStatus,
  SegmentPreviewDto,
  SegmentResolutionDto,
  TemplateAnalyticsDto,
  TemplateCategory,
  TemplateDto,
  TemplateUsageDto,
  TranslateRequestDto,
  TranslationDto,
  UpdateBroadcastSegmentDto,
  UpdateLanguagePreferenceDto,
  UpdateModerationRuleDto,
  UpdatePushCampaignDto,
  UpdateTemplateDto,
  UseTemplateDto,
} from './dto/communications-advanced.dto';

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
 * CommunicationsAdvancedController — Phase 2 Cycle 19 sub-cycle a
 * (P2-19a). ~18 endpoints across 5 surfaces:
 *
 *   Translation + language preferences (5)
 *     POST   /communications/translate
 *     GET    /communications/translations/:messageId
 *     GET    /communications/language-preferences
 *     PATCH  /communications/language-preferences
 *
 *   Templates (7)
 *     GET    /communications/templates
 *     GET    /communications/templates/:id
 *     POST   /communications/templates
 *     PATCH  /communications/templates/:id
 *     POST   /communications/templates/:id/render
 *     POST   /communications/templates/:id/use
 *     GET    /communications/templates/:id/analytics
 *     GET    /communications/templates/:id/usage
 *
 *   Broadcast segments (6)
 *     GET    /communications/segments
 *     GET    /communications/segments/:id
 *     POST   /communications/segments
 *     PATCH  /communications/segments/:id
 *     POST   /communications/segments/:id/resolve
 *     GET    /communications/segments/:id/preview
 *
 *   Broadcast analytics (1)
 *     GET    /communications/broadcasts/:id/analytics
 *
 * Permission gates:
 *   - com-001:read / write — translation, templates (read-side),
 *     language preferences
 *   - com-002:read / write — templates (write-side), broadcast
 *     segments + analytics
 */
@ApiTags('Communications Advanced')
@Controller()
export class CommunicationsAdvancedController {
  constructor(
    private readonly translations: TranslationService,
    private readonly languages: LanguagePreferenceService,
    private readonly templates: TemplateService,
    private readonly segments: BroadcastSegmentService,
    private readonly analytics: BroadcastAnalyticsService,
    private readonly moderation: ModerationService,
    private readonly appeals: AppealService,
    private readonly aiModeration: AIModerationService,
    private readonly pushCampaigns: PushCampaignService,
    private readonly actors: ActorContextService,
  ) {}

  private async resolveActor(req: AuthedRequest) {
    if (!req.user) throw new Error('Unauthenticated request reached communications-advanced');
    return this.actors.resolveActor(req.user.sub, req.user.personId);
  }

  // ── Translation ──────────────────────────────────────────────

  @Post('communications/translate')
  @RequirePermission('com-001:read')
  @ApiOperation({
    summary:
      'Translate a message to a target language. Cached — same (messageId, targetLanguage) pair returns the cached row.',
  })
  async translate(
    @Req() req: AuthedRequest,
    @Body() body: TranslateRequestDto,
  ): Promise<TranslationDto> {
    const actor = await this.resolveActor(req);
    return this.translations.translate(body, actor.accountId, actor);
  }

  @Get('communications/translations/:messageId')
  @RequirePermission('com-001:read')
  @ApiOperation({
    summary:
      'List every cached translation for a message. Caller must be a thread participant, the sender, or a school admin.',
  })
  async listTranslations(
    @Req() req: AuthedRequest,
    @Param('messageId') messageId: string,
  ): Promise<TranslationDto[]> {
    const actor = await this.resolveActor(req);
    return this.translations.listForMessage(messageId, actor);
  }

  // ── Language preferences ────────────────────────────────────

  @Get('communications/language-preferences')
  @RequirePermission('com-001:read')
  @ApiOperation({
    summary:
      'Read the calling user’s language preference + auto-translate toggles. Returns the default English row if no preference is set.',
  })
  async getLanguagePreference(@Req() req: AuthedRequest): Promise<LanguagePreferenceDto> {
    const actor = await this.resolveActor(req);
    return this.languages.getOrDefault(actor.accountId);
  }

  @Patch('communications/language-preferences')
  @RequirePermission('com-001:read')
  @ApiOperation({
    summary: 'Upsert the calling user’s language preference. Self-service — no admin override.',
  })
  async updateLanguagePreference(
    @Req() req: AuthedRequest,
    @Body() body: UpdateLanguagePreferenceDto,
  ): Promise<LanguagePreferenceDto> {
    const actor = await this.resolveActor(req);
    return this.languages.upsert(actor.accountId, body);
  }

  // ── Templates ────────────────────────────────────────────────

  @Get('communications/templates')
  @RequirePermission('com-001:read')
  @ApiOperation({
    summary:
      'List templates visible to the calling user. Non-admins see only templates whose allowed_roles overlap with the caller’s IAM role tokens.',
  })
  async listTemplates(
    @Req() req: AuthedRequest,
    @Query('category') category?: TemplateCategory,
    @Query('includeInactive') includeInactive?: string,
  ): Promise<TemplateDto[]> {
    const actor = await this.resolveActor(req);
    return this.templates.list(actor, {
      category,
      includeInactive: includeInactive === 'true',
    });
  }

  @Get('communications/templates/:id')
  @RequirePermission('com-001:read')
  async getTemplate(@Req() req: AuthedRequest, @Param('id') id: string): Promise<TemplateDto> {
    const actor = await this.resolveActor(req);
    return this.templates.getById(id, actor);
  }

  @Post('communications/templates')
  @RequirePermission('com-002:write')
  async createTemplate(
    @Req() req: AuthedRequest,
    @Body() body: CreateTemplateDto,
  ): Promise<TemplateDto> {
    const actor = await this.resolveActor(req);
    return this.templates.create(body, actor);
  }

  @Patch('communications/templates/:id')
  @RequirePermission('com-002:write')
  async patchTemplate(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateTemplateDto,
  ): Promise<TemplateDto> {
    const actor = await this.resolveActor(req);
    return this.templates.patch(id, body, actor);
  }

  @Post('communications/templates/:id/render')
  @RequirePermission('com-001:read')
  @ApiOperation({
    summary:
      'Render a template with the supplied variable values. KEYSTONE — required variables without a provided value AND without a default_value fail with 400.',
  })
  async renderTemplate(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: RenderTemplateDto,
  ): Promise<RenderedTemplateDto> {
    const actor = await this.resolveActor(req);
    return this.templates.render(id, body, actor);
  }

  @Post('communications/templates/:id/use')
  @RequirePermission('com-001:write')
  @ApiOperation({
    summary:
      'Render the template AND log a row in msg_template_usage_log. Use this whenever a template is applied to a real broadcast / thread.',
  })
  async useTemplate(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UseTemplateDto,
  ): Promise<RenderedTemplateDto> {
    const actor = await this.resolveActor(req);
    return this.templates.use(id, body, actor);
  }

  @Get('communications/templates/:id/analytics')
  @RequirePermission('com-001:read')
  async templateAnalytics(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
  ): Promise<TemplateAnalyticsDto> {
    const actor = await this.resolveActor(req);
    return this.templates.getAnalytics(id, actor);
  }

  @Get('communications/templates/:id/usage')
  @RequirePermission('com-001:read')
  async templateUsage(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
  ): Promise<TemplateUsageDto[]> {
    const actor = await this.resolveActor(req);
    return this.templates.listUsage(id, actor);
  }

  // ── Broadcast segments ──────────────────────────────────────

  @Get('communications/segments')
  @RequirePermission('com-002:read')
  async listSegments(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<BroadcastSegmentDto[]> {
    return this.segments.list({ includeInactive: includeInactive === 'true' });
  }

  @Get('communications/segments/:id')
  @RequirePermission('com-002:read')
  async getSegment(@Param('id') id: string): Promise<BroadcastSegmentDto> {
    return this.segments.getById(id);
  }

  @Post('communications/segments')
  @RequirePermission('com-002:write')
  async createSegment(
    @Req() req: AuthedRequest,
    @Body() body: CreateBroadcastSegmentDto,
  ): Promise<BroadcastSegmentDto> {
    const actor = await this.resolveActor(req);
    return this.segments.create(body, actor);
  }

  @Patch('communications/segments/:id')
  @RequirePermission('com-002:write')
  async patchSegment(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateBroadcastSegmentDto,
  ): Promise<BroadcastSegmentDto> {
    const actor = await this.resolveActor(req);
    return this.segments.patch(id, body, actor);
  }

  @Post('communications/segments/:id/resolve')
  @RequirePermission('com-002:write')
  @ApiOperation({
    summary:
      'Compute the recipient set (platform_users.id values) the segment resolves to. Also refreshes estimated_recipients on the segment row.',
  })
  async resolveSegment(@Param('id') id: string): Promise<SegmentResolutionDto> {
    return this.segments.resolve(id);
  }

  @Get('communications/segments/:id/preview')
  @RequirePermission('com-002:read')
  async previewSegment(@Param('id') id: string): Promise<SegmentPreviewDto> {
    return this.segments.preview(id);
  }

  // ── Broadcast analytics ─────────────────────────────────────

  @Get('communications/broadcasts/:id/analytics')
  @RequirePermission('com-002:read')
  @ApiOperation({
    summary:
      'Per-(broadcast, segment) delivery / open / click funnel plus the aggregate rollup row (segment_id IS NULL).',
  })
  async broadcastAnalytics(@Param('id') id: string): Promise<BroadcastAnalyticsDto> {
    return this.analytics.getForBroadcast(id);
  }

  // ── Moderation rules (P2-19b) ───────────────────────────────

  @Get('communications/moderation/rules')
  @RequirePermission('com-003:read')
  @ApiOperation({
    summary:
      'List moderation rules across all 3 tiers (PLATFORM + DISTRICT + BUILDING). Active only by default; pass includeInactive=true for archived rules.',
  })
  async listModerationRules(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<ModerationRuleDto[]> {
    return this.moderation.listRules(includeInactive === 'true');
  }

  @Get('communications/moderation/rules/:id')
  @RequirePermission('com-003:read')
  async getModerationRule(@Param('id') id: string): Promise<ModerationRuleDto> {
    return this.moderation.getRule(id);
  }

  @Post('communications/moderation/rules')
  @RequirePermission('com-003:admin')
  @ApiOperation({
    summary:
      'Create a moderation rule. scope=PLATFORM is Platform-Admin only — tenant admins cannot deactivate platform-non-negotiable rules. scope=DISTRICT and BUILDING are tenant-scoped.',
  })
  async createModerationRule(
    @Req() req: AuthedRequest,
    @Body() body: CreateModerationRuleDto,
  ): Promise<ModerationRuleDto> {
    const actor = await this.resolveActor(req);
    return this.moderation.createRule(body, actor);
  }

  @Patch('communications/moderation/rules/:id')
  @RequirePermission('com-003:admin')
  async patchModerationRule(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateModerationRuleDto,
  ): Promise<ModerationRuleDto> {
    const actor = await this.resolveActor(req);
    return this.moderation.patchRule(id, body, actor);
  }

  // ── Moderation queue / actions (P2-19b) ─────────────────────

  @Get('communications/moderation/queue')
  @RequirePermission('com-003:write')
  @ApiOperation({
    summary:
      'Admin queue of moderation actions awaiting review. Filter by review_status (default PENDING). Limit 1-200 (default 50).',
  })
  async listModerationQueue(
    @Query('reviewStatus') reviewStatus?: ReviewStatus,
    @Query('limit') limit?: string,
  ): Promise<ModerationActionDto[]> {
    return this.moderation.listQueue({
      reviewStatus,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('communications/moderation-actions/:id')
  @RequirePermission('com-003:read')
  async getModerationAction(@Param('id') id: string): Promise<ModerationActionDto> {
    return this.moderation.getAction(id);
  }

  @Patch('communications/moderation-actions/:id')
  @RequirePermission('com-003:write')
  @ApiOperation({
    summary:
      'Admin reviews a moderation action: RELEASED restores the message to recipients, CONFIRMED_BLOCK keeps it blocked, ESCALATED bumps it to the counsellor queue.',
  })
  async patchModerationAction(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: PatchModerationActionDto,
  ): Promise<ModerationActionDto> {
    const actor = await this.resolveActor(req);
    return this.moderation.patchAction(id, body, actor);
  }

  // ── Appeals (P2-19b) ────────────────────────────────────────

  @Get('communications/moderation/appeals')
  @RequirePermission('com-003:write')
  @ApiOperation({
    summary:
      'Admin queue of user appeals on moderation actions. Filter by status (default SUBMITTED).',
  })
  async listAppeals(
    @Query('status') status?: AppealStatus,
    @Query('limit') limit?: string,
  ): Promise<AppealDto[]> {
    return this.appeals.list({ status, limit: limit ? Number(limit) : undefined });
  }

  @Get('communications/moderation-appeals/:id')
  @RequirePermission('com-003:read')
  async getAppeal(@Param('id') id: string): Promise<AppealDto> {
    return this.appeals.getById(id);
  }

  @Post('communications/moderation-actions/:id/appeal')
  @RequirePermission('com-001:write')
  @ApiOperation({
    summary:
      'User submits an appeal against a moderation action. Caller must be the message sender or a school admin. UNIQUE(action_id) — only one appeal per action.',
  })
  async createAppeal(
    @Req() req: AuthedRequest,
    @Param('id') actionId: string,
    @Body() body: CreateAppealDto,
  ): Promise<AppealDto> {
    const actor = await this.resolveActor(req);
    return this.appeals.create(actionId, body, actor);
  }

  @Patch('communications/moderation-appeals/:id')
  @RequirePermission('com-003:write')
  @ApiOperation({
    summary:
      'Admin reviews an appeal. On OVERTURNED the parent moderation action flips to RELEASED inside the same tenant tx.',
  })
  async patchAppeal(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: PatchAppealDto,
  ): Promise<AppealDto> {
    const actor = await this.resolveActor(req);
    return this.appeals.patch(id, body, actor);
  }

  // ── AI moderation (P2-19b) ──────────────────────────────────

  @Post('communications/ai-moderation/analyze')
  @RequirePermission('com-003:write')
  @ApiOperation({
    summary:
      'Compute the AI sensitivity score for a message. Cache hit on UNIQUE(message_id) returns the cached row with cached=true.',
  })
  async analyzeAi(@Body() body: AiAnalyzeRequestDto): Promise<AiModerationResultDto> {
    return this.aiModeration.analyze(body.messageId, body.text);
  }

  @Get('communications/ai-moderation/:messageId')
  @RequirePermission('com-003:read')
  async getAiModerationResult(
    @Param('messageId') messageId: string,
  ): Promise<AiModerationResultDto | null> {
    return this.aiModeration.getCached(messageId);
  }

  // ── Push campaigns (P2-19b) ─────────────────────────────────

  @Get('communications/push-campaigns')
  @RequirePermission('com-002:read')
  async listPushCampaigns(
    @Query('status') status?: PushCampaignStatus,
    @Query('limit') limit?: string,
  ): Promise<PushCampaignDto[]> {
    return this.pushCampaigns.list({ status, limit: limit ? Number(limit) : undefined });
  }

  @Get('communications/push-campaigns/:id')
  @RequirePermission('com-002:read')
  async getPushCampaign(@Param('id') id: string): Promise<PushCampaignDto> {
    return this.pushCampaigns.getById(id);
  }

  @Post('communications/push-campaigns')
  @RequirePermission('com-002:write')
  async createPushCampaign(
    @Req() req: AuthedRequest,
    @Body() body: CreatePushCampaignDto,
  ): Promise<PushCampaignDto> {
    const actor = await this.resolveActor(req);
    return this.pushCampaigns.create(body, actor);
  }

  @Patch('communications/push-campaigns/:id')
  @RequirePermission('com-002:write')
  @ApiOperation({
    summary:
      'Edit a push campaign. status=SCHEDULED requires scheduled_at populated. SENT and CANCELLED are terminal — no edits allowed.',
  })
  async patchPushCampaign(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdatePushCampaignDto,
  ): Promise<PushCampaignDto> {
    const actor = await this.resolveActor(req);
    return this.pushCampaigns.patch(id, body, actor);
  }

  @Get('communications/push-campaigns/:id/analytics')
  @RequirePermission('com-002:read')
  async getPushAnalytics(@Param('id') id: string): Promise<PushAnalyticsDto | null> {
    return this.pushCampaigns.getAnalytics(id);
  }

  // ── Push device tokens (P2-19b) ─────────────────────────────

  @Post('communications/push-devices')
  @RequirePermission('com-001:write')
  @ApiOperation({
    summary:
      'Register a push device token for the calling user. Re-registering an existing token updates last_used_at and is_active=true.',
  })
  async registerPushDevice(
    @Req() req: AuthedRequest,
    @Body() body: RegisterPushDeviceDto,
  ): Promise<PushDeviceTokenDto> {
    const actor = await this.resolveActor(req);
    return this.pushCampaigns.registerDevice(body, actor);
  }

  @Get('communications/push-devices')
  @RequirePermission('com-001:read')
  async listMyPushDevices(@Req() req: AuthedRequest): Promise<PushDeviceTokenDto[]> {
    const actor = await this.resolveActor(req);
    return this.pushCampaigns.listOwnDevices(actor);
  }

  @Delete('communications/push-devices/:id')
  @RequirePermission('com-001:write')
  @HttpCode(204)
  async deregisterPushDevice(@Req() req: AuthedRequest, @Param('id') id: string): Promise<void> {
    const actor = await this.resolveActor(req);
    await this.pushCampaigns.deregisterDevice(id, actor);
  }
}
