import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import {
  LanguagePreferenceDto,
  UpdateLanguagePreferenceDto,
} from './dto/communications-advanced.dto';

interface LanguagePreferenceRow {
  id: string;
  user_id: string;
  preferred_language: string;
  auto_translate_incoming: boolean;
  auto_translate_outgoing: boolean;
  updated_at: string;
}

function rowToDto(row: LanguagePreferenceRow): LanguagePreferenceDto {
  return {
    id: row.id,
    userId: row.user_id,
    preferredLanguage: row.preferred_language,
    autoTranslateIncoming: row.auto_translate_incoming,
    autoTranslateOutgoing: row.auto_translate_outgoing,
    updatedAt: row.updated_at,
  };
}

/**
 * LanguagePreferenceService — per-user (platform_users.id) language
 * preference plus auto-translate toggles. Used by the translation
 * surface (TranslationService) and the auto-translate worker.
 *
 * Storage: tenant-scoped `msg_user_language_preferences`. UNIQUE on
 * user_id means each platform user holds at most one row per tenant —
 * the get-or-default helper returns the default English row for first-
 * time callers so the UI never has to handle a 404 on read.
 *
 * Authorisation: callers can only read/write their own preference row.
 * The controller never accepts an explicit `userId` parameter; the
 * row is keyed off `actor.accountId` from the request context.
 */
@Injectable()
export class LanguagePreferenceService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async getOrDefault(accountId: string): Promise<LanguagePreferenceDto> {
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const rows = await client.$queryRawUnsafe<LanguagePreferenceRow[]>(
        'SELECT id::text AS id, user_id::text AS user_id, preferred_language, ' +
          'auto_translate_incoming, auto_translate_outgoing, ' +
          'updated_at::text AS updated_at ' +
          'FROM msg_user_language_preferences WHERE user_id = $1::uuid LIMIT 1',
        accountId,
      );
      if (rows.length > 0) return rowToDto(rows[0]!);
      // No row yet — return a default English shape without inserting.
      // The Step 4 PATCH endpoint UPSERTs on first write.
      return {
        id: '',
        userId: accountId,
        preferredLanguage: 'en',
        autoTranslateIncoming: false,
        autoTranslateOutgoing: false,
        updatedAt: '',
      };
    });
  }

  async upsert(
    accountId: string,
    input: UpdateLanguagePreferenceDto,
  ): Promise<LanguagePreferenceDto> {
    return this.tenantPrisma.executeInTenantTransaction(async (tx: PrismaClient) => {
      const existing = await tx.$queryRawUnsafe<LanguagePreferenceRow[]>(
        'SELECT id::text AS id, user_id::text AS user_id, preferred_language, ' +
          'auto_translate_incoming, auto_translate_outgoing, ' +
          'updated_at::text AS updated_at ' +
          'FROM msg_user_language_preferences WHERE user_id = $1::uuid FOR UPDATE',
        accountId,
      );
      if (existing.length === 0) {
        const newId = generateId();
        await tx.$executeRawUnsafe(
          'INSERT INTO msg_user_language_preferences ' +
            '(id, user_id, preferred_language, auto_translate_incoming, auto_translate_outgoing) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
          newId,
          accountId,
          input.preferredLanguage ?? 'en',
          input.autoTranslateIncoming ?? false,
          input.autoTranslateOutgoing ?? false,
        );
      } else {
        await tx.$executeRawUnsafe(
          'UPDATE msg_user_language_preferences SET ' +
            'preferred_language = COALESCE($2, preferred_language), ' +
            'auto_translate_incoming = COALESCE($3, auto_translate_incoming), ' +
            'auto_translate_outgoing = COALESCE($4, auto_translate_outgoing), ' +
            'updated_at = now() ' +
            'WHERE user_id = $1::uuid',
          accountId,
          input.preferredLanguage ?? null,
          input.autoTranslateIncoming ?? null,
          input.autoTranslateOutgoing ?? null,
        );
      }
      const rows = await tx.$queryRawUnsafe<LanguagePreferenceRow[]>(
        'SELECT id::text AS id, user_id::text AS user_id, preferred_language, ' +
          'auto_translate_incoming, auto_translate_outgoing, ' +
          'updated_at::text AS updated_at ' +
          'FROM msg_user_language_preferences WHERE user_id = $1::uuid LIMIT 1',
        accountId,
      );
      return rowToDto(rows[0]!);
    });
  }

  /**
   * Reverse lookup used by the TranslationWorker — does the recipient
   * have auto_translate_incoming=true set? Returns null when the user
   * has never set a preference (the default — no auto-translate).
   */
  async resolveAutoTranslateTarget(accountId: string): Promise<string | null> {
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const rows = await client.$queryRawUnsafe<
        Array<{ preferred_language: string; auto_translate_incoming: boolean }>
      >(
        'SELECT preferred_language, auto_translate_incoming ' +
          'FROM msg_user_language_preferences WHERE user_id = $1::uuid LIMIT 1',
        accountId,
      );
      if (rows.length === 0) return null;
      const row = rows[0]!;
      return row.auto_translate_incoming ? row.preferred_language : null;
    });
  }
}
