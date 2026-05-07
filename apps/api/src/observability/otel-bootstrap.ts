import { trace, type Tracer } from '@opentelemetry/api';

/**
 * Cycle 31 Step 2 — OpenTelemetry Bootstrap.
 *
 * Lazy-activates the @opentelemetry/sdk-node + auto-instrumentations
 * pipeline when `OTEL_ENABLED=true` is set in the deploy environment.
 *
 * In dev / test the full SDK stays uninstalled — only the public
 * `@opentelemetry/api` surface ships in node_modules. Calls to
 * `tracer.startSpan()` resolve to the no-op tracer until the SDK is
 * loaded, so the codebase can pepper in `tracer.startSpan()` calls
 * without paying the cold-start cost or the 50+ transitive-dep
 * install when OTel is off.
 *
 * To enable in production:
 *
 *   pnpm --filter @campusos/api add @opentelemetry/sdk-node \
 *     @opentelemetry/auto-instrumentations-node \
 *     @opentelemetry/exporter-trace-otlp-http
 *
 *   OTEL_ENABLED=true \
 *   OTEL_SERVICE_NAME=campusos-api \
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 \
 *   node dist/main.js
 *
 * Backends supported: Jaeger (dev), AWS X-Ray (prod), Tempo, Honeycomb,
 * Datadog — anything that speaks OTLP/HTTP.
 *
 * Architecture Review §25.3 — distributed tracing across HTTP →
 * service → DB → Kafka → consumer → extracted service.
 */

const TRACER_NAME = 'campusos-api';

export function bootstrapOpenTelemetry(): void {
  if (process.env.OTEL_ENABLED !== 'true') {
    return;
  }
  // Lazy-require so the SDK package is only loaded in production
  // images where the deploy step has installed it. The require is in
  // a try/catch so a misconfigured prod (env=true, packages missing)
  // logs a clear error rather than crashing the boot.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');

    const sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter({
        url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT
          ? process.env.OTEL_EXPORTER_OTLP_ENDPOINT + '/v1/traces'
          : undefined,
      }),
      instrumentations: [
        getNodeAutoInstrumentations({
          // Disable noisy fs instrumentation; keep HTTP, pg, ioredis, kafkajs.
          '@opentelemetry/instrumentation-fs': { enabled: false },
        }),
      ],
    });
    sdk.start();
    process.on('SIGTERM', () => {
      sdk.shutdown().catch(() => undefined);
    });
  } catch (err) {
    // Don't crash boot — log and continue with the no-op tracer.
    process.stderr.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'WARN',
        service_name: process.env.SERVICE_NAME ?? 'campusos-api',
        message: 'OTEL_ENABLED=true but @opentelemetry/sdk-node not installed — tracing disabled',
        error_class: err instanceof Error ? err.constructor.name : 'Unknown',
      }) + '\n',
    );
  }
}

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Helper: run `fn` inside a span. The span ends automatically when
 * `fn` resolves or throws. The OTel API's `withActiveSpan` shape is
 * inverted from the AsyncLocalStorage idiom this codebase uses
 * elsewhere, so this helper smooths it over.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return await tracer.startActiveSpan(name, async (span) => {
    try {
      for (const [key, value] of Object.entries(attributes)) {
        if (value !== undefined) span.setAttribute(key, value);
      }
      const result = await fn();
      span.end();
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: 2 /* ERROR */ });
      span.end();
      throw err;
    }
  });
}
