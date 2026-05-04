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
import { GoalService } from './goal.service';
import { CreateGoalDto, GoalResponseDto, UpdateGoalDto } from './dto/behavior-plan.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Behavior Plan Goals')
@ApiBearerAuth()
@Controller()
export class GoalController {
  constructor(
    private readonly goals: GoalService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('behavior-plans/:id/goals')
  @RequirePermission('beh-002:read')
  @ApiOperation({ summary: 'List goals on a plan. Visibility flows through the parent plan.' })
  async list(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<GoalResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.goals.listForPlan(id, actor);
  }

  @Post('behavior-plans/:id/goals')
  @RequirePermission('beh-002:write')
  @ApiOperation({ summary: 'Add a measurable goal to a plan. Counsellor/admin only.' })
  async create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateGoalDto,
    @Req() req: AuthedRequest,
  ): Promise<GoalResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.goals.create(id, body, actor);
  }

  @Patch('behavior-plan-goals/:id')
  @RequirePermission('beh-002:write')
  @ApiOperation({
    summary:
      'Update a goal. When progress transitions away from NOT_STARTED, last_assessed_at is bumped to today.',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateGoalDto,
    @Req() req: AuthedRequest,
  ): Promise<GoalResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.goals.update(id, body, actor);
  }

  @Delete('behavior-plan-goals/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('beh-002:write')
  @ApiOperation({ summary: 'Delete a goal. Refused on EXPIRED plans (audit trail).' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest): Promise<void> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    await this.goals.remove(id, actor);
  }
}
