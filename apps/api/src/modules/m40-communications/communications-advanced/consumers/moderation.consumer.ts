import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumedMessage, KafkaConsumerService } from '@shared/kafka/kafka-consumer.service';
import { IdempotencyService } from '@shared/kafka/idempotency.service';
import { prefixedTopic } from '@shared/kafka/event-envelope';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '@modules/m40-communications/notifications/consumers/notification-consumer-base';
import { ModerationService } from '../moderation.service';
import { AIModerationService } from '../ai-moderation.service';

interface MessagePostedPayload {
  messageId: string;
  threadId: string;
  senderId: string;
  body: string;
  postedAt: string;
}

const CONSUMER_GROUP = 'moderation-worker';

/**
 * ModerationConsumer — three-tier moderation worker.
 *
 * Subscribes to msg.message.posted. For each message:
 *   1. Reads every active rule matching PLATFORM tier OR the tenant
 *      school (ModerationService.resolveDecision).
 *   2. If any rule carries an ai_sensitivity_threshold, computes the
 *      AI score once via the AIModerationService cache and passes it
 *      to resolveDecision so the rule evaluator sees the threshold
 *      signal alongside keyword matches.
 *   3. resolveDecision picks the most-restrictive action across all
 *      matches (BLOCK > ESCALATE > FLAG).
 *   4. Materialises the result into msg_moderation_actions via
 *      recordAction. AUTO_APPROVED rows land with review_status=RELEASED
 *      so they don't clutter the admin queue; BLOCKED/FLAGGED/ESCALATED
 *      rows land PENDING for admin review.
 *
 * Idempotency: standard claim-after-success against
 * platform_event_consumer_idempotency under `moderation-worker`. The
 * AI cache UNIQUE(message_id) plus the rule evaluator means
 * duplicate processing is harmless beyond a few wasted DB reads.
 *
 * Phase 2 punch list: emit msg.message.blocked when action_taken is
 * BLOCKED so the message-list endpoint hides it from recipients
 * immediately rather than waiting for the next poll. Today the
 * blocked rows still appear in msg_messages — the recipient-side
 * filter that hides them lands when the messaging UI consumes
 * msg_moderation_actions.
 */
@Injectable()
export class ModerationConsumer implements OnModuleInit {
  private readonly logger = new Logger(ModerationConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly moderation: ModerationService,
    private readonly ai: AIModerationService,
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
    if (!event.payload.messageId || !event.payload.body) {
      this.logger.warn(
        'Dropping ' + msg.topic + ' (eventId=' + event.eventId + ') — missing messageId or body',
      );
      return;
    }

    await processWithIdempotency(
      CONSUMER_GROUP,
      event as UnwrappedEvent<unknown>,
      this.idempotency,
      this.logger,
      async () => this.moderate(event!.payload, event!.eventId),
    );
  }

  private async moderate(p: MessagePostedPayload, sourceEventId: string): Promise<void> {
    // Step 1: compute the AI sensitivity score once via the cache.
    // The cache means a redelivered event reads the cached row rather
    // than re-calling the AI Inference service.
    let aiScore: number | null = null;
    try {
      const ai = await this.ai.analyze(p.messageId, p.body);
      aiScore = ai.sensitivityScore;
    } catch (err) {
      const m = (err as { message?: string }).message ?? '';
      this.logger.warn(
        'ModerationConsumer AI analyze failed for messageId=' + p.messageId + ': ' + m,
      );
      // Continue with null — keyword rules still fire.
    }

    // Step 2: resolve the most-restrictive decision across all active
    // rules (PLATFORM + tenant).
    const decision = await this.moderation.resolveDecision(p.body, aiScore);
    if (decision === null) {
      // No rule matched — auto-approve for audit completeness. The
      // schema-side reviewed_chk lockstep handles the (RELEASED,
      // reviewer columns NULL) edge but the recordAction stamp sets
      // review_status=RELEASED for AUTO_APPROVED rows so the admin
      // queue stays clean.
      this.logger.debug(
        'ModerationConsumer no-rule match for messageId=' + p.messageId + ' — skipping log',
      );
      return;
    }

    await this.moderation.recordAction({
      messageId: p.messageId,
      messageCreatedAt: p.postedAt,
      decision,
      // REVIEW-P2C19 BLOCKING 6: pass the consumer group + event id
      // so the contribution-ledger claim survives a crash between the
      // action INSERT and the idempotency claim landing. A redelivered
      // event hits 23505 on the ledger and the service re-reads the
      // existing action row.
      consumerGroup: CONSUMER_GROUP,
      sourceEventId,
    });

    this.logger.log(
      'ModerationConsumer messageId=' +
        p.messageId +
        ' actionTaken=' +
        decision.actionTaken +
        ' matchedKeywords=' +
        decision.matchedKeywords.length +
        ' aiScore=' +
        (decision.aiSensitivityScore ?? 'null'),
    );
  }
}
