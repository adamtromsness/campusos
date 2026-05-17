import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumedMessage, KafkaConsumerService } from '@shared/kafka/kafka-consumer.service';
import { IdempotencyService } from '@shared/kafka/idempotency.service';
import { prefixedTopic } from '@shared/kafka/event-envelope';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '@shared/kafka/envelope-consumer';
import { BroadcastAnalyticsService } from '../broadcast-analytics.service';

interface BroadcastDeliveryPayload {
  broadcastId: string;
  segmentId?: string | null;
  totalRecipients: number;
  delivered?: number;
  opened?: number;
  clicked?: number;
  bounced?: number;
  unsubscribed?: number;
}

const CONSUMER_GROUP = 'broadcast-analytics-worker';

/**
 * BroadcastAnalyticsConsumer — consumes delivery webhook events on
 * `msg.broadcast.delivered` and UPSERTs the per-(broadcast, segment)
 * row in msg_broadcast_analytics via BroadcastAnalyticsService.
 *
 * The event_id idempotency claim + UPSERT-by-(broadcast, segment)
 * means duplicate webhook deliveries land as no-op updates rather
 * than double-counting.
 *
 * No producer ships in P2-19a — the topic is forward-compatible with
 * the future broadcast send path (Cycle 14 broadcast schema + a
 * delivery webhook bridge from the upstream push/email provider).
 * Subscribing now means the consumer is wired the moment producers
 * go live.
 */
@Injectable()
export class BroadcastAnalyticsConsumer implements OnModuleInit {
  private readonly logger = new Logger(BroadcastAnalyticsConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly analytics: BroadcastAnalyticsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.consumer.subscribe({
      topics: [prefixedTopic('msg.broadcast.delivered')],
      groupId: CONSUMER_GROUP,
      handler: (msg: ConsumedMessage) => this.handle(msg),
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    const event = unwrapEnvelope<BroadcastDeliveryPayload>(msg, this.logger);
    if (!event) return;
    if (!event.payload.broadcastId) {
      this.logger.warn(
        'Dropping ' + msg.topic + ' (eventId=' + event.eventId + ') — missing broadcastId',
      );
      return;
    }

    await processWithIdempotency(
      CONSUMER_GROUP,
      event as UnwrappedEvent<unknown>,
      this.idempotency,
      this.logger,
      async () => {
        await this.analytics.applyDeliveryEvent({
          broadcastId: event!.payload.broadcastId,
          segmentId: event!.payload.segmentId ?? undefined,
          totalRecipients: event!.payload.totalRecipients,
          delivered: event!.payload.delivered,
          opened: event!.payload.opened,
          clicked: event!.payload.clicked,
          bounced: event!.payload.bounced,
          unsubscribed: event!.payload.unsubscribed,
        });
      },
    );
  }
}
