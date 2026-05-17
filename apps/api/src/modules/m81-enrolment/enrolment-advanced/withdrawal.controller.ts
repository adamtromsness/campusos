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
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import {
  CancelWithdrawalDto,
  CompleteWithdrawalDto,
  CreateWithdrawalDto,
  ExitTaskResponseDto,
  PlaceReenrolHoldDto,
  TaskCategory,
  UpdateExitTaskDto,
  WithdrawalResponseDto,
} from './dto/withdrawal.dto';
import { ExitTaskService } from './exit-task.service';
import { WithdrawalService } from './withdrawal.service';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Enrolment Withdrawal')
@ApiBearerAuth()
@Controller('enrolment')
export class WithdrawalController {
  constructor(
    private readonly withdrawals: WithdrawalService,
    private readonly exitTasks: ExitTaskService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('withdrawals')
  @RequirePermission('stu-004:read')
  @ApiOperation({
    summary:
      'List withdrawals (admin: school-wide; parent: own children only via sis_student_guardians).',
  })
  async list(
    @Req() req: AuthedRequest,
    @Query('status') status?: string,
  ): Promise<WithdrawalResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.withdrawals.list(actor, status);
  }

  @Get('withdrawals/:id')
  @RequirePermission('stu-004:read')
  @ApiOperation({ summary: 'Get a single withdrawal with exit tasks inlined.' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<WithdrawalResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.withdrawals.getById(id, actor);
  }

  @Post('withdrawals')
  @RequirePermission('stu-004:write')
  @ApiOperation({
    summary:
      'Initiate a withdrawal — auto-creates the per-school exit task checklist from the configured template.',
  })
  async create(
    @Body() body: CreateWithdrawalDto,
    @Req() req: AuthedRequest,
  ): Promise<WithdrawalResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.withdrawals.create(body, actor);
  }

  @Patch('withdrawals/:id/complete')
  @RequirePermission('stu-004:admin')
  @ApiOperation({
    summary:
      'Complete a withdrawal — refuses unless every exit task is COMPLETED, WAIVED, or NOT_APPLICABLE. Flips sis_students.enrollment_status to WITHDRAWN and emits enr.student.withdrawn AFTER tx commits.',
  })
  async complete(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CompleteWithdrawalDto,
    @Req() req: AuthedRequest,
  ): Promise<WithdrawalResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.withdrawals.complete(id, body, actor);
  }

  @Patch('withdrawals/:id/cancel')
  @RequirePermission('stu-004:write')
  @ApiOperation({ summary: 'Cancel a withdrawal — admin or original requester only.' })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelWithdrawalDto,
    @Req() req: AuthedRequest,
  ): Promise<WithdrawalResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.withdrawals.cancel(id, body, actor);
  }

  @Patch('withdrawals/:id/reenrol-hold')
  @RequirePermission('stu-004:admin')
  @ApiOperation({
    summary:
      'Place or lift a re-enrolment hold (admin only). Hold blocks future re-enrolment confirmations + new applications.',
  })
  async placeHold(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PlaceReenrolHoldDto,
    @Req() req: AuthedRequest,
  ): Promise<WithdrawalResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.withdrawals.placeReenrolHold(id, body, actor);
  }

  // ============================================================
  // Exit task endpoints
  // ============================================================

  @Get('exit-tasks/my-department')
  @RequirePermission('stu-004:read')
  @ApiOperation({
    summary:
      'List PENDING exit tasks across the school. Optional category filter narrows to a specific department.',
  })
  async listMyDepartment(
    @Req() req: AuthedRequest,
    @Query('category') category?: TaskCategory,
  ): Promise<ExitTaskResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.exitTasks.listPending(actor, category);
  }

  @Patch('exit-tasks/:id')
  @RequirePermission('stu-004:write')
  @ApiOperation({
    summary:
      'Department staff marks an exit task COMPLETED, WAIVED, NOT_APPLICABLE, or back to PENDING. Refuses on COMPLETED / CANCELLED parent withdrawals.',
  })
  async patchTask(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateExitTaskDto,
    @Req() req: AuthedRequest,
  ): Promise<ExitTaskResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.exitTasks.patch(id, body, actor);
  }
}
