import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { FeedbackService } from './feedback.service';
import {
  FeedbackResponseDto,
  RequestFeedbackDto,
  SubmitFeedbackDto,
} from './dto/behavior-plan.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Behavior Plan Feedback')
@ApiBearerAuth()
@Controller()
export class FeedbackController {
  constructor(
    private readonly feedback: FeedbackService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('behavior-plans/:id/feedback')
  @RequirePermission('beh-002:read')
  @ApiOperation({
    summary:
      'List feedback rows for a plan (pending + submitted). Staff/counsellor/admin only — guardians and students always receive an empty array. Parent BIP summaries never include teacher feedback (REVIEW-CYCLE9 BLOCKING).',
  })
  async list(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<FeedbackResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.feedback.listForPlan(id, actor);
  }

  @Post('behavior-plans/:id/feedback-requests')
  @RequirePermission('beh-002:write')
  @ApiOperation({
    summary:
      'Counsellor opens a pending feedback request for a teacher on a BIP. Emits beh.bip.feedback_requested with recipientAccountId for the Cycle 7 TaskWorker fan-out.',
  })
  async request(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RequestFeedbackDto,
    @Req() req: AuthedRequest,
  ): Promise<FeedbackResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.feedback.requestFeedback(id, body, actor);
  }

  @Get('bip-feedback/pending')
  @RequirePermission('beh-002:read')
  @ApiOperation({
    summary:
      "Teacher's pending feedback queue. Row-scoped to actor.employeeId for non-counsellors; counsellors and admins see all pending across the tenant.",
  })
  async pending(@Req() req: AuthedRequest): Promise<FeedbackResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.feedback.listPending(actor);
  }

  @Patch('bip-feedback/:id')
  @RequirePermission('beh-002:read')
  @ApiOperation({
    summary:
      "Teacher submits their feedback on a BIP. Gated on beh-002:read plus row-scope (caller's employeeId === row.teacher_id) — counsellors and admins can override.",
  })
  async submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SubmitFeedbackDto,
    @Req() req: AuthedRequest,
  ): Promise<FeedbackResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.feedback.submit(id, body, actor);
  }
}
