import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { PlatformScoped } from '../auth/platform-scoped.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { DlqService } from './dlq.service';

interface AuthedRequest extends Request {
  user: { sub: string; personId: string };
}

class DiscardDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

/**
 * Cycle 31 Step 7 — DLQ admin controller.
 *
 * Gated on sys-001:admin (Platform Admin only). The DLQ surface
 * exposes raw event payloads which may contain PII; only operators
 * with the highest privilege tier may inspect or replay them.
 *
 * Routes mounted under /api/v1/admin/dlq so the path makes the
 * audience explicit.
 */
@ApiTags('Platform Admin — DLQ')
@Controller('admin/dlq')
@PlatformScoped()
export class DlqController {
  constructor(private readonly dlq: DlqService) {}

  @Get()
  @RequirePermission('sys-001:admin')
  @ApiOperation({ summary: 'List dead-letter messages across all consumers.' })
  list(
    @Query('consumerGroup') consumerGroup?: string,
    @Query('topic') topic?: string,
    @Query('tenantId') tenantId?: string,
    @Query('resolved') resolved?: string,
    @Query('limit') limit?: string,
  ) {
    return this.dlq.list({
      consumerGroup,
      topic,
      tenantId,
      resolved: resolved === 'true' ? true : resolved === 'false' ? false : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('stats')
  @RequirePermission('sys-001:admin')
  @ApiOperation({ summary: 'DLQ rollup for the platform admin dashboard.' })
  stats() {
    return this.dlq.stats();
  }

  @Get(':id')
  @RequirePermission('sys-001:admin')
  getById(@Param('id') id: string) {
    return this.dlq.getById(id);
  }

  @Post(':id/replay')
  @RequirePermission('sys-001:admin')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Re-emit the original event to its topic. Marks the DLQ row resolved with the actor + REPLAYED resolution code.',
  })
  async replay(@Req() req: AuthedRequest, @Param('id') id: string): Promise<void> {
    await this.dlq.replay(id, req.user.sub);
  }

  @Post(':id/discard')
  @RequirePermission('sys-001:admin')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Acknowledge without replay. The DLQ row stays for audit but is excluded from active counts.',
  })
  async discard(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: DiscardDto,
  ): Promise<void> {
    await this.dlq.discard(id, req.user.sub, body.reason);
  }
}
