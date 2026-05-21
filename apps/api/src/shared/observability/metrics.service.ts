import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Histogram, register } from 'prom-client';
import { CircuitBreaker, CircuitState } from './circuit-breaker';

/**
 * Cycle 31 Step 3 — Prometheus Metrics.
 *
 * Exposes the histograms, gauges, and counters listed in the
 * cycle-31 plan + Architecture Review §25.4.
 *
 * Metric naming follows Prometheus conventions:
 *   - histograms have `_seconds` / `_total` suffix as appropriate
 *   - gauges describe current state (no suffix)
 *   - counters end in `_total`
 *   - per-tenant labels live on counters / gauges so noisy-neighbour
 *     dashboards can filter by tenant_id; histograms intentionally
 *     skip the tenant label to keep cardinality bounded.
 *
 * The /metrics endpoint is served by MetricsController under the
 * top-level path (NOT under /api/v1) so the Prometheus scraper can
 * hit it without bearer auth — protected by the ObservabilityModule
 * controller decorators (TODO Step 7) + network ACLs in production.
 */
@Injectable()
export class MetricsService {
  private static initialised = false;

  readonly httpRequestDuration: Histogram<string>;
  readonly httpRequestsTotal: Counter<string>;
  readonly dbQueryDuration: Histogram<string>;
  readonly kafkaProduceDuration: Histogram<string>;
  readonly kafkaMessagesProduced: Counter<string>;
  readonly kafkaMessagesConsumed: Counter<string>;
  readonly kafkaConsumerLag: Gauge<string>;
  readonly dbConnectionPoolActive: Gauge<string>;
  readonly dbConnectionPoolIdle: Gauge<string>;
  readonly redisCacheHits: Counter<string>;
  readonly redisCacheMisses: Counter<string>;
  readonly dlqMessagesTotal: Counter<string>;
  readonly circuitBreakerState: Gauge<string>;

  constructor() {
    // Prevent double-registration when NestJS hot-reloads in dev /
    // a module is imported twice in tests. prom-client throws on
    // duplicate metric names so we guard both with a class-level flag
    // (handles two `new MetricsService()` calls inside the same module
    // load) AND with a check on the global registry (handles vitest
    // module isolation, where the static flag resets per file load
    // but `register` from prom-client is process-global).
    if (!MetricsService.initialised && !register.getSingleMetric('process_cpu_user_seconds_total')) {
      collectDefaultMetrics({ register });
      MetricsService.initialised = true;
    } else {
      MetricsService.initialised = true;
    }

    this.httpRequestDuration = this.getOrCreateHistogram(
      'http_request_duration_seconds',
      'HTTP request duration by route and status',
      ['method', 'route', 'status_code'],
      [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    );
    this.httpRequestsTotal = this.getOrCreateCounter('http_requests_total', 'Total HTTP requests', [
      'method',
      'route',
      'status_code',
      'tenant_id',
    ]);
    this.dbQueryDuration = this.getOrCreateHistogram(
      'db_query_duration_seconds',
      'Database query duration by module',
      ['module', 'operation'],
      [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
    );
    this.kafkaProduceDuration = this.getOrCreateHistogram(
      'kafka_produce_duration_seconds',
      'Kafka produce duration',
      ['topic'],
      [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
    );
    this.kafkaMessagesProduced = this.getOrCreateCounter(
      'kafka_messages_produced_total',
      'Kafka messages produced',
      ['topic', 'tenant_id'],
    );
    this.kafkaMessagesConsumed = this.getOrCreateCounter(
      'kafka_messages_consumed_total',
      'Kafka messages consumed',
      ['topic', 'consumer_group', 'tenant_id'],
    );
    this.kafkaConsumerLag = this.getOrCreateGauge(
      'kafka_consumer_lag',
      'Kafka consumer lag (messages) per topic/partition',
      ['topic', 'partition', 'consumer_group'],
    );
    this.dbConnectionPoolActive = this.getOrCreateGauge(
      'db_connection_pool_active',
      'Active database connections in the pool',
      ['pool'],
    );
    this.dbConnectionPoolIdle = this.getOrCreateGauge(
      'db_connection_pool_idle',
      'Idle database connections in the pool',
      ['pool'],
    );
    this.redisCacheHits = this.getOrCreateCounter(
      'redis_cache_hits_total',
      'Redis cache hits by cache key prefix',
      ['cache'],
    );
    this.redisCacheMisses = this.getOrCreateCounter(
      'redis_cache_misses_total',
      'Redis cache misses by cache key prefix',
      ['cache'],
    );
    this.dlqMessagesTotal = this.getOrCreateCounter(
      'dlq_messages_total',
      'Messages parked into DLQ by consumer group',
      ['consumer_group', 'error_class'],
    );
    this.circuitBreakerState = this.getOrCreateGauge(
      'circuit_breaker_state',
      'Circuit breaker state per dependency (0=closed, 1=open, 2=half-open)',
      ['dependency'],
    );
  }

  async render(): Promise<string> {
    return register.metrics();
  }

  contentType(): string {
    return register.contentType;
  }

  /**
   * Helper used by RequestLogMiddleware (Step 1) to record per-request
   * latency. Accepts the route path + status + duration_ms.
   */
  recordHttpRequest(args: {
    method: string;
    route: string;
    statusCode: number;
    durationMs: number;
    tenantId: string | null;
  }): void {
    this.httpRequestDuration
      .labels(args.method, args.route, String(args.statusCode))
      .observe(args.durationMs / 1000);
    this.httpRequestsTotal
      .labels(args.method, args.route, String(args.statusCode), args.tenantId ?? '__none__')
      .inc();
  }

  /**
   * Bind a CircuitBreaker to the `circuit_breaker_state` Prometheus
   * gauge. Call this exactly once per breaker, immediately after the
   * `new CircuitBreaker(...)` constructor in the owning module. The
   * gauge is set to the current state on bind and on every subsequent
   * transition. State→numeric mapping matches the gauge help text:
   * 0=closed, 1=open, 2=half-open.
   *
   * REVIEW-FINAL-2026-05-07 OBS-9.2 fix — the CircuitBreaker class
   * shipped the onStateChange listener pipeline in Cycle 31 Step 7
   * but no production wiring existed; the gauge was declared but
   * never populated. Future breaker call sites should use this helper
   * so the Step 8 alert rule "1-minute sustained OPEN on any breaker
   * tagged dependency=critical" actually fires.
   */
  bindCircuitBreaker(breaker: CircuitBreaker, dependency: string): void {
    const stateToNumber = (state: CircuitState): number => {
      if (state === 'CLOSED') return 0;
      if (state === 'OPEN') return 1;
      return 2; // HALF_OPEN
    };
    // Set initial state.
    this.circuitBreakerState.labels(dependency).set(stateToNumber(breaker.getState()));
    // Update on every transition.
    breaker.onStateChange((dep, state) => {
      this.circuitBreakerState.labels(dep).set(stateToNumber(state));
    });
  }

  // The getOrCreate* helpers handle prom-client's strict
  // double-registration error on hot reload in dev / tests.
  private getOrCreateHistogram(
    name: string,
    help: string,
    labelNames: string[],
    buckets: number[],
  ): Histogram<string> {
    const existing = register.getSingleMetric(name);
    if (existing) return existing as Histogram<string>;
    return new Histogram({ name, help, labelNames, buckets });
  }

  private getOrCreateCounter(name: string, help: string, labelNames: string[]): Counter<string> {
    const existing = register.getSingleMetric(name);
    if (existing) return existing as Counter<string>;
    return new Counter({ name, help, labelNames });
  }

  private getOrCreateGauge(name: string, help: string, labelNames: string[]): Gauge<string> {
    const existing = register.getSingleMetric(name);
    if (existing) return existing as Gauge<string>;
    return new Gauge({ name, help, labelNames });
  }
}
