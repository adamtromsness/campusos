import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { SessionNoteService } from './session-note.service';
import {
  CreateSessionNoteDto,
  SessionNoteResponseDto,
  UpdateSessionNoteDto,
} from './dto/counselling.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

/**
 * SessionNote controller — every endpoint is gated on the dedicated
 * FERPA permission `student_counseling_record:read`. The IAM seed
 * grants this permission to Staff (counsellor / VP / admin assistant)
 * + School Admin / Platform Admin only. Teachers, parents, and
 * students NEVER hold this permission and receive a 403 at the gate.
 *
 * The lock endpoint is intentionally write-only with no inverse —
 * once a note is locked it is immutable forever per the M27 ERD.
 * To correct a locked observation the counsellor must open a
 * follow-up session and write a new note.
 */
@ApiTags('Counselling Session Notes (FERPA)')
@ApiBearerAuth()
@Controller('counselling')
export class SessionNoteController {
  constructor(
    private readonly notes: SessionNoteService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('sessions/:sessionId/notes')
  @RequirePermission('student_counseling_record:read')
  @ApiOperation({
    summary:
      'List session notes for a session. FERPA-protected — only counsellor + admin (student_counseling_record:read). Teachers and parents always 403.',
  })
  async listForSession(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Req() req: AuthedRequest,
  ): Promise<SessionNoteResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.notes.listForSession(sessionId, actor);
  }

  @Post('sessions/:sessionId/notes')
  @RequirePermission('student_counseling_record:read')
  @ApiOperation({
    summary:
      'Add a session note for a participant or primary-caseload student. UNIQUE(session_id, student_id) — duplicates rejected with a friendly 400.',
  })
  async create(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() body: CreateSessionNoteDto,
    @Req() req: AuthedRequest,
  ): Promise<SessionNoteResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.notes.create(sessionId, body, actor);
  }

  @Get('session-notes/:id')
  @RequirePermission('student_counseling_record:read')
  @ApiOperation({
    summary: 'Fetch a single session note. FERPA-gated.',
  })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<SessionNoteResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.notes.getById(id, actor);
  }

  @Patch('session-notes/:id')
  @RequirePermission('student_counseling_record:read')
  @ApiOperation({
    summary:
      'Update an unlocked session note. Refuses any update when is_locked=true with 400 — once locked the note is immutable forever.',
  })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateSessionNoteDto,
    @Req() req: AuthedRequest,
  ): Promise<SessionNoteResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.notes.patch(id, body, actor);
  }

  @Patch('session-notes/:id/lock')
  @RequirePermission('student_counseling_record:read')
  @ApiOperation({
    summary:
      'IRREVERSIBLE — lock the note. Stamps is_locked=true + locked_at + locked_by atomically. There is no unlock endpoint by design.',
  })
  async lock(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<SessionNoteResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.notes.lock(id, actor);
  }
}
