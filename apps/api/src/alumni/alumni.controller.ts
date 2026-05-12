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
import { AlumniProfileService, AlumniTagService } from './profile.service';
import { CampaignService, DonationService, OutreachService } from './campaign.service';
import { AlumniEventService, AlumniNewsService, ReunionGroupService } from './news.service';
import {
  AddRecipientsByTagDto,
  AddTagDto,
  AlumniEventDto,
  AlumniNewsDto,
  AlumniProfileDto,
  AlumniTagDto,
  CampaignDto,
  CampaignFunnelDto,
  CampaignRaisedDto,
  CampaignRecipientDto,
  CampaignStatus,
  CreateAlumniEventDto,
  CreateAlumniNewsDto,
  CreateAlumniProfileDto,
  CreateCampaignDto,
  CreateDonationDto,
  CreateReunionGroupDto,
  DonationDto,
  NewsCategory,
  OutreachStatus,
  ReunionGroupDto,
  ReunionStatus,
  UpdateAlumniEventDto,
  UpdateAlumniNewsDto,
  UpdateAlumniProfileDto,
  UpdateCampaignDto,
  UpdateRecipientStatusDto,
  UpdateReunionGroupDto,
} from './dto/alumni.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    personId: string;
    email: string;
    displayName: string;
    sessionId: string;
  };
}

@ApiTags('Alumni')
@Controller()
export class AlumniController {
  constructor(
    private readonly profiles: AlumniProfileService,
    private readonly tags: AlumniTagService,
    private readonly campaigns: CampaignService,
    private readonly donations: DonationService,
    private readonly outreach: OutreachService,
    private readonly news: AlumniNewsService,
    private readonly reunions: ReunionGroupService,
    private readonly events: AlumniEventService,
    private readonly actors: ActorContextService,
  ) {}

  private async resolveActor(req: AuthedRequest) {
    if (!req.user) throw new Error('Unauthenticated request reached Alumni controller');
    return this.actors.resolveActor(req.user.sub, req.user.personId);
  }

  // ── Profiles ──

  @Get('alumni/profiles')
  @RequirePermission('pub-004:read')
  @ApiOperation({
    summary:
      'Alumni directory. Non-staff readers see opted-in profiles only; staff + admin see all rows.',
  })
  async listProfiles(
    @Req() req: AuthedRequest,
    @Query('graduationYear') graduationYear?: string,
    @Query('employer') employer?: string,
    @Query('tag') tag?: string,
  ): Promise<AlumniProfileDto[]> {
    const actor = await this.resolveActor(req);
    return this.profiles.list(actor, {
      graduationYear: graduationYear ? Number(graduationYear) : undefined,
      employer,
      tag,
    });
  }

  @Get('alumni/profiles/me')
  @RequirePermission('pub-004:read')
  async getMyProfile(@Req() req: AuthedRequest): Promise<AlumniProfileDto> {
    return this.profiles.getMine(await this.resolveActor(req));
  }

  @Get('alumni/profiles/by-tag/:tag')
  @RequirePermission('pub-004:read')
  async listByTag(
    @Param('tag') tag: string,
    @Req() req: AuthedRequest,
  ): Promise<AlumniProfileDto[]> {
    return this.tags.listByTag(tag, await this.resolveActor(req));
  }

  @Get('alumni/profiles/:id')
  @RequirePermission('pub-004:read')
  async getProfile(@Param('id') id: string, @Req() req: AuthedRequest): Promise<AlumniProfileDto> {
    return this.profiles.getById(id, await this.resolveActor(req));
  }

  @Post('alumni/profiles')
  @RequirePermission('pub-004:write')
  async createProfile(
    @Body() dto: CreateAlumniProfileDto,
    @Req() req: AuthedRequest,
  ): Promise<AlumniProfileDto> {
    return this.profiles.create(dto, await this.resolveActor(req));
  }

  @Patch('alumni/profiles/:id')
  @RequirePermission('pub-004:write')
  async patchProfile(
    @Param('id') id: string,
    @Body() dto: UpdateAlumniProfileDto,
    @Req() req: AuthedRequest,
  ): Promise<AlumniProfileDto> {
    return this.profiles.patch(id, dto, await this.resolveActor(req));
  }

  // ── Tags ──

  @Post('alumni/tags')
  @RequirePermission('pub-004:write')
  async addTag(@Body() dto: AddTagDto, @Req() req: AuthedRequest): Promise<AlumniTagDto> {
    return this.tags.addTag(dto, await this.resolveActor(req));
  }

  @Delete('alumni/tags/:id')
  @RequirePermission('pub-004:write')
  @HttpCode(204)
  async removeTag(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    await this.tags.removeTag(id, await this.resolveActor(req));
  }

  // ── Campaigns ──

  @Get('alumni/campaigns')
  @RequirePermission('pub-004:read')
  async listCampaigns(
    @Req() req: AuthedRequest,
    @Query('status') status?: CampaignStatus,
  ): Promise<CampaignDto[]> {
    return this.campaigns.list(await this.resolveActor(req), status);
  }

  @Get('alumni/campaigns/:id')
  @RequirePermission('pub-004:read')
  async getCampaign(@Param('id') id: string, @Req() req: AuthedRequest): Promise<CampaignDto> {
    return this.campaigns.getById(id, await this.resolveActor(req));
  }

  @Post('alumni/campaigns')
  @RequirePermission('pub-004:write')
  async createCampaign(
    @Body() dto: CreateCampaignDto,
    @Req() req: AuthedRequest,
  ): Promise<CampaignDto> {
    return this.campaigns.create(dto, await this.resolveActor(req));
  }

  @Patch('alumni/campaigns/:id')
  @RequirePermission('pub-004:write')
  async patchCampaign(
    @Param('id') id: string,
    @Body() dto: UpdateCampaignDto,
    @Req() req: AuthedRequest,
  ): Promise<CampaignDto> {
    return this.campaigns.patch(id, dto, await this.resolveActor(req));
  }

  @Post('alumni/campaigns/:id/activate')
  @RequirePermission('pub-004:write')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Activate a DRAFT campaign. Emits alm.campaign.activated AFTER tx commits.',
  })
  async activateCampaign(@Param('id') id: string, @Req() req: AuthedRequest): Promise<CampaignDto> {
    return this.campaigns.activate(id, await this.resolveActor(req));
  }

  @Get('alumni/campaigns/:id/raised')
  @RequirePermission('pub-004:read')
  @ApiOperation({
    summary:
      'Campaign raised total in reporting_currency. Redis-cached with TTL=5min; cached=true when served from cache.',
  })
  async getCampaignRaised(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<CampaignRaisedDto> {
    return this.campaigns.raised(id, await this.resolveActor(req));
  }

  @Get('alumni/campaigns/:id/funnel')
  @RequirePermission('pub-004:write')
  @ApiOperation({
    summary: 'Outreach funnel for a campaign — staff + admin only.',
  })
  async getCampaignFunnel(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<CampaignFunnelDto> {
    return this.campaigns.funnel(id, await this.resolveActor(req));
  }

  @Post('alumni/campaigns/:id/recipients')
  @RequirePermission('pub-004:write')
  @ApiOperation({
    summary: 'Bulk-add recipients by tag. Resolves the tag and idempotently inserts.',
  })
  async addRecipientsByTag(
    @Param('id') id: string,
    @Body() dto: AddRecipientsByTagDto,
    @Req() req: AuthedRequest,
  ): Promise<{ campaignId: string; created: number; skipped: number }> {
    return this.campaigns.addRecipientsByTag(id, dto, await this.resolveActor(req));
  }

  @Get('alumni/campaigns/:id/recipients')
  @RequirePermission('pub-004:write')
  async listRecipients(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
    @Query('status') status?: OutreachStatus,
  ): Promise<CampaignRecipientDto[]> {
    return this.campaigns.listRecipients(id, await this.resolveActor(req), status);
  }

  @Post('alumni/campaigns/:id/send-outreach')
  @RequirePermission('pub-004:write')
  @HttpCode(200)
  async sendOutreach(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<{ campaignId: string; sent: number }> {
    return this.outreach.sendOutreach(id, await this.resolveActor(req));
  }

  @Patch('alumni/campaign-recipients/:id')
  @RequirePermission('pub-004:write')
  async updateRecipientStatus(
    @Param('id') id: string,
    @Body() dto: UpdateRecipientStatusDto,
    @Req() req: AuthedRequest,
  ): Promise<CampaignRecipientDto> {
    return this.outreach.updateStatus(id, dto, await this.resolveActor(req));
  }

  // ── Donations ──

  @Post('alumni/campaigns/:id/donate')
  @RequirePermission('pub-004:write')
  @ApiOperation({
    summary:
      'Record a donation. Computes amount_in_reporting_currency from amount + currency + fxRate. Flips the matching campaign_recipient to DONATED. Emits alm.donation.received AFTER tx commits.',
  })
  async donate(
    @Param('id') campaignId: string,
    @Body() dto: CreateDonationDto & { donorAlumniId: string },
    @Req() req: AuthedRequest,
  ): Promise<DonationDto> {
    const actor = await this.resolveActor(req);
    return this.donations.donate(campaignId, dto.donorAlumniId, dto, actor);
  }

  @Get('alumni/campaigns/:id/donations')
  @RequirePermission('pub-004:read')
  @ApiOperation({
    summary: 'List donations. Anonymous donations are stripped for non-staff callers.',
  })
  async listDonations(
    @Param('id') campaignId: string,
    @Req() req: AuthedRequest,
  ): Promise<DonationDto[]> {
    return this.donations.listForCampaign(campaignId, await this.resolveActor(req));
  }

  // ── News ──

  @Get('alumni/news')
  @RequirePermission('pub-004:read')
  async listNews(
    @Req() req: AuthedRequest,
    @Query('category') category?: NewsCategory,
    @Query('includeDrafts') includeDrafts?: string,
  ): Promise<AlumniNewsDto[]> {
    const actor = await this.resolveActor(req);
    return this.news.list(actor, {
      category,
      includeDrafts: includeDrafts === 'true',
    });
  }

  @Get('alumni/news/:id')
  @RequirePermission('pub-004:read')
  async getNews(@Param('id') id: string, @Req() req: AuthedRequest): Promise<AlumniNewsDto> {
    return this.news.getById(id, await this.resolveActor(req));
  }

  @Post('alumni/news')
  @RequirePermission('pub-004:write')
  async createNews(
    @Body() dto: CreateAlumniNewsDto,
    @Req() req: AuthedRequest,
  ): Promise<AlumniNewsDto> {
    return this.news.create(dto, await this.resolveActor(req));
  }

  @Patch('alumni/news/:id')
  @RequirePermission('pub-004:write')
  async patchNews(
    @Param('id') id: string,
    @Body() dto: UpdateAlumniNewsDto,
    @Req() req: AuthedRequest,
  ): Promise<AlumniNewsDto> {
    return this.news.patch(id, dto, await this.resolveActor(req));
  }

  @Delete('alumni/news/:id')
  @RequirePermission('pub-004:write')
  @HttpCode(204)
  async deleteNews(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    await this.news.remove(id, await this.resolveActor(req));
  }

  // ── Reunions ──

  @Get('alumni/reunions')
  @RequirePermission('pub-004:read')
  async listReunions(
    @Req() req: AuthedRequest,
    @Query('graduationYear') graduationYear?: string,
    @Query('status') status?: ReunionStatus,
  ): Promise<ReunionGroupDto[]> {
    return this.reunions.list(await this.resolveActor(req), {
      graduationYear: graduationYear ? Number(graduationYear) : undefined,
      status,
    });
  }

  @Get('alumni/reunions/:id')
  @RequirePermission('pub-004:read')
  async getReunion(@Param('id') id: string, @Req() req: AuthedRequest): Promise<ReunionGroupDto> {
    return this.reunions.getById(id, await this.resolveActor(req));
  }

  @Post('alumni/reunions')
  @RequirePermission('pub-004:write')
  async createReunion(
    @Body() dto: CreateReunionGroupDto,
    @Req() req: AuthedRequest,
  ): Promise<ReunionGroupDto> {
    return this.reunions.create(dto, await this.resolveActor(req));
  }

  @Patch('alumni/reunions/:id')
  @RequirePermission('pub-004:write')
  async patchReunion(
    @Param('id') id: string,
    @Body() dto: UpdateReunionGroupDto,
    @Req() req: AuthedRequest,
  ): Promise<ReunionGroupDto> {
    return this.reunions.patch(id, dto, await this.resolveActor(req));
  }

  // ── Alumni Events ──

  @Get('alumni/events')
  @RequirePermission('pub-004:read')
  @ApiOperation({
    summary:
      'List alumni events. When evt_event_id is set, ticketsAvailable is enriched from the P2-12 Events module; graceful null fallback when Events not enabled.',
  })
  async listEvents(
    @Req() req: AuthedRequest,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ): Promise<AlumniEventDto[]> {
    return this.events.list(await this.resolveActor(req), { fromDate, toDate });
  }

  @Get('alumni/events/:id')
  @RequirePermission('pub-004:read')
  async getEvent(@Param('id') id: string, @Req() req: AuthedRequest): Promise<AlumniEventDto> {
    return this.events.getById(id, await this.resolveActor(req));
  }

  @Post('alumni/events')
  @RequirePermission('pub-004:write')
  async createEvent(
    @Body() dto: CreateAlumniEventDto,
    @Req() req: AuthedRequest,
  ): Promise<AlumniEventDto> {
    return this.events.create(dto, await this.resolveActor(req));
  }

  @Patch('alumni/events/:id')
  @RequirePermission('pub-004:write')
  async patchEvent(
    @Param('id') id: string,
    @Body() dto: UpdateAlumniEventDto,
    @Req() req: AuthedRequest,
  ): Promise<AlumniEventDto> {
    return this.events.patch(id, dto, await this.resolveActor(req));
  }

  @Delete('alumni/events/:id')
  @RequirePermission('pub-004:write')
  @HttpCode(204)
  async deleteEvent(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    await this.events.remove(id, await this.resolveActor(req));
  }
}
