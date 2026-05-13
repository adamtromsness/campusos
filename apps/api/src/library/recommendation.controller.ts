import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { RecommendationService } from './recommendation.service';
import { RecommendationResponseDto } from './dto/library-advanced.dto';

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
}
