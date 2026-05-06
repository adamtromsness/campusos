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
import {
  AddContributorDto,
  AudiencePreviewDto,
  CreateCommentDto,
  CreateDistributionListDto,
  CreateDistributionRuleDto,
  CreateEditionDto,
  CreatePublicationDto,
  CreateSectionDto,
  CreateSeriesDto,
  DistributionListDto,
  DistributionRuleDto,
  DistributionStatusDto,
  EditionDto,
  InviteCollaboratorDto,
  PublicationCollaboratorDto,
  PublicationDetailDto,
  PublicationDto,
  PublicationStatus,
  SectionCommentDto,
  SectionContributorDto,
  SectionDto,
  SeriesDto,
  SubscriptionDto,
  UpdateEditionDto,
  UpdatePublicationStatusDto,
  UpdateSectionDto,
  UpdateSeriesDto,
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
}
