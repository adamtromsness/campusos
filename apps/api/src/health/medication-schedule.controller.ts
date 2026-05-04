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
import { MedicationScheduleService } from './medication-schedule.service';
import {
  CreateScheduleSlotDto,
  ScheduleSlotResponseDto,
  UpdateScheduleSlotDto,
} from './dto/health.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Health Medication Schedule')
@ApiBearerAuth()
@Controller()
export class MedicationScheduleController {
  constructor(
    private readonly schedule: MedicationScheduleService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('health/medications/:id/schedule')
  @RequirePermission('hlt-001:read')
  @ApiOperation({
    summary: "List schedule slots for a medication. Inherits the parent medication's row scope.",
  })
  async list(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ScheduleSlotResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.schedule.listForMedication(id, actor);
  }

  @Post('health/medications/:id/schedule')
  @RequirePermission('hlt-002:write')
  @ApiOperation({
    summary:
      'Add a schedule slot to a medication. Nurse / admin only. day_of_week=NULL means every day; specific values 0..6 follow the ISO Sunday-Saturday convention.',
  })
  async create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateScheduleSlotDto,
    @Req() req: AuthedRequest,
  ): Promise<ScheduleSlotResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.schedule.create(id, body, actor);
  }

  @Patch('health/medication-schedule/:id')
  @RequirePermission('hlt-002:write')
  @ApiOperation({ summary: 'Update a schedule slot. Nurse / admin only.' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateScheduleSlotDto,
    @Req() req: AuthedRequest,
  ): Promise<ScheduleSlotResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.schedule.update(id, body, actor);
  }

  @Delete('health/medication-schedule/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('hlt-002:write')
  @ApiOperation({
    summary:
      'Delete a schedule slot. Nurse / admin only. Historical administration rows survive (the schedule_entry_id ref on hlth_medication_administrations is a deliberate soft ref per Step 2).',
  })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest): Promise<void> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    await this.schedule.remove(id, actor);
  }
}
