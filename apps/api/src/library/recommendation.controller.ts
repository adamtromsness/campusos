import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { RecommendationService } from './recommendation.service';
import {
  RecommendationResponseDto,
  RecommendationWeightsDto,
  UpdateRecommendationWeightsDto,
} from './dto/library-advanced.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Library Advanced — Recommendations')
@ApiBearerAuth()
@Controller()
export class RecommendationController {
  constructor(
    private readonly recs: RecommendationService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('library/recommendations/:studentId')
  @RequirePermission('lib-003:read')
  @ApiOperation({
    summary:
      'List up to 20 active (non-dismissed) recommendations for a student, sorted by score DESC. Students may only read their own; guardians may read recommendations for linked children; librarians + admins read any. ?includeDismissed=true surfaces dismissed rows for the dashboard view.',
  })
  async listForStudent(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Query('includeDismissed') includeDismissedRaw: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<RecommendationResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    const includeDismissed = includeDismissedRaw === 'true';
    return this.recs.listForStudent(studentId, actor, { includeDismissed });
  }

  @Post('library/recommendations/:recommendationId/dismiss')
  @HttpCode(204)
  @RequirePermission('lib-003:write')
  @ApiOperation({
    summary:
      'Student dismisses a recommendation. The service stamps dismissed_at + dismissed_by atomically. The next LibraryRecommendationWorker run filters dismissed rows out and excludes the same item from re-recommend for 90 days.',
  })
  async dismiss(
    @Param('recommendationId', ParseUUIDPipe) recommendationId: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.recs.dismiss(recommendationId, actor);
  }

  // ── Recommendation engine weight configuration (P2-25b Step 8) ──

  @Get('library/recommendation-config')
  @RequirePermission('lib-002:read')
  @ApiOperation({
    summary:
      'Read the per-school recommendation engine weights (5 strategies — collaborative filtering / reading level / subject / new arrival / staff pick). Defaults applied when no school_config row exists. Returns the merged weight set the LibraryRecommendationWorker uses to blend the 5 strategy scores into the final ranked list.',
  })
  async getConfig(@Req() req: AuthedRequest): Promise<RecommendationWeightsDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    const weights = await this.recs.getConfig(actor);
    return weights as RecommendationWeightsDto;
  }

  @Patch('library/recommendation-config')
  @RequirePermission('lib-002:admin')
  @ApiOperation({
    summary:
      'Update recommendation engine weights (admin-only — librarians read but cannot mutate). PATCH-merge semantics: only supplied keys overwrite the stored value. The merged weights must sum to 100 (±0.5). Returns the new fully-resolved weight set after the upsert. Stored under school_config key library_recommendation_weights.',
  })
  async updateConfig(
    @Body() body: UpdateRecommendationWeightsDto,
    @Req() req: AuthedRequest,
  ): Promise<RecommendationWeightsDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    const weights = await this.recs.updateConfig(actor, body);
    return weights as RecommendationWeightsDto;
  }
}
