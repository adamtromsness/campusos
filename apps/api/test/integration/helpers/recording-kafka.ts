import type { EmitOptions, KafkaProducerService } from '@shared/kafka/kafka-producer.service';

/**
 * Captured Kafka emit. Mirrors the EmitOptions shape but with payload
 * narrowed to `unknown` so tests can `expect(call.payload).toMatchObject(...)`
 * without fighting generics.
 */
export interface RecordedEmit {
  topic: string;
  key: string;
  payload: unknown;
  sourceModule: string;
  eventId?: string;
  correlationId?: string;
  tenantId?: string;
  tenantSubdomain?: string;
  eventVersion?: number;
  occurredAt?: string;
  headers?: Record<string, string>;
}

/**
 * Stand-in for KafkaProducerService. Records every emit() call into an
 * in-memory array so tests can assert on topic / payload / source module
 * without needing a live Kafka broker.
 *
 * Per D4 in docs/procurement-integration-test-harness.md: "no real Kafka
 * dependency for tests; the DATABASE-BACKED rule is about DB queries, not
 * transport. Recording shim is more explicit and reusable than vi.fn()."
 *
 * Tests cast the instance to KafkaProducerService for the constructor:
 *   const kafka = new RecordingKafkaProducer();
 *   const service = new RequisitionService(
 *     tenantPrisma,
 *     kafka as unknown as KafkaProducerService,
 *     financeValidation,
 *   );
 *
 * Between tests, call kafka.reset() to clear captured calls.
 */
export class RecordingKafkaProducer {
  private readonly _calls: RecordedEmit[] = [];

  /** Read-only snapshot of every emit() call captured so far. */
  get calls(): readonly RecordedEmit[] {
    return this._calls;
  }

  /** Filter captured calls by topic. */
  callsForTopic(topic: string): RecordedEmit[] {
    return this._calls.filter((c) => c.topic === topic);
  }

  /** Wipe captured calls. Call this in beforeEach. */
  reset(): void {
    this._calls.length = 0;
  }

  async emit<P = unknown>(opts: EmitOptions<P>): Promise<void> {
    this._calls.push({
      topic: opts.topic,
      key: opts.key,
      payload: opts.payload,
      sourceModule: opts.sourceModule,
      eventId: opts.eventId,
      correlationId: opts.correlationId,
      tenantId: opts.tenantId,
      tenantSubdomain: opts.tenantSubdomain,
      eventVersion: opts.eventVersion,
      occurredAt: opts.occurredAt,
      headers: opts.headers,
    });
  }

  /**
   * Not used by procurement services. Included so the cast to
   * KafkaProducerService stays type-clean for callers that touch
   * the DLQ replay path.
   */
  async emitRaw(): Promise<void> {
    // no-op
  }
}

/**
 * Convenience cast: returns a fresh RecordingKafkaProducer typed as
 * KafkaProducerService so it drops into service constructors without
 * the `as unknown as` dance at every callsite.
 */
export function makeRecordingKafka(): RecordingKafkaProducer & KafkaProducerService {
  return new RecordingKafkaProducer() as unknown as RecordingKafkaProducer & KafkaProducerService;
}
