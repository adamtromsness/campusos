import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { AdministrationService } from './administration.service';
import {
  AdministerDoseDto,
  AdministrationResponseDto,
  LogMissedDoseDto,
  MedicationDashboardRowDto,
} from './dto/health.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Health Medication Administrations')
@ApiBearerAuth()
@Controller()
export class AdministrationController {
  constructor(
    private readonly admin: AdministrationService,
    private readonly actors: ActorContextService,
  ) {}

  @Post('health/medications/:id/administer')
  @RequirePermission('hlt-002:write')
  @ApiOperation({
    summary:
      'Log an administered dose. Nurse / admin only. Stamps administered_by from actor.employeeId — refuses callers without an hr_employees row (synthetic Platform Admin would fail by design). Emits hlth.medication.administered for the future Cycle 3 NotificationConsumer to fan out parent notifications.',
  })
  async administer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AdministerDoseDto,
    @Req() req: AuthedRequest,
  ): Promise<AdministrationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.admin.administer(id, body, actor);
  }

  @Post('health/medications/:id/missed')
  @RequirePermission('hlt-002:write')
  @ApiOperation({
    summary:
      "Log a missed dose. Nurse / admin only. Sets was_missed=true with administered_at NULL and missed_reason populated per the schema's missed_chk shape. The administered_by column is left NULL because the dose was not given by anyone.",
  })
  async missed(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: LogMissedDoseDto,
    @Req() req: AuthedRequest,
  ): Promise<AdministrationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.admin.logMissed(id, body, actor);
  }

  @Get('health/medications/:id/administrations')
  @RequirePermission('hlt-001:read')
  @ApiOperation({
    summary:
      "Per-medication dose history. Inherits the parent medication's row scope (nurse / admin / parent only; teachers 403 service-layer). Writes a VIEW_MEDICATIONS audit row.",
  })
  async list(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<AdministrationResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.admin.listForMedication(id, actor);
  }

  @Get('health/medication-dashboard')
  @RequirePermission('hlt-002:read')
  @ApiOperation({
    summary:
      "Today's school-wide medication checklist. Nurse / admin only. One row per scheduled-today slot across every active medication, with status resolved (ADMINISTERED / MISSED / PENDING). The Step 8 nurse dashboard polls this endpoint.",
  })
  async dashboard(@Req() req: AuthedRequest): Promise<MedicationDashboardRowDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.admin.getDashboard(actor);
  }
}
