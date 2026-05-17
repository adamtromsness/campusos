import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { StandardGradeService } from './standard-grade.service';
import {
  AddEvidenceDto,
  ClassStandardsReportDto,
  CreateStandardGradeDto,
  StandardGradeEvidenceResponseDto,
  StandardGradeResponseDto,
  UpdateStandardGradeDto,
} from './dto/standard-grade.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Classroom Advanced — Standards-Based Gradebook')
@ApiBearerAuth()
@Controller('classroom')
export class StandardGradeController {
  constructor(
    private readonly standardGrades: StandardGradeService,
    private readonly actors: ActorContextService,
  ) {}

  @Post('standard-grades')
  @RequirePermission('tch-003:write')
  @ApiOperation({
    summary:
      'Rate a student against a Cycle 23 standard. UPSERT keyed on (student_id, standard_id, class_id) so re-rating the same triple updates the existing row in-place. Validates the standard_id resolves to either tenant cur_standards or platform.cur_standards_platform.',
  })
  async upsert(
    @Body() body: CreateStandardGradeDto,
    @Req() req: AuthedRequest,
  ): Promise<StandardGradeResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.standardGrades.upsert(body, actor);
  }

  @Get('students/:studentId/standard-grades')
  @RequirePermission('tch-003:read')
  @ApiOperation({
    summary: 'Proficiency profile across all standards for a student.',
  })
  async listForStudent(
    @Param('studentId', ParseUUIDPipe) studentId: string,
  ): Promise<StandardGradeResponseDto[]> {
    return this.standardGrades.listForStudent(studentId);
  }

  @Get('standard-grades/:id')
  @RequirePermission('tch-003:read')
  @ApiOperation({ summary: 'Fetch a single standard grade with linked evidence inlined.' })
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<StandardGradeResponseDto> {
    return this.standardGrades.getById(id);
  }

  @Patch('standard-grades/:id')
  @RequirePermission('tch-003:write')
  @ApiOperation({
    summary:
      'Update proficiency level or notes for a standard grade. assessed_by + assessed_at refresh on every level change.',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateStandardGradeDto,
    @Req() req: AuthedRequest,
  ): Promise<StandardGradeResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.standardGrades.update(id, body, actor);
  }

  @Post('standard-grades/:id/evidence')
  @RequirePermission('tch-003:write')
  @ApiOperation({
    summary:
      'Link evidence to a proficiency rating. evidenceRefId is required for SUBMISSION (cls_submissions.id) + ASSESSMENT (cls_grades.id). Optional for OBSERVATION + TEACHER_NOTE.',
  })
  async addEvidence(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AddEvidenceDto,
    @Req() req: AuthedRequest,
  ): Promise<StandardGradeEvidenceResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.standardGrades.addEvidence(id, body, actor);
  }

  @Get('classes/:id/standards-report')
  @RequirePermission('tch-003:read')
  @ApiOperation({
    summary:
      'Class-wide proficiency heatmap. Returns one row per (student, standard) cell plus aggregate counts per standard for the heatmap legend. Caller must teach the class (admins bypass).',
  })
  async classReport(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ClassStandardsReportDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.standardGrades.classReport(id, actor);
  }
}
