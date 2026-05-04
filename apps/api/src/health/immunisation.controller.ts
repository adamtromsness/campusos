import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { ImmunisationService } from './immunisation.service';
import {
  CreateImmunisationDto,
  ImmunisationResponseDto,
  UpdateImmunisationDto,
} from './dto/health.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Health Immunisations')
@ApiBearerAuth()
@Controller()
export class ImmunisationController {
  constructor(
    private readonly immunisations: ImmunisationService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('health/students/:studentId/immunisations')
  @RequirePermission('hlt-001:read')
  @ApiOperation({
    summary:
      'List immunisations for a student. Nurse / admin / parent only at the service layer; teachers receive 403 because the vaccine schedule is not classroom-relevant. Writes a VIEW_IMMUNISATIONS row to hlth_health_access_log.',
  })
  async list(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<ImmunisationResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.immunisations.listForStudent(studentId, actor);
  }

  @Post('health/students/:studentId/immunisations')
  @RequirePermission('hlt-001:write')
  @ApiOperation({
    summary: "Add an immunisation row to a student's health record. Nurse / admin only.",
  })
  async create(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Body() body: CreateImmunisationDto,
    @Req() req: AuthedRequest,
  ): Promise<ImmunisationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.immunisations.create(studentId, body, actor);
  }

  @Patch('health/immunisations/:id')
  @RequirePermission('hlt-001:write')
  @ApiOperation({
    summary:
      'Update an immunisation row. Nurse / admin only. Use this path to flip status to CURRENT after a parent provides a recent vaccination record, or to WAIVED after a religious / medical exemption is approved.',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateImmunisationDto,
    @Req() req: AuthedRequest,
  ): Promise<ImmunisationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.immunisations.update(id, body, actor);
  }
}
