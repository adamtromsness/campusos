import {
  Body,
  Controller,
  Delete,
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
import { RotationService } from './rotation.service';
import {
  CreateRotationCycleDto,
  GenerateCalendarDto,
  RotationCalendarEntryDto,
  RotationCycleResponseDto,
  RotationDayLookupDto,
  UpdateRotationCycleDto,
  UpsertRotationCalendarDto,
} from './dto/scheduling-advanced.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Scheduling — Rotation')
@ApiBearerAuth()
@Controller('scheduling/rotation')
export class RotationController {
  constructor(
    private readonly rotation: RotationService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('cycles')
  @RequirePermission('sch-001:read')
  @ApiOperation({ summary: 'List rotation cycles for the current school.' })
  async listCycles(): Promise<RotationCycleResponseDto[]> {
    return this.rotation.listCycles();
  }

  @Get('cycles/:id')
  @RequirePermission('sch-001:read')
  @ApiOperation({ summary: 'Get a single rotation cycle.' })
  async getCycle(@Param('id', ParseUUIDPipe) id: string): Promise<RotationCycleResponseDto> {
    return this.rotation.getCycle(id);
  }

  @Post('cycles')
  @RequirePermission('sch-001:admin')
  @ApiOperation({
    summary:
      'Create a rotation cycle (admin only). cycle_length 1..14 — A/B week = 2, 6-day rotation = 6.',
  })
  async createCycle(
    @Body() body: CreateRotationCycleDto,
    @Req() req: AuthedRequest,
  ): Promise<RotationCycleResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rotation.createCycle(body, actor);
  }

  @Patch('cycles/:id')
  @RequirePermission('sch-001:admin')
  @ApiOperation({ summary: 'Update a rotation cycle name / active flag / description.' })
  async updateCycle(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateRotationCycleDto,
    @Req() req: AuthedRequest,
  ): Promise<RotationCycleResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rotation.updateCycle(id, body, actor);
  }

  @Get('cycles/:id/calendar')
  @RequirePermission('sch-001:read')
  @ApiOperation({
    summary: 'List rotation calendar entries for a cycle. Optional from/to filters.',
  })
  async listCalendar(
    @Param('id', ParseUUIDPipe) cycleId: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ): Promise<RotationCalendarEntryDto[]> {
    return this.rotation.listCalendar(cycleId, fromDate, toDate);
  }

  @Post('cycles/:id/calendar')
  @RequirePermission('sch-001:admin')
  @ApiOperation({
    summary:
      'Upsert a single rotation calendar entry (admin only). ON CONFLICT (cycle, date) DO UPDATE.',
  })
  async upsertCalendarEntry(
    @Param('id', ParseUUIDPipe) cycleId: string,
    @Body() body: UpsertRotationCalendarDto,
    @Req() req: AuthedRequest,
  ): Promise<RotationCalendarEntryDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rotation.upsertCalendarEntry(cycleId, body, actor);
  }

  @Delete('cycles/:id/calendar/:date')
  @RequirePermission('sch-001:admin')
  @ApiOperation({ summary: 'Delete a rotation calendar entry by (cycle, date).' })
  async deleteCalendarEntry(
    @Param('id', ParseUUIDPipe) cycleId: string,
    @Param('date') date: string,
    @Req() req: AuthedRequest,
  ): Promise<{ deleted: boolean }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rotation.deleteCalendarEntry(cycleId, date, actor);
  }

  @Post('cycles/:id/generate')
  @RequirePermission('sch-001:admin')
  @ApiOperation({
    summary:
      'Auto-generate rotation calendar entries for the date range. Mon..Fri only. closureDates skip rotation_day allocation.',
  })
  async generate(
    @Param('id', ParseUUIDPipe) cycleId: string,
    @Body() body: GenerateCalendarDto,
    @Req() req: AuthedRequest,
  ): Promise<{ created: number; updated: number; closed: number }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rotation.generateCalendar(cycleId, body, actor);
  }

  @Get('lookup/:date')
  @RequirePermission('sch-001:read')
  @ApiOperation({
    summary:
      "What rotation day is :date? Returns rotation_day + is_school_day for the current school's active cycle.",
  })
  async lookup(@Param('date') date: string): Promise<RotationDayLookupDto> {
    return this.rotation.lookupRotationDay(date);
  }
}
