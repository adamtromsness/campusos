import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { getRequestContext } from '../tenant/tenant.context';
import { MetricsService } from './metrics.service';

/**
 * Cycle 31 Step 1 — Request Log Middleware.
 *
 * Emits one structured INFO log line per HTTP request on the `on
 * finish` hook with method + route + status + duration_ms. Runs
 * AFTER TraceIdMiddleware so the log line carries trace_id +
 * span_id from the request context.
 *
 * Architecture Review §25.2: every HTTP request must be observable
 * end-to-end. The /metrics endpoint (Step 3) emits the same data
 * as a Prometheus histogram for aggregation; this middleware
 * emits per-request log lines for correlation against
 * trace_id-keyed Jaeger spans.
 *
 * Health-check requests (`/api/v1/health`) are intentionally
 * silenced to keep the log stream signal-rich.
 */
@Injectable()
export class RequestLogMiddleware implements NestMiddleware {
  private readonly logger = new Logger('Request');

  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    if (req.path === '/api/v1/health' || req.path === '/health' || req.path === '/metrics') {
      return next();
    }
    const start = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - start;
      this.logger.log({
        message: `${req.method} ${req.originalUrl ?? req.url} ${res.statusCode}`,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: durationMs,
      });
      // Cycle 31 Step 3 — record the http_request_duration_seconds
      // histogram + http_requests_total counter for Prometheus scraping.
      // Use req.route.path when NestJS has matched a route (so the
      // label cardinality stays bounded — '/api/v1/students/:id'
      // rather than '/api/v1/students/<uuid>'); fall back to the
      // raw path on 404s.
      const route = (req as Request & { route?: { path?: string } }).route?.path ?? req.path;
      const tenantId = (() => {
        try {
          return getRequestContext()?.tenant?.schoolId ?? null;
        } catch {
          return null;
        }
      })();
      this.metrics.recordHttpRequest({
        method: req.method,
        route,
        statusCode: res.statusCode,
        durationMs,
        tenantId,
      });
    });
    next();
  }
}
