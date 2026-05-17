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
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { SessionService } from './session.service';
import {
  AddParticipantDto,
  CreateSessionDto,
  ListSessionsQueryDto,
  MarkAttendanceDto,
  SessionParticipantResponseDto,
  SessionResponseDto,
  UpdateSessionDto,
} from './dto/counselling.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Counselling Sessions')
@ApiBearerAuth()
@Controller('counselling')
export class SessionController {
  constructor(
    private readonly sessions: SessionService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('sessions')
  @RequirePermission('cou-001:read')
  @ApiOperation({
    summary:
      'List counselling sessions. Counsellors see own; admins see all. Filters: status, sessionType, caseloadId, counselorId, fromDate, toDate.',
  })
  async list(
    @Query() query: ListSessionsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<SessionResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.sessions.list(query, actor);
  }

  @Get('sessions/:id')
  @RequirePermission('cou-001:read')
  @ApiOperation({
    summary:
      'Fetch a session with the inlined participants list. 404 to non-counsellors of record.',
  })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<SessionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.sessions.getById(id, actor);
  }

  @Post('sessions')
  @RequirePermission('cou-001:write')
  @ApiOperation({
    summary:
      'Schedule or log a session. INDIVIDUAL requires primaryCaseloadId. GROUP must omit it. Counsellor or admin only.',
  })
  async create(
    @Body() body: CreateSessionDto,
    @Req() req: AuthedRequest,
  ): Promise<SessionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.sessions.create(body, actor);
  }

  @Patch('sessions/:id')
  @RequirePermission('cou-001:write')
  @ApiOperation({
    summary:
      'Update mutable session fields (status, durationMinutes, sessionType, notes). Locks the row inside one tx.',
  })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateSessionDto,
    @Req() req: AuthedRequest,
  ): Promise<SessionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.sessions.patch(id, body, actor);
  }

  @Post('sessions/:id/participants')
  @RequirePermission('cou-001:write')
  @ApiOperation({
    summary:
      'Add a student participant to a session. UNIQUE(session, student) — duplicates rejected with a friendly 400.',
  })
  async addParticipant(
    @Param('id', ParseUUIDPipe) sessionId: string,
    @Body() body: AddParticipantDto,
    @Req() req: AuthedRequest,
  ): Promise<SessionParticipantResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.sessions.addParticipant(sessionId, body, actor);
  }

  @Patch('session-participants/:id')
  @RequirePermission('cou-001:write')
  @ApiOperation({
    summary:
      'Mark attendance on a participant row (ATTENDED / NO_SHOW / LATE). Counsellor or admin only.',
  })
  async markAttendance(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: MarkAttendanceDto,
    @Req() req: AuthedRequest,
  ): Promise<SessionParticipantResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.sessions.markAttendance(id, body, actor);
  }
}
