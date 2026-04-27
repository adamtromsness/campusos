import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Kafka, Producer } from 'kafkajs';

/**
 * KafkaProducerService — best-effort Kafka producer.
 *
 * Connects on module init. If the broker is unreachable (common in dev when
 * docker-compose hasn't started Kafka), the service logs a warning and
 * silently no-ops on subsequent emits — request handling is never blocked.
 *
 * Cycle 1 emits but does not consume; consumers land in Cycle 3
 * (Communications). Best-effort delivery is acceptable for this cycle's
 * scope. When the consumer side is real, harden this with retries and
 * a dead-letter table.
 *
 * TODO(Cycle 3 / ADR-057): wrap every payload in the standard event
 * envelope before producing — required as soon as the first consumer
 * lands. Envelope fields per ADR-057:
 *   - event_id        UUIDv7 (idempotency / dedupe key for consumers)
 *   - event_version   schema version of the inner payload (e.g. "1.0")
 *   - event_type      duplicate of `topic` for in-payload routing
 *   - tenant_id       schoolId from the current tenant context
 *   - correlation_id  request id propagated from the API request
 *   - occurred_at     ISO-8601 timestamp the domain event happened at
 *   - producer        "campusos-api" (hardcoded; matches clientId)
 *   - data            the existing payload, untouched
 * Until then, payloads are raw — consumers in Cycle 3 must accept this.
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
   * @param topic   Topic name, e.g. 'att.attendance.marked'
   * @param key     Partitioning/ordering key (often the entity id)
   * @param payload JSON-serializable payload
   * @param headers Optional headers (correlation id, schema version, etc.)
   */
  async emit(
    topic: string,
    key: string,
    payload: unknown,
    headers?: Record<string, string>,
  ): Promise<void> {
    if (!this.connected || !this.producer) {
      this.logger.debug('[skip-emit] ' + topic + ' key=' + key);
      return;
    }
    try {
      var msg: any = { key: key, value: JSON.stringify(payload) };
      if (headers) msg.headers = headers;
      await this.producer.send({ topic: topic, messages: [msg] });
    } catch (e: any) {
      this.logger.warn('Failed to emit ' + topic + ' (key=' + key + '): ' + (e?.message || e));
    }
  }
}
