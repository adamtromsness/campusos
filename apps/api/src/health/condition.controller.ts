import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { ConditionService } from './condition.service';
import { ConditionResponseDto, CreateConditionDto, UpdateConditionDto } from './dto/health.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Health Conditions')
@ApiBearerAuth()
@Controller()
export class ConditionController {
  constructor(
    private readonly conditions: ConditionService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('health/students/:studentId/conditions')
  @RequirePermission('hlt-001:read')
  @ApiOperation({
    summary:
      'List conditions for a student. Row-scoped via the parent HealthRecordService. management_plan is stripped for non-managers (teachers and parents see condition_name + severity only). Writes a VIEW_CONDITIONS row to hlth_health_access_log.',
  })
  async list(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<ConditionResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.conditions.listForStudent(studentId, actor);
  }

  @Post('health/students/:studentId/conditions')
  @RequirePermission('hlt-001:write')
  @ApiOperation({
    summary: "Add a condition to a student's health record. Nurse / admin only.",
  })
  async create(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Body() body: CreateConditionDto,
    @Req() req: AuthedRequest,
  ): Promise<ConditionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.conditions.create(studentId, body, actor);
  }

  @Patch('health/conditions/:id')
  @RequirePermission('hlt-001:write')
  @ApiOperation({
    summary:
      'Update a condition. Nurse / admin only. The canonical resolve path is is_active=false — the row stays in the historical timeline.',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateConditionDto,
    @Req() req: AuthedRequest,
  ): Promise<ConditionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.conditions.update(id, body, actor);
  }

  @Delete('health/conditions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('hlt-001:write')
  @ApiOperation({
    summary:
      'Hard delete a condition. Nurse / admin only — used to remove a row recorded in error. The canonical resolve path is is_active=false.',
  })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest): Promise<void> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    await this.conditions.remove(id, actor);
  }
}
