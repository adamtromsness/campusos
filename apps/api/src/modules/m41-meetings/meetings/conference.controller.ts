import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { ConferenceService } from './conference.service';
import {
  ConferenceEventResponseDto,
  CreateConferenceEventDto,
  UpdateConferenceEventDto,
} from './dto/meeting.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

@ApiTags('Meetings — Conferences')
@ApiBearerAuth()
@Controller('meetings/conferences')
export class ConferenceController {
  constructor(
    private readonly conferences: ConferenceService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('mtg-002:read')
  async list(): Promise<ConferenceEventResponseDto[]> {
    return this.conferences.list();
  }

  @Get(':id')
  @RequirePermission('mtg-002:read')
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<ConferenceEventResponseDto> {
    return this.conferences.getById(id);
  }

  @Post()
  @RequirePermission('mtg-002:admin')
  @ApiOperation({ summary: 'Admin only — create a conference event' })
  async create(
    @Req() req: AuthedRequest,
    @Body() body: CreateConferenceEventDto,
  ): Promise<ConferenceEventResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.conferences.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('mtg-002:admin')
  async patch(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateConferenceEventDto,
  ): Promise<ConferenceEventResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.conferences.patch(id, body, actor);
  }
}
