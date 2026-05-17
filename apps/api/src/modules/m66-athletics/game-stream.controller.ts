import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { GameStreamService } from './game-stream.service';
import {
  CreateGameRecordingDto,
  CreateGameStreamDto,
  CreateHighlightClipDto,
  GameRecordingResponseDto,
  GameStreamResponseDto,
  HighlightClipResponseDto,
  RecordHighlightClipConsentDto,
  UpdateGameStreamDto,
} from './dto/athletics-advanced.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

@ApiTags('Athletics Advanced — Streaming + Highlights + Recordings')
@ApiBearerAuth()
@Controller('athletics')
export class GameStreamController {
  constructor(
    private readonly streams: GameStreamService,
    private readonly actors: ActorContextService,
  ) {}

  // ── Streams ─────────────────────────────────────────────────────

  @Get('streams/live')
  @RequirePermission('ath-005:read')
  @ApiOperation({ summary: 'List currently live game streams.' })
  async listLive(): Promise<GameStreamResponseDto[]> {
    return this.streams.listLive();
  }

  @Get('streams/:id')
  @RequirePermission('ath-005:read')
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<GameStreamResponseDto> {
    return this.streams.getById(id);
  }

  @Get('games/:gameId/stream')
  @RequirePermission('ath-005:read')
  @ApiOperation({ summary: 'Resolve the stream for a game (404 if no stream configured).' })
  async getByGame(
    @Param('gameId', ParseUUIDPipe) gameId: string,
  ): Promise<GameStreamResponseDto | null> {
    return this.streams.getByGameId(gameId);
  }

  @Post('games/:gameId/stream')
  @RequirePermission('ath-005:write')
  @ApiOperation({
    summary:
      'Configure a stream for a game. UNIQUE(game_id) enforces one stream per game per ADR-068.',
  })
  async configure(
    @Req() req: AuthedRequest,
    @Param('gameId', ParseUUIDPipe) gameId: string,
    @Body() body: CreateGameStreamDto,
  ): Promise<GameStreamResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.streams.configureStream(gameId, body, actor);
  }

  @Patch('streams/:id')
  @RequirePermission('ath-005:write')
  @ApiOperation({ summary: 'Update stream status (SCHEDULED → LIVE → ENDED) and recording info.' })
  async patch(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateGameStreamDto,
  ): Promise<GameStreamResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.streams.patchStream(id, body, actor);
  }

  // ── Highlight Clips ─────────────────────────────────────────────

  @Get('streams/:streamId/clips')
  @RequirePermission('ath-005:read')
  async listClipsForStream(
    @Param('streamId', ParseUUIDPipe) streamId: string,
  ): Promise<HighlightClipResponseDto[]> {
    return this.streams.listClipsForStream(streamId);
  }

  @Get('students/:studentId/highlight-clips')
  @RequirePermission('ath-005:read')
  async listClipsForStudent(
    @Param('studentId', ParseUUIDPipe) studentId: string,
  ): Promise<HighlightClipResponseDto[]> {
    return this.streams.listClipsForStudent(studentId);
  }

  @Get('highlight-clips/:id')
  @RequirePermission('ath-005:read')
  async getClipById(@Param('id', ParseUUIDPipe) id: string): Promise<HighlightClipResponseDto> {
    return this.streams.getClipById(id);
  }

  @Post('streams/:streamId/clips')
  @RequirePermission('ath-005:write')
  @ApiOperation({
    summary:
      'Extract a highlight clip (timeline scrubbing). Per ADR-068 the clip starts as PENDING consent.',
  })
  async createClip(
    @Req() req: AuthedRequest,
    @Param('streamId', ParseUUIDPipe) streamId: string,
    @Body() body: CreateHighlightClipDto,
  ): Promise<HighlightClipResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.streams.createClip(streamId, body, actor);
  }

  @Post('highlight-clips/:id/consent')
  @RequirePermission('ath-005:read')
  @ApiOperation({
    summary:
      'Record consent on a highlight clip. Open to the student themself, a linked guardian, or AD/admin (admin override for COPPA cases).',
  })
  async recordConsent(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RecordHighlightClipConsentDto,
  ): Promise<HighlightClipResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.streams.recordClipConsent(id, body, actor);
  }

  @Post('highlight-clips/:id/add-to-portfolio')
  @RequirePermission('ath-005:write')
  @ApiOperation({
    summary:
      'Link a highlight clip to the student portfolio. Refused unless consent_status is CONSENTED. Emits ath.highlight_clip.portfolio_link_requested.',
  })
  async addToPortfolio(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<HighlightClipResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.streams.addClipToPortfolio(id, actor);
  }

  // ── Game Recordings ─────────────────────────────────────────────

  @Get('games/:gameId/recordings')
  @RequirePermission('ath-005:read')
  async listRecordingsForGame(
    @Param('gameId', ParseUUIDPipe) gameId: string,
  ): Promise<GameRecordingResponseDto[]> {
    return this.streams.listRecordingsForGame(gameId);
  }

  @Get('recordings/:id')
  @RequirePermission('ath-005:read')
  async getRecordingById(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<GameRecordingResponseDto> {
    return this.streams.getRecordingById(id);
  }

  @Post('games/:gameId/recordings')
  @RequirePermission('ath-005:write')
  async createRecording(
    @Req() req: AuthedRequest,
    @Param('gameId', ParseUUIDPipe) gameId: string,
    @Body() body: CreateGameRecordingDto,
  ): Promise<GameRecordingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.streams.createRecording(gameId, body, actor);
  }
}
