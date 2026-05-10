import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumedMessage, KafkaConsumerService } from '../kafka/kafka-consumer.service';
import { IdempotencyService } from '../kafka/idempotency.service';
import { prefixedTopic } from '../kafka/event-envelope';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '../notifications/consumers/notification-consumer-base';

const CONSUMER_GROUP = 'cover-arrangement-consumer';

interface AssignmentConfirmedPayload {
  assignmentId: string;
  jobId: string;
  schoolId: string;
  substituteId: string;
  substituteName: string | null;
  confirmedAt: string;
}

/**
 * CoverArrangementConsumer — P2-9b Step 10.
 *
 * Bridges sub.assignment.confirmed (P2-9 marketplace) into the Cycle 5
 * sch_coverage_requests state machine.
 *
 * On confirmed: for every sub_job_classes snapshot attached to the
 * accepted job, find a matching sch_coverage_requests row (same
 * timetable_slot_id + same date) and flip it OPEN -> CANCELLED with a
 * note indicating the slot is covered by a marketplace substitute.
 *
 * Why CANCELLED and not ASSIGNED?
 *
 *   sch_coverage_requests.assigned_substitute_id is a real DB-enforced
 *   FK to hr_employees(id) — a tenant-scoped table. Marketplace
 *   substitutes live in platform.platform_substitute_profiles and have
 *   no hr_employees row in this tenant per the ADR-029 platform-portable
 *   model. We cannot satisfy that FK without first creating a shadow
 *   hr_employees row, which is out of scope for P2-9b.
 *
 *   Flipping the row to CANCELLED (with status notes pointing at the
 *   marketplace assignment id) is the cleanest signal to the scheduling
 *   module that the slot is covered without trying to wedge a platform
 *   substitute into a tenant FK.
 *
 * The cleaner ASSIGNED integration — auto-create an hr_employees shadow
 * row for marketplace substitutes on first acceptance, then point the
 * coverage request at it — is a Phase 2 punch list item documented in
 * P2C9-REVIEW-NOTES.md.
 *
 * If no matching coverage request exists (e.g. an ad-hoc marketplace
 * cover not driven by a Cycle 4 leave_request), the consumer drops
 * the event silently — there's nothing to update.
 */
@Injectable()
export class CoverArrangementConsumer implements OnModuleInit {
  private readonly logger = new Logger(CoverArrangementConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic('sub.assignment.confirmed')],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    const event = unwrapEnvelope<AssignmentConfirmedPayload>(msg, this.logger);
    if (!event) return;
    const p = event.payload;
    if (!p.assignmentId || !p.jobId || !p.schoolId) {
      this.logger.warn(
        '[' + CONSUMER_GROUP + '] dropping malformed event eventId=' + event.eventId,
      );
      return;
    }
    const self = this;
    await processWithIdempotency(
      CONSUMER_GROUP,
      event as UnwrappedEvent<unknown>,
      this.idempotency,
      this.logger,
      async function () {
        await self.linkCoverArrangement(event!);
      },
    );
  }

  private async linkCoverArrangement(
    event: UnwrappedEvent<AssignmentConfirmedPayload>,
  ): Promise<void> {
    const p = event.payload;
    const flipped = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // For every sub_job_classes row on this job, find a matching
      // sch_coverage_requests row (same timetable_slot + same coverage_date
      // computed from the parent job's job_date) and flip OPEN -> CANCELLED.
      const result = (await tx.$queryRawUnsafe(
        `UPDATE sch_coverage_requests cr
         SET status = 'CANCELLED', updated_at = now(),
             notes = COALESCE(notes, '') || $1
         FROM sub_job_classes c
         JOIN sub_job_postings j ON j.id = c.job_id
         WHERE c.job_id = $2::uuid
           AND cr.timetable_slot_id = c.timetable_slot_id
           AND cr.coverage_date = j.job_date
           AND cr.status = 'OPEN'
         RETURNING cr.id::text AS id`,
        '\n[Cover arrangement linked to marketplace substitute assignment ' + p.assignmentId + ']',
        p.jobId,
      )) as Array<{ id: string }>;
      return result.length;
    });

    if (flipped > 0) {
      this.logger.log(
        '[' +
          CONSUMER_GROUP +
          '] linked ' +
          flipped +
          ' sch_coverage_requests rows to marketplace assignment=' +
          p.assignmentId,
      );
    } else {
      this.logger.debug(
        '[' +
          CONSUMER_GROUP +
          '] no matching open coverage requests for marketplace assignment=' +
          p.assignmentId +
          ' (ad-hoc cover or unmatched timetable_slot)',
      );
    }
  }
}
