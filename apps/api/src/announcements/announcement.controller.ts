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
import { AnnouncementService } from './announcement.service';
import {
  AnnouncementResponseDto,
  AnnouncementStatsResponseDto,
  CreateAnnouncementDto,
  ListAnnouncementsQueryDto,
  MarkAnnouncementReadResponseDto,
  UpdateAnnouncementDto,
} from './dto/announcement.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    personId: string;
    email: string;
    displayName: string;
    sessionId: string;
  };
}

@ApiTags('Announcements')
@ApiBearerAuth()
@Controller('announcements')
export class AnnouncementController {
  constructor(
    private readonly announcements: AnnouncementService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('com-002:read')
  @ApiOperation({
    summary:
      'List announcements visible to the calling user. Managers (com-002:write) see every ' +
      'announcement; readers see only published rows where they have a row in ' +
      'msg_announcement_audiences.',
  })
  async list(
    @Query() q: ListAnnouncementsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<AnnouncementResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.announcements.list(q, actor);
  }

  @Get(':id')
  @RequirePermission('com-002:read')
  @ApiOperation({ summary: 'Get a single announcement (404 when not visible to the caller)' })
  async getOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<AnnouncementResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.announcements.getById(id, actor);
  }

  @Post()
  @RequirePermission('com-002:write')
  @ApiOperation({
    summary:
      'Create a draft or publish-now announcement. Publishing emits ' +
      '`msg.announcement.published` so the AudienceFanOutWorker can pre-populate ' +
      '`msg_announcement_audiences` and enqueue notifications.',
  })
  async create(
    @Body() body: CreateAnnouncementDto,
    @Req() req: AuthedRequest,
  ): Promise<AnnouncementResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.announcements.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('com-002:write')
  @ApiOperation({
    summary:
      'Edit a draft announcement. Author or school admin only. Setting `isPublished=true` ' +
      'publishes the draft and triggers fan-out. Already-published announcements cannot be ' +
      'edited via this endpoint.',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateAnnouncementDto,
    @Req() req: AuthedRequest,
  ): Promise<AnnouncementResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.announcements.update(id, body, actor);
  }

  @Post(':id/read')
  @RequirePermission('com-002:read')
  @ApiOperation({
    summary:
      'Mark an announcement as read for the calling user. Idempotent — re-running returns ' +
      'newlyRead=false. Also flips the matching audience row from PENDING to DELIVERED.',
  })
  async markRead(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<MarkAnnouncementReadResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.announcements.markRead(id, actor);
  }

  @Get(':id/stats')
  @RequirePermission('com-002:write')
  @ApiOperation({
    summary:
      'Audience + read stats for an announcement. Author or school admin only — readers and ' +
      'non-author teachers get 403 even though they hold com-002:write.',
  })
  async getStats(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<AnnouncementStatsResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.announcements.getStats(id, actor);
  }
}
