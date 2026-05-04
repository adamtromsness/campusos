import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { HealthAccessLogService } from './health-access-log.service';
import { HealthAccessLogRowDto, ListAccessLogQueryDto } from './dto/health.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Health Access Log')
@ApiBearerAuth()
@Controller()
export class HealthAccessLogController {
  constructor(
    private readonly log: HealthAccessLogService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('health/access-log')
  @RequirePermission('hlt-001:admin')
  @ApiOperation({
    summary:
      'Admin-only HIPAA access log. Append-only audit per ADR-010 — every health read endpoint writes a row before returning data. Filters by student / actor / access type / date range. Newest first, capped at 500 rows.',
  })
  async list(
    @Query() query: ListAccessLogQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<HealthAccessLogRowDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.log.list(query, actor);
  }
}
