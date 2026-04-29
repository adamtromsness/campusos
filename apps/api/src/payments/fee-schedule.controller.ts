import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { FeeScheduleService } from './fee-schedule.service';
import {
  CreateFeeCategoryDto,
  CreateFeeScheduleDto,
  FeeCategoryResponseDto,
  FeeScheduleResponseDto,
  UpdateFeeScheduleDto,
} from './dto/fee-schedule.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Payments: Fee Schedules')
@ApiBearerAuth()
@Controller()
export class FeeScheduleController {
  constructor(
    private readonly fees: FeeScheduleService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('fee-categories')
  @RequirePermission('fin-001:read')
  @ApiOperation({ summary: 'List fee categories in the school' })
  async listCategories(): Promise<FeeCategoryResponseDto[]> {
    return this.fees.listCategories();
  }

  @Post('fee-categories')
  @RequirePermission('fin-001:admin')
  @ApiOperation({ summary: 'Create a fee category (admin only)' })
  async createCategory(
    @Body() body: CreateFeeCategoryDto,
    @Req() req: AuthedRequest,
  ): Promise<FeeCategoryResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.fees.createCategory(body, actor);
  }

  @Get('fee-schedules')
  @RequirePermission('fin-001:read')
  @ApiOperation({ summary: 'List fee schedules with academic year + category names' })
  async listSchedules(): Promise<FeeScheduleResponseDto[]> {
    return this.fees.listSchedules();
  }

  @Get('fee-schedules/:id')
  @RequirePermission('fin-001:read')
  @ApiOperation({ summary: 'Get a single fee schedule' })
  async getScheduleById(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FeeScheduleResponseDto> {
    return this.fees.getScheduleById(id);
  }

  @Post('fee-schedules')
  @RequirePermission('fin-001:admin')
  @ApiOperation({ summary: 'Create a fee schedule (admin only)' })
  async createSchedule(
    @Body() body: CreateFeeScheduleDto,
    @Req() req: AuthedRequest,
  ): Promise<FeeScheduleResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.fees.createSchedule(body, actor);
  }

  @Patch('fee-schedules/:id')
  @RequirePermission('fin-001:admin')
  @ApiOperation({ summary: 'Patch a fee schedule (admin only)' })
  async updateSchedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateFeeScheduleDto,
    @Req() req: AuthedRequest,
  ): Promise<FeeScheduleResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.fees.updateSchedule(id, body, actor);
  }
}
