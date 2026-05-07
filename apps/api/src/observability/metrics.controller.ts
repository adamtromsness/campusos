import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator';
import { MetricsService } from './metrics.service';

/**
 * Cycle 31 Step 3 — Prometheus /metrics endpoint.
 *
 * Served at /metrics (NOT under /api/v1) so the Prometheus scraper
 * can hit it without the bearer-auth chain. Marked @Public() so the
 * AuthGuard doesn't reject. Production network ACLs scope access
 * to the scraper itself.
 *
 * Returns plain text in the Prometheus exposition format.
 */
@Controller('/metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Public()
  @Header('Cache-Control', 'no-cache')
  async render(@Res() res: Response): Promise<void> {
    const body = await this.metrics.render();
    res.setHeader('Content-Type', this.metrics.contentType());
    res.send(body);
  }
}
