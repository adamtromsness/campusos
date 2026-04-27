import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { SubmissionService } from './submission.service';
import {
  SubmissionResponseDto,
  SubmitAssignmentDto,
  TeacherSubmissionListResponseDto,
} from './dto/submission.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Classroom — Submissions')
@ApiBearerAuth()
@Controller()
export class SubmissionController {
  constructor(
    private readonly submissions: SubmissionService,
    private readonly actors: ActorContextService,
  ) {}

  @Post('assignments/:assignmentId/submit')
  @RequirePermission('tch-002:write')
  @ApiOperation({
    summary:
      'Student submits (or resubmits) their work for an assignment. Idempotent upsert by ' +
      '(assignment_id, student_id). Resubmitting overwrites text/attachments and resets status ' +
      "to 'SUBMITTED'. Emits cls.submission.submitted.",
  })
  async submit(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() body: SubmitAssignmentDto,
    @Req() req: AuthedRequest,
  ): Promise<SubmissionResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.submissions.submit(assignmentId, body, actor);
  }

  @Get('assignments/:assignmentId/submissions')
  @RequirePermission('tch-002:read')
  @ApiOperation({
    summary:
      'Teacher / admin view: roster + submissions for the assignment. Students who have not ' +
      'submitted appear as NOT_STARTED rows (no row id). Forbidden for students / parents.',
  })
  async listForAssignment(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Req() req: AuthedRequest,
  ): Promise<TeacherSubmissionListResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.submissions.listForAssignment(assignmentId, actor);
  }

  @Get('assignments/:assignmentId/submissions/mine')
  @RequirePermission('tch-002:read')
  @ApiOperation({
    summary:
      "Student view: returns the calling student's submission for this assignment, or null if " +
      'they have not submitted yet. Available only to STUDENT callers.',
  })
  async listMine(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Req() req: AuthedRequest,
  ): Promise<SubmissionResponseDto | null> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.submissions.listMineForAssignment(assignmentId, actor);
  }

  @Get('submissions/:id')
  @RequirePermission('tch-002:read')
  @ApiOperation({
    summary:
      'Single submission lookup (row-scoped). Visible to admins, the teacher of the class, ' +
      'and the owning student / linked guardian.',
  })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<SubmissionResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.submissions.getById(id, actor);
  }
}
