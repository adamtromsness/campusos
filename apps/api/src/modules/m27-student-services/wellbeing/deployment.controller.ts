import {
  Body,
  Controller,
  Get,
  Param,
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
import { DeploymentService } from './deployment.service';
import {
  ActivateDeploymentResponseDto,
  CreateDeploymentDto,
  DeploymentResponseDto,
  ListDeploymentsQueryDto,
} from './dto/wellbeing.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Wellbeing Deployments')
@ApiBearerAuth()
@Controller('counselling/wellbeing/deployments')
export class DeploymentController {
  constructor(
    private readonly deployments: DeploymentService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('cou-004:read')
  @ApiOperation({
    summary:
      'List deployments. Counsellors see own (deployed_by=me); admins see all. Filter by status, templateId.',
  })
  async list(
    @Query() query: ListDeploymentsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<DeploymentResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.deployments.list(query, actor);
  }

  @Get(':id')
  @RequirePermission('cou-004:read')
  @ApiOperation({
    summary:
      'Fetch a single deployment with completion stats inlined (totalTargeted / totalCompleted / completionRate).',
  })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<DeploymentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.deployments.getById(id, actor);
  }

  @Post()
  @RequirePermission('cou-004:write')
  @ApiOperation({
    summary:
      'Counsellor or admin creates a SCHEDULED deployment. Validates the template exists + is active + has questions. Validates target shape: CASELOAD / SCHOOL must omit targetIds; CLASS / YEAR_GROUP / CUSTOM_LIST require a non-empty targetIds array.',
  })
  async create(
    @Body() body: CreateDeploymentDto,
    @Req() req: AuthedRequest,
  ): Promise<DeploymentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.deployments.create(body, actor);
  }

  @Patch(':id/activate')
  @RequirePermission('cou-004:write')
  @ApiOperation({
    summary:
      'KEYSTONE — SCHEDULED → ACTIVE. Resolves the target audience into a student id list, bulk-INSERTs svc_wellbeing_checkins rows (one per student, completed_at NULL = PENDING), and stamps total_targeted on the deployment. Returns the updated deployment + the count of check-ins created. The Step 7 student UI then renders these PENDING rows as the to-do list.',
  })
  async activate(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ActivateDeploymentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.deployments.activate(id, actor);
  }

  @Patch(':id/complete')
  @RequirePermission('cou-004:write')
  @ApiOperation({ summary: 'ACTIVE → COMPLETED. Counsellor closes out the deployment.' })
  async complete(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<DeploymentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.deployments.complete(id, actor);
  }

  @Patch(':id/cancel')
  @RequirePermission('cou-004:write')
  @ApiOperation({
    summary: 'SCHEDULED or ACTIVE → CANCELLED. Pulls a deployment before it completes.',
  })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<DeploymentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.deployments.cancel(id, actor);
  }
}
