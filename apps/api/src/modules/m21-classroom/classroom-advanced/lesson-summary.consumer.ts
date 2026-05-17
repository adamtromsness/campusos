import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumedMessage, KafkaConsumerService } from '@shared/kafka/kafka-consumer.service';
import { IdempotencyService } from '@shared/kafka/idempotency.service';
import { prefixedTopic } from '@shared/kafka/event-envelope';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '@shared/kafka/envelope-consumer';
import { LessonRecordingService } from './lesson-recording.service';

interface SummaryReadyPayload {
  recordingId?: string;
  schoolId?: string;
  summaryText?: string;
  keyTopics?: string[];
  actionItems?: string[];
  modelVersion?: string | null;
  tokensUsed?: number | null;
}

const CONSUMER_GROUP = 'classroom-lesson-summary-consumer';

/**
 * LessonSummaryConsumer — P2-7c Step 6.
 *
 * Subscribes to `dev.lesson.summary.from_ai` from the AI Inference
 * extracted service. The dev pipeline chains the inline summary call
 * straight from VideoTranscriptConsumer because the AI Inference
 * service is not yet deployed; this consumer is the production wire
 * for when that service ships and publishes its own response topic.
 *
 * NOTE the topic name is `lesson.summary.from_ai` (the AI Inference
 * response back into CampusOS) — distinct from `lesson.summary.ready`
 * which is what LessonRecordingService.applySummary EMITS for teacher
 * notification fan-out. Two different topics in two different
 * directions on the bus.
 *
 * Both helpers (applySummary + claim) are idempotent so a duplicate
 * delivery is a no-op.
 */
@Injectable()
export class LessonSummaryConsumer implements OnModuleInit {
  private readonly logger = new Logger(LessonSummaryConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly recordings: LessonRecordingService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic('lesson.summary.from_ai')],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    const event = unwrapEnvelope<SummaryReadyPayload>(msg, this.logger);
    if (!event) return;
    const self = this;
    await processWithIdempotency(
      CONSUMER_GROUP,
      event as UnwrappedEvent<unknown>,
      this.idempotency,
      this.logger,
      async function () {
        await self.process(event!);
      },
    );
  }

  private async process(event: UnwrappedEvent<SummaryReadyPayload>): Promise<void> {
    const p = event.payload;
    if (!p.recordingId || !p.summaryText) {
      this.logger.warn(
        'Dropping lesson.summary.from_ai (eventId=' +
          event.eventId +
          ') — missing recordingId or summaryText',
      );
      return;
    }
    await this.recordings.applySummary({
      recordingId: p.recordingId,
      summaryText: p.summaryText,
      keyTopics: p.keyTopics ?? [],
      actionItems: p.actionItems ?? [],
      modelVersion: p.modelVersion ?? null,
      tokensUsed: p.tokensUsed ?? null,
    });
  }
}
