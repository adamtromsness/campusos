import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { TeamMediaService } from './team-media.service';
import {
  CreateMediaAssetDto,
  CreateTeamPhotoDto,
  MediaAssetResponseDto,
  MediaAssetType,
  TeamPhotoResponseDto,
} from './dto/athletics-advanced.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

@ApiTags('Athletics Advanced — Team Media')
@ApiBearerAuth()
@Controller('athletics')
export class TeamMediaController {
  constructor(
    private readonly media: TeamMediaService,
    private readonly actors: ActorContextService,
  ) {}

  // ── Team photos ────────────────────────────────────────────────

  @Get('rosters/:id/photos')
  @RequirePermission('ath-001:read')
  async listForRoster(@Param('id', ParseUUIDPipe) id: string): Promise<TeamPhotoResponseDto[]> {
    return this.media.listForRoster(id);
  }

  @Post('team-photos')
  @RequirePermission('ath-001:write')
  async createPhoto(
    @Req() req: AuthedRequest,
    @Body() body: CreateTeamPhotoDto,
  ): Promise<TeamPhotoResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.media.createPhoto(body, actor);
  }

  // ── Media assets ────────────────────────────────────────────────

  @Get('programmes/:id/media')
  @RequirePermission('ath-001:read')
  @ApiOperation({ summary: 'List media assets attached to a programme.' })
  async listForProgramme(@Param('id', ParseUUIDPipe) id: string): Promise<MediaAssetResponseDto[]> {
    return this.media.listForProgramme(id);
  }

  @Get('media-assets')
  @RequirePermission('ath-001:read')
  async listMedia(
    @Query('programmeId') programmeId?: string,
    @Query('assetType') assetType?: string,
    @Query('seasonId') seasonId?: string,
  ): Promise<MediaAssetResponseDto[]> {
    return this.media.listMedia({
      programmeId,
      assetType: (assetType as MediaAssetType) ?? undefined,
      seasonId,
    });
  }

  @Post('media-assets')
  @RequirePermission('ath-001:write')
  async createAsset(
    @Req() req: AuthedRequest,
    @Body() body: CreateMediaAssetDto,
  ): Promise<MediaAssetResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.media.createAsset(body, actor);
  }
}
