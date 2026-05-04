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
import { IepPlanService } from './iep-plan.service';
import {
  CreateAccommodationDto,
  CreateGoalProgressDto,
  CreateIepGoalDto,
  CreateIepPlanDto,
  CreateIepServiceDto,
  IepAccommodationResponseDto,
  IepGoalProgressResponseDto,
  IepGoalResponseDto,
  IepPlanResponseDto,
  IepServiceResponseDto,
  UpdateAccommodationDto,
  UpdateIepGoalDto,
  UpdateIepPlanDto,
  UpdateIepServiceDto,
} from './dto/health.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Health IEP / 504 Plans')
@ApiBearerAuth()
@Controller()
export class IepPlanController {
  constructor(
    private readonly plans: IepPlanService,
    private readonly actors: ActorContextService,
  ) {}

  // ─── Plan ──────────────────────────────────────────────────

  @Get('health/students/:studentId/iep')
  @RequirePermission('hlt-001:read')
  @ApiOperation({
    summary:
      'Get the active IEP/504 plan for a student with inlined goals + services + accommodations + per-goal progress timeline. Returns 200 with null body when no non-EXPIRED plan exists. Service-layer 403 for teachers (they read accommodations via sis_student_active_accommodations); parent and counsellor/admin/nurse see full detail. Writes a VIEW_IEP audit row.',
  })
  async get(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<IepPlanResponseDto | null> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.plans.getForStudent(studentId, actor);
  }

  @Post('health/students/:studentId/iep')
  @RequirePermission('hlt-001:write')
  @ApiOperation({
    summary:
      "Create a new DRAFT IEP/504 plan for a student. Nurse / counsellor / admin only. Schema's partial UNIQUE on (student_id) WHERE status<>'EXPIRED' rejects a 2nd non-EXPIRED plan with a friendly 400.",
  })
  async create(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Body() body: CreateIepPlanDto,
    @Req() req: AuthedRequest,
  ): Promise<IepPlanResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.plans.create(studentId, body, actor);
  }

  @Patch('health/iep-plans/:id')
  @RequirePermission('hlt-001:write')
  @ApiOperation({
    summary:
      'Update IEP plan — status transitions (DRAFT/ACTIVE/REVIEW/EXPIRED) and dates. Locks the row FOR UPDATE inside a tenant transaction. On status change, re-emits iep.accommodation.updated so the read model re-syncs (EXPIRED plans contribute no accommodations).',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateIepPlanDto,
    @Req() req: AuthedRequest,
  ): Promise<IepPlanResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.plans.update(id, body, actor);
  }

  // ─── Goals ─────────────────────────────────────────────────

  @Post('health/iep-plans/:id/goals')
  @RequirePermission('hlt-001:write')
  @ApiOperation({
    summary: 'Add a measurable goal to an IEP plan. Nurse / counsellor / admin only.',
  })
  async addGoal(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateIepGoalDto,
    @Req() req: AuthedRequest,
  ): Promise<IepGoalResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.plans.addGoal(id, body, actor);
  }

  @Patch('health/iep-goals/:id')
  @RequirePermission('hlt-001:write')
  @ApiOperation({
    summary:
      'Update an IEP goal — text, current_value, status (ACTIVE/MET/NOT_MET/DISCONTINUED). Nurse / counsellor / admin only.',
  })
  async updateGoal(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateIepGoalDto,
    @Req() req: AuthedRequest,
  ): Promise<IepGoalResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.plans.updateGoal(id, body, actor);
  }

  @Post('health/iep-goals/:id/progress')
  @RequirePermission('hlt-001:write')
  @ApiOperation({
    summary:
      'Append a progress entry to an IEP goal. Append-only audit history. Stamps recorded_by from actor.employeeId — refuses callers without an hr_employees row.',
  })
  async addGoalProgress(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateGoalProgressDto,
    @Req() req: AuthedRequest,
  ): Promise<IepGoalProgressResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.plans.addGoalProgress(id, body, actor);
  }

  // ─── Services ──────────────────────────────────────────────

  @Post('health/iep-plans/:id/services')
  @RequirePermission('hlt-001:write')
  @ApiOperation({
    summary:
      'Add a related service (speech / OT / counselling) to an IEP plan. delivery_method enum: PULL_OUT / PUSH_IN / CONSULT.',
  })
  async addService(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateIepServiceDto,
    @Req() req: AuthedRequest,
  ): Promise<IepServiceResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.plans.addService(id, body, actor);
  }

  @Patch('health/iep-services/:id')
  @RequirePermission('hlt-001:write')
  @ApiOperation({ summary: 'Update an IEP service. Nurse / counsellor / admin only.' })
  async updateService(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateIepServiceDto,
    @Req() req: AuthedRequest,
  ): Promise<IepServiceResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.plans.updateService(id, body, actor);
  }

  // ─── Accommodations (the keystone for ADR-030 emit) ─────────

  @Post('health/iep-plans/:id/accommodations')
  @RequirePermission('hlt-001:write')
  @ApiOperation({
    summary:
      'Add an accommodation. applies_to enum: ALL_ASSESSMENTS / ALL_ASSIGNMENTS / SPECIFIC. SPECIFIC requires a non-empty specificAssignmentTypes array. Emits iep.accommodation.updated with the full post-mutation accommodation set so the IepAccommodationConsumer reconciles sis_student_active_accommodations.',
  })
  async addAccommodation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateAccommodationDto,
    @Req() req: AuthedRequest,
  ): Promise<IepAccommodationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.plans.addAccommodation(id, body, actor);
  }

  @Patch('health/iep-accommodations/:id')
  @RequirePermission('hlt-001:write')
  @ApiOperation({
    summary:
      'Update an accommodation. Re-emits iep.accommodation.updated so the read model re-syncs.',
  })
  async updateAccommodation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateAccommodationDto,
    @Req() req: AuthedRequest,
  ): Promise<IepAccommodationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.plans.updateAccommodation(id, body, actor);
  }

  @Delete('health/iep-accommodations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('hlt-001:write')
  @ApiOperation({
    summary:
      'Delete an accommodation. Re-emits iep.accommodation.updated so the consumer drops the matching read-model row.',
  })
  async removeAccommodation(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    await this.plans.removeAccommodation(id, actor);
  }
}
