import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { TaskTemplateResponseDto, UpsertTaskTemplateDto } from './dto/withdrawal.dto';
import { ExitTaskTemplateService } from './exit-task-template.service';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Enrolment Withdrawal Task Templates')
@ApiBearerAuth()
@Controller('enrolment')
export class ExitTaskTemplateController {
  constructor(
    private readonly templates: ExitTaskTemplateService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('withdrawal-task-templates')
  @RequirePermission('stu-004:read')
  @ApiOperation({
    summary:
      'Read the active DEFAULT exit task template. Lazy-seeds the 7-task baseline on first read for a fresh tenant.',
  })
  async list(@Req() req: AuthedRequest): Promise<TaskTemplateResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.templates.list(actor);
  }

  @Post('withdrawal-task-templates')
  @RequirePermission('stu-004:admin')
  @ApiOperation({
    summary:
      'Replace the active DEFAULT template with the supplied list. Existing rows are marked is_active=false; supplied tasks UPSERT by (school, template, task_name).',
  })
  async upsert(
    @Body() body: UpsertTaskTemplateDto,
    @Req() req: AuthedRequest,
  ): Promise<TaskTemplateResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.templates.upsert(body, actor);
  }
}
