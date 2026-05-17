import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { AIUsageService } from './ai-usage.service';
import {
  AIQuotaResponseDto,
  AIUsageRowResponseDto,
  AIUsageSummaryDto,
} from './dto/ai-tutoring.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Classroom Advanced — AI Usage')
@ApiBearerAuth()
@Controller('classroom')
export class AIUsageController {
  constructor(
    private readonly usage: AIUsageService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('ai-usage')
  @ApiQuery({ name: 'days', required: false, type: Number })
  @RequirePermission('tch-007:admin')
  @ApiOperation({
    summary:
      'Admin AI usage summary — aggregate tokens + cost across the last N days (default 30).',
  })
  async getSummary(
    @Query('days') days: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<AIUsageSummaryDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    const n = days ? Number(days) : undefined;
    return this.usage.getSummary(actor, Number.isFinite(n!) ? (n as number) : undefined);
  }

  @Get('ai-usage/log')
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @RequirePermission('tch-007:admin')
  @ApiOperation({ summary: 'Admin paginated AI usage log (newest first).' })
  async listUsage(
    @Query('limit') limit: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<AIUsageRowResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    const n = limit ? Number(limit) : undefined;
    return this.usage.listUsage(actor, Number.isFinite(n!) ? (n as number) : undefined);
  }

  @Get('ai-usage/quota')
  @RequirePermission('tch-007:read')
  @ApiOperation({
    summary:
      'Current daily AI token quota for this tenant — used by the admin dashboard remaining-tokens indicator.',
  })
  async getQuota(@Req() req: AuthedRequest): Promise<AIQuotaResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.usage.getQuota(actor);
  }
}
