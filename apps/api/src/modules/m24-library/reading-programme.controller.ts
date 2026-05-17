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
import { ReadingProgrammeService } from './reading-programme.service';
import {
  CreateReadingProgrammeDto,
  ReadingProgrammeLeaderboardEntryDto,
  ReadingProgrammeResponseDto,
  UpdateReadingProgrammeDto,
} from './dto/library.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Library — Reading Programmes')
@ApiBearerAuth()
@Controller('library/programmes')
export class ReadingProgrammeController {
  constructor(
    private readonly programmes: ReadingProgrammeService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('lib-003:read')
  @ApiOperation({
    summary:
      'List reading programmes for this school. Active only by default; pass includeInactive=true to see deactivated rows. STUDENT callers receive their per-programme myProgress (books_read / pages_read / is_complete) inlined per row.',
  })
  async list(
    @Query('includeInactive') includeInactiveRaw: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<ReadingProgrammeResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    const includeInactive = includeInactiveRaw === 'true';
    return this.programmes.list(actor, { includeInactive });
  }

  @Get(':id')
  @RequirePermission('lib-003:read')
  @ApiOperation({
    summary:
      'Fetch a reading programme. STUDENT callers receive their myProgress inlined when a progress row exists; otherwise myProgress is null.',
  })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ReadingProgrammeResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.programmes.getById(id, actor);
  }

  @Get(':id/leaderboard')
  @RequirePermission('lib-003:read')
  @ApiOperation({
    summary:
      'Top readers for a programme — sorted by books_read DESC, pages_read DESC, last_updated_at ASC NULLS LAST. Default limit 25; max 200.',
  })
  async leaderboard(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limitRaw: string | undefined,
  ): Promise<ReadingProgrammeLeaderboardEntryDto[]> {
    const limit =
      limitRaw !== undefined && limitRaw !== '' && !Number.isNaN(Number(limitRaw))
        ? Number(limitRaw)
        : 25;
    return this.programmes.getLeaderboard(id, limit);
  }

  @Post()
  @RequirePermission('lib-003:write')
  @ApiOperation({
    summary:
      'Librarian, teacher, or admin creates a reading programme. The Step 7 ReadingLogService.create auto-upserts lib_programme_progress for matching SCHOOL_WIDE / CLASS / YEAR_GROUP audiences when students log books with completed_date set.',
  })
  async create(
    @Body() body: CreateReadingProgrammeDto,
    @Req() req: AuthedRequest,
  ): Promise<ReadingProgrammeResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.programmes.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('lib-003:write')
  @ApiOperation({
    summary:
      'Librarian / teacher / admin updates programme metadata. is_active=false is the canonical soft-deactivate path.',
  })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateReadingProgrammeDto,
    @Req() req: AuthedRequest,
  ): Promise<ReadingProgrammeResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.programmes.patch(id, body, actor);
  }
}
