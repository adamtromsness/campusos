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
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { EmergencyAlertService } from './emergency-alert.service';
import {
  AlertStatus,
  EmergencyAlertDeliveryDto,
  EmergencyAlertResponseDto,
  EmergencyAlertStatusDto,
  IssueEmergencyAlertDto,
  ListEmergencyAlertsQueryDto,
} from './dto/emergency-alert.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

@ApiTags('Communications — Emergency Alerts')
@ApiBearerAuth()
@Controller('messaging/emergency-alerts')
export class EmergencyAlertController {
  constructor(
    private readonly alerts: EmergencyAlertService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('com-003:read')
  @ApiOperation({
    summary:
      'List emergency alerts. Non-admins see myDelivery inlined per row so the persistent banner can decide whether to render.',
  })
  async list(
    @Req() req: AuthedRequest,
    @Query('status') status?: string,
  ): Promise<EmergencyAlertResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    const filters: ListEmergencyAlertsQueryDto = {};
    if (status) filters.status = status as AlertStatus;
    return this.alerts.list(filters, actor);
  }

  @Get(':id')
  @RequirePermission('com-003:read')
  async getById(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<EmergencyAlertResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.alerts.getById(id, actor);
  }

  @Post()
  @RequirePermission('com-003:write')
  @ApiOperation({
    summary:
      'Issue a new emergency alert. KEYSTONE — fans out one delivery row per (recipient, channel) inside one tenant tx, then emits msg.emergency.issued AFTER tx commit.',
  })
  async issue(
    @Req() req: AuthedRequest,
    @Body() body: IssueEmergencyAlertDto,
  ): Promise<EmergencyAlertResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.alerts.issue(body, actor);
  }

  @Patch(':id/resolve')
  @RequirePermission('com-003:write')
  async resolve(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<EmergencyAlertResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.alerts.resolve(id, actor);
  }

  @Get(':id/status')
  @RequirePermission('com-003:write')
  @ApiOperation({ summary: 'Issuer-only — delivery + acknowledgement count rollup' })
  async status(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<EmergencyAlertStatusDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.alerts.status(id, actor);
  }
}

@ApiTags('Communications — Emergency Alert Deliveries')
@ApiBearerAuth()
@Controller('messaging/emergency-alert-deliveries')
export class EmergencyAlertDeliveryController {
  constructor(
    private readonly alerts: EmergencyAlertService,
    private readonly actors: ActorContextService,
  ) {}

  @Post(':id/acknowledge')
  @RequirePermission('com-003:read')
  @ApiOperation({
    summary:
      "Recipient acknowledges their own delivery. Idempotent — re-ack leaves the existing acknowledged_at in place. Row scope = delivery.recipient_id == actor's accountId.",
  })
  async acknowledge(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<EmergencyAlertDeliveryDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.alerts.acknowledgeDelivery(id, actor);
  }
}
