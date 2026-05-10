import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { FormativeAssessmentService } from './formative-assessment.service';
import {
  CreateFormativeAssessmentDto,
  FormativeAssessmentResponseDto,
  FormativeResponseRowDto,
  FormativeResultsDto,
  SubmitFormativeResponseDto,
  UpdateFormativeAssessmentDto,
} from './dto/formative-assessment.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Classroom Advanced — Formative Assessment')
@ApiBearerAuth()
@Controller('classroom')
export class FormativeAssessmentController {
  constructor(
    private readonly formative: FormativeAssessmentService,
    private readonly actors: ActorContextService,
  ) {}

  @Post('formative-assessments')
  @RequirePermission('tch-002:write')
  @ApiOperation({
    summary:
      'Create a formative assessment in DRAFT (is_active=false). assessment_type 4-value CHECK EXIT_TICKET / POLL / QUICK_CHECK / DO_NOW. questions JSONB array shape — {questionId, prompt, responseType, options}.',
  })
  async create(
    @Body() body: CreateFormativeAssessmentDto,
    @Req() req: AuthedRequest,
  ): Promise<FormativeAssessmentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.formative.create(body, actor);
  }

  @Get('classes/:id/formative-assessments')
  @RequirePermission('tch-002:read')
  @ApiOperation({
    summary:
      'List formative assessments for a class. Students see ACTIVE only — staff and admins see every state.',
  })
  async listForClass(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<FormativeAssessmentResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.formative.listForClass(id, actor);
  }

  @Get('formative-assessments/:id')
  @RequirePermission('tch-002:read')
  @ApiOperation({ summary: 'Fetch a formative assessment.' })
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<FormativeAssessmentResponseDto> {
    return this.formative.getById(id);
  }

  @Patch('formative-assessments/:id')
  @RequirePermission('tch-002:write')
  @ApiOperation({
    summary:
      'Update a formative assessment. Refused once is_active=true — close it first, or create a new one.',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateFormativeAssessmentDto,
    @Req() req: AuthedRequest,
  ): Promise<FormativeAssessmentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.formative.update(id, body, actor);
  }

  @Patch('formative-assessments/:id/activate')
  @RequirePermission('tch-002:write')
  @ApiOperation({
    summary:
      'Open the assessment for student responses. The multi-column active_chk keeps is_active=true + activated_at NOT NULL + closed_at NULL atomic.',
  })
  async activate(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<FormativeAssessmentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.formative.activate(id, actor);
  }

  @Patch('formative-assessments/:id/close')
  @RequirePermission('tch-002:write')
  @ApiOperation({ summary: 'Close the assessment to new responses.' })
  async close(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<FormativeAssessmentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.formative.close(id, actor);
  }

  @Post('formative-assessments/:id/respond')
  @RequirePermission('tch-002:read')
  @ApiOperation({
    summary:
      'Student submits a response. UPSERT keyed on (assessment_id, student_id) via UNIQUE keystone — re-submitting overwrites the prior response. Refuses non-active assessments and non-enrolled students.',
  })
  async respond(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SubmitFormativeResponseDto,
    @Req() req: AuthedRequest,
  ): Promise<FormativeResponseRowDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.formative.submitResponse(id, body, actor);
  }

  @Get('formative-assessments/:id/results')
  @RequirePermission('tch-002:read')
  @ApiOperation({
    summary:
      'Real-time results aggregate for the teacher — per-question response counts plus the raw response rows.',
  })
  async getResults(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<FormativeResultsDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.formative.getResults(id, actor);
  }
}
