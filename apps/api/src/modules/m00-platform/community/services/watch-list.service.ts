import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { CreateWatchListDto, ItemCondition, ListingType, WatchListDto } from '../dto/community.dto';

/**
 * P2-21c — WatchListService.
 *
 * Schools register search criteria; WatchListMatchWorker is the
 * Kafka consumer that fires on mkt.listing.published, calls
 * matchListing() here, and surfaces matching watch lists. The
 * worker layer is responsible for notification fan-out — this
 * service exposes the matching SQL.
 */
@Injectable()
export class WatchListService {
  private readonly logger = new Logger(WatchListService.name);

  constructor(private readonly platform: PrismaClient) {}

  // ── CRUD ─────────────────────────────────────────────────────────

  async list(schoolId: string, includeFulfilled = false): Promise<WatchListDto[]> {
    const rows = await this.platform.$queryRawUnsafe<RawWatchList[]>(
      `SELECT id::text, school_id::text, target_listing_type, search_keywords,
              max_price_cents, condition_min, status, created_by::text,
              fulfilled_at, created_at, updated_at
         FROM platform.platform_marketplace_watch_lists
         WHERE school_id = $1::uuid
           ${includeFulfilled ? '' : `AND status = 'ACTIVE'`}
         ORDER BY created_at DESC`,
      schoolId,
    );
    return rows.map(rowToDto);
  }

  /**
   * REVIEW-P2C21 BLOCKING 6 — school-scope on getById.
   *
   * Cross-school readers cannot pull another school's watch-list by
   * UUID. Collapsed 404 don't-leak-existence.
   */
  async getById(id: string, schoolId: string): Promise<WatchListDto> {
    return rowToDto(await this.loadOrFail(id, schoolId));
  }

  async create(
    actor: ResolvedActor,
    schoolId: string,
    input: CreateWatchListDto,
  ): Promise<WatchListDto> {
    const id = generateId();
    await this.platform.$executeRawUnsafe(
      `INSERT INTO platform.platform_marketplace_watch_lists
        (id, school_id, target_listing_type, search_keywords, max_price_cents,
         condition_min, status, created_by)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, 'ACTIVE', $7::uuid)`,
      id,
      schoolId,
      input.targetListingType,
      input.searchKeywords ?? null,
      input.maxPriceCents ?? null,
      input.conditionMin ?? null,
      actor.personId,
    );
    return this.getById(id, schoolId);
  }

  /**
   * REVIEW-P2C21 BLOCKING 6 — school-scope on fulfill.
   *
   * The UPDATE WHERE clause carries school_id so a cross-school caller
   * cannot mutate another school's watch list even if they know the
   * UUID. loadOrFail short-circuits to 404 before we get here, but
   * the UPDATE adds defence-in-depth.
   */
  async fulfill(id: string, schoolId: string): Promise<WatchListDto> {
    const existing = await this.loadOrFail(id, schoolId);
    if (existing.status === 'FULFILLED') return rowToDto(existing);
    await this.platform.$executeRawUnsafe(
      `UPDATE platform.platform_marketplace_watch_lists
         SET status = 'FULFILLED', fulfilled_at = now(), updated_at = now()
         WHERE id = $1::uuid AND school_id = $2::uuid`,
      id,
      schoolId,
    );
    return this.getById(id, schoolId);
  }

  /**
   * REVIEW-P2C21 BLOCKING 6 — school-scope on remove.
   */
  async remove(id: string, schoolId: string): Promise<void> {
    await this.loadOrFail(id, schoolId);
    await this.platform.$executeRawUnsafe(
      `DELETE FROM platform.platform_marketplace_watch_lists
         WHERE id = $1::uuid AND school_id = $2::uuid`,
      id,
      schoolId,
    );
  }

  // ── Matching keystone ────────────────────────────────────────────

  /**
   * Match a newly-published listing against active watch lists.
   * Returns the watch lists whose criteria match the listing. The
   * caller (typically WatchListMatchWorker) decides what to do with
   * the matches (notify, etc.).
   *
   * Match rules:
   *  - target_listing_type must match listing.listing_type
   *  - if search_keywords set: tsvector match
   *  - if max_price_cents set: listing.price_cents <= max_price_cents
   *  - if condition_min set: listing.condition ordinal >= condition_min ordinal
   */
  async matchListing(input: {
    listingId: string;
    listingType: ListingType;
    priceCents: number | null;
    condition: ItemCondition | null;
    searchableText: string;
  }): Promise<WatchListDto[]> {
    const params: unknown[] = [input.listingType];
    const conditions: string[] = [`status = 'ACTIVE'`, `target_listing_type = $1`];
    if (input.searchableText && input.searchableText.trim().length > 0) {
      params.push(input.searchableText);
      conditions.push(
        `(search_keywords IS NULL OR to_tsvector('english', $${params.length})
            @@ plainto_tsquery('english', search_keywords))`,
      );
    } else {
      conditions.push(`search_keywords IS NULL`);
    }
    if (input.priceCents !== null) {
      params.push(input.priceCents);
      conditions.push(`(max_price_cents IS NULL OR max_price_cents >= $${params.length}::int)`);
    }
    if (input.condition) {
      params.push(input.condition);
      conditions.push(
        `(condition_min IS NULL OR
          CASE condition_min
            WHEN 'NEW' THEN 5 WHEN 'LIKE_NEW' THEN 4 WHEN 'GOOD' THEN 3
            WHEN 'FAIR' THEN 2 WHEN 'POOR' THEN 1 ELSE 0
          END
          <=
          CASE $${params.length}
            WHEN 'NEW' THEN 5 WHEN 'LIKE_NEW' THEN 4 WHEN 'GOOD' THEN 3
            WHEN 'FAIR' THEN 2 WHEN 'POOR' THEN 1 ELSE 0
          END)`,
      );
    } else {
      conditions.push(`condition_min IS NULL`);
    }
    const rows = await this.platform.$queryRawUnsafe<RawWatchList[]>(
      `SELECT id::text, school_id::text, target_listing_type, search_keywords,
              max_price_cents, condition_min, status, created_by::text,
              fulfilled_at, created_at, updated_at
         FROM platform.platform_marketplace_watch_lists
         WHERE ${conditions.join(' AND ')}`,
      ...params,
    );
    if (rows.length > 0) {
      this.logger.log(
        `[mkt-watchlist] listing=${input.listingId} matched ${rows.length} active watch list(s)`,
      );
    }
    return rows.map(rowToDto);
  }

  // ── Internals ────────────────────────────────────────────────────

  /**
   * REVIEW-P2C21 BLOCKING 6 — school-scoped row loader.
   *
   * Cross-school UUID guesses collapse to 404 don't-leak-existence
   * before any UPDATE/DELETE/READ.
   */
  private async loadOrFail(id: string, schoolId: string): Promise<RawWatchList> {
    const rows = await this.platform.$queryRawUnsafe<RawWatchList[]>(
      `SELECT id::text, school_id::text, target_listing_type, search_keywords,
              max_price_cents, condition_min, status, created_by::text,
              fulfilled_at, created_at, updated_at
         FROM platform.platform_marketplace_watch_lists
         WHERE id = $1::uuid AND school_id = $2::uuid`,
      id,
      schoolId,
    );
    if (rows.length === 0) {
      throw new NotFoundException(`platform_marketplace_watch_lists ${id} not found.`);
    }
    return rows[0]!;
  }
}

interface RawWatchList {
  id: string;
  school_id: string;
  target_listing_type: string;
  search_keywords: string | null;
  max_price_cents: number | null;
  condition_min: string | null;
  status: string;
  created_by: string;
  fulfilled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function rowToDto(row: RawWatchList): WatchListDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    targetListingType: row.target_listing_type as WatchListDto['targetListingType'],
    searchKeywords: row.search_keywords,
    maxPriceCents: row.max_price_cents,
    conditionMin: row.condition_min as WatchListDto['conditionMin'],
    status: row.status as WatchListDto['status'],
    createdBy: row.created_by,
    fulfilledAt: row.fulfilled_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
