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
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { ConferenceService } from './conference.service';
import {
  ConferenceMembershipResponseDto,
  ConferenceResponseDto,
  ConferenceScheduleResponseDto,
  CreateConferenceDto,
  CreateConferenceMembershipDto,
  CreateConferenceScheduleDto,
  UpdateConferenceDto,
} from './dto/athletics-advanced.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

@ApiTags('Athletics Advanced — Conferences')
@ApiBearerAuth()
@Controller('athletics/conferences')
export class ConferenceController {
  constructor(
    private readonly conferences: ConferenceService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('ath-003:read')
  async list(
    @Query('sport') sport?: string,
    @Query('includeInactive', new ParseBoolPipe({ optional: true })) includeInactive?: boolean,
  ): Promise<ConferenceResponseDto[]> {
    return this.conferences.list({ sport, includeInactive: includeInactive ?? false });
  }

  @Get(':id')
  @RequirePermission('ath-003:read')
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<ConferenceResponseDto> {
    return this.conferences.getById(id);
  }

  @Post()
  @RequirePermission('ath-003:write')
  async create(
    @Req() req: AuthedRequest,
    @Body() body: CreateConferenceDto,
  ): Promise<ConferenceResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.conferences.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('ath-003:write')
  async patch(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateConferenceDto,
  ): Promise<ConferenceResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.conferences.patch(id, body, actor);
  }

  // ── Memberships ─────────────────────────────────────────────────

  @Get(':id/memberships')
  @RequirePermission('ath-003:read')
  async listMemberships(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConferenceMembershipResponseDto[]> {
    return this.conferences.listMemberships(id);
  }

  @Post(':id/memberships')
  @RequirePermission('ath-003:write')
  async addMembership(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateConferenceMembershipDto,
  ): Promise<ConferenceMembershipResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.conferences.addMembership(id, body, actor);
  }

  // ── Schedules ───────────────────────────────────────────────────

  @Get(':id/schedule')
  @RequirePermission('ath-003:read')
  @ApiOperation({ summary: 'Conference schedule grid (cross-school games).' })
  async listSchedule(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConferenceScheduleResponseDto[]> {
    return this.conferences.listSchedule(id);
  }

  @Post(':id/schedule')
  @RequirePermission('ath-003:write')
  async addScheduleEntry(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateConferenceScheduleDto,
  ): Promise<ConferenceScheduleResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.conferences.addScheduleEntry(id, body, actor);
  }
}
