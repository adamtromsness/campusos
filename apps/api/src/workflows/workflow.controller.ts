import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { WorkflowEngineService } from './workflow-engine.service';
import {
  ApprovalCommentResponseDto,
  ApprovalRequestResponseDto,
  CreateCommentDto,
  ListApprovalsQueryDto,
  ReviewStepDto,
  SubmitApprovalDto,
} from './dto/workflow.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Approvals')
@ApiBearerAuth()
@Controller('approvals')
export class WorkflowController {
  constructor(
    private readonly engine: WorkflowEngineService,
    private readonly actors: ActorContextService,
  ) {}

  @Post()
  @RequirePermission('ops-001:write')
  @ApiOperation({
    summary:
      'Submit a new approval request. Engine selects the active workflow template by request_type and activates Step 1.',
  })
  async submit(
    @Body() body: SubmitApprovalDto,
    @Req() req: AuthedRequest,
  ): Promise<ApprovalRequestResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.engine.submit(body, actor);
  }

  @Get()
  @RequirePermission('ops-001:read')
  @ApiOperation({
    summary:
      'List approval requests visible to the caller. Default scope: own + rows where I am a current/past approver. Admin sees all unless ?mine=true.',
  })
  async list(
    @Query() query: ListApprovalsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<ApprovalRequestResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.engine.list(query, actor);
  }

  @Get(':id')
  @RequirePermission('ops-001:read')
  @ApiOperation({ summary: 'Fetch one approval request with its step history and comments.' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ApprovalRequestResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.engine.getById(id, actor);
  }

  @Post(':id/steps/:stepId/approve')
  @RequirePermission('ops-001:write')
  @ApiOperation({
    summary:
      'Approve an awaiting step. Activates the next step or resolves the request as APPROVED.',
  })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stepId', ParseUUIDPipe) stepId: string,
    @Body() body: ReviewStepDto,
    @Req() req: AuthedRequest,
  ): Promise<ApprovalRequestResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.engine.advanceStep(id, stepId, 'APPROVED', body.comments, actor);
  }

  @Post(':id/steps/:stepId/reject')
  @RequirePermission('ops-001:write')
  @ApiOperation({
    summary:
      'Reject an awaiting step. Resolves the request as REJECTED and skips remaining steps.',
  })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stepId', ParseUUIDPipe) stepId: string,
    @Body() body: ReviewStepDto,
    @Req() req: AuthedRequest,
  ): Promise<ApprovalRequestResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.engine.advanceStep(id, stepId, 'REJECTED', body.comments, actor);
  }

  @Post(':id/comments')
  @RequirePermission('ops-001:write')
  @ApiOperation({ summary: 'Append a comment to the request thread.' })
  async addComment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateCommentDto,
    @Req() req: AuthedRequest,
  ): Promise<ApprovalCommentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.engine.addComment(
      id,
      body.body,
      body.isRequesterVisible !== false,
      actor,
    );
  }

  @Post(':id/withdraw')
  @RequirePermission('ops-001:write')
  @ApiOperation({
    summary:
      'Requester pulls back a still-PENDING request. Skips remaining steps; does NOT emit approval.request.resolved.',
  })
  async withdraw(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ApprovalRequestResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.engine.withdraw(id, actor);
  }
}
