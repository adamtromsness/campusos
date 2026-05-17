import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { SurveyTemplateService } from './survey-template.service';
import {
  AddQuestionDto,
  CreateSurveyTemplateDto,
  SurveyTemplateResponseDto,
  UpdateQuestionDto,
  UpdateSurveyTemplateDto,
  WellbeingQuestionResponseDto,
} from './dto/wellbeing.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Wellbeing Survey Templates')
@ApiBearerAuth()
@Controller('counselling/wellbeing')
export class SurveyTemplateController {
  constructor(
    private readonly templates: SurveyTemplateService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('templates')
  @RequirePermission('cou-004:read')
  @ApiOperation({
    summary:
      'List wellbeing survey templates for this school. Defaults to active templates only — pass includeInactive=true to see deactivated rows. Counsellor + admin reach this endpoint; the IAM seed grants cou-004:read to teachers and students too but those personas use the aggregated trends + own-history surfaces, not the template builder.',
  })
  async list(
    @Query('includeInactive', new ParseBoolPipe({ optional: true })) includeInactive?: boolean,
  ): Promise<SurveyTemplateResponseDto[]> {
    return this.templates.list(includeInactive ?? false);
  }

  @Get('templates/:id')
  @RequirePermission('cou-004:read')
  @ApiOperation({
    summary: 'Fetch a survey template with its questions inlined ordered by sort_order.',
  })
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<SurveyTemplateResponseDto> {
    return this.templates.getById(id);
  }

  @Post('templates')
  @RequirePermission('cou-004:write')
  @ApiOperation({
    summary:
      'Counsellor or admin creates a survey template + its questions in one tenant transaction. UNIQUE(school_id, name) catch surfaces the conflict as a friendly 400.',
  })
  async create(
    @Body() body: CreateSurveyTemplateDto,
    @Req() req: AuthedRequest,
  ): Promise<SurveyTemplateResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.templates.create(body, actor);
  }

  @Patch('templates/:id')
  @RequirePermission('cou-004:write')
  @ApiOperation({
    summary:
      'Update template metadata. is_active=false is the canonical soft-deactivate path — the schema NO ACTION FK from svc_wellbeing_deployments.template_id refuses a hard-delete while any deployment references the template.',
  })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateSurveyTemplateDto,
    @Req() req: AuthedRequest,
  ): Promise<SurveyTemplateResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.templates.patch(id, body, actor);
  }

  @Post('templates/:id/questions')
  @RequirePermission('cou-004:write')
  @ApiOperation({
    summary:
      'Append a question to an existing template. Callers choose the sort_order. SAFETY domain questions are the trigger surface for the Step 5 alert evaluation.',
  })
  async addQuestion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AddQuestionDto,
    @Req() req: AuthedRequest,
  ): Promise<WellbeingQuestionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.templates.addQuestion(id, body, actor);
  }

  @Patch('questions/:id')
  @RequirePermission('cou-004:write')
  @ApiOperation({ summary: 'Update a survey question (text, type, domain, sort_order).' })
  async patchQuestion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateQuestionDto,
    @Req() req: AuthedRequest,
  ): Promise<WellbeingQuestionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.templates.patchQuestion(id, body, actor);
  }

  @Delete('questions/:id')
  @HttpCode(204)
  @RequirePermission('cou-004:write')
  @ApiOperation({
    summary:
      'Delete a question. Refused with a friendly 400 when any response references the question — deactivate the parent template via PATCH /templates/:id with isActive=false instead.',
  })
  async deleteQuestion(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.templates.deleteQuestion(id, actor);
  }
}
