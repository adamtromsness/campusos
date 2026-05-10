import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { RubricService } from './rubric.service';
import {
  CloneRubricDto,
  CreateRubricDto,
  CreateRubricScoreDto,
  RubricResponseDto,
  RubricScoreResponseDto,
  UpdateRubricDto,
} from './dto/rubric.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Classroom Advanced — Rubrics')
@ApiBearerAuth()
@Controller('classroom')
export class RubricController {
  constructor(
    private readonly rubrics: RubricService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('rubrics')
  @ApiQuery({ name: 'scope', required: false, enum: ['all', 'templates', 'mine'] })
  @RequirePermission('tch-001:read')
  @ApiOperation({
    summary:
      'List rubrics for the current school. scope=templates filters to is_template=true; scope=mine restricts to the calling teacher.',
  })
  async list(
    @Query('scope') scope: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<RubricResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rubrics.list(actor, scope);
  }

  @Get('rubrics/:id')
  @RequirePermission('tch-001:read')
  @ApiOperation({
    summary:
      'Fetch a rubric with criteria inlined. Includes weightTotal and weightWarning so the UI can surface a non-blocking notice when criteria weights do not sum to 100.',
  })
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<RubricResponseDto> {
    return this.rubrics.getById(id);
  }

  @Post('rubrics')
  @RequirePermission('tch-001:write')
  @ApiOperation({
    summary:
      'Create a rubric with criteria. total_points is denormalised from the SUM of criteria max_points. Criteria weights SHOULD sum to 100 — the response surfaces a weightWarning when they do not.',
  })
  async create(
    @Body() body: CreateRubricDto,
    @Req() req: AuthedRequest,
  ): Promise<RubricResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rubrics.create(body, actor);
  }

  @Patch('rubrics/:id')
  @RequirePermission('tch-001:write')
  @ApiOperation({
    summary:
      'Update a rubric. When criteria are provided, replaces the criteria atomically (DELETE all + INSERT each in one tenant tx).',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateRubricDto,
    @Req() req: AuthedRequest,
  ): Promise<RubricResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rubrics.update(id, body, actor);
  }

  @Delete('rubrics/:id')
  @HttpCode(204)
  @RequirePermission('tch-001:write')
  @ApiOperation({
    summary:
      'Delete a rubric. Refused with 400 when any cls_rubric_scores rows reference its criteria.',
  })
  async delete(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest): Promise<void> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rubrics.delete(id, actor);
  }

  @Post('rubrics/:id/clone')
  @RequirePermission('tch-001:write')
  @ApiOperation({
    summary:
      'Clone a template rubric into a new is_template=false rubric for an assignment. Optional title overrides the auto-generated "<source title> (copy)".',
  })
  async clone(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CloneRubricDto,
    @Req() req: AuthedRequest,
  ): Promise<RubricResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rubrics.clone(id, body, actor);
  }

  @Post('rubric-scores')
  @RequirePermission('tch-001:write')
  @ApiOperation({
    summary:
      'Score a submission against a rubric criterion. Idempotent UPSERT keyed on (submission, criterion, scorer) — re-scoring updates the existing row. Refuses points exceeding the criterion max_points.',
  })
  async upsertScore(
    @Body() body: CreateRubricScoreDto,
    @Req() req: AuthedRequest,
  ): Promise<RubricScoreResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rubrics.upsertScore(body, actor);
  }

  @Get('submissions/:id/rubric-scores')
  @RequirePermission('tch-001:read')
  @ApiOperation({
    summary:
      'List every rubric score for a submission. Used by the grading UI to render the per-criterion editor.',
  })
  async listScoresForSubmission(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RubricScoreResponseDto[]> {
    return this.rubrics.listScoresForSubmission(id);
  }
}
