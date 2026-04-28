import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { BellScheduleService } from './bell-schedule.service';
import {
  BellScheduleResponseDto,
  CreateBellScheduleDto,
  UpdateBellScheduleDto,
  UpsertPeriodsDto,
} from './dto/bell-schedule.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Bell Schedules')
@ApiBearerAuth()
@Controller('bell-schedules')
export class BellScheduleController {
  constructor(
    private readonly schedules: BellScheduleService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('sch-001:read')
  @ApiOperation({ summary: 'List bell schedules in the current tenant' })
  async list(): Promise<BellScheduleResponseDto[]> {
    return this.schedules.list();
  }

  @Get(':id')
  @RequirePermission('sch-001:read')
  @ApiOperation({ summary: 'Get a bell schedule and its periods' })
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<BellScheduleResponseDto> {
    return this.schedules.getById(id);
  }

  @Post()
  @RequirePermission('sch-001:admin')
  @ApiOperation({ summary: 'Create a bell schedule (admin only)' })
  async create(
    @Body() body: CreateBellScheduleDto,
    @Req() req: AuthedRequest,
  ): Promise<BellScheduleResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.schedules.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('sch-001:admin')
  @ApiOperation({ summary: 'Patch a bell schedule (admin only)' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateBellScheduleDto,
    @Req() req: AuthedRequest,
  ): Promise<BellScheduleResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.schedules.update(id, body, actor);
  }

  @Post(':id/periods')
  @RequirePermission('sch-001:admin')
  @ApiOperation({ summary: "Replace the schedule's periods (full upsert, admin only)" })
  async upsertPeriods(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpsertPeriodsDto,
    @Req() req: AuthedRequest,
  ): Promise<BellScheduleResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.schedules.upsertPeriods(id, body, actor);
  }

  @Post(':id/set-default')
  @RequirePermission('sch-001:admin')
  @ApiOperation({ summary: 'Mark the schedule as default for the current school (admin only)' })
  async setDefault(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<BellScheduleResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.schedules.setDefault(id, actor);
  }
}
