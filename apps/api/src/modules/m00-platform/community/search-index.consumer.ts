import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumedMessage, KafkaConsumerService } from '@shared/kafka';
import { IdempotencyService } from '@shared/kafka';
import { prefixedTopic } from '@shared/kafka';
import { UnwrappedEvent, processWithIdempotency, unwrapEnvelope } from '@shared/kafka';
import { ItemCondition, ListingType } from './dto/community.dto';
import { SearchService } from './services/search.service';

/**
 * P2-21c — SearchIndexConsumer (ADR-076).
 *
 * Materialises platform_search_index from content events. Subscribes
 * to mkt.listing.published and refreshes the index row for that
 * listing. The future forum + knowledge-article modules will emit
 * their own published topics that this consumer can subscribe to as
 * those surfaces ship.
 *
 * Standard claim-after-success idempotency. The upsert in
 * SearchService.upsert uses ON CONFLICT (content_type, content_id)
 * DO UPDATE so a redelivered event is naturally idempotent at the
 * SQL layer as well.
 */
@Injectable()
export class SearchIndexConsumer implements OnModuleInit {
  private readonly logger = new Logger(SearchIndexConsumer.name);
  private static readonly CONSUMER_GROUP = 'search-index';
  private static readonly TOPIC = 'mkt.listing.published';

  constructor(
    private readonly kafkaConsumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly search: SearchService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.kafkaConsumer.subscribe({
      groupId: SearchIndexConsumer.CONSUMER_GROUP,
      topics: [prefixedTopic(SearchIndexConsumer.TOPIC)],
      handler: (msg) => this.handle(msg),
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    const event = unwrapEnvelope<ListingPublishedPayload>(msg, this.logger);
    if (!event) return;

    await processWithIdempotency(
      SearchIndexConsumer.CONSUMER_GROUP,
      event as UnwrappedEvent<unknown>,
      this.idempotency,
      this.logger,
      async () => {
        const p = event.payload;
        if (!p || !p.listingId) {
          this.logger.warn(`[search-index] malformed payload event=${event.eventId}`);
          return;
        }
        const searchableText = [p.title, p.description, p.category, (p.tags ?? []).join(' ')]
          .filter(Boolean)
          .join(' ');
        const bodyPreview = (p.description ?? '').slice(0, 280);
        await this.search.upsert({
          contentType: 'LISTING',
          contentId: p.listingId,
          title: p.title,
          bodyPreview,
          searchableText,
          schoolId: p.sellerSchoolId ?? null,
          authorProfileId: p.sellerProfileId ?? null,
          contentDate: p.publishedAt ? new Date(p.publishedAt) : null,
        });
        this.logger.log(`[search-index] upserted LISTING ${p.listingId}`);
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
