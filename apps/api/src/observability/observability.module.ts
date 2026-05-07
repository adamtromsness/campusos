import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { ReferenceHealthScannerWorker } from './reference-health/reference-health.worker';
import { RequestLogMiddleware } from './request-log.middleware';
import { TraceIdMiddleware } from './trace-id.middleware';

/**
 * Cycle 31 Step 1 — Observability Module.
 *
 * Wires the TraceIdMiddleware globally. NestJS applies module
 * middleware in registration order, so this module is imported
 * BEFORE TenantModule in AppModule.imports — that way the trace
 * context is established before tenant resolution and the tenant
 * middleware's own log lines carry trace_id.
 *
 * Step 2 (OpenTelemetry SDK) drops in via main.ts before
 * NestFactory.create so its auto-instrumentation captures the very
 * earliest request handlers; this module's middleware-level
 * fallback stays in place for the (rare) case where the OTel SDK is
 * not bootstrapped (e.g. unit tests).
 */
@Module({
  imports: [TenantModule],
  providers: [
    TraceIdMiddleware,
    RequestLogMiddleware,
    MetricsService,
    ReferenceHealthScannerWorker,
  ],
  controllers: [MetricsController],
  exports: [MetricsService],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Order matters: TraceIdMiddleware sets the AsyncLocalStorage
    // context first; RequestLogMiddleware reads from it on finish
    // and records the http_request_duration_seconds histogram.
    consumer.apply(TraceIdMiddleware, RequestLogMiddleware).forRoutes('*');
  }
}
