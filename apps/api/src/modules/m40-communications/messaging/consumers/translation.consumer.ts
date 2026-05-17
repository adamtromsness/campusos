import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ConsumedMessage, KafkaConsumerService } from '@shared/kafka';
import { IdempotencyService } from '@shared/kafka';
import { prefixedTopic } from '@shared/kafka';
import { TenantPrismaService } from '@shared/tenant';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '@shared/kafka';
import { TranslationService } from '../translation.service';

interface MessagePostedPayload {
  messageId: string;
  threadId: string;
  senderId: string;
  body: string;
  postedAt: string;
  threadSubject?: string | null;
  threadType?: string | null;
}

const CONSUMER_GROUP = 'translation-worker';

/**
 * TranslationConsumer — auto-translate worker.
 *
 * Subscribes to msg.message.posted. For each message, walks the
 * thread participants (excluding the sender) and translates the body
 * into every recipient's `preferred_language` when their language
 * preference row has `auto_translate_incoming=true`. The translation
 * is cached in msg_translations keyed on
 * UNIQUE(message_id, target_language) so a redelivered event AND a
 * second recipient with the same preferred_language both hit the
 * cache instead of double-calling the AI Inference service.
 *
 * Sender language is read from the sender's preference row (defaults
 * to 'en'). The TranslationService passes the already-known body via
 * `sourceText` so the worker never re-reads msg_messages.
 *
 * Idempotency: standard claim-after-success against
 * platform_event_consumer_idempotency under
 * `translation-worker` group. The cache UNIQUE means duplicate
 * processing is harmless beyond a few wasted DB reads.
 */
@Injectable()
export class TranslationConsumer implements OnModuleInit {
  private readonly logger = new Logger(TranslationConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly translations: TranslationService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.consumer.subscribe({
      topics: [prefixedTopic('msg.message.posted')],
      groupId: CONSUMER_GROUP,
      handler: (msg: ConsumedMessage) => this.handle(msg),
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    const event = unwrapEnvelope<MessagePostedPayload>(msg, this.logger);
    if (!event) return;
    if (!event.payload.messageId || !event.payload.threadId || !event.payload.senderId) {
      this.logger.warn(
        'Dropping ' + msg.topic + ' (eventId=' + event.eventId + ') — missing routing ids',
      );
      return;
    }

    await processWithIdempotency(
      CONSUMER_GROUP,
      event as UnwrappedEvent<unknown>,
      this.idempotency,
      this.logger,
      async () => this.fanOut(event!.payload),
    );
  }

  private async fanOut(p: MessagePostedPayload): Promise<void> {
    const targets = await this.resolveAutoTranslateTargets(p.threadId, p.senderId);
    if (targets.length === 0) {
      this.logger.debug(
        'TranslationConsumer skip — no auto-translate participants for thread ' + p.threadId,
      );
      return;
    }
    const sourceLanguage = await this.resolveSenderLanguage(p.senderId);
    // Deduplicate target languages — many recipients may share the
    // same preferred_language. UNIQUE(message_id, target_language)
    // would dedupe at the DB layer either way; collapsing here saves
    // AI calls.
    const uniqueLangs = Array.from(new Set(targets.map((t) => t.preferred_language)));
    for (const lang of uniqueLangs) {
      try {
        await this.translations.translate(
          {
            messageId: p.messageId,
            targetLanguage: lang,
            sourceText: p.body,
            sourceLanguage: sourceLanguage ?? undefined,
          },
          null, // requested_by=NULL marks the row as worker-produced
        );
      } catch (err) {
        const msg = (err as { message?: string }).message ?? '';
        this.logger.warn(
          'TranslationConsumer translate failed for messageId=' +
            p.messageId +
            ' lang=' +
            lang +
            ': ' +
            msg,
        );
        // Rethrow so processWithIdempotency leaves the claim unset and a
        // Kafka redelivery retries. The cache UNIQUE makes the retry
        // safe — successful translations from earlier languages are
        // already in the table.
        throw err;
      }
    }
  }

  private async resolveAutoTranslateTargets(
    threadId: string,
    senderId: string,
  ): Promise<Array<{ account_id: string; preferred_language: string }>> {
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      return client.$queryRawUnsafe<Array<{ account_id: string; preferred_language: string }>>(
        'SELECT tp.platform_user_id::text AS account_id, lp.preferred_language ' +
          'FROM msg_thread_participants tp ' +
          'JOIN msg_user_language_preferences lp ON lp.user_id = tp.platform_user_id ' +
          'WHERE tp.thread_id = $1::uuid ' +
          '  AND tp.platform_user_id <> $2::uuid ' +
          '  AND tp.left_at IS NULL ' +
          '  AND lp.auto_translate_incoming = true',
        threadId,
        senderId,
      );
    });
  }

  private async resolveSenderLanguage(senderId: string): Promise<string | null> {
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const rows = await client.$queryRawUnsafe<Array<{ preferred_language: string }>>(
        'SELECT preferred_language FROM msg_user_language_preferences WHERE user_id = $1::uuid LIMIT 1',
        senderId,
      );
      return rows.length > 0 ? rows[0]!.preferred_language : 'en';
    });
  }
}
