import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { AlertService } from './alert.service';
import { AlertResponseDto, ListAlertsQueryDto, ResolveAlertDto } from './dto/wellbeing.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Wellbeing Alerts')
@ApiBearerAuth()
@Controller('counselling/wellbeing/alerts')
export class AlertController {
  constructor(
    private readonly alerts: AlertService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('cou-004:read')
  @ApiOperation({
    summary:
      'List wellbeing alerts. Counsellor + admin only at the service layer (cou-004:read holders that are not counsellors get 403). Counsellors see alerts for students on their own ACTIVE caseloads; admins see all. Sorted by severity (SELF_HARM_INDICATOR first) then created_at DESC. Filters: status, alertType, studentId.',
  })
  async list(
    @Query() query: ListAlertsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<AlertResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.alerts.list(query, actor);
  }

  @Get(':id')
  @RequirePermission('cou-004:read')
  @ApiOperation({
    summary:
      'Fetch a single alert with the linked response + question text inlined for the queue UI. Counsellor + admin only.',
  })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<AlertResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.alerts.getById(id, actor);
  }

  @Patch(':id/acknowledge')
  @RequirePermission('cou-004:write')
  @ApiOperation({
    summary:
      'NEW → ACKNOWLEDGED. Stamps acknowledged_by + acknowledged_at atomically inside the locked tx so the multi-column acknowledged_chk lockstep is satisfied.',
  })
  async acknowledge(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<AlertResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.alerts.acknowledge(id, actor);
  }

  @Patch(':id/resolve')
  @RequirePermission('cou-004:write')
  @ApiOperation({
    summary:
      'Any non-RESOLVED state → RESOLVED with required resolution_notes. The skip-acknowledge fast path (NEW → RESOLVED) stamps acknowledged_by + acknowledged_at via COALESCE so the lockstep CHECK is satisfied.',
  })
  async resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ResolveAlertDto,
    @Req() req: AuthedRequest,
  ): Promise<AlertResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.alerts.resolve(id, body, actor);
  }
}
