import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Kafka, Producer } from 'kafkajs';
import { getCurrentTenant } from '../tenant/tenant.context';
import {
  EnvelopeOptions,
  EventEnvelope,
  envelopeFromOptions,
  prefixedTopic,
} from './event-envelope';

/**
 * Inputs for `KafkaProducerService.emit()`. Combines the routing fields
 * (topic, key, optional headers) with the envelope inputs. Producers
 * normally only set `topic` / `key` / `payload` / `sourceModule` and
 * let the envelope builder fill in the rest from the request context.
 *
 * `tenantId` + `tenantSubdomain` are only needed for worker-originated
 * emits where there's no request context (e.g. a future audience
 * fan-out worker republishing an internal event). Request-path emits
 * pull both from `getCurrentTenant()`.
 */
export interface EmitOptions<P = unknown> {
  topic: string;
  key: string;
  payload: P;
  sourceModule: string;
  eventVersion?: number;
  occurredAt?: string;
  tenantId?: string;
  tenantSubdomain?: string;
  correlationId?: string;
  /** Extra Kafka headers, merged on top of the default envelope routing headers. */
  headers?: Record<string, string>;
}

/**
 * KafkaProducerService — best-effort Kafka producer with the ADR-057
 * canonical event envelope.
 *
 * Cycle 3 Step 0 lifted every emit onto the canonical envelope:
 *   - Domain payload now sits under `envelope.payload`.
 *   - `event_id`, `tenant_id`, `correlation_id`, `event_type`,
 *     `event_version`, `occurred_at`, `published_at`, `source_module`
 *     are all populated by the producer.
 *   - Topics get an env prefix on the wire (`dev.att.…`) so
 *     environments sharing a Kafka cluster never cross-pollinate.
 *   - Three transport headers — `event-id`, `tenant-id`,
 *     `tenant-subdomain` — stay set for backward compatibility with
 *     consumers that haven't migrated to envelope reads (the only one
 *     in the system today is `GradebookSnapshotWorker`, which reads
 *     envelope first and falls back to headers). Headers also let a
 *     consumer dedupe before parsing the body.
 *
 * Connection:
 *   - Connects on module init.
 *   - If the broker is unreachable (common in dev when docker-compose
 *     hasn't started Kafka), the service logs a warning and silently
 *     no-ops on subsequent emits — request handling is never blocked.
 */
@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaProducerService.name);
  private producer: Producer | null = null;
  private connected = false;

  async onModuleInit(): Promise<void> {
    var brokerList = process.env.KAFKA_BROKERS || 'localhost:9092';
    var brokers = brokerList
      .split(',')
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
    var kafka = new Kafka({
      clientId: 'campusos-api',
      brokers: brokers,
      retry: { retries: 1, initialRetryTime: 100 },
      logLevel: 1,
    });
    this.producer = kafka.producer({ allowAutoTopicCreation: true });
    try {
      await this.producer.connect();
      this.connected = true;
      this.logger.log('Connected to Kafka brokers: ' + brokers.join(', '));
    } catch (e: any) {
      this.connected = false;
      this.logger.warn(
        'Kafka unavailable; events will be skipped (best-effort mode). ' + (e?.message || e),
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.connected && this.producer) {
      try {
        await this.producer.disconnect();
      } catch (e: any) {
        this.logger.warn('Kafka disconnect error: ' + (e?.message || e));
      }
    }
  }

  /**
   * Emit a single event. Never throws — failures are logged.
   *
   * The payload is wrapped in the ADR-057 envelope before send. The
   * three transport headers (`event-id`, `tenant-id`,
   * `tenant-subdomain`) are also set for legacy consumers that read
   * routing fields from headers. The wire topic is env-prefixed via
   * `prefixedTopic()`.
   */
  async emit<P = unknown>(opts: EmitOptions<P>): Promise<void> {
    if (!this.connected || !this.producer) {
      this.logger.debug('[skip-emit] ' + opts.topic + ' key=' + opts.key);
      return;
    }

    var envelopeOpts: EnvelopeOptions<P> = {
      eventType: opts.topic,
      payload: opts.payload,
      sourceModule: opts.sourceModule,
      eventVersion: opts.eventVersion,
      occurredAt: opts.occurredAt,
      tenantId: opts.tenantId,
      correlationId: opts.correlationId,
    };
    var envelope: EventEnvelope<P>;
    try {
      envelope = envelopeFromOptions(envelopeOpts);
    } catch (e: any) {
      this.logger.warn('Failed to build envelope for ' + opts.topic + ': ' + (e?.message || e));
      return;
    }

    // Resolve tenant subdomain for the legacy `tenant-subdomain` header.
    // Prefer the explicit option (worker-originated emit); else pull from
    // the request context. If neither is available we still emit — the
    // envelope already carries `tenant_id` so the payload isn't unscoped;
    // the only loss is the legacy header for header-only consumers.
    var subdomain = opts.tenantSubdomain;
    if (!subdomain) {
      try {
        subdomain = getCurrentTenant().subdomain;
      } catch {
        subdomain = undefined;
      }
    }

    var headers: Record<string, string> = {
      'event-id': envelope.event_id,
      'event-type': envelope.event_type,
      'tenant-id': envelope.tenant_id,
    };
    if (subdomain) headers['tenant-subdomain'] = subdomain;
    if (opts.headers) {
      for (var k in opts.headers) {
        if (Object.prototype.hasOwnProperty.call(opts.headers, k)) {
          headers[k] = opts.headers[k]!;
        }
      }
    }

    try {
      var wireTopic = prefixedTopic(opts.topic);
      await this.producer.send({
        topic: wireTopic,
        messages: [
          {
            key: opts.key,
            value: JSON.stringify(envelope),
            headers: headers,
          },
        ],
      });
    } catch (e: any) {
      this.logger.warn(
        'Failed to emit ' + opts.topic + ' (key=' + opts.key + '): ' + (e?.message || e),
      );
    }
  }
}
