import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { OnboardingService } from './onboarding.service';
import {
  CompleteTaskDto,
  CreateChecklistDto,
  OnboardingChecklistResponseDto,
  StudentOnboardingProgressResponseDto,
  TaskCompletionResponseDto,
} from './dto/cycle16.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Enrollment / Cycle 16')
@Controller()
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly actors: ActorContextService,
  ) {}

  // ── Checklist templates (admin-managed catalogue) ──

  @Get('onboarding-checklists')
  @RequirePermission('stu-003:read')
  @ApiOperation({ summary: 'List onboarding checklist templates for the school.' })
  listChecklists(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<OnboardingChecklistResponseDto[]> {
    return this.onboarding.listChecklists(includeInactive === 'true');
  }

  @Get('onboarding-checklists/:id')
  @RequirePermission('stu-003:read')
  @ApiOperation({ summary: 'Get a checklist template with its tasks inlined.' })
  getChecklist(@Param('id') id: string): Promise<OnboardingChecklistResponseDto> {
    return this.onboarding.getChecklist(id);
  }

  @Post('onboarding-checklists')
  @RequirePermission('stu-003:admin')
  @ApiOperation({
    summary:
      'Create a checklist template + its task templates atomically. School admin only. UNIQUE(school, name, admission_type) — duplicates → 400.',
  })
  async createChecklist(
    @Body() body: CreateChecklistDto,
    @Req() req: AuthedRequest,
  ): Promise<OnboardingChecklistResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.onboarding.createChecklist(body, actor);
  }

  // ── Per-application onboarding progress ──

  @Get('applications/:applicationId/onboarding')
  @RequirePermission('stu-003:read')
  @ApiOperation({
    summary:
      "Get the onboarding progress row for an application (with task completions inlined). Admin/EO see all; guardian sees own children's applications only; everyone else gets a collapsed 404 (REVIEW-CYCLE16 BLOCKING 1). Returns null when no row exists yet.",
  })
  async getProgressForApplication(
    @Param('applicationId') applicationId: string,
    @Req() req: AuthedRequest,
  ): Promise<StudentOnboardingProgressResponseDto | null> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.onboarding.getProgressForApplication(applicationId, actor);
  }

  @Get('onboarding-progress/:id')
  @RequirePermission('stu-003:read')
  @ApiOperation({
    summary:
      'Get an onboarding progress row by id (with task completions inlined). Same row-scope contract as the per-application read (REVIEW-CYCLE16 BLOCKING 1).',
  })
  async getProgress(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<StudentOnboardingProgressResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.onboarding.getProgress(id, actor);
  }

  @Post('onboarding-task-completions/:id/complete')
  @RequirePermission('stu-003:write')
  @ApiOperation({
    summary:
      'Mark a task as COMPLETED. Bumps tasks_completed and, when the last mandatory task lands, flips overall_status=COMPLETE atomically and emits enr.student.onboarded.',
  })
  async complete(
    @Param('id') id: string,
    @Body() body: CompleteTaskDto,
    @Req() req: AuthedRequest,
  ): Promise<{
    completion: TaskCompletionResponseDto;
    progress: StudentOnboardingProgressResponseDto;
    onboarded: boolean;
  }> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.onboarding.completeTask(id, body, actor);
  }

  @Post('onboarding-task-completions/:id/waive')
  @RequirePermission('stu-003:admin')
  @ApiOperation({
    summary:
      'Waive a task — counts toward tasks_completed but flagged as WAIVED in audit. Admin only. Reuses the same lifecycle path as /complete: bumps tasks_completed, flips overall_status=COMPLETE when the last mandatory task lands, emits enr.student.onboarded (REVIEW-CYCLE16 BLOCKING 2).',
  })
  async waive(
    @Param('id') id: string,
    @Body() body: CompleteTaskDto,
    @Req() req: AuthedRequest,
  ): Promise<{
    completion: TaskCompletionResponseDto;
    progress: StudentOnboardingProgressResponseDto;
    onboarded: boolean;
  }> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.onboarding.waiveTask(id, body, actor);
  }
}
