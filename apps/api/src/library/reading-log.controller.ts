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
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { ReadingLogService } from './reading-log.service';
import { CreateReadingLogDto, ReadingLogResponseDto, UpdateReadingLogDto } from './dto/library.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Library — Reading Log')
@ApiBearerAuth()
@Controller('library/reading-log')
export class ReadingLogController {
  constructor(
    private readonly logs: ReadingLogService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('lib-003:read')
  @ApiOperation({
    summary:
      'List reading log entries. STUDENT callers receive their own log only (resolved via actor.personId → platform_students → sis_students). STAFF / ADMIN callers must pass ?studentId=<uuid> to read another student’s log; this is the librarian student-detail view.',
  })
  async list(
    @Query('studentId') studentId: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<ReadingLogResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.logs.list(actor, { studentId });
  }

  @Get(':id')
  @RequirePermission('lib-003:read')
  @ApiOperation({
    summary:
      "Fetch a single reading log entry. STUDENT non-owner gets 404 (don't-leak-existence); STAFF / ADMIN can read any.",
  })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ReadingLogResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.logs.getById(id, actor);
  }

  @Post()
  @RequirePermission('lib-003:write')
  @ApiOperation({
    summary:
      'STUDENT-INPUT KEYSTONE — student logs a book. The Step 7 service validates the catalogue item exists in this tenant, INSERTs the log row, and (when completedDate is set + pagesRead is supplied) auto-upserts lib_programme_progress for every active programme covering this student via the SCHOOL_WIDE / CLASS audience-matching SQL. Fires inside a single tenant transaction.',
  })
  async log(
    @Body() body: CreateReadingLogDto,
    @Req() req: AuthedRequest,
  ): Promise<ReadingLogResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.logs.log(body, actor);
  }

  @Patch(':id')
  @RequirePermission('lib-003:write')
  @ApiOperation({
    summary:
      'Update a reading log entry. Student edits own only (row-scope inside the tx). When this PATCH transitions the log from in-progress to completed (completedDate flips from null to a value), the programme-progress auto-upsert fires the same way as create.',
  })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateReadingLogDto,
    @Req() req: AuthedRequest,
  ): Promise<ReadingLogResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.logs.patch(id, body, actor);
  }
}
