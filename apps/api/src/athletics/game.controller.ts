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
import { GameService } from './game.service';
import { CreateGameDto, GameResponseDto, GameStatus, UpdateGameDto } from './dto/athletics.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

@ApiTags('Athletics — Games')
@ApiBearerAuth()
@Controller('athletics')
export class GameController {
  constructor(
    private readonly games: GameService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('games')
  @RequirePermission('ath-002:read')
  async list(
    @Query('seasonId') seasonId?: string,
    @Query('rosterId') rosterId?: string,
    @Query('status') status?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ): Promise<GameResponseDto[]> {
    return this.games.list({
      seasonId,
      rosterId,
      status: status as GameStatus | undefined,
      fromDate,
      toDate,
    });
  }

  @Get('schedule')
  @RequirePermission('ath-002:read')
  @ApiOperation({ summary: 'Public-facing calendar view — upcoming games across all sports.' })
  async schedule(): Promise<GameResponseDto[]> {
    const today = new Date().toISOString().slice(0, 10);
    return this.games.list({ fromDate: today });
  }

  @Get('games/:id')
  @RequirePermission('ath-002:read')
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<GameResponseDto> {
    return this.games.getById(id);
  }

  @Post('games')
  @RequirePermission('ath-002:write')
  async create(@Req() req: AuthedRequest, @Body() body: CreateGameDto): Promise<GameResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.games.create(body, actor);
  }

  @Patch('games/:id')
  @RequirePermission('ath-002:write')
  async patch(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateGameDto,
  ): Promise<GameResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.games.patch(id, body, actor);
  }
}
