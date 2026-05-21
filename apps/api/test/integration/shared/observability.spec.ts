import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StructuredLogger } from '@shared/observability/structured-logger';
import { RequestLogMiddleware } from '@shared/observability/request-log.middleware';
import { TraceIdMiddleware } from '@shared/observability/trace-id.middleware';
import { MetricsService } from '@shared/observability/metrics.service';
import { CircuitBreaker, CircuitBreakerOpenError } from '@shared/observability/circuit-breaker';
import { bootstrapOpenTelemetry, getTracer, withSpan } from '@shared/observability/otel-bootstrap';
import {
  getTraceContext,
  getTraceId,
  runWithTraceContext,
} from '@shared/observability/trace-context';
import { runWithTenantContext, type TenantInfo } from '@shared/tenant/tenant.context';

/**
 * Wave 8 — observability suite. Covers:
 *   - structured-logger emits a JSON line per log call with trace + tenant
 *     context picked up from AsyncLocalStorage.
 *   - trace-context happy path + getTraceId convenience.
 *   - trace-id middleware accepts upstream X-Trace-Id / X-Span-Id.
 *   - request-log middleware writes one log line + records the histogram
 *     on `res.on('finish')`. Health + metrics paths are silenced.
 *   - metrics service exposes Prometheus text and binds circuit-breaker
 *     state to the gauge.
 *   - circuit breaker state transitions surface on the bound gauge.
 *   - otel-bootstrap is a no-op without OTEL_ENABLED=true; the tracer
 *     surface (getTracer + withSpan) works against the no-op tracer.
 */

const TENANT: TenantInfo = {
  schoolId: '019ec0fa-aaaa-7777-8888-400000000001',
  schemaName: 'tenant_test',
  organisationId: '019ec0fa-aaaa-7777-8888-400000000002',
  subdomain: 'test',
  isFrozen: false,
  planTier: 'MEDIUM',
  homeRegion: 'us-east-1',
};

// Stand-in for express Request / Response so we can drive middleware
// without bringing up a full Nest app.
function makeReq(
  opts: {
    method?: string;
    path?: string;
    originalUrl?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const headers = opts.headers ?? {};
  return {
    method: opts.method ?? 'GET',
    path: opts.path ?? '/api/v1/some',
    originalUrl: opts.originalUrl ?? opts.path ?? '/api/v1/some',
    url: opts.originalUrl ?? opts.path ?? '/api/v1/some',
    headers,
    header(name: string) {
      return headers[name.toLowerCase()];
    },
  };
}

function makeRes() {
  const listeners: Record<string, (() => void)[]> = {};
  const setHeaders: Record<string, string> = {};
  return {
    statusCode: 200,
    setHeader(k: string, v: string) {
      setHeaders[k.toLowerCase()] = v;
    },
    getHeader(k: string) {
      return setHeaders[k.toLowerCase()];
    },
    on(event: string, cb: () => void) {
      (listeners[event] ??= []).push(cb);
    },
    emit(event: string) {
      (listeners[event] ?? []).forEach((cb) => cb());
    },
    headers: setHeaders,
  };
}

describe('integration:shared/observability', () => {
  // ──────────────────────────────────────────────────────────────────
  // trace-context + getTraceId convenience
  // ──────────────────────────────────────────────────────────────────
  describe('trace-context', () => {
    it('runWithTraceContext propagates traceId + spanId + correlationId', () => {
      const ctx = { traceId: 't-1', spanId: 's-1', correlationId: 'c-1' };
      runWithTraceContext(ctx, () => {
        expect(getTraceContext()).toEqual(ctx);
        expect(getTraceId()).toBe('t-1');
      });
    });

    it('getTraceContext returns undefined outside context', () => {
      expect(getTraceContext()).toBeUndefined();
      expect(getTraceId()).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // trace-id middleware
  // ──────────────────────────────────────────────────────────────────
  describe('TraceIdMiddleware', () => {
    it('generates fresh trace + span IDs when no upstream header', () => {
      const m = new TraceIdMiddleware();
      const req = makeReq();
      const res = makeRes();
      let captured: any;
      m.use(req as any, res as any, () => {
        captured = getTraceContext();
      });
      expect(captured?.traceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(captured?.spanId).toMatch(/^[0-9a-f-]{36}$/);
      expect(captured?.correlationId).toBe(captured?.traceId);
      expect(res.getHeader('x-trace-id')).toBe(captured?.traceId);
      expect(res.getHeader('x-span-id')).toBe(captured?.spanId);
    });

    it('accepts well-formed upstream X-Trace-Id / X-Span-Id', () => {
      const m = new TraceIdMiddleware();
      const traceId = '019ec0fa-aaaa-7777-8888-500000000001';
      const spanId = '019ec0fa-aaaa-7777-8888-500000000002';
      const req = makeReq({
        headers: { 'x-trace-id': traceId, 'x-span-id': spanId },
      });
      const res = makeRes();
      let captured: any;
      m.use(req as any, res as any, () => {
        captured = getTraceContext();
      });
      expect(captured.traceId).toBe(traceId);
      expect(captured.spanId).toBe(spanId);
    });

    it('regenerates IDs when upstream header is malformed', () => {
      const m = new TraceIdMiddleware();
      const req = makeReq({
        headers: { 'x-trace-id': 'not-a-uuid', 'x-span-id': 'not-a-uuid' },
      });
      const res = makeRes();
      let captured: any;
      m.use(req as any, res as any, () => {
        captured = getTraceContext();
      });
      expect(captured.traceId).not.toBe('not-a-uuid');
      expect(captured.traceId).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // structured-logger — JSON line shape + extras
  // ──────────────────────────────────────────────────────────────────
  describe('StructuredLogger', () => {
    let writeSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      writeSpy.mockRestore();
    });

    function lines(): any[] {
      return writeSpy.mock.calls
        .map((c) => String(c[0]).trim())
        .filter(Boolean)
        .map((s) => JSON.parse(s));
    }

    it('emits INFO with trace + tenant + user when in context', () => {
      const logger = new StructuredLogger({ serviceName: 'unit-test-svc' });
      runWithTenantContext({ tenant: TENANT, userId: 'acct-1' }, () => {
        runWithTraceContext({ traceId: 't-1', spanId: 's-1', correlationId: 't-1' }, () => {
          logger.log('hello world', 'MyContext');
        });
      });
      const recs = lines();
      expect(recs).toHaveLength(1);
      expect(recs[0]).toMatchObject({
        level: 'INFO',
        service_name: 'unit-test-svc',
        trace_id: 't-1',
        span_id: 's-1',
        tenant_id: TENANT.schoolId,
        user_id: 'acct-1',
        module: 'MyContext',
        message: 'hello world',
      });
    });

    it('error level writes stack as separate field', () => {
      const logger = new StructuredLogger();
      logger.error('oops', 'STACK_HERE', 'CtxA');
      const recs = lines();
      expect(recs[0]).toMatchObject({
        level: 'ERROR',
        message: 'oops',
        stack: 'STACK_HERE',
        module: 'CtxA',
      });
    });

    it('warn / debug / verbose obey setLogLevels gating', () => {
      const logger = new StructuredLogger({ levels: ['log'] });
      logger.warn('not emitted');
      logger.debug('not emitted');
      logger.verbose('not emitted');
      expect(lines()).toHaveLength(0);
      logger.setLogLevels(['log', 'warn', 'debug', 'verbose']);
      logger.warn('emitted');
      logger.debug('emitted');
      logger.verbose('emitted');
      logger.log('emitted');
      const recs = lines();
      expect(recs.map((r) => r.level)).toEqual(['WARN', 'DEBUG', 'TRACE', 'INFO']);
    });

    it('object message with .message + extra fields flattens onto the record', () => {
      const logger = new StructuredLogger();
      logger.log({ message: 'paid', amount: 100, status: 'OK' });
      const rec = lines()[0];
      expect(rec.message).toBe('paid');
      expect(rec.amount).toBe(100);
      expect(rec.status).toBe('OK');
    });

    it('non-string message without .message is JSON-stringified', () => {
      const logger = new StructuredLogger();
      logger.log({ amount: 100 });
      const rec = lines()[0];
      // The message field is the JSON.stringify of the original object.
      expect(rec.message).toBe(JSON.stringify({ amount: 100 }));
    });

    it('primitive message falls back to String(msg)', () => {
      const logger = new StructuredLogger();
      logger.log(42);
      const rec = lines()[0];
      expect(rec.message).toBe('42');
    });

    it('tenant_id and user_id are null when there is no context', () => {
      const logger = new StructuredLogger();
      logger.log('no ctx');
      const rec = lines()[0];
      expect(rec.tenant_id).toBeNull();
      expect(rec.user_id).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // request-log middleware
  // ──────────────────────────────────────────────────────────────────
  describe('RequestLogMiddleware', () => {
    it('records a metric + log line on res "finish"', () => {
      const metrics = new MetricsService();
      const recordSpy = vi.spyOn(metrics, 'recordHttpRequest');
      const m = new RequestLogMiddleware(metrics);
      const req = makeReq({ method: 'POST', path: '/api/v1/students' });
      const res = makeRes();
      let nextCalled = false;
      m.use(req as any, res as any, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
      // Simulate the request finishing
      res.statusCode = 201;
      res.emit('finish');
      expect(recordSpy).toHaveBeenCalledTimes(1);
      const arg = recordSpy.mock.calls[0]![0]!;
      expect(arg).toMatchObject({
        method: 'POST',
        route: '/api/v1/students',
        statusCode: 201,
        tenantId: null,
      });
      expect(arg.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('skips /api/v1/health, /health, and /metrics paths', () => {
      const metrics = new MetricsService();
      const recordSpy = vi.spyOn(metrics, 'recordHttpRequest');
      const m = new RequestLogMiddleware(metrics);
      for (const path of ['/api/v1/health', '/health', '/metrics']) {
        const req = makeReq({ path });
        const res = makeRes();
        m.use(req as any, res as any, () => undefined);
        res.emit('finish');
      }
      expect(recordSpy).not.toHaveBeenCalled();
    });

    it('reads tenantId from the AsyncLocalStorage tenant context', () => {
      const metrics = new MetricsService();
      const recordSpy = vi.spyOn(metrics, 'recordHttpRequest');
      const m = new RequestLogMiddleware(metrics);
      runWithTenantContext({ tenant: TENANT }, () => {
        const req = makeReq({ method: 'GET', path: '/api/v1/students' });
        const res = makeRes();
        m.use(req as any, res as any, () => undefined);
        res.emit('finish');
      });
      expect(recordSpy.mock.calls[0]![0].tenantId).toBe(TENANT.schoolId);
    });

    it('prefers req.route.path over req.path for label cardinality', () => {
      const metrics = new MetricsService();
      const recordSpy = vi.spyOn(metrics, 'recordHttpRequest');
      const m = new RequestLogMiddleware(metrics);
      const req: any = makeReq({ method: 'GET', path: '/api/v1/students/abc-123' });
      req.route = { path: '/api/v1/students/:id' };
      const res = makeRes();
      m.use(req as any, res as any, () => undefined);
      res.emit('finish');
      expect(recordSpy.mock.calls[0]![0].route).toBe('/api/v1/students/:id');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // metrics service
  // ──────────────────────────────────────────────────────────────────
  describe('MetricsService', () => {
    it('exposes Prometheus text via render()', async () => {
      const m = new MetricsService();
      m.recordHttpRequest({
        method: 'GET',
        route: '/api/v1/test',
        statusCode: 200,
        durationMs: 12,
        tenantId: TENANT.schoolId,
      });
      const body = await m.render();
      expect(body).toContain('http_requests_total');
      expect(body).toContain('http_request_duration_seconds');
      expect(m.contentType()).toContain('text');
    });

    it('repeated construction does not throw (getOrCreate* helpers de-dupe)', () => {
      const a = new MetricsService();
      const b = new MetricsService();
      expect(a).toBeDefined();
      expect(b).toBeDefined();
    });

    it('bindCircuitBreaker mirrors breaker state onto the gauge', async () => {
      const metrics = new MetricsService();
      const cb = new CircuitBreaker('redis-test', {
        failureThreshold: 1,
        openDurationMs: 1000,
      });
      const setSpy = vi.spyOn(metrics.circuitBreakerState, 'labels');
      metrics.bindCircuitBreaker(cb, 'redis-test');
      // Initial state — CLOSED == 0
      expect(setSpy).toHaveBeenCalled();

      try {
        await cb.execute(async () => {
          throw new Error('boom');
        });
      } catch {
        // expected
      }
      // After failure, breaker is OPEN; the listener should have fired.
      // Subsequent setSpy calls were made through .labels(...).set(...)
      expect(setSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // circuit-breaker — additional integration with state listener
  // ──────────────────────────────────────────────────────────────────
  describe('CircuitBreaker (integration)', () => {
    it('starts CLOSED, opens on threshold, throws CircuitBreakerOpenError fast', async () => {
      const cb = new CircuitBreaker('dep-a', { failureThreshold: 2, openDurationMs: 500 });
      expect(cb.getState()).toBe('CLOSED');
      for (let i = 0; i < 2; i++) {
        try {
          await cb.execute(async () => {
            throw new Error('boom');
          });
        } catch {
          // expected
        }
      }
      expect(cb.getState()).toBe('OPEN');
      let caught: any;
      try {
        await cb.execute(async () => 'ok');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CircuitBreakerOpenError);
    });

    it('records success path and stays CLOSED', async () => {
      const cb = new CircuitBreaker('dep-b');
      const v = await cb.execute(async () => 42);
      expect(v).toBe(42);
      expect(cb.getState()).toBe('CLOSED');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // otel-bootstrap — no-op when OTEL_ENABLED is unset; smoke test helpers
  // ──────────────────────────────────────────────────────────────────
  describe('otel-bootstrap', () => {
    it('bootstrapOpenTelemetry is a no-op without OTEL_ENABLED=true', () => {
      const prev = process.env.OTEL_ENABLED;
      try {
        delete process.env.OTEL_ENABLED;
        expect(() => bootstrapOpenTelemetry()).not.toThrow();
        process.env.OTEL_ENABLED = 'false';
        expect(() => bootstrapOpenTelemetry()).not.toThrow();
      } finally {
        if (prev === undefined) delete process.env.OTEL_ENABLED;
        else process.env.OTEL_ENABLED = prev;
      }
    });

    it('OTEL_ENABLED=true with missing SDK warns + degrades to no-op', () => {
      const prev = process.env.OTEL_ENABLED;
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        process.env.OTEL_ENABLED = 'true';
        // The SDK packages aren't installed in dev — exercising the
        // require()-throw branch.
        expect(() => bootstrapOpenTelemetry()).not.toThrow();
      } finally {
        stderrSpy.mockRestore();
        if (prev === undefined) delete process.env.OTEL_ENABLED;
        else process.env.OTEL_ENABLED = prev;
      }
    });

    it('getTracer returns a tracer object', () => {
      const t = getTracer();
      expect(t).toBeDefined();
      expect(typeof t.startActiveSpan).toBe('function');
    });

    it('withSpan executes the body + propagates the return value', async () => {
      const v = await withSpan('my-span', { foo: 'bar', count: 1, ok: true }, async () => 42);
      expect(v).toBe(42);
    });

    it('withSpan records exception on throw + rethrows', async () => {
      await expect(
        withSpan('failing-span', { kind: 'db' }, async () => {
          throw new Error('span-boom');
        }),
      ).rejects.toThrow(/span-boom/);
    });

    it('withSpan ignores undefined attribute values', async () => {
      const v = await withSpan(
        'partial-attrs',
        { defined: 'x', undefinedAttr: undefined },
        async () => 'done',
      );
      expect(v).toBe('done');
    });
  });
});
