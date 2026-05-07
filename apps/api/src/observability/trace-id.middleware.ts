import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { generateId } from '@campusos/database';
import { runWithTraceContext, type TraceContext } from './trace-context';

const TRACE_HEADER = 'x-trace-id';
const SPAN_HEADER = 'x-span-id';

/**
 * Cycle 31 Step 1 — Trace ID Middleware.
 *
 * Generates a UUIDv7 trace_id on every incoming HTTP request (or
 * accepts the upstream X-Trace-Id header when the request entered
 * via an API gateway / mesh that already established a trace).
 *
 * The trace_id is:
 *   - written to AsyncLocalStorage via runWithTraceContext so the
 *     StructuredLogger and KafkaProducerService can pick it up,
 *   - mirrored back on the response as `X-Trace-Id` so a curl client
 *     can grep the same id in logs / Jaeger.
 *
 * Span IDs are also UUIDv7 so each HTTP request gets a fresh span
 * under its (possibly upstream) trace. Step 2's OpenTelemetry SDK
 * replaces this with proper W3C Trace Context propagation; Step 1's
 * shape is the strict-minimum baseline that Step 2 can drop into.
 */
@Injectable()
export class TraceIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const upstreamTrace = req.header(TRACE_HEADER);
    const upstreamSpan = req.header(SPAN_HEADER);
    const traceId = isWellFormed(upstreamTrace) ? upstreamTrace! : generateId();
    const spanId = isWellFormed(upstreamSpan) ? upstreamSpan! : generateId();
    const correlationId = generateId();

    res.setHeader(TRACE_HEADER, traceId);
    res.setHeader(SPAN_HEADER, spanId);

    const ctx: TraceContext = { traceId, spanId, correlationId };
    runWithTraceContext(ctx, () => next());
  }
}

function isWellFormed(value: string | undefined): boolean {
  if (!value) return false;
  // Accept any UUID shape (UUIDv4 / UUIDv7 / W3C trace-id 16-byte hex
  // would fail this — Step 2 hooks the OTel SDK in for full W3C
  // compliance).
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
