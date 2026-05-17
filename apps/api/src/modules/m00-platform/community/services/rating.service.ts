import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  CommunityRatingDto,
  CreateRatingDto,
  RATEABLE_TYPES,
  RateableType,
} from '../dto/community.dto';
import { CommunityProfileService } from './community-profile.service';

/**
 * P2-21c — RatingService.
 *
 * Polymorphic 1-5 star ratings against LISTING / TRANSACTION /
 * FORUM_POST content. UNIQUE(rateable_type, rateable_id, rated_by)
 * caps a user at one rating per item; resubmission UPDATEs the
 * existing row.
 *
 * On rating submit: awards +10 RATING_RECEIVED reputation points to
 * the rated content's author profile. On helpful_vote: awards +5
 * HELPFUL_VOTE to the author. Reputation log writes are idempotent
 * — a re-rate (UPDATE) does NOT double-award.
 */
@Injectable()
export class RatingService {
  private readonly logger = new Logger(RatingService.name);

  constructor(
    private readonly platform: PrismaClient,
    private readonly profiles: CommunityProfileService,
  ) {}

  async listForRateable(
    rateableType: RateableType,
    rateableId: string,
  ): Promise<CommunityRatingDto[]> {
    if (!RATEABLE_TYPES.includes(rateableType)) {
      throw new BadRequestException(`rateableType must be one of ${RATEABLE_TYPES.join(', ')}.`);
    }
    const rows = await this.platform.$queryRawUnsafe<RawRating[]>(
      `SELECT r.id::text, r.rateable_type, r.rateable_id::text, r.rated_by::text,
              cp.display_name AS rated_by_display_name,
              r.score, r.review_text, r.helpful_votes, r.created_at, r.updated_at
         FROM platform.platform_community_ratings r
         LEFT JOIN platform.platform_community_profiles cp ON cp.person_id = r.rated_by
         WHERE r.rateable_type = $1 AND r.rateable_id = $2::uuid
         ORDER BY r.helpful_votes DESC, r.created_at DESC`,
      rateableType,
      rateableId,
    );
    return rows.map(rowToDto);
  }

  async create(actor: ResolvedActor, input: CreateRatingDto): Promise<CommunityRatingDto> {
    if (input.score < 1 || input.score > 5) {
      throw new BadRequestException('score must be between 1 and 5.');
    }
    // Find the author profile to award reputation to (best-effort).
    const authorProfileId = await this.resolveAuthorProfileId(input.rateableType, input.rateableId);
    if (authorProfileId !== null) {
      // Refuse self-rating.
      const myProfile = await this.profiles.getOrCreate(
        actor.personId,
        actor.personType ?? 'Community member',
      );
      if (authorProfileId === myProfile.id) {
        throw new BadRequestException('You cannot rate your own content.');
      }
    }

    const id = generateId();
    let isNew = true;
    try {
      await this.platform.$executeRawUnsafe(
        `INSERT INTO platform.platform_community_ratings
          (id, rateable_type, rateable_id, rated_by, score, review_text)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::int, $6)`,
        id,
        input.rateableType,
        input.rateableId,
        actor.personId,
        input.score,
        input.reviewText ?? null,
      );
    } catch (e: unknown) {
      const err = e as { message?: string };
      if (
        typeof err?.message === 'string' &&
        err.message.includes('platform_community_ratings_uq')
      ) {
        // Re-rate path: UPDATE existing row.
        isNew = false;
        await this.platform.$executeRawUnsafe(
          `UPDATE platform.platform_community_ratings
             SET score = $1::int, review_text = $2, updated_at = now()
             WHERE rateable_type = $3 AND rateable_id = $4::uuid AND rated_by = $5::uuid`,
          input.score,
          input.reviewText ?? null,
          input.rateableType,
          input.rateableId,
          actor.personId,
        );
      } else {
        throw e;
      }
    }

    if (isNew && authorProfileId !== null) {
      // First-time rating awards +10 reputation. Re-rates do not.
      void this.profiles
        .addReputation(authorProfileId, 10, 'RATING_RECEIVED', input.rateableId)
        .catch((e) => this.logger.warn(`[mkt-rating] reputation award failed: ${String(e)}`));
    }

    return this.findByActor(actor, input.rateableType, input.rateableId);
  }

  async helpfulVote(ratingId: string): Promise<CommunityRatingDto> {
    const row = await this.loadOrFail(ratingId);
    await this.platform.$executeRawUnsafe(
      `UPDATE platform.platform_community_ratings
         SET helpful_votes = helpful_votes + 1, updated_at = now()
         WHERE id = $1::uuid`,
      ratingId,
    );
    // Award the rater +5 reputation per helpful vote.
    const raterProfile = await this.platform.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text FROM platform.platform_community_profiles WHERE person_id = $1::uuid`,
      row.rated_by,
    );
    if (raterProfile.length > 0) {
      void this.profiles
        .addReputation(raterProfile[0]!.id, 5, 'HELPFUL_VOTE', ratingId)
        .catch((e) =>
          this.logger.warn(`[mkt-rating] helpful-vote reputation failed: ${String(e)}`),
        );
    }
    return rowToDto(await this.loadOrFail(ratingId));
  }

  // ── Internals ────────────────────────────────────────────────────

  /**
   * Find the seller_profile_id for the rateable target so the
   * reputation award routes to the right profile. Returns null for
   * rateables that have no profile owner (FORUM_POST until that
   * surface ships).
   */
  private async resolveAuthorProfileId(
    rateableType: RateableType,
    rateableId: string,
  ): Promise<string | null> {
    if (rateableType === 'LISTING') {
      const rows = await this.platform.$queryRawUnsafe<Array<{ seller_profile_id: string }>>(
        `SELECT seller_profile_id::text FROM platform.platform_marketplace_listings
         WHERE id = $1::uuid`,
        rateableId,
      );
      return rows.length > 0 ? rows[0]!.seller_profile_id : null;
    }
    if (rateableType === 'TRANSACTION') {
      const rows = await this.platform.$queryRawUnsafe<Array<{ seller_profile_id: string }>>(
        `SELECT seller_profile_id::text FROM platform.platform_asset_transactions
         WHERE id = $1::uuid`,
        rateableId,
      );
      return rows.length > 0 ? rows[0]!.seller_profile_id : null;
    }
    return null;
  }

  private async findByActor(
    actor: ResolvedActor,
    rateableType: RateableType,
    rateableId: string,
  ): Promise<CommunityRatingDto> {
    const rows = await this.platform.$queryRawUnsafe<RawRating[]>(
      `SELECT r.id::text, r.rateable_type, r.rateable_id::text, r.rated_by::text,
              cp.display_name AS rated_by_display_name,
              r.score, r.review_text, r.helpful_votes, r.created_at, r.updated_at
         FROM platform.platform_community_ratings r
         LEFT JOIN platform.platform_community_profiles cp ON cp.person_id = r.rated_by
         WHERE r.rateable_type = $1 AND r.rateable_id = $2::uuid AND r.rated_by = $3::uuid`,
      rateableType,
      rateableId,
      actor.personId,
    );
    if (rows.length === 0) {
      throw new NotFoundException('Rating not found after create.');
    }
    return rowToDto(rows[0]!);
  }

  private async loadOrFail(id: string): Promise<RawRating> {
    const rows = await this.platform.$queryRawUnsafe<RawRating[]>(
      `SELECT r.id::text, r.rateable_type, r.rateable_id::text, r.rated_by::text,
              cp.display_name AS rated_by_display_name,
              r.score, r.review_text, r.helpful_votes, r.created_at, r.updated_at
         FROM platform.platform_community_ratings r
         LEFT JOIN platform.platform_community_profiles cp ON cp.person_id = r.rated_by
         WHERE r.id = $1::uuid`,
      id,
    );
    if (rows.length === 0) {
      throw new NotFoundException(`platform_community_ratings ${id} not found.`);
    }
    return rows[0]!;
  }
}

interface RawRating {
  id: string;
  rateable_type: string;
  rateable_id: string;
  rated_by: string;
  rated_by_display_name: string | null;
  score: number;
  review_text: string | null;
  helpful_votes: number;
  created_at: Date;
  updated_at: Date;
}

function rowToDto(row: RawRating): CommunityRatingDto {
  return {
    id: row.id,
    rateableType: row.rateable_type as CommunityRatingDto['rateableType'],
    rateableId: row.rateable_id,
    ratedBy: row.rated_by,
    ratedByDisplayName: row.rated_by_display_name,
    score: row.score,
    reviewText: row.review_text,
    helpfulVotes: row.helpful_votes,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
