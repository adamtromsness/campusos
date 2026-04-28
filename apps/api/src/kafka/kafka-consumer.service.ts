import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Consumer, Kafka } from 'kafkajs';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';

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
}

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
  }): Promise<void> {
    var sub: Subscription = {
      topics: opts.topics,
      groupId: opts.groupId,
      handler: opts.handler,
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
   * Persist a poison message to `platform.platform_dlq_messages`. Best-effort:
   * if the DLQ insert itself fails, log and swallow so the consumer can move
   * on rather than retrying both the original message and the DLQ insert.
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
        'DLQ write failed for group=' +
          groupId +
          ' topic=' +
          params.topic +
          ': ' +
          (e?.stack || e?.message || e),
      );
    }
  }
}
