import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

export interface PeopleSearchResult {
  id: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  email: string | null;
  primaryPhone: string | null;
}

const MIN_QUERY_LENGTH = 2;
const MAX_RESULTS = 10;

/**
 * Name + email lookup over iam_person — the underlying join for the
 * emergency-contact "link to a CampusOS user" search and for any
 * future "find a person" flow.
 *
 * Privacy model: matches are joined INNER against platform_users so
 * only active accounts surface; placeholder iam_person rows (no
 * login) are invisible. Results are capped at 10 and the caller is
 * excluded from their own results. Hits ranked by prefix-match on
 * first_name → preferred_name → last_name → email, with the rest
 * falling through as substring matches.
 *
 * Scope: today the search is global across all iam_person rows that
 * have an associated platform_users account. The user-spec hinted
 * at a "same school as caller, or platform-level no-school" filter,
 * but that requires querying each tenant's sis_/hr_ tables per
 * candidate and gets expensive fast. Reasonable next step is to
 * project per-tenant affiliation flags onto iam_person (or onto a
 * companion search index) and gate on those — out of scope for now.
 */
@Injectable()
export class PeopleSearchService {
  constructor(private readonly prisma: PrismaClient) {}

  async search(callerPersonId: string, query: string): Promise<PeopleSearchResult[]> {
    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      throw new BadRequestException(`Search query must be at least ${MIN_QUERY_LENGTH} characters`);
    }

    const pattern = '%' + q.toLowerCase() + '%';
    // Postgres LOWER() + LIKE rather than ILIKE because we want
    // index-friendly behaviour; the LOWER expression can be backed
    // by a functional index later. With LIMIT 10 this is fine even
    // on a sequential scan at the current scale.
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        first_name: string;
        last_name: string;
        preferred_name: string | null;
        email: string | null;
        primary_phone: string | null;
      }>
    >(
      `SELECT ip.id::text AS id,
              ip.first_name,
              ip.last_name,
              ip.preferred_name,
              pu.email,
              ip.primary_phone
       FROM platform.iam_person ip
       JOIN platform.platform_users pu ON pu.person_id = ip.id
       WHERE ip.id <> $1::uuid
         AND (
           LOWER(ip.first_name) LIKE $2
           OR LOWER(ip.last_name) LIKE $2
           OR LOWER(COALESCE(ip.preferred_name, '')) LIKE $2
           OR LOWER(pu.email) LIKE $2
         )
       ORDER BY
         -- Exact-email matches win, then prefix matches on names.
         CASE WHEN LOWER(pu.email) = $3 THEN 0 ELSE 1 END,
         CASE WHEN LOWER(ip.first_name) LIKE $4 THEN 0 ELSE 1 END,
         CASE WHEN LOWER(ip.last_name) LIKE $4 THEN 0 ELSE 1 END,
         ip.last_name ASC,
         ip.first_name ASC
       LIMIT $5`,
      callerPersonId,
      pattern,
      q.toLowerCase(),
      q.toLowerCase() + '%',
      MAX_RESULTS,
    );

    return rows.map((r) => ({
      id: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      preferredName: r.preferred_name,
      email: r.email,
      primaryPhone: r.primary_phone,
    }));
  }
}
