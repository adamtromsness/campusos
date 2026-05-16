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
import {
  CollaboratorService,
  EditionService,
  PublicationService,
  SeriesService,
} from './series.service';
import { CommentService, ContributorService, SectionService } from './sections.service';
import { DistributionService, SubscriptionService } from './distribution.service';
import { TemplateService, VersionService } from './versions.service';
import { PublicationAnalyticsService, ScheduledPublishService } from './scheduled-publish.service';
import {
  AddContributorDto,
  AudiencePreviewDto,
  CancelScheduledPublicationDto,
  CreateCheckpointDto,
  CreateCommentDto,
  CreateDistributionListDto,
  CreateDistributionRuleDto,
  CreateEditionDto,
  CreateFromTemplateDto,
  CreatePublicationDto,
  CreateScheduledPublicationDto,
  CreateSectionDto,
  CreateSeriesDto,
  CreateTemplateDto,
  DistributionListDto,
  DistributionRuleDto,
  DistributionStatusDto,
  EditionDto,
  IngestAnalyticsEventDto,
  InviteCollaboratorDto,
  PublicationAnalyticsDto,
  PublicationCollaboratorDto,
  PublicationDetailDto,
  PublicationDto,
  PublicationStatus,
  PublicationVersionDetailDto,
  PublicationVersionDto,
  RevertToVersionDto,
  ScheduledPublicationDto,
  SectionCommentDto,
  SectionContributorDto,
  SectionDto,
  SeriesDto,
  SubscriptionDto,
  TemplateDto,
  UpdateEditionDto,
  UpdatePublicationStatusDto,
  UpdateSectionDto,
  UpdateSeriesDto,
  UpdateTemplateDto,
} from './dto/publications.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    personId: string;
    email: string;
    displayName: string;
    sessionId: string;
  };
}

@ApiTags('Publications')
@Controller()
export class PublicationsController {
  constructor(
    private readonly series: SeriesService,
    private readonly editions: EditionService,
    private readonly publications: PublicationService,
    private readonly collaborators: CollaboratorService,
    private readonly sections: SectionService,
    private readonly contributors: ContributorService,
    private readonly comments: CommentService,
    private readonly distribution: DistributionService,
    private readonly subscriptions: SubscriptionService,
    private readonly versions: VersionService,
    private readonly templates: TemplateService,
    private readonly scheduled: ScheduledPublishService,
    private readonly analytics: PublicationAnalyticsService,
    private readonly actors: ActorContextService,
  ) {}

  private async resolveActor(req: AuthedRequest) {
    if (!req.user) throw new Error('Unauthenticated request reached Publications controller');
    return this.actors.resolveActor(req.user.sub, req.user.personId);
  }

  // ── Series ──

  @Get('publications/series')
  @RequirePermission('pub-001:read')
  async listSeries(): Promise<SeriesDto[]> {
    return this.series.list();
  }

  @Get('publications/series/:id')
  @RequirePermission('pub-001:read')
  async getSeries(@Param('id') id: string): Promise<SeriesDto> {
    return this.series.getById(id);
  }

  @Post('publications/series')
  @RequirePermission('pub-001:write')
  async createSeries(@Body() dto: CreateSeriesDto, @Req() req: AuthedRequest): Promise<SeriesDto> {
    return this.series.create(await this.resolveActor(req), dto);
  }

  @Patch('publications/series/:id')
  @RequirePermission('pub-001:write')
  async patchSeries(
    @Param('id') id: string,
    @Body() dto: UpdateSeriesDto,
    @Req() req: AuthedRequest,
  ): Promise<SeriesDto> {
    return this.series.patch(await this.resolveActor(req), id, dto);
  }

  // ── Editions ──

  @Get('publications/series/:id/editions')
  @RequirePermission('pub-001:read')
  async listEditions(@Param('id') id: string): Promise<EditionDto[]> {
    return this.editions.listForSeries(id);
  }

  @Get('publications/editions/:id')
  @RequirePermission('pub-001:read')
  async getEdition(@Param('id') id: string): Promise<EditionDto> {
    return this.editions.getById(id);
  }

  @Post('publications/series/:id/editions')
  @RequirePermission('pub-001:write')
  async createEdition(
    @Param('id') seriesId: string,
    @Body() dto: CreateEditionDto,
    @Req() req: AuthedRequest,
  ): Promise<EditionDto> {
    return this.editions.create(await this.resolveActor(req), seriesId, dto);
  }

  @Patch('publications/editions/:id')
  @RequirePermission('pub-001:write')
  async patchEdition(
    @Param('id') id: string,
    @Body() dto: UpdateEditionDto,
    @Req() req: AuthedRequest,
  ): Promise<EditionDto> {
    return this.editions.patch(await this.resolveActor(req), id, dto);
  }

  // ── Publications ──

  @Get('publications')
  @RequirePermission('pub-001:read')
  @ApiOperation({
    summary:
      'List publications. REVIEW-CYCLE25 BLOCKING 1 — non-writer non-collaborator readers see only PUBLISHED publications.',
  })
  async listPublications(
    @Req() req: AuthedRequest,
    @Query('status') status?: PublicationStatus,
    @Query('seriesId') seriesId?: string,
  ): Promise<PublicationDto[]> {
    return this.publications.list(await this.resolveActor(req), { status, seriesId });
  }

  // Static segments must be declared BEFORE the /publications/:id wildcard so
  // Express does not bind the literal segment to the :id parameter.
  @Get('publications/my-subscriptions')
  @RequirePermission('pub-001:read')
  async mySubscriptions(@Req() req: AuthedRequest): Promise<SubscriptionDto[]> {
    return this.subscriptions.myList(await this.resolveActor(req));
  }

  @Get('publications/:id')
  @RequirePermission('pub-001:read')
  @ApiOperation({
    summary:
      'Publication detail. REVIEW-CYCLE25 BLOCKING 1 — non-writer non-collaborator readers receive a collapsed 404 on non-PUBLISHED publications.',
  })
  async getPublication(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<PublicationDetailDto> {
    return this.publications.getById(id, await this.resolveActor(req));
  }

  @Post('publications')
  @RequirePermission('pub-001:write')
  async createPublication(
    @Body() dto: CreatePublicationDto,
    @Req() req: AuthedRequest,
  ): Promise<PublicationDto> {
    return this.publications.create(await this.resolveActor(req), dto);
  }

  @Patch('publications/:id/status')
  @RequirePermission('pub-001:write')
  @ApiOperation({
    summary:
      'Advance a publication through its lifecycle. ADR-035 KEYSTONE — APPROVED transitions are refused while any section has is_approved=false.',
  })
  async patchPublicationStatus(
    @Param('id') id: string,
    @Body() dto: UpdatePublicationStatusDto,
    @Req() req: AuthedRequest,
  ): Promise<PublicationDto> {
    return this.publications.patchStatus(await this.resolveActor(req), id, dto);
  }

  // ── Collaborators ──

  @Post('publications/:id/collaborators')
  @RequirePermission('pub-001:write')
  async invite(
    @Param('id') id: string,
    @Body() dto: InviteCollaboratorDto,
    @Req() req: AuthedRequest,
  ): Promise<PublicationCollaboratorDto> {
    return this.collaborators.invite(await this.resolveActor(req), id, dto);
  }

  @Delete('publication-collaborators/:id')
  @RequirePermission('pub-001:write')
  @HttpCode(204)
  async removeCollaborator(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    return this.collaborators.remove(await this.resolveActor(req), id);
  }

  // ── Sections ──

  @Get('publications/:id/sections')
  @RequirePermission('pub-001:read')
  @ApiOperation({
    summary:
      'List sections. REVIEW-CYCLE25 BLOCKING 1 — non-writer non-collaborator readers see only approved sections under PUBLISHED publications.',
  })
  async listSections(@Param('id') id: string, @Req() req: AuthedRequest): Promise<SectionDto[]> {
    return this.sections.listForPublication(id, await this.resolveActor(req));
  }

  @Post('publications/:id/sections')
  @RequirePermission('pub-002:write')
  async createSection(
    @Param('id') id: string,
    @Body() dto: CreateSectionDto,
    @Req() req: AuthedRequest,
  ): Promise<SectionDto> {
    return this.sections.create(await this.resolveActor(req), id, dto);
  }

  @Patch('publication-sections/:id')
  @RequirePermission('pub-002:write')
  async patchSection(
    @Param('id') id: string,
    @Body() dto: UpdateSectionDto,
    @Req() req: AuthedRequest,
  ): Promise<SectionDto> {
    return this.sections.patch(await this.resolveActor(req), id, dto);
  }

  @Delete('publication-sections/:id')
  @RequirePermission('pub-002:write')
  @HttpCode(204)
  async removeSection(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    return this.sections.remove(await this.resolveActor(req), id);
  }

  @Patch('publication-sections/:id/approve')
  @RequirePermission('pub-002:write')
  @ApiOperation({
    summary:
      'ADR-035 approval flip — editor / admin lifts the pending flag on a student-authored section.',
  })
  async approveSection(@Param('id') id: string, @Req() req: AuthedRequest): Promise<SectionDto> {
    return this.sections.approve(await this.resolveActor(req), id);
  }

  // ── Section contributors ──

  @Post('publication-sections/:id/contributors')
  @RequirePermission('pub-002:write')
  async addContributor(
    @Param('id') id: string,
    @Body() dto: AddContributorDto,
    @Req() req: AuthedRequest,
  ): Promise<SectionContributorDto> {
    return this.contributors.add(await this.resolveActor(req), id, dto);
  }

  @Delete('publication-section-contributors/:id')
  @RequirePermission('pub-002:write')
  @HttpCode(204)
  async removeContributor(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    return this.contributors.remove(await this.resolveActor(req), id);
  }

  // ── Section comments ──

  @Get('publication-sections/:id/comments')
  @RequirePermission('pub-002:write')
  @ApiOperation({
    summary:
      'Section comments — REVIEW-CYCLE25 BLOCKING 1: editorial review surface restricted to staff writers + collaborators on the parent publication. Non-writer non-collaborator readers receive a collapsed 404.',
  })
  async listSectionComments(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<SectionCommentDto[]> {
    return this.comments.listForSection(id, await this.resolveActor(req));
  }

  @Post('publication-sections/:id/comments')
  @RequirePermission('pub-002:write')
  async createComment(
    @Param('id') id: string,
    @Body() dto: CreateCommentDto,
    @Req() req: AuthedRequest,
  ): Promise<SectionCommentDto> {
    return this.comments.create(await this.resolveActor(req), id, dto);
  }

  @Patch('publication-comments/:id/resolve')
  @RequirePermission('pub-002:write')
  async resolveComment(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<SectionCommentDto> {
    return this.comments.resolve(await this.resolveActor(req), id);
  }

  // ── Distribution ──

  @Get('publications/:id/distribution-lists')
  @RequirePermission('pub-003:read')
  @ApiOperation({
    summary:
      'List distribution lists. REVIEW-CYCLE25 MAJOR 6 — gated to admin OR pub-003:write OR EDITOR collaborator on the publication.',
  })
  async listDistributionLists(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<DistributionListDto[]> {
    return this.distribution.listForPublication(await this.resolveActor(req), id);
  }

  @Post('publications/:id/distribution-lists')
  @RequirePermission('pub-003:write')
  async createDistributionList(
    @Param('id') id: string,
    @Body() dto: CreateDistributionListDto,
    @Req() req: AuthedRequest,
  ): Promise<DistributionListDto> {
    return this.distribution.createList(await this.resolveActor(req), id, dto);
  }

  @Post('publication-distribution-lists/:id/rules')
  @RequirePermission('pub-003:write')
  async addRule(
    @Param('id') id: string,
    @Body() dto: CreateDistributionRuleDto,
    @Req() req: AuthedRequest,
  ): Promise<DistributionRuleDto> {
    return this.distribution.addRule(await this.resolveActor(req), id, dto);
  }

  @Post('publications/:id/audience-preview')
  @RequirePermission('pub-003:write')
  @ApiOperation({
    summary:
      'Dry-run audience resolution — returns the count + sample names without writing recipient rows.',
  })
  async previewAudience(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<AudiencePreviewDto> {
    return this.distribution.previewAudience(await this.resolveActor(req), id);
  }

  @Post('publications/:id/distribute')
  @RequirePermission('pub-003:write')
  @ApiOperation({
    summary:
      'PUBLISH + DISTRIBUTE KEYSTONE — resolves the audience, INSERTs recipient rows (PENDING), flips status to PUBLISHED, emits pub.publication.published for Cycle 14 fan-out.',
  })
  async distribute(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<{ totalRecipients: number; alreadyExisted: number; status: 'PUBLISHED' }> {
    return this.distribution.distribute(await this.resolveActor(req), id);
  }

  @Get('publications/:id/distribution-status')
  @RequirePermission('pub-003:read')
  @ApiOperation({
    summary:
      'Delivery rollup. REVIEW-CYCLE25 MAJOR 6 — gated to admin / pub-003:write / EDITOR collaborator.',
  })
  async distributionStatus(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<DistributionStatusDto> {
    return this.distribution.deliveryStatus(await this.resolveActor(req), id);
  }

  // ── Subscriptions ──

  @Get('publications/series/:id/subscriptions')
  @RequirePermission('pub-001:write')
  async listSubscriptions(@Param('id') id: string): Promise<SubscriptionDto[]> {
    return this.subscriptions.listForSeries(id);
  }

  @Post('publications/series/:id/subscribe')
  @RequirePermission('pub-001:read')
  async subscribe(@Param('id') id: string, @Req() req: AuthedRequest): Promise<SubscriptionDto> {
    return this.subscriptions.subscribe(await this.resolveActor(req), id);
  }

  @Post('publications/series/:id/unsubscribe')
  @RequirePermission('pub-001:read')
  async unsubscribe(@Param('id') id: string, @Req() req: AuthedRequest): Promise<SubscriptionDto> {
    return this.subscriptions.unsubscribe(await this.resolveActor(req), id);
  }

  // ── P2-26: Version History ──

  @Get('publications/:id/versions')
  @RequirePermission('pub-001:read')
  @ApiOperation({
    summary:
      'P2-26 — list version history (without snapshot body) for a publication. Editor + collaborators only.',
  })
  async listVersions(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<PublicationVersionDto[]> {
    return this.versions.listForPublication(await this.resolveActor(req), id);
  }

  @Get('publications/versions/:versionId')
  @RequirePermission('pub-001:read')
  @ApiOperation({
    summary: 'P2-26 — fetch the full snapshot for a specific version. Editor + collaborators only.',
  })
  async getVersion(
    @Param('versionId') versionId: string,
    @Req() req: AuthedRequest,
  ): Promise<PublicationVersionDetailDto> {
    return this.versions.getById(await this.resolveActor(req), versionId);
  }

  @Post('publications/:id/checkpoint')
  @RequirePermission('pub-001:write')
  @ApiOperation({
    summary:
      'P2-26 — editor explicitly saves a checkpoint. Creates a new IMMUTABLE version with trigger=MANUAL_CHECKPOINT.',
  })
  async createCheckpoint(
    @Param('id') id: string,
    @Body() body: CreateCheckpointDto,
    @Req() req: AuthedRequest,
  ): Promise<PublicationVersionDto> {
    return this.versions.checkpoint(await this.resolveActor(req), id, body);
  }

  @Post('publications/:id/revert/:versionNumber')
  @RequirePermission('pub-001:write')
  @ApiOperation({
    summary:
      'P2-26 — REVERT KEYSTONE. Creates a NEW IMMUTABLE version from the target version snapshot (append-only — existing rows are never modified).',
  })
  async revertToVersion(
    @Param('id') id: string,
    @Param('versionNumber') versionNumber: string,
    @Body() body: RevertToVersionDto,
    @Req() req: AuthedRequest,
  ): Promise<PublicationVersionDto> {
    return this.versions.revert(await this.resolveActor(req), id, Number(versionNumber), body);
  }

  // ── P2-26: Templates ──

  @Get('publications/templates')
  @RequirePermission('pub-001:read')
  @ApiOperation({
    summary:
      'P2-26 — list publication templates. Includes platform-seeded system templates + school-custom templates.',
  })
  async listTemplates(
    @Query('includeInactive') includeInactive: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<TemplateDto[]> {
    return this.templates.list(
      await this.resolveActor(req),
      includeInactive === 'true' || includeInactive === '1',
    );
  }

  @Get('publications/templates/:id')
  @RequirePermission('pub-001:read')
  async getTemplate(@Param('id') id: string, @Req() req: AuthedRequest): Promise<TemplateDto> {
    return this.templates.getById(await this.resolveActor(req), id);
  }

  @Post('publications/templates')
  @RequirePermission('pub-001:write')
  @ApiOperation({
    summary:
      'P2-26 — admins + pub-001:write STAFF only. Creates a school-custom template (is_system always false).',
  })
  async createTemplate(
    @Body() body: CreateTemplateDto,
    @Req() req: AuthedRequest,
  ): Promise<TemplateDto> {
    return this.templates.create(await this.resolveActor(req), body);
  }

  @Patch('publications/templates/:id')
  @RequirePermission('pub-001:write')
  @ApiOperation({
    summary:
      'P2-26 — admins + pub-001:write STAFF only. is_system=true templates are rejected with 403 — only the platform seeder may modify those.',
  })
  async updateTemplate(
    @Param('id') id: string,
    @Body() body: UpdateTemplateDto,
    @Req() req: AuthedRequest,
  ): Promise<TemplateDto> {
    return this.templates.patch(await this.resolveActor(req), id, body);
  }

  @Delete('publications/templates/:id')
  @RequirePermission('pub-001:write')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'P2-26 — admins + pub-001:write STAFF only. is_system=true templates are rejected with 403.',
  })
  async deleteTemplate(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    await this.templates.remove(await this.resolveActor(req), id);
  }

  @Post('publications/from-template/:templateId')
  @RequirePermission('pub-001:write')
  @ApiOperation({
    summary:
      'P2-26 — FROM-TEMPLATE KEYSTONE. Creates a new pub_publications row (status=DRAFT) and auto-populates sections from template_content.sections inside one tenant tx.',
  })
  async createFromTemplate(
    @Param('templateId') templateId: string,
    @Body() body: CreateFromTemplateDto,
    @Req() req: AuthedRequest,
  ): Promise<PublicationDto> {
    return this.templates.createFromTemplate(await this.resolveActor(req), templateId, body);
  }

  // ── P2-26: Scheduled Publishing ──

  @Get('publications/scheduled')
  @RequirePermission('pub-001:write')
  @ApiOperation({
    summary: 'P2-26 — list every active schedule. Editors + admins only.',
  })
  async listScheduled(@Req() req: AuthedRequest): Promise<ScheduledPublicationDto[]> {
    return this.scheduled.list(await this.resolveActor(req));
  }

  @Get('publications/:id/schedule')
  @RequirePermission('pub-001:read')
  @ApiOperation({
    summary:
      'P2-26 — fetch the active schedule for a publication (if any). Returns null when none exists.',
  })
  async getScheduleForPublication(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<ScheduledPublicationDto | null> {
    return this.scheduled.getForPublication(await this.resolveActor(req), id);
  }

  @Post('publications/:id/schedule')
  @RequirePermission('pub-001:write')
  @ApiOperation({
    summary:
      'P2-26 — schedule a publication for auto-publish. Validates scheduled_at is in the future + parent status is DRAFT/IN_REVIEW/APPROVED.',
  })
  async schedulePublication(
    @Param('id') id: string,
    @Body() body: CreateScheduledPublicationDto,
    @Req() req: AuthedRequest,
  ): Promise<ScheduledPublicationDto> {
    return this.scheduled.schedule(await this.resolveActor(req), id, body);
  }

  @Delete('publications/:id/schedule')
  @RequirePermission('pub-001:write')
  @ApiOperation({
    summary:
      'P2-26 — cancel an active schedule. Flips status to CANCELLED with multi-column cancelled_chk lockstep satisfied atomically.',
  })
  async cancelSchedule(
    @Param('id') id: string,
    @Body() body: CancelScheduledPublicationDto,
    @Req() req: AuthedRequest,
  ): Promise<ScheduledPublicationDto> {
    return this.scheduled.cancel(await this.resolveActor(req), id, body);
  }

  // ── P2-26: Analytics ──

  @Get('publications/:id/analytics')
  @RequirePermission('pub-001:read')
  @ApiOperation({
    summary: 'P2-26 — per-publication engagement counters. Editor + collaborators + admins only.',
  })
  async getAnalytics(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<PublicationAnalyticsDto> {
    return this.analytics.get(await this.resolveActor(req), id);
  }

  @Get('publications/analytics/summary')
  @RequirePermission('pub-001:read')
  @ApiOperation({
    summary: 'P2-26 — school-wide analytics summary. School admins only at service layer.',
  })
  async analyticsSummary(@Req() req: AuthedRequest): Promise<PublicationAnalyticsDto[]> {
    return this.analytics.summary(await this.resolveActor(req));
  }

  @Post('publications/:id/analytics/events')
  @RequirePermission('pub-001:read')
  @HttpCode(202)
  @ApiOperation({
    summary:
      'P2-26 — atomic counter increment for view/open/link_click/bounce events. Concurrent events safe via SQL-level INCREMENT.',
  })
  async ingestAnalyticsEvent(
    @Param('id') id: string,
    @Body() body: IngestAnalyticsEventDto,
  ): Promise<PublicationAnalyticsDto> {
    return this.analytics.ingestEvent(id, body);
  }
}
