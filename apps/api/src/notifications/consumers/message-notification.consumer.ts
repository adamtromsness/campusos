import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumedMessage, KafkaConsumerService } from '../../kafka/kafka-consumer.service';
import { IdempotencyService } from '../../kafka/idempotency.service';
import { prefixedTopic } from '../../kafka/event-envelope';
import { TenantPrismaService } from '../../tenant/tenant-prisma.service';
import { NotificationQueueService } from '../notification-queue.service';
import { RedisService } from '../redis.service';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from './notification-consumer-base';

/**
 * MessageNotificationConsumer — listens for `msg.message.posted`, the
 * topic produced by the Step 6 messaging service when someone sends a
 * direct or thread message.
 *
 * For each thread participant other than the sender, the consumer:
 *   1. enqueues a `message.posted` in-app notification, and
 *   2. increments the per-(user, thread) Redis unread counter via
 *      `RedisService.incrementUnread()` so the Step 6 UnreadCountService
 *      and Step 8 NotificationBell render badges immediately.
 *
 * Step 5 lands the consumer; the producer side ships in Step 6 alongside
 * MessageService. Subscribing now means the consumer is wired the moment
 * the producer goes live — no follow-up deploy needed.
 */
interface MessagePayload {
  messageId: string;
  threadId: string;
  senderId: string;
  body: string;
  postedAt: string;
}

interface ThreadContext {
  subject: string | null;
  threadType: string;
  senderName: string;
}

var CONSUMER_GROUP = 'message-notification-consumer';

@Injectable()
export class MessageNotificationConsumer implements OnModuleInit {
  private readonly logger = new Logger(MessageNotificationConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly queue: NotificationQueueService,
    private readonly redis: RedisService,
  ) {}

  async onModuleInit(): Promise<void> {
    var self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic('msg.message.posted')],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    var event = unwrapEnvelope<MessagePayload>(msg, this.logger);
    if (!event) return;
    if (!event.payload.messageId || !event.payload.threadId || !event.payload.senderId) {
      this.logger.warn(
        'Dropping ' + msg.topic + ' (eventId=' + event.eventId + ') — missing message ids',
      );
      return;
    }

    var self = this;
    await processWithIdempotency(
      CONSUMER_GROUP,
      event as UnwrappedEvent<unknown>,
      this.idempotency,
      this.logger,
      async function () {
        await self.fanOut(event!.payload, event!.eventId);
      },
    );
  }

  private async fanOut(p: MessagePayload, eventId: string): Promise<void> {
    var ctx = await this.loadThreadContext(p.threadId, p.senderId);
    if (!ctx) {
      this.logger.warn('Skipping fan-out — thread ' + p.threadId + ' not found');
      return;
    }
    var participants = await this.loadActiveParticipants(p.threadId, p.senderId);
    if (participants.length === 0) {
      this.logger.debug('No other participants in thread ' + p.threadId);
      return;
    }

    var preview = p.body && p.body.length > 140 ? p.body.slice(0, 137) + '…' : p.body || '';
    var payload = {
      message_id: p.messageId,
      thread_id: p.threadId,
      thread_subject: ctx.subject,
      thread_type: ctx.threadType,
      sender_id: p.senderId,
      sender_name: ctx.senderName,
      preview: preview,
      posted_at: p.postedAt,
      deep_link: '/messages/' + p.threadId,
    };

    for (var i = 0; i < participants.length; i++) {
      var accountId = participants[i]!;
      // Bump the per-thread unread counter even if the notification ends up
      // deduped or quieted — the inbox badge tracks message arrival, not
      // notification delivery.
      await this.redis.incrementUnread(accountId, p.threadId);
      try {
        await this.queue.enqueue({
          notificationType: 'message.posted',
          recipientAccountId: accountId,
          payload: payload,
          idempotencyKey: 'message.posted:' + eventId + ':' + accountId,
        });
      } catch (e: any) {
        this.logger.error(
          'Enqueue failed for ' + accountId + ' (message.posted): ' + (e?.stack || e?.message || e),
        );
        throw e;
      }
    }
  }

  /**
   * Resolve the thread metadata + sender display name in one round-trip.
   * `msg_thread_participants` is HASH-partitioned with `msg_threads`; we
   * reach the partition leaf via `school_id` (denormalised on the join
   * column) when the Step 6 service writes it, but for the read path here
   * the partition pruner ignores the participant index and we get a hit
   * on the unique secondary index. Fast enough for the rate of message
   * notifications expected during Cycle 3.
   */
  private async loadThreadContext(
    threadId: string,
    senderAccountId: string,
  ): Promise<ThreadContext | null> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          subject: string | null;
          thread_type: string;
          sender_first_name: string | null;
          sender_last_name: string | null;
          sender_display_name: string | null;
        }>
      >(
        'SELECT t.subject, tt.name AS thread_type, ' +
          ' ip.first_name AS sender_first_name, ' +
          ' ip.last_name AS sender_last_name, ' +
          ' u.display_name AS sender_display_name ' +
          'FROM msg_threads t ' +
          'JOIN msg_thread_types tt ON tt.id = t.thread_type_id ' +
          'LEFT JOIN platform.platform_users u ON u.id = $2::uuid ' +
          'LEFT JOIN platform.iam_person ip ON ip.id = u.person_id ' +
          'WHERE t.id = $1::uuid LIMIT 1',
        threadId,
        senderAccountId,
      );
    });
    if (rows.length === 0) return null;
    var r = rows[0]!;
    var name =
      r.sender_first_name && r.sender_last_name
        ? r.sender_first_name + ' ' + r.sender_last_name
        : r.sender_display_name || 'A user';
    return {
      subject: r.subject,
      threadType: r.thread_type,
      senderName: name,
    };
  }

  private async loadActiveParticipants(
    threadId: string,
    senderAccountId: string,
  ): Promise<string[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ platform_user_id: string }>>(
        'SELECT platform_user_id::text AS platform_user_id ' +
          'FROM msg_thread_participants ' +
          'WHERE thread_id = $1::uuid ' +
          ' AND platform_user_id <> $2::uuid ' +
          ' AND left_at IS NULL ' +
          ' AND is_muted = false',
        threadId,
        senderAccountId,
      );
    });
    return rows.map(function (r) {
      return r.platform_user_id;
    });
  }
}
