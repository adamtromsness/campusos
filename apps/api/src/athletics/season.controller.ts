import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { SeasonService } from './season.service';
import { CreateSeasonDto, SeasonResponseDto, UpdateSeasonDto } from './dto/athletics.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

@ApiTags('Athletics — Seasons')
@ApiBearerAuth()
@Controller('athletics')
export class SeasonController {
  constructor(
    private readonly seasons: SeasonService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('programmes/:id/seasons')
  @RequirePermission('ath-001:read')
  async listForProgramme(@Param('id', ParseUUIDPipe) id: string): Promise<SeasonResponseDto[]> {
    return this.seasons.listForProgramme(id);
  }

  @Get('seasons/:id')
  @RequirePermission('ath-001:read')
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<SeasonResponseDto> {
    return this.seasons.getById(id);
  }

  @Post('programmes/:id/seasons')
  @RequirePermission('ath-001:write')
  @ApiOperation({ summary: 'Open a new season for a programme. AD or admin only.' })
  async create(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateSeasonDto,
  ): Promise<SeasonResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.seasons.create(id, body, actor);
  }

  @Patch('seasons/:id')
  @RequirePermission('ath-001:write')
  async patch(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateSeasonDto,
  ): Promise<SeasonResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.seasons.patch(id, body, actor);
  }
}
