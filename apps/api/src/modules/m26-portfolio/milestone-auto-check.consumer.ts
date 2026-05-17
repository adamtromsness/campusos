import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumedMessage, KafkaConsumerService } from '@shared/kafka';
import { IdempotencyService } from '@shared/kafka';
import { prefixedTopic } from '@shared/kafka';
import {
  processWithIdempotency,
  unwrapEnvelope,
  UnwrappedEvent,
} from '@shared/kafka';
import { ReadinessPathwayService } from './readiness.service';

/**
 * MilestoneAutoCheckWorker — Phase 2 Cycle 27 Step 6.
 *
 * Subscribes to the cross-module events that should auto-complete a
 * readiness pathway milestone when the corresponding work lands in
 * another module. Per the plan:
 *
 *   sis.service_learning.approved   -> auto-completes any milestone
 *                                      whose auto_check_source matches
 *                                      "graduation_audit:SERVICE_HOURS"
 *                                      for the student in the payload.
 *
 *   sis.transcript.generated        -> auto-completes any milestone
 *                                      whose auto_check_source matches
 *                                      "transcript:GENERATED" for the
 *                                      student in the payload.
 *
 * The worker delegates the per-assignment walk + status flip to
 * ReadinessPathwayService.autoCheckByCrossModuleEvent — which locks
 * the assignment rows FOR UPDATE inside one tenant tx, mutates the
 * milestone_statuses JSONB, recomputes overall_progress, and emits
 * pfl.pathway.milestone_completed per flipped milestone.
 *
 * Standard claim-after-success idempotency via processWithIdempotency
 * matches the Cycle 5 CoverageConsumer + Cycle 9 BehaviourNotification-
 * Consumer + Cycle 10 IepAccommodationConsumer patterns.
 */

interface ServiceLearningApprovedPayload {
  studentId: string;
  schoolId: string;
  hoursTotal?: number;
  approvedAt?: string;
}

interface TranscriptGeneratedPayload {
  studentId: string;
  schoolId: string;
  transcriptId?: string;
}

type AutoCheckEvent =
  | { kind: 'service_learning'; payload: ServiceLearningApprovedPayload }
  | { kind: 'transcript'; payload: TranscriptGeneratedPayload };

const CONSUMER_GROUP = 'milestone-auto-check-worker';

const TOPIC_SERVICE_LEARNING = prefixedTopic('sis.service_learning.approved');
const TOPIC_TRANSCRIPT = prefixedTopic('sis.transcript.generated');

@Injectable()
export class MilestoneAutoCheckConsumer implements OnModuleInit {
  private readonly logger = new Logger(MilestoneAutoCheckConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly readiness: ReadinessPathwayService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: [TOPIC_SERVICE_LEARNING, TOPIC_TRANSCRIPT],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    const topic = msg.topic;
    let kind: AutoCheckEvent['kind'];
    let autoCheckSource: string;
    if (topic === TOPIC_SERVICE_LEARNING) {
      kind = 'service_learning';
      autoCheckSource = 'graduation_audit:SERVICE_HOURS';
    } else if (topic === TOPIC_TRANSCRIPT) {
      kind = 'transcript';
      autoCheckSource = 'transcript:GENERATED';
    } else {
      this.logger.warn('[milestone-auto-check] dropping unexpected topic ' + topic);
      return;
    }

    const event = unwrapEnvelope<{ studentId: string; schoolId: string }>(msg, this.logger);
    if (!event) return;
    const self = this;
    await processWithIdempotency(
      CONSUMER_GROUP,
      event as UnwrappedEvent<unknown>,
      this.idempotency,
      this.logger,
      async function () {
        const p = event!.payload;
        if (!p.studentId || !p.schoolId) {
          self.logger.warn(
            '[milestone-auto-check] dropping ' +
              topic +
              ' (eventId=' +
              event!.eventId +
              ') — missing studentId or schoolId',
          );
          return;
        }
        const count = await self.readiness.autoCheckByCrossModuleEvent(
          p.schoolId,
          p.studentId,
          autoCheckSource,
        );
        self.logger.log(
          '[milestone-auto-check] kind=' +
            kind +
            ' source=' +
            autoCheckSource +
            ' student=' +
            p.studentId +
            ' updatedAssignments=' +
            count,
        );
      },
    );
  }
}
