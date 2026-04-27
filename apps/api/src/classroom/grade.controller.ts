import { Body, Controller, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { GradeService } from './grade.service';
import {
  BatchGradeRequestDto,
  BatchGradeResponseDto,
  GradeResponseDto,
  GradeSubmissionDto,
  PublishAllResponseDto,
} from './dto/grade.dto';
import { IsUUID } from 'class-validator';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

class PublishAllBodyDto {
  @IsUUID()
  assignmentId!: string;
}

@ApiTags('Classroom — Grades')
@ApiBearerAuth()
@Controller()
export class GradeController {
  constructor(
    private readonly grades: GradeService,
    private readonly actors: ActorContextService,
  ) {}

  @Post('submissions/:id/grade')
  @RequirePermission('tch-003:write')
  @ApiOperation({
    summary:
      'Grade a submission (teacher-of-class or admin). Upserts cls_grades by (assignment, ' +
      'student); flips the linked submission to GRADED. Set publish=true to emit cls.grade.published.',
  })
  async gradeSubmission(
    @Param('id', ParseUUIDPipe) submissionId: string,
    @Body() body: GradeSubmissionDto,
    @Req() req: AuthedRequest,
  ): Promise<GradeResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.grades.gradeSubmission(submissionId, body, actor);
  }

  @Post('classes/:classId/grades/batch')
  @RequirePermission('tch-003:write')
  @ApiOperation({
    summary:
      'Batch-grade an assignment for multiple students in a single transaction. Each entry ' +
      'upserts (assignment, student); set publish=true to publish the whole batch and emit ' +
      'cls.grade.published per row.',
  })
  async batchGrade(
    @Param('classId', ParseUUIDPipe) classId: string,
    @Body() body: BatchGradeRequestDto,
    @Req() req: AuthedRequest,
  ): Promise<BatchGradeResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.grades.batchGrade(classId, body, actor);
  }

  @Post('grades/:id/publish')
  @RequirePermission('tch-003:write')
  @ApiOperation({
    summary:
      'Publish a single grade (idempotent — republishing is a no-op). Emits cls.grade.published ' +
      'only on the draft → published transition.',
  })
  async publish(
    @Param('id', ParseUUIDPipe) gradeId: string,
    @Req() req: AuthedRequest,
  ): Promise<GradeResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.grades.publish(gradeId, actor);
  }

  @Post('grades/:id/unpublish')
  @RequirePermission('tch-003:write')
  @ApiOperation({
    summary:
      'Unpublish a grade — sets is_published=false and emits cls.grade.unpublished so the ' +
      "snapshot worker recomputes the student's average.",
  })
  async unpublish(
    @Param('id', ParseUUIDPipe) gradeId: string,
    @Req() req: AuthedRequest,
  ): Promise<GradeResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.grades.unpublish(gradeId, actor);
  }

  @Post('classes/:classId/grades/publish-all')
  @RequirePermission('tch-003:write')
  @ApiOperation({
    summary:
      'Publish every draft grade for a single assignment (assignmentId in the body). One ' +
      'cls.grade.published event per row that transitioned from draft to published.',
  })
  async publishAll(
    @Param('classId', ParseUUIDPipe) classId: string,
    @Body() body: PublishAllBodyDto,
    @Req() req: AuthedRequest,
  ): Promise<PublishAllResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.grades.publishAllForAssignment(classId, body.assignmentId, actor);
  }
}
