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
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { GroupService } from './group.service';
import { MembershipService } from './membership.service';
import { OwnershipTransferService } from './ownership-transfer.service';
import { GroupAnnouncementService } from './group-announcement.service';
import { GroupEventService } from '../events/group-event.service';
import {
  AnnouncementResponseDto,
  ApproveJoinDto,
  CreateAnnouncementDto,
  CreateEventDto,
  CreateGroupDto,
  EventResponseDto,
  GroupResponseDto,
  GroupScopeType,
  GroupStatus,
  InitiateTransferDto,
  InviteMemberDto,
  JoinGroupDto,
  MemberResponseDto,
  NotificationPrefsDto,
  RsvpDto,
  SuspendMemberDto,
  TransferResponseDto,
  UpdateAnnouncementDto,
  UpdateEventDto,
  UpdateGroupDto,
  UpdateMemberRoleDto,
  UpdateNotificationPrefsDto,
} from './dto/groups.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Groups & Communities')
@Controller()
export class GroupsController {
  constructor(
    private readonly groups: GroupService,
    private readonly memberships: MembershipService,
    private readonly transfers: OwnershipTransferService,
    private readonly announcements: GroupAnnouncementService,
    private readonly events: GroupEventService,
    private readonly actors: ActorContextService,
  ) {}

  // ── Groups ──

  @Get('groups')
  @RequirePermission('grp-001:read')
  @ApiOperation({ summary: 'List groups visible to the caller' })
  async list(
    @Req() req: AuthedRequest,
    @Query('mine') mine?: string,
    @Query('status') status?: string,
    @Query('scopeType') scopeType?: string,
  ): Promise<GroupResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.groups.list(actor, {
      onlyMine: mine === 'true',
      status: (status as GroupStatus) || undefined,
      scopeType: (scopeType as GroupScopeType) || undefined,
    });
  }

  @Get('groups/mine')
  @RequirePermission('grp-001:read')
  @ApiOperation({ summary: 'List groups the caller is a member of' })
  async listMine(@Req() req: AuthedRequest): Promise<GroupResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.groups.list(actor, { onlyMine: true });
  }

  @Get('groups/:id')
  @RequirePermission('grp-001:read')
  @ApiOperation({ summary: 'Get a single group (INVITE_ONLY hidden from non-members)' })
  async getById(@Param('id') id: string, @Req() req: AuthedRequest): Promise<GroupResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.groups.getById(id, actor);
  }

  @Post('groups')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Create a group; creator becomes OWNER atomically' })
  async create(@Body() body: CreateGroupDto, @Req() req: AuthedRequest): Promise<GroupResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.groups.create(body, actor);
  }

  @Patch('groups/:id')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Update group metadata; OWNER/ADMIN/admin only' })
  async patch(
    @Param('id') id: string,
    @Body() body: UpdateGroupDto,
    @Req() req: AuthedRequest,
  ): Promise<GroupResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.groups.patch(id, body, actor);
  }

  // ── Membership ──

  @Get('groups/:id/members')
  @RequirePermission('grp-001:read')
  @ApiOperation({ summary: 'List members of a group' })
  async listMembers(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<MemberResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.memberships.listForGroup(id, actor);
  }

  @Get('groups/me/memberships')
  @RequirePermission('grp-001:read')
  @ApiOperation({ summary: "Caller's memberships across every group" })
  async listMyMemberships(@Req() req: AuthedRequest): Promise<MemberResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.memberships.listMine(actor);
  }

  @Post('groups/:id/join')
  @RequirePermission('grp-001:write')
  @ApiOperation({
    summary:
      'Self-service join. OPEN -> ACTIVE; APPROVAL_REQUIRED -> PENDING_APPROVAL; INVITE_ONLY rejects.',
  })
  async join(
    @Param('id') id: string,
    @Body() body: JoinGroupDto,
    @Req() req: AuthedRequest,
  ): Promise<MemberResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.memberships.joinGroup(id, body, actor);
  }

  @Post('groups/:id/leave')
  @RequirePermission('grp-001:write')
  @HttpCode(200)
  @ApiOperation({ summary: 'Leave a group; OWNER must transfer first' })
  async leave(@Param('id') id: string, @Req() req: AuthedRequest): Promise<{ ok: true }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.memberships.leaveGroup(id, actor);
  }

  @Post('groups/:id/invite')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Invite a person to the group; OWNER/ADMIN/admin only' })
  async invite(
    @Param('id') id: string,
    @Body() body: InviteMemberDto,
    @Req() req: AuthedRequest,
  ): Promise<MemberResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.memberships.invite(id, body, actor);
  }

  @Post('group-members/:id/accept')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Accept an INVITED membership; recipient only' })
  async acceptInvite(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<MemberResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.memberships.acceptInvite(id, actor);
  }

  @Post('group-members/:id/decline')
  @RequirePermission('grp-001:write')
  @HttpCode(200)
  @ApiOperation({ summary: 'Decline an INVITED membership; recipient only' })
  async declineInvite(@Param('id') id: string, @Req() req: AuthedRequest): Promise<{ ok: true }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.memberships.declineInvite(id, actor);
  }

  @Post('group-members/:id/approve')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Approve a PENDING_APPROVAL membership' })
  async approveJoin(
    @Param('id') id: string,
    @Body() body: ApproveJoinDto,
    @Req() req: AuthedRequest,
  ): Promise<MemberResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.memberships.approveJoin(id, body, actor);
  }

  @Post('group-members/:id/deny')
  @RequirePermission('grp-001:write')
  @HttpCode(200)
  @ApiOperation({ summary: 'Deny a PENDING_APPROVAL membership' })
  async denyJoin(@Param('id') id: string, @Req() req: AuthedRequest): Promise<{ ok: true }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.memberships.denyJoin(id, actor);
  }

  @Patch('group-members/:id/role')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Change member role (ADMIN<->MEMBER); OWNER untouchable here' })
  async updateRole(
    @Param('id') id: string,
    @Body() body: UpdateMemberRoleDto,
    @Req() req: AuthedRequest,
  ): Promise<MemberResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.memberships.updateRole(id, body, actor);
  }

  @Post('group-members/:id/suspend')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Suspend a member; reason required' })
  async suspendMember(
    @Param('id') id: string,
    @Body() body: SuspendMemberDto,
    @Req() req: AuthedRequest,
  ): Promise<MemberResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.memberships.suspend(id, body, actor);
  }

  @Post('group-members/:id/unsuspend')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Lift a member suspension' })
  async unsuspendMember(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<MemberResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.memberships.unsuspend(id, actor);
  }

  @Delete('group-members/:id')
  @RequirePermission('grp-001:write')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove a member; OWNER must transfer first' })
  async removeMember(@Param('id') id: string, @Req() req: AuthedRequest): Promise<{ ok: true }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.memberships.remove(id, actor);
  }

  // ── Notification preferences ──

  @Get('group-members/:id/notification-prefs')
  @RequirePermission('grp-001:read')
  @ApiOperation({ summary: 'Get notification preferences for a membership' })
  async getPrefs(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<NotificationPrefsDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.memberships.getPrefs(id, actor);
  }

  @Patch('group-members/:id/notification-prefs')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Update notification preferences for a membership' })
  async updatePrefs(
    @Param('id') id: string,
    @Body() body: UpdateNotificationPrefsDto,
    @Req() req: AuthedRequest,
  ): Promise<NotificationPrefsDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.memberships.updatePrefs(id, body, actor);
  }

  // ── Ownership transfers ──

  @Get('groups/:id/transfers')
  @RequirePermission('grp-001:read')
  @ApiOperation({ summary: 'List ownership transfer history for a group' })
  async listTransfers(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<TransferResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.transfers.list(id, actor);
  }

  @Get('groups/me/pending-transfers')
  @RequirePermission('grp-001:read')
  @ApiOperation({ summary: 'Pending transfers awaiting my acceptance' })
  async listMyPendingTransfers(@Req() req: AuthedRequest): Promise<TransferResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.transfers.listMine(actor);
  }

  @Post('groups/:id/transfers')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Initiate ownership transfer; OWNER only' })
  async initiateTransfer(
    @Param('id') id: string,
    @Body() body: InitiateTransferDto,
    @Req() req: AuthedRequest,
  ): Promise<TransferResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.transfers.initiate(id, body, actor);
  }

  @Post('group-transfers/:id/accept')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Accept ownership transfer; recipient only — atomic role swap' })
  async acceptTransfer(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<TransferResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.transfers.accept(id, actor);
  }

  @Post('group-transfers/:id/decline')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Decline ownership transfer; recipient only' })
  async declineTransfer(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<TransferResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.transfers.decline(id, actor);
  }

  @Post('group-transfers/:id/cancel')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Cancel a pending transfer; initiator or admin only' })
  async cancelTransfer(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<TransferResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.transfers.cancel(id, actor);
  }

  // ── Announcements ──

  @Get('groups/:id/announcements')
  @RequirePermission('grp-001:read')
  @ApiOperation({ summary: 'Group announcement feed; pinned first' })
  async listAnnouncements(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<AnnouncementResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.announcements.listForGroup(id, actor);
  }

  @Post('groups/:id/announcements')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Post an announcement; OWNER/ADMIN/admin only' })
  async createAnnouncement(
    @Param('id') id: string,
    @Body() body: CreateAnnouncementDto,
    @Req() req: AuthedRequest,
  ): Promise<AnnouncementResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.announcements.create(id, body, actor);
  }

  @Get('group-announcements/:id')
  @RequirePermission('grp-001:read')
  async getAnnouncement(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<AnnouncementResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.announcements.getById(id, actor);
  }

  @Patch('group-announcements/:id')
  @RequirePermission('grp-001:write')
  async patchAnnouncement(
    @Param('id') id: string,
    @Body() body: UpdateAnnouncementDto,
    @Req() req: AuthedRequest,
  ): Promise<AnnouncementResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.announcements.patch(id, body, actor);
  }

  @Post('group-announcements/:id/read')
  @RequirePermission('grp-001:read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark announcement as read; idempotent' })
  async readAnnouncement(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<{ ok: true }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.announcements.markRead(id, actor);
  }

  @Delete('group-announcements/:id')
  @RequirePermission('grp-001:write')
  @HttpCode(200)
  async deleteAnnouncement(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<{ ok: true }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.announcements.remove(id, actor);
  }

  // ── Events ──

  @Get('groups/:id/events')
  @RequirePermission('grp-001:read')
  @ApiOperation({ summary: 'Group event feed' })
  async listEvents(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<EventResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.events.listForGroup(id, actor);
  }

  @Post('groups/:id/events')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'Create event; OWNER/ADMIN/admin only' })
  async createEvent(
    @Param('id') id: string,
    @Body() body: CreateEventDto,
    @Req() req: AuthedRequest,
  ): Promise<EventResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.events.create(id, body, actor);
  }

  @Get('group-events/:id')
  @RequirePermission('grp-001:read')
  async getEvent(@Param('id') id: string, @Req() req: AuthedRequest): Promise<EventResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.events.getById(id, actor);
  }

  @Patch('group-events/:id')
  @RequirePermission('grp-001:write')
  async patchEvent(
    @Param('id') id: string,
    @Body() body: UpdateEventDto,
    @Req() req: AuthedRequest,
  ): Promise<EventResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.events.patch(id, body, actor);
  }

  @Post('group-events/:id/rsvp')
  @RequirePermission('grp-001:write')
  @ApiOperation({ summary: 'RSVP to a group event; max_attendees enforced atomically' })
  async rsvpEvent(
    @Param('id') id: string,
    @Body() body: RsvpDto,
    @Req() req: AuthedRequest,
  ): Promise<EventResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.events.rsvp(id, body, actor);
  }

  @Get('group-events/me/rsvps')
  @RequirePermission('grp-001:read')
  @ApiOperation({ summary: "Caller's upcoming RSVPs" })
  async listMyRsvps(@Req() req: AuthedRequest): Promise<EventResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.events.listMyRsvps(actor);
  }

  @Delete('group-events/:id')
  @RequirePermission('grp-001:write')
  @HttpCode(200)
  async deleteEvent(@Param('id') id: string, @Req() req: AuthedRequest): Promise<{ ok: true }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.events.remove(id, actor);
  }
}
