import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { ApplicationStageService } from './application-stage.service';
import { AdvanceStageDto, ApplicationStageResponseDto } from './dto/cycle16.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Enrollment / Cycle 16')
@Controller()
export class ApplicationStageController {
  constructor(
    private readonly stages: ApplicationStageService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('applications/:applicationId/stages')
  @RequirePermission('stu-003:read')
  @ApiOperation({
    summary:
      "List the stage history for an application (audit timeline). Admin/EO see every application; guardian sees own children's applications only; everyone else gets a collapsed 404 (REVIEW-CYCLE16 BLOCKING 1).",
  })
  async list(
    @Param('applicationId') applicationId: string,
    @Req() req: AuthedRequest,
  ): Promise<ApplicationStageResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.stages.list(applicationId, actor);
  }

  @Post('applications/:applicationId/stages/advance')
  @RequirePermission('stu-003:write')
  @ApiOperation({
    summary: 'Advance the application to the next status. EO / admin only.',
  })
  async advance(
    @Param('applicationId') applicationId: string,
    @Body() body: AdvanceStageDto,
    @Req() req: AuthedRequest,
  ): Promise<ApplicationStageResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.stages.advance(applicationId, body.toStatus, body.notes ?? null, actor);
  }
}
