import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import {
  CommunityProfileDto,
  REPUTATION_REASONS,
  ReputationReason,
  UpdateCommunityProfileDto,
} from '../dto/community.dto';

/**
 * P2-21c — CommunityProfileService.
 *
 * Manages platform_community_profiles. Each iam_person gets at most
 * one profile (UNIQUE(person_id)). The service exposes:
 *  - getOrCreate(personId) — used by every other community service so
 *    a user gets a profile lazily on first interaction (rating, listing
 *    creation, etc.).
 *  - getById / getByPersonId — straight reads.
 *  - leaderboard — ordered by reputation_points DESC, public profiles
 *    only. The denormalised reputation_points + index makes this O(1).
 *  - updateOwn — self-service profile editing.
 *  - addReputation — internal helper called by RatingService and
 *    AssetTransactionService. Writes a platform_community_reputation_log
 *    row + atomically bumps platform_community_profiles.reputation_points
 *    in the same Prisma $transaction so the denormalised aggregate stays
 *    consistent.
 *
 * Service-side rule: reputation_log rows are immutable — there's no
 * UPDATE or DELETE path. Adjustments go through the
 * 'ADMIN_ADJUSTMENT' reason with a fresh log row.
 */
@Injectable()
export class CommunityProfileService {
  constructor(private readonly platform: PrismaClient) {}

  // ── Reads ────────────────────────────────────────────────────────

  async leaderboard(limit = 25): Promise<CommunityProfileDto[]> {
    const lim = Math.min(Math.max(1, limit), 100);
    const rows = await this.platform.$queryRawUnsafe<RawProfile[]>(
      `SELECT id::text, person_id::text, display_name, bio, school_name, role_label,
              avatar_s3_key, reputation_points, is_public, created_at, updated_at
         FROM platform.platform_community_profiles
         WHERE is_public = true
         ORDER BY reputation_points DESC, display_name ASC
         LIMIT ${lim}`,
    );
    return rows.map(rowToDto);
  }

  /**
   * REVIEW-P2C21 BLOCKING 7 — actor-aware getById that respects is_public.
   *
   * Without this, any actor with mkt-005:read could read a private
   * profile by UUID despite the OpenAPI summary claiming privacy
   * behavior. Now:
   *   - owner can always read own profile (regardless of is_public)
   *   - any other reader sees is_public=true profiles
   *   - private profiles by other people collapse to 404
   *     don't-leak-existence
   *   - the actorless overload is preserved for internal callers
   *     (e.g. SearchIndexConsumer, MarketplaceListingService.create)
   */
  async getById(id: string, actor?: { personId: string }): Promise<CommunityProfileDto> {
    const row = await this.loadOrFail(id);
    if (actor && !row.is_public && row.person_id !== actor.personId) {
      throw new NotFoundException(`platform_community_profiles ${id} not found.`);
    }
    return rowToDto(row);
  }

  async getByPersonId(personId: string): Promise<CommunityProfileDto | null> {
    const row = await this.loadByPersonId(personId);
    return row ? rowToDto(row) : null;
  }

  /**
   * Get-or-create a profile for the calling person. Lazy bootstrap —
   * never throws on missing profile; instead inserts a minimal row.
   * Used by every community write path so first-time interaction
   * doesn't require an explicit profile-creation step.
   */
  async getOrCreate(personId: string, displayNameFallback: string): Promise<CommunityProfileDto> {
    const existing = await this.loadByPersonId(personId);
    if (existing) return rowToDto(existing);

    const id = generateId();
    try {
      await this.platform.$executeRawUnsafe(
        `INSERT INTO platform.platform_community_profiles
          (id, person_id, display_name)
         VALUES ($1::uuid, $2::uuid, $3)
         ON CONFLICT (person_id) DO NOTHING`,
        id,
        personId,
        displayNameFallback,
      );
    } catch (_e) {
      // ignore — race-loser path; the get below will return the
      // winner's row.
    }
    const row = await this.loadByPersonId(personId);
    if (!row) {
      throw new NotFoundException(
        `Failed to bootstrap a platform_community_profiles row for person ${personId}.`,
      );
    }
    return rowToDto(row);
  }

  // ── Writes ───────────────────────────────────────────────────────

  async updateOwn(
    personId: string,
    input: UpdateCommunityProfileDto,
  ): Promise<CommunityProfileDto> {
    const existing = await this.loadByPersonId(personId);
    if (!existing) {
      throw new NotFoundException(
        `No community profile exists for this person yet. Call getOrCreate first.`,
      );
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.displayName !== undefined) {
      params.push(input.displayName);
      sets.push(`display_name = $${params.length}`);
    }
    if (input.bio !== undefined) {
      params.push(input.bio);
      sets.push(`bio = $${params.length}`);
    }
    if (input.schoolName !== undefined) {
      params.push(input.schoolName);
      sets.push(`school_name = $${params.length}`);
    }
    if (input.roleLabel !== undefined) {
      params.push(input.roleLabel);
      sets.push(`role_label = $${params.length}`);
    }
    if (input.avatarS3Key !== undefined) {
      params.push(input.avatarS3Key);
      sets.push(`avatar_s3_key = $${params.length}`);
    }
    if (input.isPublic !== undefined) {
      params.push(input.isPublic);
      sets.push(`is_public = $${params.length}`);
    }
    if (sets.length === 0) {
      return rowToDto(existing);
    }
    sets.push(`updated_at = now()`);
    params.push(existing.id);
    await this.platform.$executeRawUnsafe(
      `UPDATE platform.platform_community_profiles
         SET ${sets.join(', ')}
         WHERE id = $${params.length}::uuid`,
      ...params,
    );
    return rowToDto((await this.loadById(existing.id))!);
  }

  /**
   * Append a reputation event AND atomically bump the denormalised
   * reputation_points on the profile. Internal API used by other
   * community services.
   *
   * Wraps both writes in a single Prisma $transaction so the ledger
   * and the aggregate stay consistent.
   */
  async addReputation(
    profileId: string,
    pointsDelta: number,
    reason: ReputationReason,
    referenceId: string | null,
  ): Promise<void> {
    if (!REPUTATION_REASONS.includes(reason)) {
      throw new BadRequestException(`reason must be one of ${REPUTATION_REASONS.join(', ')}.`);
    }
    if (!Number.isInteger(pointsDelta)) {
      throw new BadRequestException('pointsDelta must be an integer.');
    }
    const logId = generateId();
    await this.platform.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO platform.platform_community_reputation_log
          (id, profile_id, points_delta, reason, reference_id)
         VALUES ($1::uuid, $2::uuid, $3::int, $4, $5)`,
        logId,
        profileId,
        pointsDelta,
        reason,
        referenceId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE platform.platform_community_profiles
           SET reputation_points = reputation_points + $1::int,
               updated_at = now()
           WHERE id = $2::uuid`,
        pointsDelta,
        profileId,
      );
    });
  }

  // ── Internals ────────────────────────────────────────────────────

  async loadOrFail(id: string): Promise<RawProfile> {
    const row = await this.loadById(id);
    if (!row) {
      throw new NotFoundException(`platform_community_profiles ${id} not found.`);
    }
    return row;
  }

  private async loadById(id: string): Promise<RawProfile | null> {
    const rows = await this.platform.$queryRawUnsafe<RawProfile[]>(
      `SELECT id::text, person_id::text, display_name, bio, school_name, role_label,
              avatar_s3_key, reputation_points, is_public, created_at, updated_at
         FROM platform.platform_community_profiles
         WHERE id = $1::uuid`,
      id,
    );
    return rows[0] ?? null;
  }

  private async loadByPersonId(personId: string): Promise<RawProfile | null> {
    const rows = await this.platform.$queryRawUnsafe<RawProfile[]>(
      `SELECT id::text, person_id::text, display_name, bio, school_name, role_label,
              avatar_s3_key, reputation_points, is_public, created_at, updated_at
         FROM platform.platform_community_profiles
         WHERE person_id = $1::uuid`,
      personId,
    );
    return rows[0] ?? null;
  }
}

interface RawProfile {
  id: string;
  person_id: string;
  display_name: string;
  bio: string | null;
  school_name: string | null;
  role_label: string | null;
  avatar_s3_key: string | null;
  reputation_points: number;
  is_public: boolean;
  created_at: Date;
  updated_at: Date;
}

function rowToDto(row: RawProfile): CommunityProfileDto {
  return {
    id: row.id,
    personId: row.person_id,
    displayName: row.display_name,
    bio: row.bio,
    schoolName: row.school_name,
    roleLabel: row.role_label,
    avatarS3Key: row.avatar_s3_key,
    reputationPoints: row.reputation_points,
    isPublic: row.is_public,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
