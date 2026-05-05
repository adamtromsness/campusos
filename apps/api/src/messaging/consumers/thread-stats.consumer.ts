import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumedMessage, KafkaConsumerService } from '../../kafka/kafka-consumer.service';
import { IdempotencyService } from '../../kafka/idempotency.service';
import { prefixedTopic } from '../../kafka/event-envelope';
import { TenantPrismaService } from '../../tenant/tenant-prisma.service';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '../../notifications/consumers/notification-consumer-base';

/**
 * ThreadStatsConsumer — Cycle 14 Step 4.
 *
 * Subscribes to dev.msg.message.posted under group
 * `thread-stats-consumer`. On every inbound event, UPSERTs
 * msg_thread_stats so the inbox can render last_message_at and
 * last_message_preview without scanning the partitioned msg_messages
 * table at read time.
 *
 * Idempotency: claim-after-success per REVIEW-CYCLE2 BLOCKING 2. The
 * consumer-group claim on event_id is the dedup gate — Kafka
 * redelivery returns from processWithIdempotency before reaching the
 * worker body. The UPSERT increments message_count by 1 only on first
 * arrival per event_id.
 */

interface MessagePayload {
  messageId: string;
  threadId: string;
  senderId: string;
  body: string;
  postedAt: string;
}

const CONSUMER_GROUP = 'thread-stats-consumer';

@Injectable()
export class ThreadStatsConsumer implements OnModuleInit {
  private readonly logger = new Logger(ThreadStatsConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic('msg.message.posted')],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    const event = unwrapEnvelope<MessagePayload>(msg, this.logger);
    if (!event) return;
    if (!event.payload.messageId || !event.payload.threadId || !event.payload.senderId) {
      this.logger.warn(
        'Dropping ' + msg.topic + ' (eventId=' + event.eventId + ') — missing message ids',
      );
      return;
    }

    const self = this;
    await processWithIdempotency(
      CONSUMER_GROUP,
      event as UnwrappedEvent<unknown>,
      this.idempotency,
      this.logger,
      async function () {
        await self.upsertStats(event!.payload);
      },
    );
  }

  private async upsertStats(p: MessagePayload): Promise<void> {
    const preview = p.body && p.body.length > 100 ? p.body.slice(0, 100) : p.body || '';
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      // Resolve school_id from msg_threads so msg_thread_stats.school_id
      // is populated correctly without trusting payload state.
      const threadRows = (await client.$queryRawUnsafe(
        'SELECT school_id::text AS school_id FROM msg_threads WHERE id = $1::uuid LIMIT 1',
        p.threadId,
      )) as Array<{ school_id: string }>;
      if (threadRows.length === 0) {
        this.logger.warn('msg_threads not found for ' + p.threadId + ' — skipping stats upsert');
        return;
      }
      const schoolId = threadRows[0]!.school_id;

      await client.$executeRawUnsafe(
        'INSERT INTO msg_thread_stats (thread_id, school_id, message_count, last_message_at, last_message_preview, last_sender_id, updated_at) ' +
          'VALUES ($1::uuid, $2::uuid, 1, $3::timestamptz, $4, $5::uuid, now()) ' +
          'ON CONFLICT (thread_id) DO UPDATE SET ' +
          '  message_count = msg_thread_stats.message_count + 1, ' +
          '  last_message_at = EXCLUDED.last_message_at, ' +
          '  last_message_preview = EXCLUDED.last_message_preview, ' +
          '  last_sender_id = EXCLUDED.last_sender_id, ' +
          '  updated_at = now()',
        p.threadId,
        schoolId,
        p.postedAt,
        preview,
        p.senderId,
      );
    });
  }
}
