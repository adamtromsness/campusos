import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { TenantModule } from '../tenant/tenant.module';
import { CommunityController } from './community.controller';
import { SearchIndexConsumer } from './search-index.consumer';
import { WatchListMatchConsumer } from './watch-list-match.consumer';
import { AssetTransactionService } from './services/asset-transaction.service';
import { CommunityProfileService } from './services/community-profile.service';
import { MarketplaceListingService } from './services/marketplace-listing.service';
import { RatingService } from './services/rating.service';
import { SearchService } from './services/search.service';
import { WatchListService } from './services/watch-list.service';

/**
 * P2-21c — Community Exchange Module.
 *
 * Cross-school marketplace + community profiles + ratings + unified
 * full-text search. Routes mount under /api/v1/community/* and use
 * the regular guard chain (Auth + Tenant + Permission) — every
 * authenticated user has a tenant context because they belong to
 * some school. Marketplace data lives in the platform schema for
 * cross-school visibility.
 *
 * 6 services + 1 controller + 2 Kafka consumers + ~22 endpoints:
 *   CommunityProfileService     — profiles + reputation log
 *   MarketplaceListingService   — listings + parent gate keystone
 *   AssetTransactionService     — 5% fee split keystone + lifecycle
 *   WatchListService            — match keystone for the consumer
 *   RatingService               — 1-5 star + reputation award
 *   SearchService               — tsvector GIN search index
 *   WatchListMatchConsumer      — Kafka consumer on mkt.listing.published
 *   SearchIndexConsumer         — Kafka consumer on mkt.listing.published
 *
 * Emits:
 *   mkt.listing.published      — when a draft listing flips to ACTIVE
 *   mkt.transaction.completed  — when a transaction flips to CONFIRMED
 *
 * Schema lives in platform.* via migration
 * 20260512160000_add_p2c21c_community_exchange. 8 tables.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    {
      provide: PrismaClient,
      useFactory: () =>
        new PrismaClient({
          datasourceUrl: process.env.DATABASE_URL,
        }),
    },
    CommunityProfileService,
    MarketplaceListingService,
    AssetTransactionService,
    WatchListService,
    RatingService,
    SearchService,
    WatchListMatchConsumer,
    SearchIndexConsumer,
  ],
  controllers: [CommunityController],
  exports: [
    CommunityProfileService,
    MarketplaceListingService,
    AssetTransactionService,
    WatchListService,
    RatingService,
    SearchService,
  ],
})
export class CommunityModule {}
