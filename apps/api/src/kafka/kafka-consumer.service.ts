import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Consumer, Kafka } from 'kafkajs';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { assertValidEnvelope, EnvelopeValidationError } from './envelope-validator';
import { unprefixTopic } from './event-envelope';

/**
 * Message shape delivered to a registered handler. Headers are flattened to
 * a string map for ergonomics — kafkajs keeps them as Buffers under the hood.
 */
export interface ConsumedMessage {
  topic: string;
  partition: number;
  key: string | null;
  headers: Record<string, string>;
  payload: unknown;
  timestamp: string;
}

export type MessageHandler = (msg: ConsumedMessage) => Promise<void>;

interface Subscription {
  topics: string[];
  groupId: string;
  handler: MessageHandler;
  validateEnvelope?: boolean;
}

/**
 * REVIEW-CYCLE31 BLOCKING 6 — Cycle 31 Step 7 envelope validation is
 * enforced centrally here unless a subscription opts out via
 * `validateEnvelope: false`. Default ON so every consumer gets the
 * ADR-057 contract for free; legacy consumers that haven't been
 * migrated yet can opt out, but their handoff line should explicitly
 * call out that they accept their own envelope shape.
 */
const ENVELOPE_VALIDATION_DEFAULT = true;

/**
 * KafkaConsumerService — Kafka consumer registry with bounded retry + DLQ.
 *
 * Step 6 (Cycle 2) introduced the first Kafka consumer (GradebookSnapshotWorker).
 * Domain workers call subscribe() during onModuleInit with their topics, group
 * id, and handler. Each subscription gets its own kafkajs Consumer so group
 * offsets are tracked independently.
 *
 * Failure semantics (REVIEW-CYCLE3 BLOCKING 1):
 *   - If a handler throws, KafkaConsumerService rethrows so kafkajs retains
 *     the offset and re-delivers the message. This is the at-least-once path
 *     the notification consumers need — they read-only-check idempotency on
 *     arrival, process, then claim() only on success, so a redeliver is
 *     harmless.
 *   - To prevent a single poison message from blocking a partition forever,
 *     we keep an in-memory `(groupId, topic, partition, offset) → attempts`
 *     map. Once attempts crosses MAX_HANDLER_ATTEMPTS (default 5) we write a
 *     `platform.platform_dlq_messages` row with the original headers + payload
 *     + error and swallow the throw so kafkajs commits the offset. Operators
 *     can replay or resolve the DLQ row out of band.
 *   - The attempts map is cleared on success so the entry doesn't leak.
 *
 * Connection strategy mirrors KafkaProducerService:
 *   - Connects on module init.
 *   - If the broker is unreachable, logs a warning and silently no-ops.
 *     Subsequent subscribe() calls are remembered but never wire up to
 *     a real consumer until a redeploy. Local dev without docker-compose
 *     up is the dominant case and shouldn't crash the API.
 */
const MAX_HANDLER_ATTEMPTS = Number(process.env.KAFKA_MAX_HANDLER_ATTEMPTS || 5);

@Injectable()
export class KafkaConsumerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(KafkaConsumerService.name);
  private kafka: Kafka | null = null;
  private connected = false;
  private readonly consumers: Consumer[] = [];
  private readonly pendingSubscriptions: Subscription[] = [];
  // Per-message attempt counter keyed by `groupId:topic:partition:offset`.
  // Cleared on success or after a DLQ write so the map doesn't leak.
  private readonly attempts: Map<string, number> = new Map();

  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async onModuleInit(): Promise<void> {
    var brokerList = process.env.KAFKA_BROKERS || 'localhost:9092';
    var brokers = brokerList
      .split(',')
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
    this.kafka = new Kafka({
      clientId: 'campusos-api-consumer',
      brokers: brokers,
      retry: { retries: 3, initialRetryTime: 200 },
      logLevel: 1,
    });
    this.connected = true;
    this.logger.log('KafkaConsumerService ready (brokers=' + brokers.join(',') + ')');
  }

  async onApplicationShutdown(): Promise<void> {
    for (var i = 0; i < this.consumers.length; i++) {
      try {
        await this.consumers[i]!.disconnect();
      } catch (e: any) {
        this.logger.warn('Consumer disconnect error: ' + (e?.message || e));
      }
    }
  }

  /**
   * Register a handler for one or more topics under a consumer group.
   *
   * Best-effort: if Kafka is unreachable at boot, the subscription is logged
   * and skipped (dev-mode without docker-compose).
   *
   * Once running, handler failures rethrow so kafkajs can retain the offset
   * and retry. After MAX_HANDLER_ATTEMPTS retries on the same
   * `(group, topic, partition, offset)` we write a DLQ row and swallow so the
   * partition can move on. See class doc.
   */
  async subscribe(opts: {
    topics: string[];
    groupId: string;
    handler: MessageHandler;
    fromBeginning?: boolean;
    /**
     * REVIEW-CYCLE31 BLOCKING 6 — when true (default) every message
     * is run through assertValidEnvelope() before dispatching to the
     * handler. Failures park to DLQ with error_class=ENVELOPE_INVALID
     * and never reach the handler. Set false only if the consumer
     * accepts a non-ADR-057 envelope shape.
     */
    validateEnvelope?: boolean;
  }): Promise<void> {
    var validateEnvelope =
      opts.validateEnvelope === undefined ? ENVELOPE_VALIDATION_DEFAULT : opts.validateEnvelope;
    var sub: Subscription = {
      topics: opts.topics,
      groupId: opts.groupId,
      handler: opts.handler,
      validateEnvelope: validateEnvelope,
    };
    this.pendingSubscriptions.push(sub);

    if (!this.connected || !this.kafka) {
      this.logger.warn(
        '[skip-subscribe] groupId=' + opts.groupId + ' topics=' + opts.topics.join(','),
      );
      return;
    }

    var consumer = this.kafka.consumer({
      groupId: opts.groupId,
      sessionTimeout: 30000,
      heartbeatInterval: 3000,
    });
    var logger = this.logger;
    var self = this;
    try {
      await consumer.connect();
      for (var i = 0; i < opts.topics.length; i++) {
        await consumer.subscribe({
          topic: opts.topics[i]!,
          fromBeginning: opts.fromBeginning === true,
        });
      }
      var handler = opts.handler;
      var groupId = opts.groupId;
      await consumer.run({
        eachMessage: async function (params: any) {
          var rawHeaders = params.message.headers || {};
          var headers: Record<string, string> = {};
          for (var key in rawHeaders) {
            if (Object.prototype.hasOwnProperty.call(rawHeaders, key)) {
              var hv = rawHeaders[key];
              if (hv === null || hv === undefined) continue;
              headers[key] = typeof hv === 'string' ? hv : Buffer.from(hv).toString('utf8');
            }
          }
          var payload: unknown = null;
          if (params.message.value) {
            try {
              payload = JSON.parse(params.message.value.toString('utf8'));
            } catch (e: any) {
              logger.warn('Failed to parse payload on ' + params.topic + ': ' + (e?.message || e));
              // Malformed JSON cannot succeed on retry. Park it directly.
              await self.dlq(
                groupId,
                params,
                headers,
                params.message.value ? params.message.value.toString('utf8') : null,
                e,
                1,
              );
              return;
            }
          }
          // REVIEW-CYCLE31 BLOCKING 6 — central envelope validation.
          // The helper validates every ADR-057 field. Validation
          // failures cannot succeed on retry; park directly to DLQ
          // with error_class=ENVELOPE_INVALID and advance the offset.
          //
          // REVIEW-FINAL-V2 MAJOR-NEW-6 — also enforce topic/event_type
          // pairing. The wire topic is env-prefixed (e.g.
          // `dev.pay.invoice.created`); the un-prefixed form is the
          // expected logical event_type that must match the envelope.
          // Without this check, a misrouted producer or a replay can
          // deliver a `pay.invoice.created` envelope on the
          // `pay.payment.received` topic and the consumer will
          // dispatch on the topic, interpreting the payload through
          // the wrong handler. Mismatch → DLQ.
          if (validateEnvelope) {
            try {
              var expectedEventType = unprefixTopic(params.topic);
              assertValidEnvelope(payload, expectedEventType);
            } catch (e: any) {
              var validationErr =
                e instanceof EnvelopeValidationError ? e : new EnvelopeValidationError(String(e));
              logger.warn(
                'Envelope validation failed on ' + params.topic + ': ' + validationErr.message,
              );
              await self.dlq(groupId, params, headers, payload, validationErr, 1);
              return;
            }
          }
          var msg: ConsumedMessage = {
            topic: params.topic,
            partition: params.partition,
            key: params.message.key ? params.message.key.toString('utf8') : null,
            headers: headers,
            payload: payload,
            timestamp: params.message.timestamp,
          };
          var attemptKey =
            groupId +
            ':' +
            params.topic +
            ':' +
            params.partition +
            ':' +
            String(params.message.offset);
          try {
            await handler(msg);
            // Success — clear the in-memory attempts entry so it doesn't leak.
            self.attempts.delete(attemptKey);
          } catch (e: any) {
            var attempts = (self.attempts.get(attemptKey) || 0) + 1;
            self.attempts.set(attemptKey, attempts);
            logger.error(
              'Handler error on ' +
                msg.topic +
                ' (key=' +
                (msg.key || '-') +
                ', attempts=' +
                attempts +
                '/' +
                MAX_HANDLER_ATTEMPTS +
                '): ' +
                (e?.stack || e?.message || e),
            );
            if (attempts >= MAX_HANDLER_ATTEMPTS) {
              // Park to DLQ + swallow so kafkajs commits and the partition
              // can advance past the poison message.
              await self.dlq(groupId, params, headers, payload, e, attempts);
              self.attempts.delete(attemptKey);
              return;
            }
            // Rethrow so kafkajs retains the offset and redelivers — this is
            // the at-least-once retry path. Notification consumers' claim-
            // after-success idempotency makes the redeliver harmless.
            throw e;
          }
        },
      });
      this.consumers.push(consumer);
      this.logger.log('Subscribed: groupId=' + opts.groupId + ' topics=' + opts.topics.join(','));
    } catch (e: any) {
      this.connected = false;
      this.logger.warn(
        'Kafka unavailable for consumer groupId=' +
          opts.groupId +
          ' — events will be skipped. ' +
          (e?.message || e),
      );
      try {
        await consumer.disconnect();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Persist a poison message to `platform.platform_dlq_messages`.
   *
   * REVIEW-FINAL-V2-2026-05-07 MAJOR-NEW-5 — fail closed on DLQ
   * write failure. The earlier shape caught and swallowed insert
   * errors so the consumer could "move on", but that meant a
   * platform-DB outage during a poison message would lose the
   * event from BOTH the Kafka retry path (because the partition
   * is committed past) AND the DLQ (because the insert failed).
   * For a school operating system handling finance + safety-
   * critical events, silent loss is worse than a blocked partition.
   *
   * The new contract:
   *   - Insert succeeds → log + return normally; caller advances
   *     past the poison message.
   *   - Insert fails → throw `DlqWriteFailureError`. The caller
   *     (`eachMessage` in `subscribe`) lets this propagate, kafkajs
   *     retains the offset, and the partition blocks until the
   *     platform DB recovers and a redelivery succeeds in writing
   *     the DLQ row.
   *
   * The trade-off is one blocked partition per affected consumer
   * group during platform-DB outages. That is the right trade for
   * a financial / safety system: an operator can see the partition
   * lag in metrics + page on the alert; silent message loss is
   * undetectable until a downstream invariant fails much later.
   */
  private async dlq(
    groupId: string,
    params: any,
    headers: Record<string, string>,
    payload: unknown,
    err: unknown,
    attempts: number,
  ): Promise<void> {
    try {
      var pclient = this.tenantPrisma.getPlatformClient();
      var eventId = headers['event-id'] || (payload as any)?.event_id || null;
      var tenantId = headers['tenant-id'] || (payload as any)?.tenant_id || null;
      var errMsg =
        (err as any)?.message || (typeof err === 'string' ? err : JSON.stringify(err)) || 'unknown';
      var errClass = (err as any)?.name || 'Error';
      var payloadJson: any = payload === null || payload === undefined ? {} : payload;
      var headersJson: any = headers || {};
      await pclient.$executeRawUnsafe(
        'INSERT INTO platform.platform_dlq_messages ' +
          ' (id, topic, partition, kafka_offset, consumer_group, event_id, tenant_id, ' +
          '  payload, headers, error_message, error_class, retry_count) ' +
          'VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8::jsonb, $9::jsonb, $10, $11, $12)',
        generateId(),
        params.topic,
        params.partition,
        Number(params.message.offset),
        groupId,
        eventId,
        tenantId,
        JSON.stringify(payloadJson),
        JSON.stringify(headersJson),
        errMsg.slice(0, 4000),
        errClass.slice(0, 200),
        attempts,
      );
      this.logger.warn(
        'Parked to DLQ: group=' +
          groupId +
          ' topic=' +
          params.topic +
          ' partition=' +
          params.partition +
          ' offset=' +
          String(params.message.offset),
      );
    } catch (e: any) {
      this.logger.error(
        'DLQ write FAILED for group=' +
          groupId +
          ' topic=' +
          params.topic +
          ' partition=' +
          params.partition +
          ' offset=' +
          String(params.message.offset) +
          ' — partition will block until platform DB recovers. ' +
          (e?.stack || e?.message || e),
      );
      // Fail closed — propagate so kafkajs retains the offset.
      throw new DlqWriteFailureError(
        'Failed to persist DLQ row for group=' +
          groupId +
          ' topic=' +
          params.topic +
          ': ' +
          (e?.message || e),
      );
    }
  }
}

/**
 * Thrown when `platform.platform_dlq_messages` insert fails. The
 * `eachMessage` handler lets this propagate so kafkajs retains the
 * offset; the partition blocks until the platform DB recovers.
 *
 * Operators detect the blocked partition via `kafka_consumer_lag`
 * metric and the on-call DLQ-storage-unavailable alert. Recovery
 * is automatic on the next redelivery once the DB is back.
 */
export class DlqWriteFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DlqWriteFailureError';
  }
}
