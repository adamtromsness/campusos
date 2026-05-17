import { AsyncLocalStorage } from 'async_hooks';

/**
 * Cycle 31 Step 1 — Trace Context (ADR-057 + Architecture Review §25.2).
 *
 * Carries the per-request observability context: trace_id, span_id,
 * and a correlation envelope used by Kafka emits. Distinct from
 * tenantStorage in tenant/tenant.context.ts because the trace context
 * is an HTTP-layer concern that must propagate through worker code
 * paths even when there is no tenant resolved (e.g. /health).
 *
 * Every HTTP request gets a UUIDv7 trace_id from
 * TraceIdMiddleware (or accepts an upstream X-Trace-Id header).
 * Services + Kafka emits + DB query comments + structured log lines
 * all read from this AsyncLocalStorage.
 */

export interface TraceContext {
  traceId: string;
  spanId: string;
  // The Kafka correlation_id field on the ADR-057 envelope is set
  // from this trace context so consumer tracing reconstructs the
  // chain across producer + consumer boundaries.
  correlationId: string;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

export function getTraceContext(): TraceContext | undefined {
  return traceStorage.getStore();
}

export function getTraceId(): string | undefined {
  return traceStorage.getStore()?.traceId;
}

export function runWithTraceContext<T>(context: TraceContext, fn: () => T): T {
  return traceStorage.run(context, fn);
}

export { traceStorage };
