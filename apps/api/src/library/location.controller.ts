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
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { LocationService } from './location.service';
import { CreateLocationDto, LocationResponseDto, UpdateLocationDto } from './dto/library.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Library — Locations')
@ApiBearerAuth()
@Controller('library/locations')
export class LocationController {
  constructor(
    private readonly locations: LocationService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('lib-001:read')
  @ApiOperation({
    summary:
      'List library locations for this school. Defaults to active locations only — pass includeInactive=true to see deactivated rows. All authenticated users with lib-001:read see locations because the catalogue + per-copy location label is part of the public catalogue surface.',
  })
  async list(
    @Query('includeInactive', new ParseBoolPipe({ optional: true })) includeInactive?: boolean,
  ): Promise<LocationResponseDto[]> {
    return this.locations.list(includeInactive ?? false);
  }

  @Get(':id')
  @RequirePermission('lib-001:read')
  @ApiOperation({ summary: 'Fetch a single library location by id.' })
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<LocationResponseDto> {
    return this.locations.getById(id);
  }

  @Post()
  @RequirePermission('lib-001:write')
  @ApiOperation({
    summary:
      'Librarian or admin creates a library location. UNIQUE(school_id, name) catch surfaces the conflict as a friendly 400.',
  })
  async create(
    @Body() body: CreateLocationDto,
    @Req() req: AuthedRequest,
  ): Promise<LocationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.locations.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('lib-001:write')
  @ApiOperation({
    summary:
      'Update location metadata. is_active=false is the canonical soft-deactivate path — the schema-side SET NULL on lib_catalogue_copies.location_id leaves a copy addressable while its location is reassigned.',
  })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateLocationDto,
    @Req() req: AuthedRequest,
  ): Promise<LocationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.locations.patch(id, body, actor);
  }
}
