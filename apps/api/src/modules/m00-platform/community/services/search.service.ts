import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { SearchContentType, SearchHitDto, SEARCH_CONTENT_TYPES } from '../dto/community.dto';

/**
 * P2-21c — SearchService (ADR-076).
 *
 * Unified full-text search across all community content types via
 * the tsvector GIN index on platform_search_index.search_vector.
 *
 * The service exposes:
 *   - search(query, contentType?) — the read path. Ranks results
 *     via ts_rank against plainto_tsquery.
 *   - upsert(input) — internal API called by SearchIndexWorker on
 *     content events. UNIQUE(content_type, content_id) so
 *     re-publishing the same content cleanly UPSERTs the row.
 *   - remove(content_type, content_id) — content takedown.
 */
@Injectable()
export class SearchService {
  constructor(private readonly platform: PrismaClient) {}

  async search(
    query: string,
    contentType?: SearchContentType,
    limit = 50,
  ): Promise<SearchHitDto[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException('Search query is required.');
    }
    const lim = Math.min(Math.max(1, limit), 200);
    const where: string[] = [`search_vector @@ plainto_tsquery('english', $1)`];
    const params: unknown[] = [trimmed];
    if (contentType) {
      if (!SEARCH_CONTENT_TYPES.includes(contentType)) {
        throw new BadRequestException(
          `contentType must be one of ${SEARCH_CONTENT_TYPES.join(', ')}.`,
        );
      }
      params.push(contentType);
      where.push(`content_type = $${params.length}`);
    }
    const rows = await this.platform.$queryRawUnsafe<RawSearchHit[]>(
      `SELECT content_type, content_id::text, title, body_preview,
              school_id::text AS school_id, author_profile_id::text AS author_profile_id,
              content_date,
              ts_rank(search_vector, plainto_tsquery('english', $1))::float8 AS rank
         FROM platform.platform_search_index
         WHERE ${where.join(' AND ')}
         ORDER BY rank DESC, content_date DESC NULLS LAST
         LIMIT ${lim}`,
      ...params,
    );
    return rows.map(rowToDto);
  }

  /**
   * Upsert a content row into the search index. Called by
   * SearchIndexWorker on content events. UPSERT keyed on
   * (content_type, content_id) so re-publishing the same content
   * refreshes title/body/vector cleanly.
   */
  async upsert(input: {
    contentType: SearchContentType;
    contentId: string;
    title: string;
    bodyPreview: string | null;
    searchableText: string;
    schoolId: string | null;
    authorProfileId: string | null;
    contentDate: Date | null;
  }): Promise<void> {
    if (!SEARCH_CONTENT_TYPES.includes(input.contentType)) {
      throw new BadRequestException(
        `contentType must be one of ${SEARCH_CONTENT_TYPES.join(', ')}.`,
      );
    }
    const id = generateId();
    await this.platform.$executeRawUnsafe(
      `INSERT INTO platform.platform_search_index
        (id, content_type, content_id, title, body_preview, search_vector,
         school_id, author_profile_id, content_date)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5,
         to_tsvector('english', $6),
         $7, $8, $9)
       ON CONFLICT (content_type, content_id) DO UPDATE
         SET title = EXCLUDED.title,
             body_preview = EXCLUDED.body_preview,
             search_vector = EXCLUDED.search_vector,
             school_id = EXCLUDED.school_id,
             author_profile_id = EXCLUDED.author_profile_id,
             content_date = EXCLUDED.content_date,
             updated_at = now()`,
      id,
      input.contentType,
      input.contentId,
      input.title,
      input.bodyPreview,
      input.searchableText,
      input.schoolId,
      input.authorProfileId,
      input.contentDate,
    );
  }

  async remove(contentType: SearchContentType, contentId: string): Promise<void> {
    await this.platform.$executeRawUnsafe(
      `DELETE FROM platform.platform_search_index
         WHERE content_type = $1 AND content_id = $2::uuid`,
      contentType,
      contentId,
    );
  }
}

interface RawSearchHit {
  content_type: string;
  content_id: string;
  title: string;
  body_preview: string | null;
  school_id: string | null;
  author_profile_id: string | null;
  content_date: Date | null;
  rank: number;
}

function rowToDto(row: RawSearchHit): SearchHitDto {
  return {
    contentType: row.content_type as SearchHitDto['contentType'],
    contentId: row.content_id,
    title: row.title,
    bodyPreview: row.body_preview,
    schoolId: row.school_id,
    authorProfileId: row.author_profile_id,
    contentDate: row.content_date?.toISOString() ?? null,
    rank: Number(row.rank.toFixed(4)),
  };
}
