import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { GameProposalService } from './game-proposal.service';
import {
  CreateGameProposalDto,
  GameProposalResponseDto,
  RespondGameProposalDto,
} from './dto/athletics.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

@ApiTags('Athletics — Game Proposals (ADR-069)')
@ApiBearerAuth()
@Controller('athletics/game-proposals')
export class GameProposalController {
  constructor(
    private readonly proposals: GameProposalService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('ath-002:read')
  async list(@Req() req: AuthedRequest): Promise<GameProposalResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.proposals.list(actor);
  }

  @Get(':id')
  @RequirePermission('ath-002:read')
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<GameProposalResponseDto> {
    return this.proposals.getById(id);
  }

  @Post()
  @RequirePermission('ath-002:write')
  async create(
    @Req() req: AuthedRequest,
    @Body() body: CreateGameProposalDto,
  ): Promise<GameProposalResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.proposals.create(body, actor);
  }

  @Patch(':id/accept')
  @RequirePermission('ath-002:write')
  async accept(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<GameProposalResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.proposals.accept(id, actor);
  }

  @Patch(':id/decline')
  @RequirePermission('ath-002:write')
  async decline(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<GameProposalResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.proposals.decline(id, actor);
  }

  @Patch(':id/counter')
  @RequirePermission('ath-002:write')
  async counter(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RespondGameProposalDto,
  ): Promise<GameProposalResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.proposals.counter(id, body, actor);
  }
}
