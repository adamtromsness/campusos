import { Controller, Get, Header, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/public.decorator';
import { MetricsService } from './metrics.service';

/**
 * Cycle 31 Step 3 — Prometheus /metrics endpoint.
 *
 * Served at /metrics (NOT under /api/v1) so the Prometheus scraper
 * can hit it without the bearer-auth chain. Marked @Public() so the
 * AuthGuard doesn't reject.
 *
 * Returns plain text in the Prometheus exposition format.
 *
 * REVIEW-FINAL P5 — optional bearer-token guard. When the env
 * `METRICS_BEARER_TOKEN` is set, /metrics requires the request to
 * carry `Authorization: Bearer <token>` matching that exact value.
 * Mismatch → 401. Token unset → endpoint stays open (matches the
 * dev-mode + private-network Prometheus path that worked before).
 *
 * The token check uses constant-time comparison to defeat timing
 * oracles. Production deployments that previously relied on network
 * ACLs alone can now layer this guard alongside their ACLs as
 * defence-in-depth. Setting the env on the API and configuring the
 * Prometheus scraper to send the matching `Authorization` header
 * is the deployment-time operator action.
 */
@Controller('/metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Public()
  @Header('Cache-Control', 'no-cache')
  async render(@Req() req: Request, @Res() res: Response): Promise<void> {
    this.assertAuthorised(req);
    const body = await this.metrics.render();
    res.setHeader('Content-Type', this.metrics.contentType());
    res.send(body);
  }

  /**
   * Optional bearer-token gate. Throws UnauthorizedException when
   * the env is set but the request fails to present a matching
   * token. Returns silently when the env is unset (dev mode +
   * private-network deployments rely on the open endpoint).
   */
  private assertAuthorised(req: Request): void {
    const expected = process.env.METRICS_BEARER_TOKEN;
    if (!expected || expected.length === 0) return;

    const auth = req.headers['authorization'];
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const supplied = auth.slice('Bearer '.length).trim();
    if (!constantTimeEquals(supplied, expected)) {
      throw new UnauthorizedException('Invalid bearer token');
    }
  }
}

/**
 * Constant-time string comparison. Comparing bytes with === is
 * vulnerable to timing oracles — short prefixes of the secret leak
 * via differential response latency. This walks both buffers fully
 * and returns false if lengths differ or any byte mismatches.
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
