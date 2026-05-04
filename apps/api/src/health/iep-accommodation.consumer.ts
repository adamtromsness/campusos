import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { ConsumedMessage, KafkaConsumerService } from '../kafka/kafka-consumer.service';
import { IdempotencyService } from '../kafka/idempotency.service';
import { prefixedTopic } from '../kafka/event-envelope';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '../notifications/consumers/notification-consumer-base';

/**
 * IepAccommodationConsumer — Cycle 10 Step 7. THE ADR-030 KEYSTONE.
 *
 * Subscribes to `dev.iep.accommodation.updated` under group
 * `iep-accommodation-consumer`. Per inbound event, reconciles
 * `sis_student_active_accommodations` (the read model teachers query
 * via the existing Cycle 1 student profile endpoint) against the
 * snapshot in the payload.
 *
 * Reconciliation algorithm:
 *
 *   1. UPSERT every accommodation in the payload, keyed on
 *      `source_iep_accommodation_id` (the schema's partial UNIQUE
 *      INDEX on that column WHERE NOT NULL is the canonical key).
 *   2. DELETE any sis_student_active_accommodations rows for this
 *      student whose source_iep_accommodation_id is NOT in the
 *      payload's set — these source rows were removed from the IEP
 *      plan, OR the plan flipped to EXPIRED (the emitter sends an
 *      empty array in that case).
 *
 * The `source_iep_accommodation_id IS NOT NULL` clause on the DELETE
 * keeps any seed-time direct writes (which intentionally have NULL
 * source_iep_accommodation_id per the Step 4 ADR-030 demo seed) out
 * of the reconcile path. Seed rows coexist with consumer-maintained
 * rows by design.
 *
 * Standard claim-after-success idempotency via processWithIdempotency
 * matches the pattern from the Cycle 5 CoverageConsumer + Cycle 9
 * BehaviourNotificationConsumer.
 */

interface AccommodationSnapshot {
  sourceIepAccommodationId: string;
  accommodationType: string;
  description?: string | null;
  appliesTo: 'ALL_ASSESSMENTS' | 'ALL_ASSIGNMENTS' | 'SPECIFIC';
  specificAssignmentTypes?: string[] | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

interface AccommodationPayload {
  planId: string;
  schoolId: string;
  studentId: string;
  planType: 'IEP' | '504';
  planStatus: 'DRAFT' | 'ACTIVE' | 'REVIEW' | 'EXPIRED';
  accommodations: AccommodationSnapshot[];
}

const CONSUMER_GROUP = 'iep-accommodation-consumer';

@Injectable()
export class IepAccommodationConsumer implements OnModuleInit {
  private readonly logger = new Logger(IepAccommodationConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic('iep.accommodation.updated')],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    const event = unwrapEnvelope<AccommodationPayload>(msg, this.logger);
    if (!event) return;
    const self = this;
    await processWithIdempotency(
      CONSUMER_GROUP,
      event as UnwrappedEvent<unknown>,
      this.idempotency,
      this.logger,
      async function () {
        await self.reconcile(event!);
      },
    );
  }

  private async reconcile(event: UnwrappedEvent<AccommodationPayload>): Promise<void> {
    const p = event.payload;
    if (!p.studentId || !p.schoolId) {
      this.logger.warn(
        'Dropping iep.accommodation.updated (eventId=' + event.eventId + ') — missing routing ids',
      );
      return;
    }

    const incomingIds = new Set<string>();
    for (const a of p.accommodations) {
      if (a.sourceIepAccommodationId) incomingIds.add(a.sourceIepAccommodationId);
    }

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // 1) UPSERT every accommodation in the payload.
      for (const a of p.accommodations) {
        const id = generateId();
        // ON CONFLICT keys on the partial UNIQUE INDEX, which only
        // applies WHERE source_iep_accommodation_id IS NOT NULL — the
        // exact subset we are upserting into.
        await tx.$executeRawUnsafe(
          'INSERT INTO sis_student_active_accommodations ' +
            '(id, school_id, student_id, plan_type, accommodation_type, description, applies_to, ' +
            ' specific_assignment_types, effective_from, effective_to, source_iep_accommodation_id) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::text[], $9::date, $10::date, $11::uuid) ' +
            'ON CONFLICT (source_iep_accommodation_id) WHERE source_iep_accommodation_id IS NOT NULL ' +
            'DO UPDATE SET ' +
            '  accommodation_type = EXCLUDED.accommodation_type, ' +
            '  description = EXCLUDED.description, ' +
            '  applies_to = EXCLUDED.applies_to, ' +
            '  specific_assignment_types = EXCLUDED.specific_assignment_types, ' +
            '  effective_from = EXCLUDED.effective_from, ' +
            '  effective_to = EXCLUDED.effective_to, ' +
            '  plan_type = EXCLUDED.plan_type, ' +
            '  updated_at = now()',
          id,
          p.schoolId,
          p.studentId,
          p.planType,
          a.accommodationType,
          a.description ?? null,
          a.appliesTo,
          a.specificAssignmentTypes ?? null,
          a.effectiveFrom ?? null,
          a.effectiveTo ?? null,
          a.sourceIepAccommodationId,
        );
      }

      // 2) DELETE rows for this student whose source_iep_accommodation_id
      //    is NOT in the snapshot — those source accommodations were
      //    removed (or the plan flipped to EXPIRED → empty array).
      //    Only operate on consumer-maintained rows; seed rows with
      //    NULL source_iep_accommodation_id are left alone.
      if (incomingIds.size === 0) {
        await tx.$executeRawUnsafe(
          'DELETE FROM sis_student_active_accommodations ' +
            'WHERE student_id = $1::uuid AND source_iep_accommodation_id IS NOT NULL',
          p.studentId,
        );
      } else {
        await tx.$executeRawUnsafe(
          'DELETE FROM sis_student_active_accommodations ' +
            'WHERE student_id = $1::uuid ' +
            '  AND source_iep_accommodation_id IS NOT NULL ' +
            '  AND source_iep_accommodation_id <> ALL($2::uuid[])',
          p.studentId,
          Array.from(incomingIds),
        );
      }
    });

    this.logger.log(
      '[iep-accommodation-consumer] reconciled student=' +
        p.studentId +
        ' planStatus=' +
        p.planStatus +
        ' incoming=' +
        p.accommodations.length,
    );
  }
}
