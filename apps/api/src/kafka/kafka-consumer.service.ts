import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { Consumer, Kafka } from 'kafkajs';

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
 * KafkaConsumerService — best-effort Kafka consumer registry.
 *
 * Step 6 (Cycle 2) introduces the first Kafka consumer in the system
 * (GradebookSnapshotWorker). This service is the shared registry: domain
 * workers call subscribe() during onModuleInit with their topics, group
 * id, and handler. Each subscription gets its own kafkajs Consumer so
 * group offsets are tracked independently.
 *
 * Connection strategy mirrors KafkaProducerService:
 *   - Connects on module init.
 *   - If the broker is unreachable, logs a warning and silently no-ops.
 *     Subsequent subscribe() calls are remembered but never wire up to
 *     a real consumer until a redeploy. Local dev without docker-compose
 *     up is the dominant case and shouldn't crash the API.
 *
 * Future hardening (post-Cycle 3, when the canonical envelope lands):
 *   - Retry / DLQ semantics for handler failures
 *   - Pause/resume on backpressure
 *   - Eager rebalance metrics
 */
@Injectable()
export class KafkaConsumerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(KafkaConsumerService.name);
  private kafka: Kafka | null = null;
  private connected = false;
  private readonly consumers: Consumer[] = [];
  private readonly pendingSubscriptions: Subscription[] = [];

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
   * Best-effort: if Kafka is unreachable, the subscription is logged and
   * skipped. Errors thrown by the handler are caught and logged so a single
   * bad message can't kill the consumer loop.
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
    try {
      await consumer.connect();
      for (var i = 0; i < opts.topics.length; i++) {
        await consumer.subscribe({
          topic: opts.topics[i]!,
          fromBeginning: opts.fromBeginning === true,
        });
      }
      var handler = opts.handler;
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
              logger.warn(
                'Failed to parse payload on ' + params.topic + ': ' + (e?.message || e),
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
          try {
            await handler(msg);
          } catch (e: any) {
            logger.error(
              'Handler error on ' + msg.topic + ' (key=' + (msg.key || '-') + '): ' +
                (e?.stack || e?.message || e),
            );
          }
        },
      });
      this.consumers.push(consumer);
      this.logger.log(
        'Subscribed: groupId=' + opts.groupId + ' topics=' + opts.topics.join(','),
      );
    } catch (e: any) {
      this.connected = false;
      this.logger.warn(
        'Kafka unavailable for consumer groupId=' + opts.groupId +
          ' — events will be skipped. ' + (e?.message || e),
      );
      try {
        await consumer.disconnect();
      } catch {
        // ignore
      }
    }
  }
}
