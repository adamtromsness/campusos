import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumedMessage, KafkaConsumerService } from '@shared/kafka/kafka-consumer.service';
import { IdempotencyService } from '@shared/kafka/idempotency.service';
import { prefixedTopic } from '@shared/kafka/event-envelope';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '@modules/m40-communications/notifications/consumers/notification-consumer-base';
import { ItemCondition, ListingType } from './dto/community.dto';
import { WatchListService } from './services/watch-list.service';

/**
 * P2-21c — WatchListMatchWorker (Kafka consumer).
 *
 * Subscribes to mkt.listing.published, runs WatchListService.matchListing
 * against the published listing, and logs the matching watch lists.
 *
 * NOTE: actual notification fan-out (email, in-app, push) is wired
 * into the future Cycle 14 NotificationConsumer chain. This consumer
 * currently produces a log line per match so the audit trail is
 * visible; that's enough for the demo + the unit test.
 *
 * Idempotent via claim-after-success — a redelivered event re-runs
 * matchListing safely because the operation is read-only against
 * the watch-list table.
 */
@Injectable()
export class WatchListMatchConsumer implements OnModuleInit {
  private readonly logger = new Logger(WatchListMatchConsumer.name);
  private static readonly CONSUMER_GROUP = 'watch-list-match';
  private static readonly TOPIC = 'mkt.listing.published';

  constructor(
    private readonly kafkaConsumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly watchLists: WatchListService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.kafkaConsumer.subscribe({
      groupId: WatchListMatchConsumer.CONSUMER_GROUP,
      topics: [prefixedTopic(WatchListMatchConsumer.TOPIC)],
      handler: (msg) => this.handle(msg),
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    const event = unwrapEnvelope<ListingPublishedPayload>(msg, this.logger);
    if (!event) return;

    await processWithIdempotency(
      WatchListMatchConsumer.CONSUMER_GROUP,
      event as UnwrappedEvent<unknown>,
      this.idempotency,
      this.logger,
      async () => {
        const p = event.payload;
        if (!p || !p.listingId || !p.listingType) {
          this.logger.warn(`[watch-list-match] malformed payload event=${event.eventId}`);
          return;
        }
        const searchableText = [p.title, p.description, p.category, (p.tags ?? []).join(' ')]
          .filter(Boolean)
          .join(' ');
        const matches = await this.watchLists.matchListing({
          listingId: p.listingId,
          listingType: p.listingType,
          priceCents: p.priceCents ?? null,
          condition: p.condition ?? null,
          searchableText,
        });
        this.logger.log(
          `[watch-list-match] listing=${p.listingId} matched=${matches.length} watchListIds=${matches
            .map((m) => m.id)
            .join(',')}`,
        );
      },
    );
  }
}

interface ListingPublishedPayload {
  listingId: string;
  listingType: ListingType;
  title: string;
  description: string;
  sellerSchoolId: string;
  sellerProfileId: string;
  priceCents: number | null;
  condition: ItemCondition | null;
  category: string | null;
  tags: string[];
  publishedAt: string | null;
}
