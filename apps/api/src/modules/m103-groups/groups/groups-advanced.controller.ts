import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PollService } from '../polls/poll.service';
import { GroupMeetupService } from '../events/meetup.service';
import { ResourceLibraryService } from '../resources/resource-library.service';
import { InvitationService } from './invitation.service';
import { GroupAnalyticsService } from './analytics.service';
import {
  CreateGroupMeetupDto,
  CreateInvitationDto,
  CreatePollDto,
  CreateResourceDto,
  CreateResourceVersionDto,
  GroupAnalyticsRowDto,
  InvitationResponseDto,
  MeetupResponseDto,
  PollResponseDto,
  RecomputeAnalyticsDto,
  ResourceResponseDto,
  ResourceVersionResponseDto,
  RespondInvitationDto,
  RsvpMeetupDto,
  UpdateGroupMeetupDto,
  UpdateResourceDto,
  VotePollDto,
} from './dto/groups-advanced.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Groups Advanced (P2-28a)')
@Controller()
export class GroupsAdvancedController {
  constructor(
    private readonly polls: PollService,
    private readonly meetups: GroupMeetupService,
    private readonly resources: ResourceLibraryService,
    private readonly invitations: InvitationService,
    private readonly analytics: GroupAnalyticsService,
    private readonly actors: ActorContextService,
  ) {}

  /* ── Polls (4 endpoints) ── */

  @Get('groups/:groupId/polls')
  @RequirePermission('grp-001:read')
  @ApiOperation({ summary: 'List polls on a group' })
  async listPolls(
    @Param('groupId') groupId: string,
    @Req() req: AuthedRequest,
  ): Promise<PollResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.polls.listForGroup(groupId, actor);
  }

  @Post('groups/:groupId/polls')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Create a poll on a group' })
  async createPoll(
    @Param('groupId') groupId: string,
    @Body() dto: CreatePollDto,
    @Req() req: AuthedRequest,
  ): Promise<PollResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.polls.create(groupId, dto, actor);
  }

  @Post('polls/:pollId/vote')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Vote on a poll (atomic vote_count increment)' })
  async vote(
    @Param('pollId') pollId: string,
    @Body() dto: VotePollDto,
    @Req() req: AuthedRequest,
  ): Promise<PollResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.polls.vote(pollId, dto, actor);
  }

  @Patch('polls/:pollId/close')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Close a poll (OWNER/ADMIN/school admin only)' })
  async closePoll(
    @Param('pollId') pollId: string,
    @Req() req: AuthedRequest,
  ): Promise<PollResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.polls.close(pollId, actor);
  }

  /* ── Group meetups (5 endpoints) ── */

  @Get('groups/:groupId/meetups')
  @RequirePermission('grp-001:read')
  @ApiOperation({ summary: 'List informal group meetups' })
  async listMeetups(
    @Param('groupId') groupId: string,
    @Req() req: AuthedRequest,
  ): Promise<MeetupResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.meetups.listForGroup(groupId, actor);
  }

  @Post('groups/:groupId/meetups')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Create a group meetup (OWNER/ADMIN/school admin)' })
  async createMeetup(
    @Param('groupId') groupId: string,
    @Body() dto: CreateGroupMeetupDto,
    @Req() req: AuthedRequest,
  ): Promise<MeetupResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.meetups.create(groupId, dto, actor);
  }

  @Patch('meetups/:meetupId')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Update a group meetup' })
  async patchMeetup(
    @Param('meetupId') meetupId: string,
    @Body() dto: UpdateGroupMeetupDto,
    @Req() req: AuthedRequest,
  ): Promise<MeetupResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.meetups.patch(meetupId, dto, actor);
  }

  @Delete('meetups/:meetupId')
  @HttpCode(200)
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Delete a group meetup' })
  async deleteMeetup(
    @Param('meetupId') meetupId: string,
    @Req() req: AuthedRequest,
  ): Promise<{ ok: true }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.meetups.remove(meetupId, actor);
  }

  @Post('meetups/:meetupId/rsvp')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'RSVP to a meetup (CONFIRMED count enforced vs max_attendees)' })
  async rsvpMeetup(
    @Param('meetupId') meetupId: string,
    @Body() dto: RsvpMeetupDto,
    @Req() req: AuthedRequest,
  ): Promise<MeetupResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.meetups.rsvp(meetupId, dto, actor);
  }

  /* ── Resource library (5 endpoints) ── */

  @Get('groups/:groupId/resources')
  @RequirePermission('grp-002:read')
  @ApiOperation({ summary: 'List resources on a group' })
  async listResources(
    @Param('groupId') groupId: string,
    @Req() req: AuthedRequest,
  ): Promise<ResourceResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.resources.listForGroup(groupId, actor);
  }

  @Post('groups/:groupId/resources')
  @RequirePermission('grp-002:write')
  @ApiOperation({ summary: 'Upload a new resource to a group' })
  async createResource(
    @Param('groupId') groupId: string,
    @Body() dto: CreateResourceDto,
    @Req() req: AuthedRequest,
  ): Promise<ResourceResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.resources.create(groupId, dto, actor);
  }

  @Patch('resources/:resourceId')
  @RequirePermission('grp-002:write')
  @ApiOperation({ summary: 'Update resource metadata (pin / title / description)' })
  async patchResource(
    @Param('resourceId') resourceId: string,
    @Body() dto: UpdateResourceDto,
    @Req() req: AuthedRequest,
  ): Promise<ResourceResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.resources.patch(resourceId, dto, actor);
  }

  @Delete('resources/:resourceId')
  @HttpCode(200)
  @RequirePermission('grp-002:write')
  @ApiOperation({ summary: 'Delete a resource (uploader or admin)' })
  async deleteResource(
    @Param('resourceId') resourceId: string,
    @Req() req: AuthedRequest,
  ): Promise<{ ok: true }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.resources.remove(resourceId, actor);
  }

  @Post('resources/:resourceId/versions')
  @RequirePermission('grp-002:write')
  @ApiOperation({ summary: 'Add a new version of a resource (atomic version increment)' })
  async addResourceVersion(
    @Param('resourceId') resourceId: string,
    @Body() dto: CreateResourceVersionDto,
    @Req() req: AuthedRequest,
  ): Promise<ResourceVersionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.resources.addVersion(resourceId, dto, actor);
  }

  @Get('resources/:resourceId/versions')
  @RequirePermission('grp-002:read')
  @ApiOperation({ summary: 'List version history for a resource' })
  async listResourceVersions(
    @Param('resourceId') resourceId: string,
    @Req() req: AuthedRequest,
  ): Promise<ResourceVersionResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.resources.listVersions(resourceId, actor);
  }

  /* ── Invitations (5 endpoints) ── */

  @Get('groups/:groupId/invitations')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'List invitations on a group (managers only)' })
  async listInvitations(
    @Param('groupId') groupId: string,
    @Req() req: AuthedRequest,
  ): Promise<InvitationResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.invitations.listForGroup(groupId, actor);
  }

  @Get('invitations/mine')
  @RequirePermission('grp-001:read')
  @ApiOperation({ summary: 'List pending invitations for the calling user' })
  async listMyInvitations(@Req() req: AuthedRequest): Promise<InvitationResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.invitations.listMine(actor);
  }

  @Post('groups/:groupId/invitations')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Invite a user to a group' })
  async createInvitation(
    @Param('groupId') groupId: string,
    @Body() dto: CreateInvitationDto,
    @Req() req: AuthedRequest,
  ): Promise<InvitationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.invitations.create(groupId, dto, actor);
  }

  @Patch('invitations/:invitationId/respond')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Accept or decline an invitation (ACCEPTED auto-creates member row)' })
  async respondInvitation(
    @Param('invitationId') invitationId: string,
    @Body() dto: RespondInvitationDto,
    @Req() req: AuthedRequest,
  ): Promise<InvitationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.invitations.respond(invitationId, dto, actor);
  }

  @Delete('invitations/:invitationId')
  @HttpCode(200)
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Cancel a pending invitation (inviter or admin)' })
  async cancelInvitation(
    @Param('invitationId') invitationId: string,
    @Req() req: AuthedRequest,
  ): Promise<{ ok: true }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.invitations.cancel(invitationId, actor);
  }

  /* ── Analytics (2 endpoints) ── */

  @Get('groups/:groupId/analytics')
  @RequirePermission('grp-003:read')
  @ApiOperation({ summary: 'List monthly engagement analytics for a group (manager-only)' })
  async listAnalytics(
    @Param('groupId') groupId: string,
    @Req() req: AuthedRequest,
  ): Promise<GroupAnalyticsRowDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.analytics.listForGroup(groupId, actor);
  }

  @Post('groups/:groupId/analytics/recompute')
  @RequirePermission('grp-003:write')
  @ApiOperation({ summary: 'Recompute analytics for a period (UPSERT)' })
  async recomputeAnalytics(
    @Param('groupId') groupId: string,
    @Body() dto: RecomputeAnalyticsDto,
    @Req() req: AuthedRequest,
  ): Promise<GroupAnalyticsRowDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.analytics.recompute(groupId, dto, actor);
  }
}
