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
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { BehaviorPlanService } from './behavior-plan.service';
import {
  BehaviorPlanResponseDto,
  CreateBehaviorPlanDto,
  ListBehaviorPlansQueryDto,
  UpdateBehaviorPlanDto,
} from './dto/behavior-plan.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Behavior Plans')
@ApiBearerAuth()
@Controller('behavior-plans')
export class BehaviorPlanController {
  constructor(
    private readonly plans: BehaviorPlanService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('beh-002:read')
  @ApiOperation({
    summary:
      'List BIPs/BSPs/Safety Plans visible to the caller. Counsellors + admins see all; teachers see plans for students in their classes; parents and students do not reach this endpoint.',
  })
  async list(
    @Query() query: ListBehaviorPlansQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<BehaviorPlanResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.plans.list(query, actor);
  }

  @Get(':id')
  @RequirePermission('beh-002:read')
  @ApiOperation({ summary: 'Fetch one plan with goals + feedback inlined.' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<BehaviorPlanResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.plans.getById(id, actor);
  }

  @Post()
  @RequirePermission('beh-002:write')
  @ApiOperation({
    summary:
      'Create a new behaviour plan. Counsellor/admin only. Defaults to status=DRAFT. Validates the optional source_incident_id soft ref.',
  })
  async create(
    @Body() body: CreateBehaviorPlanDto,
    @Req() req: AuthedRequest,
  ): Promise<BehaviorPlanResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.plans.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('beh-002:write')
  @ApiOperation({
    summary:
      'Update strategies, review_date, or transition between DRAFT and REVIEW. Use /activate to flip into ACTIVE and /expire to retire a plan.',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateBehaviorPlanDto,
    @Req() req: AuthedRequest,
  ): Promise<BehaviorPlanResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.plans.update(id, body, actor);
  }

  @Patch(':id/activate')
  @RequirePermission('beh-002:write')
  @ApiOperation({
    summary:
      'DRAFT → ACTIVE. Locks the plan row + verifies no other ACTIVE plan exists for the same (student, plan_type) before flip per the partial UNIQUE keystone.',
  })
  async activate(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<BehaviorPlanResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.plans.activate(id, actor);
  }

  @Patch(':id/expire')
  @RequirePermission('beh-002:write')
  @ApiOperation({
    summary:
      'ACTIVE | REVIEW | DRAFT → EXPIRED. Terminal state; partial UNIQUE on the ACTIVE filter releases on flip.',
  })
  async expire(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<BehaviorPlanResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.plans.expire(id, actor);
  }
}
