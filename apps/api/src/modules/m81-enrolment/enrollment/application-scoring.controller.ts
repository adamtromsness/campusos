import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { ApplicationScoringService } from './application-scoring.service';
import { ApplicationScoreResponseDto, CreateScoreDto, UpdateScoreDto } from './dto/cycle16.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Enrollment / Cycle 16')
@Controller()
export class ApplicationScoringController {
  constructor(
    private readonly scores: ApplicationScoringService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('applications/:applicationId/scores')
  @RequirePermission('stu-003:read')
  @ApiOperation({
    summary:
      'List per-criterion scores for an application. Admin / Enrolment Officer only — admissions scores are not visible to guardians or students (REVIEW-CYCLE16 BLOCKING 1 + MAJOR 4).',
  })
  async list(
    @Param('applicationId') applicationId: string,
    @Req() req: AuthedRequest,
  ): Promise<ApplicationScoreResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.scores.listForApplication(applicationId, actor);
  }

  @Post('applications/:applicationId/scores')
  @RequirePermission('stu-003:write')
  @ApiOperation({
    summary:
      'Record a per-criterion score for an application. EO / admin only. UNIQUE(application, criterion) — duplicates → 400.',
  })
  async create(
    @Param('applicationId') applicationId: string,
    @Body() body: CreateScoreDto,
    @Req() req: AuthedRequest,
  ): Promise<ApplicationScoreResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.scores.create(applicationId, body, actor);
  }

  @Patch('application-scores/:id')
  @RequirePermission('stu-003:write')
  @ApiOperation({ summary: 'Update an existing score. EO / admin only.' })
  async patch(
    @Param('id') id: string,
    @Body() body: UpdateScoreDto,
    @Req() req: AuthedRequest,
  ): Promise<ApplicationScoreResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.scores.patch(id, body, actor);
  }

  @Delete('application-scores/:id')
  @HttpCode(204)
  @RequirePermission('stu-003:write')
  @ApiOperation({ summary: 'Delete a score. EO / admin only.' })
  async remove(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.scores.remove(id, actor);
  }
}
