import { HttpException, HttpStatus, Injectable, Optional } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { RedisService } from '@shared/cache';
import { CheckDuplicateDto, CheckDuplicateResultDto } from './dto/duplicate-check.dto';

/**
 * Account Creation spec, Step 3 — privacy-safe duplicate detection.
 *
 * Before a creator provisions a new account, the form asks "does this
 * person likely already exist?" so a duplicate can be linked instead of
 * created. Because this path probes OTHER people's PII, it is
 * deliberately conservative:
 *
 *   - STRONG match only. Either an exact email match, or the full
 *     (normalized firstName + lastName) AND exact dateOfBirth triple.
 *     A partial/fuzzy name alone never matches — that would let anyone
 *     enumerate accounts by typing names.
 *   - MINIMAL disclosure. The response carries only { exists, displayName
 *     (given + last initial), context (coarse role), alreadyManagedByCurrentUser }.
 *     Never email, DOB, phone, or any record detail. Full data requires an
 *     approved link (the link/claim flow, separate).
 *   - RATE LIMITED per caller to blunt probing.
 *
 * The actual linking is NOT done here — this service only reports whether
 * a strong match exists and whether the caller already manages it.
 */
@Injectable()
export class DuplicateCheckService {
  // ~30 checks per 15 min per caller — generous for legitimate
  // form interaction (email-blur + a couple of name/DOB edits per
  // person being added), tight enough to make enumeration impractical.
  private static readonly RL_LIMIT = 30;
  private static readonly RL_WINDOW_SECONDS = 900;

  constructor(
    private readonly prisma: PrismaClient,
    @Optional() private readonly redis?: RedisService,
  ) {}

  async check(
    callerPersonId: string,
    dto: CheckDuplicateDto,
  ): Promise<CheckDuplicateResultDto> {
    await this.assertRateLimit(callerPersonId);

    const email = dto.email?.trim().toLowerCase() || null;
    const firstName = dto.firstName?.trim().toLowerCase() || null;
    const lastName = dto.lastName?.trim().toLowerCase() || null;
    const dob = dto.dateOfBirth?.trim() || null;

    // Determine which strong-match arms we can even evaluate. If the
    // caller supplied neither a usable email nor the full name+DOB
    // triple, there's nothing to match on — report "no match" without
    // touching the DB (also avoids a name-only probe doing any work).
    const canEmailMatch = !!email;
    const canTripleMatch = !!firstName && !!lastName && !!dob;
    if (!canEmailMatch && !canTripleMatch) {
      return { exists: false };
    }

    // Single query covering both arms. Self is excluded — you can't be
    // your own duplicate. INNER JOIN platform_users so only real
    // accounts surface (placeholder iam_person rows without a login are
    // invisible, same privacy stance as people-search). Oldest match
    // wins for a stable, deterministic descriptor.
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        person_id: string;
        first_name: string;
        last_name: string;
        person_type: string | null;
        managed_by_person_id: string | null;
      }>
    >(
      `SELECT ip.id::text          AS person_id,
              ip.first_name        AS first_name,
              ip.last_name         AS last_name,
              ip.person_type::text AS person_type,
              pu.managed_by_person_id::text AS managed_by_person_id
         FROM platform.iam_person ip
         JOIN platform.platform_users pu ON pu.person_id = ip.id
        WHERE ip.id <> $1::uuid
          AND (
            ($2::text IS NOT NULL AND LOWER(pu.email) = $2::text)
            OR (
              $3::text IS NOT NULL AND $4::text IS NOT NULL AND $5::date IS NOT NULL
              AND LOWER(ip.first_name) = $3::text
              AND LOWER(ip.last_name) = $4::text
              AND ip.date_of_birth = $5::date
            )
          )
        ORDER BY ip.created_at ASC
        LIMIT 1`,
      callerPersonId,
      email,
      firstName,
      lastName,
      dob,
    );

    const match = rows[0];
    if (!match) return { exists: false };

    const lastInitial = match.last_name?.trim()?.[0]?.toUpperCase();
    const displayName = lastInitial
      ? `${match.first_name} ${lastInitial}.`
      : match.first_name;

    return {
      exists: true,
      displayName,
      context: this.contextLabel(match.person_type),
      alreadyManagedByCurrentUser: match.managed_by_person_id === callerPersonId,
    };
  }

  /**
   * Coarse, non-identifying role label from iam_person.person_type. No
   * school / tenant affiliation — that would both leak where the person
   * is enrolled and require an expensive cross-tenant lookup.
   */
  private contextLabel(personType: string | null): string {
    switch (personType) {
      case 'STUDENT':
        return 'Student';
      case 'GUARDIAN':
        return 'Parent';
      case 'STAFF':
        return 'Staff member';
      case 'SUBSTITUTE':
        return 'Substitute';
      case 'ALUMNI':
        return 'Alumnus';
      case 'VOLUNTEER':
        return 'Volunteer';
      default:
        return 'CampusOS user';
    }
  }

  private async assertRateLimit(callerPersonId: string): Promise<void> {
    // Redis is @Optional() so unit/integration contexts without a cache
    // still work; rate-limiting is a best-effort guard, not a security
    // boundary (the minimal-disclosure response is the real protection).
    if (!this.redis) return;
    const key = `dupcheck:${callerPersonId}`;
    const count = await this.redis.incrementCounter(
      key,
      1,
      DuplicateCheckService.RL_WINDOW_SECONDS,
    );
    if (count > DuplicateCheckService.RL_LIMIT) {
      throw new HttpException(
        'Too many duplicate checks; try again in a few minutes',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
