import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { ProgressNoteService } from './progress-note.service';
import {
  ProgressNoteResponseDto,
  UpsertProgressNoteDto,
} from './dto/progress-note.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Classroom — Progress Notes')
@ApiBearerAuth()
@Controller()
export class ProgressNoteController {
  constructor(
    private readonly notes: ProgressNoteService,
    private readonly actors: ActorContextService,
  ) {}

  @Post('classes/:classId/progress-notes')
  @RequirePermission('tch-003:write')
  @ApiOperation({
    summary:
      'Teacher writes a per-(class, student, term) progress note. Idempotent upsert by the ' +
      'triple — re-posting overwrites. Always sets published_at=now(); use is_parent_visible / ' +
      'is_student_visible to control distribution. Emits cls.progress_note.published.',
  })
  async upsert(
    @Param('classId', ParseUUIDPipe) classId: string,
    @Body() body: UpsertProgressNoteDto,
    @Req() req: AuthedRequest,
  ): Promise<ProgressNoteResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.notes.upsert(classId, body, actor);
  }

  @Get('students/:studentId/progress-notes')
  @RequirePermission('tch-003:read')
  @ApiOperation({
    summary:
      'List progress notes for a student, scoped by persona: admins see all rows; teachers see ' +
      'rows for their classes; students/parents see only published rows where the matching ' +
      'visibility flag is true.',
  })
  async listForStudent(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<ProgressNoteResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.notes.listForStudent(studentId, actor);
  }
}
