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
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { MeetingNotesService } from './meeting-notes.service';
import { AgendaService } from './agenda.service';
import { ActionItemService } from './action-item.service';
import { RecordingService } from './recording.service';
import { IepMeetingRecordService } from './iep-meeting-record.service';
import { MeetingTypeService } from './meeting-type.service';
import {
  ActionItemResponseDto,
  ActionItemStatus,
  AgendaItemResponseDto,
  CreateActionItemDto,
  CreateAgendaItemDto,
  CreateIepMeetingRecordDto,
  CreateMeetingNotesDto,
  CreateRecordingDto,
  GiveConsentDto,
  IepMeetingRecordResponseDto,
  MeetingNotesResponseDto,
  MeetingTypeResponseDto,
  RecordingConsentResponseDto,
  RecordingResponseDto,
  UpdateActionItemDto,
  UpdateAgendaItemDto,
  UpdateIepMeetingRecordDto,
  UpdateMeetingNotesDto,
} from './dto/meeting.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

@ApiTags('Meetings — Meeting Types')
@ApiBearerAuth()
@Controller('meetings/types')
export class MeetingTypeController {
  constructor(private readonly types: MeetingTypeService) {}

  @Get()
  @RequirePermission('mtg-001:read')
  async list(): Promise<MeetingTypeResponseDto[]> {
    return this.types.list();
  }

  @Get(':id')
  @RequirePermission('mtg-001:read')
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<MeetingTypeResponseDto> {
    return this.types.getById(id);
  }
}

@ApiTags('Meetings — Notes & Agenda')
@ApiBearerAuth()
@Controller()
export class NotesAgendaController {
  constructor(
    private readonly notes: MeetingNotesService,
    private readonly agenda: AgendaService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('meetings/:id/notes')
  @RequirePermission('mtg-001:read')
  @ApiOperation({
    summary:
      'PARENT-VISIBILITY GATE — staff sees full notes_text. Parents see parent_visible_summary (or notes_text fallback) only when is_parent_visible=true AND is_approved=true. Students never see notes.',
  })
  async getNotes(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MeetingNotesResponseDto | null> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.notes.getForMeeting(id, actor);
  }

  @Post('meetings/:id/notes')
  @RequirePermission('mtg-001:write')
  async upsertNotes(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateMeetingNotesDto,
  ): Promise<MeetingNotesResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.notes.upsert(id, body, actor);
  }

  @Patch('meeting-notes/:id')
  @RequirePermission('mtg-001:write')
  async patchNotes(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateMeetingNotesDto,
  ): Promise<MeetingNotesResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.notes.patch(id, body, actor);
  }

  @Patch('meeting-notes/:id/approve')
  @RequirePermission('mtg-001:write')
  @ApiOperation({
    summary:
      'Approve meeting notes — irreversible. Multi-column approved_chk lockstep stamps is_approved + approved_by + approved_at atomically.',
  })
  async approveNotes(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MeetingNotesResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.notes.approve(id, actor);
  }

  @Get('meetings/:id/agenda')
  @RequirePermission('mtg-001:read')
  async listAgenda(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AgendaItemResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.agenda.listForMeeting(id, actor);
  }

  @Post('meetings/:id/agenda')
  @RequirePermission('mtg-001:write')
  async createAgenda(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateAgendaItemDto,
  ): Promise<AgendaItemResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.agenda.create(id, body, actor);
  }

  @Patch('meeting-agenda/:id')
  @RequirePermission('mtg-001:write')
  async patchAgenda(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateAgendaItemDto,
  ): Promise<AgendaItemResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.agenda.patch(id, body, actor);
  }

  @Delete('meeting-agenda/:id')
  @RequirePermission('mtg-001:write')
  async deleteAgenda(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ removed: boolean }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    await this.agenda.remove(id, actor);
    return { removed: true };
  }
}

@ApiTags('Meetings — Action Items')
@ApiBearerAuth()
@Controller()
export class ActionItemController {
  constructor(
    private readonly actionItems: ActionItemService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('meeting-action-items')
  @RequirePermission('mtg-001:read')
  @ApiOperation({ summary: 'My action items — assignee_id matches the calling user' })
  async listMine(
    @Req() req: AuthedRequest,
    @Query('status') status?: string,
  ): Promise<ActionItemResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.actionItems.listMine(actor, status as ActionItemStatus | undefined);
  }

  @Get('meetings/:id/action-items')
  @RequirePermission('mtg-001:read')
  async listForMeeting(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ActionItemResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.actionItems.listForMeeting(id, actor);
  }

  @Post('meetings/:id/action-items')
  @RequirePermission('mtg-001:write')
  async create(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateActionItemDto,
  ): Promise<ActionItemResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.actionItems.create(id, body, actor);
  }

  @Patch('meeting-action-items/:id')
  @RequirePermission('mtg-001:read')
  @ApiOperation({
    summary:
      'Update an action item. Assignee may update status + dueDate on own item. Organiser/admin may update anything.',
  })
  async patch(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateActionItemDto,
  ): Promise<ActionItemResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.actionItems.patch(id, body, actor);
  }
}

@ApiTags('Meetings — Recordings & Consent')
@ApiBearerAuth()
@Controller()
export class RecordingController {
  constructor(
    private readonly recordings: RecordingService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('meetings/:id/recording')
  @RequirePermission('mtg-001:read')
  async getForMeeting(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RecordingResponseDto | null> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.recordings.getForMeeting(id, actor);
  }

  @Post('meetings/:id/recording')
  @RequirePermission('mtg-001:write')
  @ApiOperation({
    summary:
      'Create a recording placeholder. S3 upload integration deferred until the video processing extracted service ships.',
  })
  async create(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateRecordingDto,
  ): Promise<RecordingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.recordings.create(id, body, actor);
  }

  @Post('meeting-recordings/:id/consent')
  @RequirePermission('mtg-001:read')
  @ApiOperation({
    summary:
      'Participant gives or withholds consent. consent_confirmed auto-flips true once every active participant has a consent_given=true row.',
  })
  async giveConsent(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: GiveConsentDto,
  ): Promise<RecordingConsentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.recordings.giveConsent(id, body, actor);
  }
}

@ApiTags('Meetings — IEP Records')
@ApiBearerAuth()
@Controller()
export class IepMeetingRecordController {
  constructor(
    private readonly records: IepMeetingRecordService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('meetings/:id/iep-record')
  @RequirePermission('mtg-001:read')
  @ApiOperation({
    summary: 'Service-layer requires admin OR hlt-001:read since IEP records are health-sensitive.',
  })
  async getForMeeting(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<IepMeetingRecordResponseDto | null> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.records.getForMeeting(id, actor);
  }

  @Get('meeting-iep-records')
  @RequirePermission('mtg-001:read')
  async list(@Req() req: AuthedRequest): Promise<IepMeetingRecordResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.records.list(actor);
  }

  @Post('meetings/:id/iep-record')
  @RequirePermission('mtg-001:write')
  async create(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateIepMeetingRecordDto,
  ): Promise<IepMeetingRecordResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.records.create(id, body, actor);
  }

  @Patch('meeting-iep-records/:id')
  @RequirePermission('mtg-001:write')
  async patch(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateIepMeetingRecordDto,
  ): Promise<IepMeetingRecordResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.records.patch(id, body, actor);
  }
}
