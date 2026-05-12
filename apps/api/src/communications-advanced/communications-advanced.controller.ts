import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { TranslationService } from './translation.service';
import { LanguagePreferenceService } from './language-preference.service';
import { TemplateService } from './template.service';
import { BroadcastSegmentService } from './broadcast-segment.service';
import { BroadcastAnalyticsService } from './broadcast-analytics.service';
import {
  BroadcastAnalyticsDto,
  BroadcastSegmentDto,
  CreateBroadcastSegmentDto,
  CreateTemplateDto,
  LanguagePreferenceDto,
  RenderTemplateDto,
  RenderedTemplateDto,
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
    return this.translations.translate(body, actor.accountId);
  }

  @Get('communications/translations/:messageId')
  @RequirePermission('com-001:read')
  @ApiOperation({ summary: 'List every cached translation for a message.' })
  async listTranslations(@Param('messageId') messageId: string): Promise<TranslationDto[]> {
    return this.translations.listForMessage(messageId);
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
}
