import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConsumedMessage, KafkaConsumerService } from '@shared/kafka/kafka-consumer.service';
import { IdempotencyService } from '@shared/kafka/idempotency.service';
import { prefixedTopic } from '@shared/kafka/event-envelope';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '@modules/m40-communications/notifications/consumers/notification-consumer-base';
import { LessonRecordingService } from './lesson-recording.service';
import { AIGatewayService } from './ai-gateway.service';
import { AIUsageService } from './ai-usage.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';

interface TranscribedPayload {
  recordingId?: string;
  schoolId?: string;
  transcriptText?: string;
  wordCount?: number;
  language?: string;
}

const CONSUMER_GROUP = 'classroom-video-transcript-consumer';

/**
 * VideoTranscriptConsumer — P2-7c Step 6.
 *
 * Subscribes to `dev.video.transcribed` (the response from the Video
 * Processing extracted service). On each event:
 *
 *   1. Unwrap the ADR-057 envelope and pull the recordingId.
 *   2. Run LessonRecordingService.applyTranscript inside the tenant
 *      context — writes cls_lesson_transcripts and flips the parent
 *      recording from TRANSCRIBING to SUMMARISING.
 *   3. Immediately call the AI Gateway summariseLesson stub (the
 *      production path is the AI Inference service consuming the
 *      transcript via a separate topic; in dev we chain inline).
 *   4. Run LessonRecordingService.applySummary which writes
 *      cls_lesson_summaries and flips the recording to COMPLETE.
 *      That call also emits lesson.summary.ready for teacher
 *      notification.
 *   5. After both steps succeed, claim-after-success — a transient
 *      DB failure leaves the eventId unclaimed and the next
 *      redelivery rebuilds the work. The applyTranscript +
 *      applySummary helpers are idempotent (existing-row short-
 *      circuit) so a redelivery is harmless.
 *
 * Stub note — until the Video Processing service ships, no producer
 * publishes `dev.video.transcribed`. The seed-classroom-advanced-c
 * script lands a placeholder transcript directly via SQL so the read
 * path renders end-to-end. The consumer subscribes successfully so
 * the wire is in place when the upstream service deploys.
 */
@Injectable()
export class VideoTranscriptConsumer implements OnModuleInit {
  private readonly logger = new Logger(VideoTranscriptConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly recordings: LessonRecordingService,
    private readonly gateway: AIGatewayService,
    private readonly usage: AIUsageService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic('video.transcribed')],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    const event = unwrapEnvelope<TranscribedPayload>(msg, this.logger);
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

  private async process(event: UnwrappedEvent<TranscribedPayload>): Promise<void> {
    const p = event.payload;
    if (!p.recordingId || !p.transcriptText) {
      this.logger.warn(
        'Dropping video.transcribed (eventId=' +
          event.eventId +
          ') — missing recordingId or transcriptText',
      );
      return;
    }

    try {
      await this.recordings.applyTranscript({
        recordingId: p.recordingId,
        transcriptText: p.transcriptText,
        wordCount: p.wordCount,
        language: p.language,
      });

      // Chain to summarisation in dev — production routes via a separate
      // dev.lesson.transcribed event consumed by the AI Inference service.
      const tenant = getCurrentTenant();
      const summary = await this.gateway.summariseLesson({
        anonymousRecordingId: p.recordingId,
        className: null,
        subject: null,
        transcript: p.transcriptText,
      });
      await this.recordings.applySummary({
        recordingId: p.recordingId,
        summaryText: summary.summaryText,
        keyTopics: summary.keyTopics,
        actionItems: summary.actionItems,
        modelVersion: summary.modelVersion,
        tokensUsed: summary.tokensUsed,
      });
      await this.usage.recordUsage({
        schoolId: tenant.schoolId,
        jobType: 'SUMMARISATION',
        tokensUsed: summary.tokensUsed,
        costUsd: summary.costUsd,
        referenceId: p.recordingId,
        actorAccountId: null,
      });
    } catch (e: any) {
      this.logger.error(
        'video.transcribed processing failed (recordingId=' +
          p.recordingId +
          '): ' +
          (e?.message || e),
      );
      // REVIEW-P2C7 MAJOR 8 — only flip the recording to FAILED on
      // permanent error classes (NotFoundException = recording does
      // not exist; the upstream service published a stale or invalid
      // recordingId). Transient errors (DB blips, AI Gateway timeout)
      // rethrow without marking FAILED so the consumer's
      // claim-after-success path retries via Kafka redelivery — and a
      // retry that succeeds finds the recording still in the
      // expected status, not a permanently FAILED row that operators
      // would need to manually unpick.
      if (e instanceof NotFoundException) {
        try {
          await this.recordings.markFailed(p.recordingId, e?.message || 'Recording not found');
        } catch (e2: any) {
          this.logger.warn('Could not mark recording FAILED: ' + (e2?.message || e2));
        }
      }
      throw e;
    }
  }
}
