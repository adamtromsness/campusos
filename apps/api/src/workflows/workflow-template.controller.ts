import { Controller, Get, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { WorkflowTemplateDto, WorkflowTemplateService } from './workflow-template.service';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Workflow Templates')
@ApiBearerAuth()
@Controller('workflow-templates')
export class WorkflowTemplateController {
  constructor(
    private readonly templates: WorkflowTemplateService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('ops-001:admin')
  @ApiOperation({
    summary: 'Admin: list every workflow template configured for the tenant.',
  })
  async list(@Req() req: AuthedRequest): Promise<WorkflowTemplateDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.templates.list(actor);
  }

  @Get(':id')
  @RequirePermission('ops-001:admin')
  @ApiOperation({ summary: 'Admin: fetch a single workflow template with its steps.' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<WorkflowTemplateDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.templates.getById(id, actor);
  }
}
