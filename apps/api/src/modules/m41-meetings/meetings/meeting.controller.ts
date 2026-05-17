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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { MeetingService } from './meeting.service';
import { SlotService } from './slot.service';
import {
  AddParticipantDto,
  CreateMeetingDto,
  CreateSlotsDto,
  MeetingParticipantResponseDto,
  MeetingResponseDto,
  MeetingSlotResponseDto,
  MeetingStatus,
  UpdateMeetingDto,
} from './dto/meeting.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

@ApiTags('Meetings — Meetings')
@ApiBearerAuth()
@Controller('meetings')
export class MeetingController {
  constructor(
    private readonly meetings: MeetingService,
    private readonly slots: SlotService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('mtg-001:read')
  async list(
    @Req() req: AuthedRequest,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('status') status?: string,
    @Query('conferenceEventId') conferenceEventId?: string,
  ): Promise<MeetingResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.meetings.list(
      {
        fromDate,
        toDate,
        status: status as MeetingStatus | undefined,
        conferenceEventId,
      },
      actor,
    );
  }

  @Get(':id')
  @RequirePermission('mtg-001:read')
  async getById(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MeetingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.meetings.getById(id, actor);
  }

  @Post()
  @RequirePermission('mtg-001:write')
  @ApiOperation({
    summary:
      'Create a meeting. Auto-adds the organiser as HOST + emits mtg.meeting.scheduled after tx commit.',
  })
  async create(
    @Req() req: AuthedRequest,
    @Body() body: CreateMeetingDto,
  ): Promise<MeetingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.meetings.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('mtg-001:write')
  async patch(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateMeetingDto,
  ): Promise<MeetingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.meetings.patch(id, body, actor);
  }

  @Post(':id/participants')
  @RequirePermission('mtg-001:write')
  async addParticipant(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AddParticipantDto,
  ): Promise<MeetingParticipantResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.meetings.addParticipant(id, body, actor);
  }

  @Get(':id/slots')
  @RequirePermission('mtg-002:read')
  @ApiOperation({
    summary:
      'List slots for a meeting. Organisers + admins see the booked_by identity columns; other parents see is_booked only with their own booking visible.',
  })
  async listSlots(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MeetingSlotResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.slots.listForMeeting(id, actor);
  }

  @Post(':id/slots')
  @RequirePermission('mtg-002:write')
  @ApiOperation({ summary: 'Bulk-create time slots for a meeting (organiser/admin)' })
  async createSlots(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateSlotsDto,
  ): Promise<MeetingSlotResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.slots.createBulk(id, body, actor);
  }
}

@ApiTags('Meetings — Participants & Slots')
@ApiBearerAuth()
@Controller()
export class ParticipantSlotController {
  constructor(
    private readonly meetings: MeetingService,
    private readonly slots: SlotService,
    private readonly actors: ActorContextService,
  ) {}

  @Delete('meeting-participants/:id')
  @RequirePermission('mtg-001:write')
  async removeParticipant(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ removed: boolean }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    await this.meetings.removeParticipant(id, actor);
    return { removed: true };
  }

  @Patch('meeting-slots/:id/book')
  @RequirePermission('mtg-002:read')
  @ApiOperation({
    summary:
      'PARENT BOOKING KEYSTONE — locks the slot row with SELECT FOR UPDATE inside a tenant tx and stamps the booked_chk lockstep atomically. Concurrent attempts serialise.',
  })
  async book(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MeetingSlotResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.slots.book(id, actor);
  }

  @Patch('meeting-slots/:id/cancel')
  @RequirePermission('mtg-002:read')
  @ApiOperation({
    summary: 'Cancel a slot booking. Booker or organiser/admin only.',
  })
  async cancel(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MeetingSlotResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.slots.cancel(id, actor);
  }
}
