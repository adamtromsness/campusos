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
import { IncidentService } from './incident.service';
import {
  CreateIncidentDto,
  IncidentResponseDto,
  ListIncidentsQueryDto,
  ResolveIncidentDto,
  ReviewIncidentDto,
} from './dto/discipline.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Discipline Incidents')
@ApiBearerAuth()
@Controller('discipline/incidents')
export class IncidentController {
  constructor(
    private readonly incidents: IncidentService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('beh-001:read')
  @ApiOperation({
    summary:
      'List incidents visible to the caller. Admins/counsellors see all. Teachers see incidents they reported or for students in their classes. Parents see their own children, with admin_notes stripped.',
  })
  async list(
    @Query() query: ListIncidentsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<IncidentResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.incidents.list(query, actor);
  }

  @Get(':id')
  @RequirePermission('beh-001:read')
  @ApiOperation({ summary: 'Fetch a single incident. 404 to non-participants.' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<IncidentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.incidents.getById(id, actor);
  }

  @Post()
  @RequirePermission('beh-001:write')
  @ApiOperation({
    summary:
      'Report a new incident. Stamps reported_by from actor.employeeId and emits beh.incident.reported.',
  })
  async create(
    @Body() body: CreateIncidentDto,
    @Req() req: AuthedRequest,
  ): Promise<IncidentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.incidents.create(body, actor);
  }

  @Patch(':id/review')
  @RequirePermission('beh-001:admin')
  @ApiOperation({ summary: 'Admin transitions an incident OPEN → UNDER_REVIEW.' })
  async review(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewIncidentDto,
    @Req() req: AuthedRequest,
  ): Promise<IncidentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.incidents.review(id, body, actor);
  }

  @Patch(':id/resolve')
  @RequirePermission('beh-001:admin')
  @ApiOperation({
    summary:
      'Admin resolves the incident. Sets resolved_by + resolved_at in the same UPDATE per the multi-column resolved_chk. Emits beh.incident.resolved.',
  })
  async resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ResolveIncidentDto,
    @Req() req: AuthedRequest,
  ): Promise<IncidentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.incidents.resolve(id, body, actor);
  }

  @Patch(':id/reopen')
  @RequirePermission('beh-001:admin')
  @ApiOperation({
    summary:
      'Admin reopens a RESOLVED incident → OPEN. Clears resolved_by + resolved_at in the same UPDATE.',
  })
  async reopen(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<IncidentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.incidents.reopen(id, actor);
  }
}
