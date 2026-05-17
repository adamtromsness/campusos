import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { StatsService } from './stats.service';
import {
  AllTimeRecordResponseDto,
  CreateAllTimeRecordDto,
  EnterPlayerStatsDto,
  PlayerGameStatResponseDto,
} from './dto/athletics.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

@ApiTags('Athletics — Stats')
@ApiBearerAuth()
@Controller('athletics')
export class StatsController {
  constructor(
    private readonly stats: StatsService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('games/:id/stats')
  @RequirePermission('ath-002:read')
  async listForGame(@Param('id', ParseUUIDPipe) id: string): Promise<PlayerGameStatResponseDto[]> {
    return this.stats.listForGame(id);
  }

  @Post('games/:id/stats')
  @RequirePermission('ath-002:write')
  @ApiOperation({ summary: 'Bulk-enter player stats for a game.' })
  async bulkEnter(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: EnterPlayerStatsDto,
  ): Promise<PlayerGameStatResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.stats.bulkEnter(id, body, actor);
  }

  @Get('players/:studentId/stats')
  @RequirePermission('ath-002:read')
  async listForPlayer(
    @Param('studentId', ParseUUIDPipe) studentId: string,
  ): Promise<PlayerGameStatResponseDto[]> {
    return this.stats.listForPlayer(studentId);
  }

  @Get('all-time-records')
  @RequirePermission('ath-002:read')
  async listAllTimeRecords(): Promise<AllTimeRecordResponseDto[]> {
    return this.stats.listAllTimeRecords();
  }

  @Post('all-time-records')
  @RequirePermission('ath-002:write')
  async createAllTimeRecord(
    @Req() req: AuthedRequest,
    @Body() body: CreateAllTimeRecordDto,
  ): Promise<AllTimeRecordResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.stats.createAllTimeRecord(body, actor);
  }
}
