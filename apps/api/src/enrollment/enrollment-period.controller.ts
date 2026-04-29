import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { EnrollmentPeriodService } from './enrollment-period.service';
import {
  CreateAdmissionStreamDto,
  CreateEnrollmentPeriodDto,
  CreateIntakeCapacityDto,
  EnrollmentPeriodResponseDto,
  UpdateEnrollmentPeriodDto,
} from './dto/enrollment-period.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Enrollment Periods')
@ApiBearerAuth()
@Controller('enrollment-periods')
export class EnrollmentPeriodController {
  constructor(
    private readonly periods: EnrollmentPeriodService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('stu-003:read')
  @ApiOperation({ summary: 'List enrollment periods (with streams + capacities + summary)' })
  async list(): Promise<EnrollmentPeriodResponseDto[]> {
    return this.periods.list();
  }

  @Get(':id')
  @RequirePermission('stu-003:read')
  @ApiOperation({ summary: 'Get an enrollment period with streams + capacities + summary' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<EnrollmentPeriodResponseDto> {
    return this.periods.getById(id);
  }

  @Post()
  @RequirePermission('stu-003:admin')
  @ApiOperation({ summary: 'Create an enrollment period (admin only)' })
  async create(
    @Body() body: CreateEnrollmentPeriodDto,
    @Req() req: AuthedRequest,
  ): Promise<EnrollmentPeriodResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.periods.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('stu-003:admin')
  @ApiOperation({ summary: 'Patch an enrollment period (admin only)' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateEnrollmentPeriodDto,
    @Req() req: AuthedRequest,
  ): Promise<EnrollmentPeriodResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.periods.update(id, body, actor);
  }

  @Post(':id/streams')
  @RequirePermission('stu-003:admin')
  @ApiOperation({ summary: 'Create an admission stream on the period (admin only)' })
  async createStream(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateAdmissionStreamDto,
    @Req() req: AuthedRequest,
  ): Promise<EnrollmentPeriodResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.periods.createStream(id, body, actor);
  }

  @Post(':id/capacities')
  @RequirePermission('stu-003:admin')
  @ApiOperation({ summary: 'Create an intake capacity on the period (admin only)' })
  async createCapacity(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateIntakeCapacityDto,
    @Req() req: AuthedRequest,
  ): Promise<EnrollmentPeriodResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.periods.createCapacity(id, body, actor);
  }
}
