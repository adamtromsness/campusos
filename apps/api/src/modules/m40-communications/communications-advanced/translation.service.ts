import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { AiInferenceService } from './ai-inference.service';
import { TranslateRequestDto, TranslationDto } from './dto/communications-advanced.dto';

interface TranslationRow {
  id: string;
  message_id: string;
  message_created_at: string;
  target_language: string;
  translated_text: string;
  source_language: string | null;
  model_version: string | null;
  confidence: string | null;
  translated_at: string;
  requested_by: string | null;
}

interface MessageLookupRow {
  body: string;
  created_at: string;
}

function rowToDto(row: TranslationRow, cached: boolean): TranslationDto {
  return {
    id: row.id,
    messageId: row.message_id,
    messageCreatedAt: row.message_created_at,
    targetLanguage: row.target_language,
    translatedText: row.translated_text,
    sourceLanguage: row.source_language,
    modelVersion: row.model_version,
    confidence: row.confidence !== null ? Number(row.confidence) : null,
    translatedAt: row.translated_at,
    requestedBy: row.requested_by,
    cached,
  };
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e?.code === 'P2002') return true;
  if (e?.code === 'P2010' && e?.meta?.code === '23505') return true;
  if (typeof e?.message === 'string' && e.message.includes('23505')) return true;
  return false;
}

/**
 * TranslationService — on-demand AI translation with cache.
 *
 * Cache contract:
 *   UNIQUE(message_id, target_language) on msg_translations is the
 *   cache key. translate() looks the pair up first; on hit returns
 *   `cached=true`; on miss it calls the AI Inference stub, INSERTs the
 *   row with ON CONFLICT DO NOTHING (race-safe — a second concurrent
 *   request wins the cache slot the first one left empty), then
 *   re-reads and returns `cached=false`.
 *
 * Source-text resolution:
 *   When `sourceText` is supplied (auto-translate worker path) we use
 *   it as-is plus the supplied message_created_at. When it's omitted
 *   (on-demand path) we join msg_messages to pull the canonical body —
 *   this requires the caller to know a real (message_id) and
 *   message_created_at can be supplied or derived from the lookup.
 *
 * Authorisation: the controller gates on `com-001:read`. Row-level
 * visibility (can this caller see this message?) is enforced
 * upstream by the existing messaging module — translate is a read
 * surface on top of the same message.
 */
@Injectable()
export class TranslationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ai: AiInferenceService,
  ) {}

  /**
   * Translate (or return cached translation for) a (message, target_language)
   * pair. Returns `cached: true` when the row was already in the table.
   *
   * REVIEW-P2C19 BLOCKING 1: when `actor` is supplied (controller path)
   * the caller must be a participant in the message's thread, the
   * sender, or a school admin. Auto-translate worker passes null actor.
   */
  async translate(
    input: TranslateRequestDto,
    requestedBy: string | null,
    actor: ResolvedActor | null = null,
  ): Promise<TranslationDto> {
    const targetLanguage = (input.targetLanguage ?? '').trim().toLowerCase();
    if (!targetLanguage) {
      throw new BadRequestException('targetLanguage must contain non-whitespace characters');
    }
    if (actor !== null) {
      await this.assertMessageVisible(input.messageId, actor);
    }

    return this.tenantPrisma.executeInTenantTransaction(async (tx: PrismaClient) => {
      // Cache lookup
      const cached = await tx.$queryRawUnsafe<TranslationRow[]>(
        'SELECT id::text AS id, message_id::text AS message_id, ' +
          'message_created_at::text AS message_created_at, target_language, translated_text, ' +
          'source_language, model_version, confidence::text AS confidence, ' +
          'translated_at::text AS translated_at, requested_by::text AS requested_by ' +
          'FROM msg_translations ' +
          'WHERE message_id = $1::uuid AND target_language = $2 LIMIT 1',
        input.messageId,
        targetLanguage,
      );
      if (cached.length > 0) {
        return rowToDto(cached[0]!, true);
      }

      // Cache miss — resolve source text. Either it was provided on the
      // request (auto-translate worker path) or we look it up.
      let sourceText = input.sourceText ?? '';
      let messageCreatedAt: string | null = null;
      if (!sourceText) {
        const lookup = await tx.$queryRawUnsafe<MessageLookupRow[]>(
          'SELECT body, created_at::text AS created_at FROM msg_messages WHERE id = $1::uuid LIMIT 1',
          input.messageId,
        );
        if (lookup.length === 0) {
          throw new NotFoundException(
            'Source message not found and sourceText not supplied — cannot translate.',
          );
        }
        sourceText = lookup[0]!.body;
        messageCreatedAt = lookup[0]!.created_at;
      } else {
        // Caller-supplied path — need a message_created_at too. We let
        // callers pass the timestamp via a follow-up lookup; for the
        // worker path this is the inbound event payload's created_at.
        const lookup = await tx.$queryRawUnsafe<MessageLookupRow[]>(
          'SELECT body, created_at::text AS created_at FROM msg_messages WHERE id = $1::uuid LIMIT 1',
          input.messageId,
        );
        messageCreatedAt = lookup.length > 0 ? lookup[0]!.created_at : new Date().toISOString();
      }

      const ai = await this.ai.translate(sourceText, targetLanguage, input.sourceLanguage ?? null);

      const newId = generateId();
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO msg_translations ' +
            '(id, message_id, message_created_at, target_language, translated_text, ' +
            'source_language, model_version, confidence, requested_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4, $5, $6, $7, $8, $9::uuid) ' +
            'ON CONFLICT (message_id, target_language) DO NOTHING',
          newId,
          input.messageId,
          messageCreatedAt,
          targetLanguage,
          ai.translatedText,
          ai.sourceLanguage,
          ai.modelVersion,
          ai.confidence,
          requestedBy,
        );
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Race lost — fall through to the re-read below.
      }

      const rows = await tx.$queryRawUnsafe<TranslationRow[]>(
        'SELECT id::text AS id, message_id::text AS message_id, ' +
          'message_created_at::text AS message_created_at, target_language, translated_text, ' +
          'source_language, model_version, confidence::text AS confidence, ' +
          'translated_at::text AS translated_at, requested_by::text AS requested_by ' +
          'FROM msg_translations ' +
          'WHERE message_id = $1::uuid AND target_language = $2 LIMIT 1',
        input.messageId,
        targetLanguage,
      );
      // If the row we just inserted (or that the race winner inserted)
      // is gone, surface a 500-class error so the caller retries.
      if (rows.length === 0) {
        throw new Error('Translation cache miss after INSERT — unexpected race');
      }
      // cached=false on the path we just produced the row. If ON CONFLICT
      // DO NOTHING swallowed the insert because a concurrent request beat
      // us to it, the row exists with a different id — we still report
      // cached=true since the caller paid one AI call's worth of work
      // but the canonical row was written by someone else.
      const isOursThatJustLanded = rows[0]!.id === newId;
      return rowToDto(rows[0]!, !isOursThatJustLanded);
    });
  }

  /** List all cached translations for a message — used by the UI to
   *  surface "available languages" toggles.
   *
   *  REVIEW-P2C19 BLOCKING 1: enforces the same message visibility
   *  check as translate() so a caller cannot enumerate translations
   *  for a message they cannot read. */
  async listForMessage(messageId: string, actor: ResolvedActor): Promise<TranslationDto[]> {
    await this.assertMessageVisible(messageId, actor);
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const rows = await client.$queryRawUnsafe<TranslationRow[]>(
        'SELECT id::text AS id, message_id::text AS message_id, ' +
          'message_created_at::text AS message_created_at, target_language, translated_text, ' +
          'source_language, model_version, confidence::text AS confidence, ' +
          'translated_at::text AS translated_at, requested_by::text AS requested_by ' +
          'FROM msg_translations WHERE message_id = $1::uuid ORDER BY target_language ASC',
        messageId,
      );
      return rows.map((r) => rowToDto(r, true));
    });
  }

  /**
   * REVIEW-P2C19 BLOCKING 1 — message visibility gate.
   *
   * The caller can access a translation iff they can read the source
   * message. Reading happens through the messaging-module ownership
   * path:
   *   - school admin (actor.isSchoolAdmin) sees every message in the
   *     calling tenant;
   *   - sender (msg_messages.sender_id = actor.accountId);
   *   - or active participant in the thread
   *     (msg_thread_participants.platform_user_id = actor.accountId
   *      AND left_at IS NULL).
   *
   * A miss collapses to 404 NotFoundException — don't-leak-existence.
   *
   * Note: msg_messages is RANGE-partitioned by created_at — the
   * lookup joins by id alone and Postgres pruning still kicks in via
   * the partition routing layer because we don't need a date range.
   */
  private async assertMessageVisible(messageId: string, actor: ResolvedActor): Promise<void> {
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const rows = await client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM msg_messages m ' +
          'WHERE m.id = $1::uuid AND (' +
          '  $2::boolean = true ' +
          '  OR m.sender_id = $3::uuid ' +
          '  OR EXISTS (' +
          '    SELECT 1 FROM msg_thread_participants p ' +
          '    WHERE p.thread_id = m.thread_id ' +
          '      AND p.platform_user_id = $3::uuid ' +
          '      AND p.left_at IS NULL' +
          '  )' +
          ') LIMIT 1',
        messageId,
        actor.isSchoolAdmin,
        actor.accountId,
      );
      if (rows.length === 0) {
        throw new NotFoundException('Message not found');
      }
    });
  }
}
