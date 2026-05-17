import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { OutboxService } from '@shared/kafka';
import { getCurrentTenant } from '@shared/tenant';
import { deterministicListingPublishedEventId } from '../event-ids';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  CreateMarketplaceListingDto,
  ListMarketplaceArgs,
  ListingStatus,
  MarketplaceListingDto,
  PatchMarketplaceListingDto,
} from '../dto/community.dto';
import { CommunityProfileService } from './community-profile.service';

/**
 * P2-21c — MarketplaceListingService.
 *
 * THE PARENT GATE KEYSTONE per ADR-073: parents can browse + buy +
 * rate but CANNOT create listings. assertCanCreateListing rejects
 * any actor whose personType is GUARDIAN or STUDENT with a friendly
 * 403; only STAFF actors (teachers, librarians, principal,
 * counsellor — anything with personType=STAFF) and school admins
 * can author listings.
 *
 * Full-text search via the tsvector GIN index on
 * platform_marketplace_listings.search_keywords. The service
 * materialises the vector from title + description + tags +
 * category on every INSERT and UPDATE, so the index stays current
 * without a separate worker round-trip.
 *
 * On publish (status transitions to ACTIVE), the service emits
 * `mkt.listing.published` via the ADR-057 envelope — the
 * WatchListMatchWorker subscribes to this and notifies schools
 * whose watch list criteria match.
 */
@Injectable()
export class MarketplaceListingService {
  private readonly logger = new Logger(MarketplaceListingService.name);

  constructor(
    private readonly platform: PrismaClient,
    private readonly outbox: OutboxService,
    private readonly profiles: CommunityProfileService,
  ) {}

  // ── Parent gate ───────────────────────────────────────────────────

  assertCanCreateListing(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STAFF') return;
    throw new ForbiddenException(
      'Only school staff can create marketplace listings. Parents and students may browse and purchase but cannot list items (ADR-073).',
    );
  }

  // ── Reads ────────────────────────────────────────────────────────

  async list(args: ListMarketplaceArgs = {}): Promise<MarketplaceListingDto[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (args.listingType) {
      params.push(args.listingType);
      where.push(`l.listing_type = $${params.length}`);
    }
    if (args.status) {
      params.push(args.status);
      where.push(`l.status = $${params.length}`);
    } else {
      // Default to ACTIVE-only for public browsing.
      where.push(`l.status = 'ACTIVE'`);
    }
    if (args.minPriceCents !== undefined) {
      params.push(args.minPriceCents);
      where.push(`l.price_cents >= $${params.length}::int`);
    }
    if (args.maxPriceCents !== undefined) {
      params.push(args.maxPriceCents);
      where.push(`l.price_cents <= $${params.length}::int`);
    }
    if (args.conditionMin) {
      params.push(args.conditionMin);
      // Cast to ordinal so >= works: NEW > LIKE_NEW > GOOD > FAIR > POOR
      where.push(`
        CASE l.condition
          WHEN 'NEW' THEN 5
          WHEN 'LIKE_NEW' THEN 4
          WHEN 'GOOD' THEN 3
          WHEN 'FAIR' THEN 2
          WHEN 'POOR' THEN 1
          ELSE 0
        END
        >= CASE $${params.length}
          WHEN 'NEW' THEN 5
          WHEN 'LIKE_NEW' THEN 4
          WHEN 'GOOD' THEN 3
          WHEN 'FAIR' THEN 2
          WHEN 'POOR' THEN 1
          ELSE 0
        END
      `);
    }
    let rankSelect = '0::float8 AS rank';
    if (args.search && args.search.trim().length > 0) {
      params.push(args.search.trim());
      where.push(`l.search_keywords @@ plainto_tsquery('english', $${params.length})`);
      rankSelect = `ts_rank(l.search_keywords, plainto_tsquery('english', $${params.length})) AS rank`;
    }
    const lim = Math.min(Math.max(1, args.limit ?? 50), 200);
    const whereSql = where.length === 0 ? '' : 'WHERE ' + where.join(' AND ');
    const rows = await this.platform.$queryRawUnsafe<RawListingWithRank[]>(
      `SELECT l.id::text, l.listing_type, l.title, l.description,
              l.seller_school_id::text AS seller_school_id,
              l.seller_profile_id::text AS seller_profile_id,
              cp.display_name AS seller_display_name,
              l.price_cents, l.condition, l.category, l.tags, l.photo_s3_keys,
              l.status, l.published_at, l.created_at, l.updated_at,
              (SELECT AVG(r.score)::float8 FROM platform.platform_community_ratings r
                 WHERE r.rateable_type = 'LISTING' AND r.rateable_id = l.id) AS avg_rating,
              (SELECT COUNT(*)::int FROM platform.platform_community_ratings r
                 WHERE r.rateable_type = 'LISTING' AND r.rateable_id = l.id) AS rating_count,
              ${rankSelect}
         FROM platform.platform_marketplace_listings l
         LEFT JOIN platform.platform_community_profiles cp ON cp.id = l.seller_profile_id
         ${whereSql}
         ORDER BY rank DESC, l.published_at DESC NULLS LAST, l.created_at DESC
         LIMIT ${lim}`,
      ...params,
    );
    return rows.map(rowToDto);
  }

  async getById(id: string): Promise<MarketplaceListingDto> {
    return rowToDto(await this.loadWithRollups(id));
  }

  // ── Writes ───────────────────────────────────────────────────────

  async create(
    actor: ResolvedActor,
    sellerSchoolId: string,
    input: CreateMarketplaceListingDto,
  ): Promise<MarketplaceListingDto> {
    this.assertCanCreateListing(actor);
    // REVIEW-P2C21 MAJOR 1 — defence-in-depth: even if a future controller
    // path supplies sellerSchoolId from somewhere other than getCurrentTenant,
    // the service refuses to seat a listing on a school other than the
    // caller's tenant. Only platform admins (no tenant context) might
    // legitimately bypass; they go through a separate moderation surface
    // when it ships.
    const tenant = getCurrentTenant();
    if (sellerSchoolId !== tenant.schoolId) {
      throw new ForbiddenException(
        "Listings must be created for the caller's tenant school (REVIEW-P2C21 MAJOR 1).",
      );
    }
    const profile = await this.profiles.getOrCreate(
      actor.personId,
      actor.personType ?? 'Community member',
    );
    const id = generateId();
    const tags = input.tags ?? [];
    const photos = input.photoS3Keys ?? [];
    const tagsJoined = tags.join(' ');
    const searchText = [input.title, input.description, input.category, tagsJoined]
      .filter(Boolean)
      .join(' ');
    await this.platform.$executeRawUnsafe(
      `INSERT INTO platform.platform_marketplace_listings
        (id, listing_type, title, description, seller_school_id, seller_profile_id,
         price_cents, condition, category, tags, photo_s3_keys, status, search_keywords)
       VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6::uuid,
         $7, $8, $9, $10::text[], $11::jsonb, 'DRAFT',
         to_tsvector('english', $12))`,
      id,
      input.listingType,
      input.title,
      input.description,
      sellerSchoolId,
      profile.id,
      input.priceCents ?? null,
      input.condition ?? null,
      input.category ?? null,
      tags,
      JSON.stringify(photos),
      searchText,
    );
    return rowToDto(await this.loadWithRollups(id));
  }

  async patch(
    actor: ResolvedActor,
    id: string,
    input: PatchMarketplaceListingDto,
  ): Promise<MarketplaceListingDto> {
    const existing = await this.loadWithRollups(id);
    const isOwner =
      existing.seller_profile_id ===
      (await this.profiles.getOrCreate(actor.personId, actor.personType ?? '')).id;
    // REVIEW-P2C21 BLOCKING 2 — school-admin override is bound to the
    // SELLER's school. A school A admin cannot edit a school B listing
    // even if they hold sch-001:admin at SCHOOL scope. Cross-school
    // moderation goes through a separate platform-admin surface
    // (deferred to MKT-009 moderation, see HANDOFF P2-21c carry-over 7).
    const tenant = getCurrentTenant();
    const isSellerSchoolAdmin =
      actor.isSchoolAdmin && existing.seller_school_id === tenant.schoolId;
    if (!isOwner && !isSellerSchoolAdmin) {
      throw new ForbiddenException(
        "Only the listing seller or a school admin of the seller's school can edit a marketplace listing (REVIEW-P2C21 BLOCKING 2).",
      );
    }

    const previousStatus = existing.status as ListingStatus;
    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.title !== undefined) {
      params.push(input.title);
      sets.push(`title = $${params.length}`);
    }
    if (input.description !== undefined) {
      params.push(input.description);
      sets.push(`description = $${params.length}`);
    }
    if (input.priceCents !== undefined) {
      params.push(input.priceCents);
      sets.push(`price_cents = $${params.length}::int`);
    }
    if (input.condition !== undefined) {
      params.push(input.condition);
      sets.push(`condition = $${params.length}`);
    }
    if (input.category !== undefined) {
      params.push(input.category);
      sets.push(`category = $${params.length}`);
    }
    if (input.tags !== undefined) {
      params.push(input.tags);
      sets.push(`tags = $${params.length}::text[]`);
    }
    if (input.photoS3Keys !== undefined) {
      params.push(JSON.stringify(input.photoS3Keys));
      sets.push(`photo_s3_keys = $${params.length}::jsonb`);
    }

    let willPublish = false;
    if (input.status !== undefined && input.status !== previousStatus) {
      // Allowed transitions: DRAFT -> ACTIVE (publish), ACTIVE -> EXPIRED, SOLD set by AssetTransactionService.
      if (input.status === 'SOLD') {
        throw new BadRequestException(
          'status=SOLD is set by the AssetTransactionService — do not patch directly.',
        );
      }
      if (previousStatus === 'DRAFT' && input.status === 'ACTIVE') {
        willPublish = true;
        params.push(input.status);
        sets.push(`status = $${params.length}`);
        sets.push(`published_at = COALESCE(published_at, now())`);
      } else if (
        (previousStatus === 'ACTIVE' || previousStatus === 'SOLD') &&
        input.status === 'EXPIRED'
      ) {
        params.push(input.status);
        sets.push(`status = $${params.length}`);
      } else if (previousStatus === 'DRAFT' && input.status === 'EXPIRED') {
        params.push(input.status);
        sets.push(`status = $${params.length}`);
      } else {
        throw new BadRequestException(
          `Invalid status transition ${previousStatus} -> ${input.status}.`,
        );
      }
    }

    // Re-materialise search_keywords if any text-bearing field changed.
    const refreshTsvector =
      input.title !== undefined ||
      input.description !== undefined ||
      input.tags !== undefined ||
      input.category !== undefined;
    if (refreshTsvector) {
      const title = input.title ?? existing.title;
      const description = input.description ?? existing.description;
      const category = (input.category !== undefined ? input.category : existing.category) ?? '';
      const tags = input.tags ?? existing.tags ?? [];
      const searchText = [title, description, category, tags.join(' ')].filter(Boolean).join(' ');
      params.push(searchText);
      sets.push(`search_keywords = to_tsvector('english', $${params.length})`);
    }

    if (sets.length === 0) {
      return rowToDto(existing);
    }

    sets.push(`updated_at = now()`);
    params.push(id);

    // REVIEW-P2C21 BLOCKING 1 — UPDATE + outbox enqueue in one
    // $transaction so a broker outage cannot lose the publish event.
    // The WatchListMatchConsumer + SearchIndexConsumer both depend on
    // this event; if Kafka is down at flip-time, the outbox row
    // commits with the UPDATE and the OutboxPublisherWorker drains
    // on recovery.
    await this.platform.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE platform.platform_marketplace_listings
           SET ${sets.join(', ')}
           WHERE id = $${params.length}::uuid`,
        ...params,
      );
      if (willPublish) {
        // Re-read inside the tx to capture the post-UPDATE state.
        const fresh = await tx.$queryRawUnsafe<
          Array<{
            id: string;
            listing_type: string;
            title: string;
            description: string;
            seller_school_id: string;
            seller_profile_id: string;
            price_cents: number | null;
            condition: string | null;
            category: string | null;
            tags: string[] | null;
            published_at: Date | null;
          }>
        >(
          `SELECT id::text, listing_type, title, description,
                  seller_school_id::text AS seller_school_id,
                  seller_profile_id::text AS seller_profile_id,
                  price_cents, condition, category, tags, published_at
             FROM platform.platform_marketplace_listings
             WHERE id = $1::uuid`,
          id,
        );
        const r = fresh[0]!;
        await this.outbox.enqueueInTx(tx, {
          topic: 'mkt.listing.published',
          key: id,
          payload: {
            listingId: id,
            listingType: r.listing_type,
            title: r.title,
            description: r.description,
            sellerSchoolId: r.seller_school_id,
            sellerProfileId: r.seller_profile_id,
            priceCents: r.price_cents,
            condition: r.condition,
            category: r.category,
            tags: r.tags ?? [],
            publishedAt: r.published_at?.toISOString() ?? null,
          },
          sourceModule: 'community',
          eventId: deterministicListingPublishedEventId(id),
        });
      }
    });

    const refreshed = await this.loadWithRollups(id);
    if (willPublish) {
      this.logger.log(`[mkt-listing] published ${id} (${refreshed.listing_type})`);
    }
    return rowToDto(refreshed);
  }

  // ── Internals ────────────────────────────────────────────────────

  async loadOrFail(id: string): Promise<RawListing> {
    const rows = await this.platform.$queryRawUnsafe<RawListing[]>(
      `SELECT id::text, listing_type, title, description,
              seller_school_id::text AS seller_school_id,
              seller_profile_id::text AS seller_profile_id,
              price_cents, condition, category, tags, photo_s3_keys,
              status, published_at, created_at, updated_at
         FROM platform.platform_marketplace_listings
         WHERE id = $1::uuid`,
      id,
    );
    if (rows.length === 0) {
      throw new NotFoundException(`platform_marketplace_listings ${id} not found.`);
    }
    return rows[0]!;
  }

  /**
   * Stamps the parent listing as SOLD when a transaction lands.
   * Called by AssetTransactionService inside its purchase tx.
   * Tolerates already-SOLD listings (idempotent).
   */
  async markSold(id: string): Promise<void> {
    await this.platform.$executeRawUnsafe(
      `UPDATE platform.platform_marketplace_listings
         SET status = 'SOLD', updated_at = now()
         WHERE id = $1::uuid AND status IN ('ACTIVE', 'DRAFT')`,
      id,
    );
  }

  private async loadWithRollups(id: string): Promise<RawListingWithRank> {
    const rows = await this.platform.$queryRawUnsafe<RawListingWithRank[]>(
      `SELECT l.id::text, l.listing_type, l.title, l.description,
              l.seller_school_id::text AS seller_school_id,
              l.seller_profile_id::text AS seller_profile_id,
              cp.display_name AS seller_display_name,
              l.price_cents, l.condition, l.category, l.tags, l.photo_s3_keys,
              l.status, l.published_at, l.created_at, l.updated_at,
              (SELECT AVG(r.score)::float8 FROM platform.platform_community_ratings r
                 WHERE r.rateable_type = 'LISTING' AND r.rateable_id = l.id) AS avg_rating,
              (SELECT COUNT(*)::int FROM platform.platform_community_ratings r
                 WHERE r.rateable_type = 'LISTING' AND r.rateable_id = l.id) AS rating_count,
              0::float8 AS rank
         FROM platform.platform_marketplace_listings l
         LEFT JOIN platform.platform_community_profiles cp ON cp.id = l.seller_profile_id
         WHERE l.id = $1::uuid`,
      id,
    );
    if (rows.length === 0) {
      throw new NotFoundException(`platform_marketplace_listings ${id} not found.`);
    }
    return rows[0]!;
  }
}

interface RawListing {
  id: string;
  listing_type: string;
  title: string;
  description: string;
  seller_school_id: string;
  seller_profile_id: string;
  price_cents: number | null;
  condition: string | null;
  category: string | null;
  tags: string[] | null;
  photo_s3_keys: unknown;
  status: string;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface RawListingWithRank extends RawListing {
  seller_display_name: string | null;
  avg_rating: number | null;
  rating_count: number;
  rank: number;
}

function rowToDto(row: RawListingWithRank): MarketplaceListingDto {
  const photos = Array.isArray(row.photo_s3_keys) ? (row.photo_s3_keys as string[]) : [];
  return {
    id: row.id,
    listingType: row.listing_type as MarketplaceListingDto['listingType'],
    title: row.title,
    description: row.description,
    sellerSchoolId: row.seller_school_id,
    sellerProfileId: row.seller_profile_id,
    sellerDisplayName: row.seller_display_name,
    priceCents: row.price_cents,
    condition: row.condition as MarketplaceListingDto['condition'],
    category: row.category,
    tags: row.tags ?? [],
    photoS3Keys: photos,
    status: row.status as MarketplaceListingDto['status'],
    publishedAt: row.published_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    averageRating: row.avg_rating !== null ? Number(row.avg_rating.toFixed(2)) : null,
    ratingCount: row.rating_count ?? 0,
  };
}
