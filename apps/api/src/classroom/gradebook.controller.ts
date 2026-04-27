import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { GradebookService } from './gradebook.service';
import {
  GradebookClassResponseDto,
  GradebookQueryDto,
  GradebookStudentResponseDto,
} from './dto/gradebook.dto';
import { StudentClassGradesResponseDto } from './dto/student-grades.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Classroom — Gradebook')
@ApiBearerAuth()
@Controller()
export class GradebookController {
  constructor(
    private readonly gradebook: GradebookService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('classes/:classId/gradebook')
  @RequirePermission('tch-003:write')
  @ApiOperation({
    summary:
      'Class gradebook (teacher / admin view). One row per actively-enrolled student joined to ' +
      'the gradebook snapshot for the resolved term. Term defaults to the current term. ' +
      'Permission and row-scope are both gated to managers only — students and parents must ' +
      'use /students/:studentId/gradebook or /students/:studentId/classes/:classId/grades.',
  })
  async getClassGradebook(
    @Param('classId', ParseUUIDPipe) classId: string,
    @Query() query: GradebookQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<GradebookClassResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.gradebook.getClassGradebook(classId, query.termId, actor);
  }

  @Get('students/:studentId/gradebook')
  @RequirePermission('tch-003:read')
  @ApiOperation({
    summary:
      'Per-student gradebook (student / parent / teacher view). Row-scoped: students see ' +
      'themselves, parents see linked children, teachers see students they teach.',
  })
  async getStudentGradebook(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Query() query: GradebookQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<GradebookStudentResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.gradebook.getStudentGradebook(studentId, query.termId, actor);
  }

  @Get('students/:studentId/classes/:classId/grades')
  @RequirePermission('tch-003:read')
  @ApiOperation({
    summary:
      'Per-class assignment-by-assignment breakdown for one student. Drives the student /grades ' +
      "view and the parent's per-child class breakdown. Non-managers (students / parents) only " +
      'see published assignments and published grades.',
  })
  async getStudentClassGrades(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Param('classId', ParseUUIDPipe) classId: string,
    @Req() req: AuthedRequest,
  ): Promise<StudentClassGradesResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.gradebook.getStudentClassGrades(studentId, classId, actor);
  }
}
