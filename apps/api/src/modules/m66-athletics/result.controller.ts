import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { ResultService } from './result.service';
import {
  EnterGameResultDto,
  GameResponseDto,
  GameResultResponseDto,
  SeasonRecordResponseDto,
} from './dto/athletics.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

@ApiTags('Athletics — Results')
@ApiBearerAuth()
@Controller('athletics')
export class ResultController {
  constructor(
    private readonly results: ResultService,
    private readonly actors: ActorContextService,
  ) {}

  @Post('games/:id/result')
  @RequirePermission('ath-002:write')
  @ApiOperation({
    summary:
      'Enter a game result. Auto-updates the season record in the same tx and emits ath.game.result.entered.',
  })
  async enter(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: EnterGameResultDto,
  ): Promise<GameResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.results.enterResult(id, body, actor);
  }

  @Patch('game-results/:id')
  @RequirePermission('ath-002:write')
  async patch(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: EnterGameResultDto,
  ): Promise<GameResultResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.results.patchResult(id, body, actor);
  }

  @Get('season-records/:rosterId')
  @RequirePermission('ath-002:read')
  async seasonRecord(
    @Param('rosterId', ParseUUIDPipe) rosterId: string,
  ): Promise<SeasonRecordResponseDto> {
    return this.results.getSeasonRecord(rosterId);
  }
}
