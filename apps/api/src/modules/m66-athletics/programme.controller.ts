import {
  Body,
  Controller,
  Get,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { ProgrammeService } from './programme.service';
import {
  CreateProgrammeDto,
  ProgrammeResponseDto,
  ProgrammeSeason,
  UpdateProgrammeDto,
} from './dto/athletics.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

@ApiTags('Athletics — Programmes')
@ApiBearerAuth()
@Controller('athletics/programmes')
export class ProgrammeController {
  constructor(
    private readonly programmes: ProgrammeService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('ath-001:read')
  @ApiOperation({ summary: 'List athletic programmes for this school.' })
  async list(
    @Query('season') season?: string,
    @Query('sport') sport?: string,
    @Query('includeInactive', new ParseBoolPipe({ optional: true })) includeInactive?: boolean,
  ): Promise<ProgrammeResponseDto[]> {
    return this.programmes.list({
      season: (season as ProgrammeSeason) ?? undefined,
      sport,
      includeInactive: includeInactive ?? false,
    });
  }

  @Get(':id')
  @RequirePermission('ath-001:read')
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<ProgrammeResponseDto> {
    return this.programmes.getById(id);
  }

  @Post()
  @RequirePermission('ath-001:write')
  @ApiOperation({ summary: 'Create a sport programme. AD or admin only.' })
  async create(
    @Req() req: AuthedRequest,
    @Body() body: CreateProgrammeDto,
  ): Promise<ProgrammeResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.programmes.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('ath-001:write')
  async patch(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateProgrammeDto,
  ): Promise<ProgrammeResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.programmes.patch(id, body, actor);
  }
}
