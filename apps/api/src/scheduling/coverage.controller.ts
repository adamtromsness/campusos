import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { CoverageService } from './coverage.service';
import {
  AssignCoverageDto,
  CancelCoverageDto,
  CoverageRequestResponseDto,
  ListCoverageQueryDto,
} from './dto/coverage.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Coverage')
@ApiBearerAuth()
@Controller('coverage')
export class CoverageController {
  constructor(
    private readonly coverage: CoverageService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('sch-004:read')
  @ApiOperation({
    summary:
      'List coverage requests. Non-admin staff see only rows where they are the absent or assigned employee.',
  })
  async list(
    @Query() query: ListCoverageQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<CoverageRequestResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.coverage.list(query, actor);
  }

  @Get(':id')
  @RequirePermission('sch-004:read')
  @ApiOperation({ summary: 'Get a coverage request by id' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<CoverageRequestResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.coverage.getById(id, actor);
  }

  @Patch(':id/assign')
  @RequirePermission('sch-004:write')
  @ApiOperation({
    summary:
      'Assign a substitute (admin only). Creates the substitution timetable row and emits sch.coverage.assigned.',
  })
  async assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AssignCoverageDto,
    @Req() req: AuthedRequest,
  ): Promise<CoverageRequestResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.coverage.assign(id, body, actor);
  }

  @Patch(':id/cancel')
  @RequirePermission('sch-004:write')
  @ApiOperation({ summary: 'Cancel a coverage request (admin only)' })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelCoverageDto,
    @Req() req: AuthedRequest,
  ): Promise<CoverageRequestResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.coverage.cancel(id, body, actor);
  }
}
