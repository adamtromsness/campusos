import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { AiInferenceService } from './ai-inference.service';
import { AiModerationResultDto } from './dto/communications-advanced.dto';

interface AiResultRow {
  id: string;
  message_id: string;
  message_created_at: string;
  sensitivity_score: string;
  categories_detected: unknown;
  model_version: string | null;
  computed_at: string;
}

interface MessageLookupRow {
  body: string;
  created_at: string;
}

function rowToDto(row: AiResultRow, cached: boolean): AiModerationResultDto {
  return {
    id: row.id,
    messageId: row.message_id,
    messageCreatedAt: row.message_created_at,
    sensitivityScore: Number(row.sensitivity_score),
    categoriesDetected: (row.categories_detected as Record<string, number>) ?? {},
    modelVersion: row.model_version,
    computedAt: row.computed_at,
    cached,
  };
}

/**
 * AIModerationService — AI sensitivity scoring with cache.
 *
 * Cache contract:
 *   UNIQUE(message_id, message_created_at) on msg_ai_moderation_results
 *   is the cache key. analyze() looks the pair up first; on hit
 *   returns `cached=true`. On miss it calls the AiInferenceService,
 *   INSERTs the row with ON CONFLICT DO NOTHING (race-safe — a second
 *   concurrent request wins the cache slot the first one left empty),
 *   then re-reads and returns `cached=false`.
 *
 * Called by the ModerationWorker when at least one rule has
 * ai_sensitivity_threshold set. Computed once per message — a
 * redelivered moderation event reads the cached row instead of re-
 * calling the AI Inference service. Mirrors the P2-19a
 * TranslationService cache pattern.
 */
@Injectable()
export class AIModerationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ai: AiInferenceService,
  ) {}

  /**
   * Look up the cached AI result for a message. Returns null when the
   * message has not yet been analyzed.
   */
  async getCached(messageId: string): Promise<AiModerationResultDto | null> {
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const rows = await client.$queryRawUnsafe<AiResultRow[]>(
        this.selectBase() + 'WHERE message_id = $1::uuid LIMIT 1',
        messageId,
      );
      if (rows.length === 0) return null;
      return rowToDto(rows[0]!, true);
    });
  }

  /**
   * Compute or read-from-cache the AI sensitivity result. The text
   * argument is the message body; passing it directly avoids a re-
   * read of msg_messages. When text is omitted (admin trigger via
   * POST /ai-moderation/analyze without a body) we read the message
   * body from msg_messages.
   */
  async analyze(messageId: string, text?: string): Promise<AiModerationResultDto> {
    const cached = await this.getCached(messageId);
    if (cached !== null) return cached;

    return this.tenantPrisma.executeInTenantTransaction(async (tx: PrismaClient) => {
      const lookup = await tx.$queryRawUnsafe<MessageLookupRow[]>(
        'SELECT body, created_at::text AS created_at FROM msg_messages WHERE id = $1::uuid LIMIT 1',
        messageId,
      );
      if (lookup.length === 0) throw new NotFoundException('Message not found');
      const body = text ?? lookup[0]!.body;
      const messageCreatedAt = lookup[0]!.created_at;
      if (!body || body.trim().length === 0) {
        throw new BadRequestException('Cannot analyze empty message body');
      }
      const result = await this.ai.analyzeSensitivity(body);
      const id = generateId();
      // ON CONFLICT DO NOTHING handles the race where two concurrent
      // ModerationWorker invocations both miss the cache and try to
      // INSERT the same (message_id) pair.
      await tx.$executeRawUnsafe(
        'INSERT INTO msg_ai_moderation_results ' +
          '(id, message_id, message_created_at, sensitivity_score, ' +
          ' categories_detected, model_version, computed_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4, $5::jsonb, $6, now()) ' +
          'ON CONFLICT (message_id, message_created_at) DO NOTHING',
        id,
        messageId,
        messageCreatedAt,
        result.sensitivityScore,
        JSON.stringify(result.categoriesDetected),
        result.modelVersion,
      );
      const rows = await tx.$queryRawUnsafe<AiResultRow[]>(
        this.selectBase() + 'WHERE message_id = $1::uuid LIMIT 1',
        messageId,
      );
      // The race-loser sees a different (id, computed_at) but same payload —
      // cached=false either way because we just computed it.
      return rowToDto(rows[0]!, false);
    });
  }

  private selectBase(): string {
    return (
      'SELECT id::text AS id, message_id::text AS message_id, ' +
      'message_created_at::text AS message_created_at, ' +
      'sensitivity_score::text AS sensitivity_score, ' +
      'categories_detected, model_version, ' +
      'computed_at::text AS computed_at FROM msg_ai_moderation_results '
    );
  }
}
