import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumedMessage, KafkaConsumerService } from '../../kafka/kafka-consumer.service';
import { IdempotencyService } from '../../kafka/idempotency.service';
import { prefixedTopic } from '../../kafka/event-envelope';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '../../notifications/consumers/notification-consumer-base';
import { PushCampaignService } from '../push-campaign.service';

interface PushDeliveryPayload {
  campaignId: string;
  delivered?: number;
  opened?: number;
  clicked?: number;
}

const CONSUMER_GROUP = 'push-analytics-worker';

/**
 * PushAnalyticsConsumer — consumes push delivery callback events on
 * `msg.push.delivered` and UPSERTs the per-campaign analytics row.
 *
 * UPSERT semantics: a duplicate webhook lands as an update —
 * delivered/opened/clicked counters bump, and delivery_rate,
 * open_rate, click_rate recompute via PushCampaignService.recordDelivery.
 *
 * Idempotency: standard claim-after-success against
 * platform_event_consumer_idempotency under `push-analytics-worker`.
 *
 * Phase 2 punch list: the upstream push notification service (APNs,
 * FCM, web push) needs to publish msg.push.delivered events with the
 * (campaignId, delivered, opened, clicked) shape this consumer
 * expects. Today the topic is forward-compatible — subscribing now
 * means the consumer is wired the moment producers go live.
 */
@Injectable()
export class PushAnalyticsConsumer implements OnModuleInit {
  private readonly logger = new Logger(PushAnalyticsConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly campaigns: PushCampaignService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.consumer.subscribe({
      topics: [prefixedTopic('msg.push.delivered')],
      groupId: CONSUMER_GROUP,
      handler: (msg: ConsumedMessage) => this.handle(msg),
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    const event = unwrapEnvelope<PushDeliveryPayload>(msg, this.logger);
    if (!event) return;
    if (!event.payload.campaignId) {
      this.logger.warn(
        'Dropping ' + msg.topic + ' (eventId=' + event.eventId + ') — missing campaignId',
      );
      return;
    }

    await processWithIdempotency(
      CONSUMER_GROUP,
      event as UnwrappedEvent<unknown>,
      this.idempotency,
      this.logger,
      async () => {
        await this.campaigns.recordDelivery({
          campaignId: event!.payload.campaignId,
          delivered: event!.payload.delivered,
          opened: event!.payload.opened,
          clicked: event!.payload.clicked,
        });
      },
    );
  }
}
