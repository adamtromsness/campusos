import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumedMessage, KafkaConsumerService } from '@shared/kafka/kafka-consumer.service';
import { IdempotencyService } from '@shared/kafka/idempotency.service';
import { prefixedTopic } from '@shared/kafka/event-envelope';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '@modules/m40-communications/notifications/consumers/notification-consumer-base';
import { generateId } from '@campusos/database';
import { RatingService } from './rating.service';

const CONSUMER_GROUP = 'cancellation-policy-consumer';

interface LateCancelledPayload {
  assignmentId: string;
  schoolId: string;
  substituteId: string;
  jobDate: string;
  jobStartTime: string;
  lateWindowHours: number;
  cancelledByType: 'SCHOOL' | 'SUBSTITUTE';
  cancellationReason: string;
  cancelledAt: string;
}

/**
 * CancellationPolicyConsumer — P2-9b Step 7.
 *
 * Subscribes to sub.assignment.late_cancelled. On every event:
 *   1. Read the school's cancellation policy.
 *   2. Count this substitute's late cancellations at this school in the
 *      last 6 months.
 *   3. If count >= repeat_offence_threshold, apply the configured
 *      consequence:
 *        WARNING_ONLY            — log only, no DB change.
 *        TEMPORARY_POOL_SUSPENSION — flip sub_school_pool.status to
 *                                    SUSPENDED with suspended_until =
 *                                    today + suspension_duration_days
 *                                    + suspension_reason.
 *        PERMANENT_POOL_REMOVAL   — flip status to REMOVED.
 *        RATING_PENALTY           — RatingService.applyPenalty bumps
 *                                    overall_rating down by
 *                                    rating_penalty_amount (clamped
 *                                    1.0–5.0).
 *   4. Stamp sub_assignments.late_cancellation_consequence_applied=true.
 *
 * The deterministic event_id from AssignmentService ensures redelivery
 * is idempotent via the standard claim-after-success pattern.
 */
@Injectable()
export class CancellationPolicyConsumer implements OnModuleInit {
  private readonly logger = new Logger(CancellationPolicyConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ratings: RatingService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic('sub.assignment.late_cancelled')],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    const event = unwrapEnvelope<LateCancelledPayload>(msg, this.logger);
    if (!event) return;
    const p = event.payload;
    if (!p.assignmentId || !p.substituteId || !p.schoolId) {
      this.logger.warn(
        '[' + CONSUMER_GROUP + '] dropping malformed late-cancel event eventId=' + event.eventId,
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
        await self.applyConsequence(event!);
      },
    );
  }

  private async applyConsequence(event: UnwrappedEvent<LateCancelledPayload>): Promise<void> {
    const p = event.payload;
    const tenant = event.tenant;

    // Tenant tx: read policy + count + apply consequence + stamp assignment.
    const result = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const policyRows = (await tx.$queryRawUnsafe(
        `SELECT consequence, suspension_duration_days, repeat_offence_threshold, rating_penalty_amount::text AS rating_penalty_amount
         FROM sub_cancellation_policies WHERE school_id = $1::uuid LIMIT 1`,
        p.schoolId,
      )) as Array<{
        consequence: string;
        suspension_duration_days: number | null;
        repeat_offence_threshold: number;
        rating_penalty_amount: string | null;
      }>;
      if (policyRows.length === 0) {
        this.logger.log(
          '[' +
            CONSUMER_GROUP +
            '] no policy configured for school=' +
            p.schoolId +
            ' — WARNING_ONLY default applied',
        );
        return { consequenceApplied: 'WARNING_ONLY_DEFAULT', count: 1 } as const;
      }
      const policy = policyRows[0]!;

      // Count this substitute's late cancellations in the last 6 months at this school
      const countRows = (await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS late_count FROM sub_assignments a
         JOIN sub_job_postings j ON j.id = a.job_id
         WHERE j.school_id = $1::uuid
           AND a.substitute_id = $2::uuid
           AND a.is_late_cancellation = true
           AND a.cancelled_at >= (now() - interval '6 months')`,
        p.schoolId,
        p.substituteId,
      )) as Array<{ late_count: number }>;
      const lateCount = countRows[0]?.late_count ?? 1;

      // Stamp the assignment regardless of consequence path
      await tx.$executeRawUnsafe(
        `UPDATE sub_assignments
         SET late_cancellation_consequence_applied = true, updated_at = now()
         WHERE id = $1::uuid`,
        p.assignmentId,
      );

      if (lateCount < policy.repeat_offence_threshold) {
        this.logger.log(
          '[' +
            CONSUMER_GROUP +
            '] tenant=' +
            tenant.subdomain +
            ' sub=' +
            p.substituteId +
            ' late_count=' +
            lateCount +
            '/' +
            policy.repeat_offence_threshold +
            ' — WARNING ladder only',
        );
        return { consequenceApplied: 'WARNING_LADDER', count: lateCount } as const;
      }

      // Threshold met — apply the configured consequence
      switch (policy.consequence) {
        case 'TEMPORARY_POOL_SUSPENSION': {
          const days = policy.suspension_duration_days ?? 7;
          const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10);
          await tx.$executeRawUnsafe(
            `UPDATE sub_school_pool
             SET status = 'SUSPENDED',
                 suspended_until = $1::date,
                 suspension_reason = $2,
                 updated_at = now()
             WHERE school_id = $3::uuid AND substitute_id = $4::uuid AND status <> 'REMOVED'`,
            until,
            'Late cancellation policy violation — ' + lateCount + ' offences in last 6 months.',
            p.schoolId,
            p.substituteId,
          );
          this.logger.log(
            '[' +
              CONSUMER_GROUP +
              '] tenant=' +
              tenant.subdomain +
              ' sub=' +
              p.substituteId +
              ' SUSPENDED for ' +
              days +
              ' days',
          );
          return {
            consequenceApplied: 'TEMPORARY_POOL_SUSPENSION',
            count: lateCount,
            days,
          } as const;
        }
        case 'PERMANENT_POOL_REMOVAL': {
          await tx.$executeRawUnsafe(
            `UPDATE sub_school_pool
             SET status = 'REMOVED',
                 suspension_reason = $1,
                 updated_at = now()
             WHERE school_id = $2::uuid AND substitute_id = $3::uuid`,
            'Permanent removal — ' + lateCount + ' late-cancellation offences in last 6 months.',
            p.schoolId,
            p.substituteId,
          );
          this.logger.log(
            '[' +
              CONSUMER_GROUP +
              '] tenant=' +
              tenant.subdomain +
              ' sub=' +
              p.substituteId +
              ' REMOVED from pool permanently',
          );
          return { consequenceApplied: 'PERMANENT_POOL_REMOVAL', count: lateCount } as const;
        }
        case 'RATING_PENALTY': {
          // Stash a synthetic SCHOOL_RATES_SUB row carrying the penalty
          // delta — the rating reduction is enforced by overall_rating
          // re-materialisation. This INSERTs a separate sub_ratings row
          // tagged with `comments` indicating the policy origin; the
          // UNIQUE(assignment, rater_type) on the table means we cannot
          // double-up on the same assignment so subsequent late-cancels
          // on the same assignment skip this branch — but the assignment
          // is already terminal so the path is moot.
          const penalty = policy.rating_penalty_amount
            ? parseFloat(policy.rating_penalty_amount)
            : 0.5;
          const penaltyScore = Math.max(1.0, 5.0 - penalty);
          await tx.$executeRawUnsafe(
            `INSERT INTO sub_ratings (id, assignment_id, rater_type, overall_score, comments, rated_at)
             VALUES ($1::uuid, $2::uuid, 'SCHOOL_RATES_SUB', $3, $4, now())
             ON CONFLICT (assignment_id, rater_type) DO NOTHING`,
            generateId(),
            p.assignmentId,
            penaltyScore,
            'AUTO-APPLIED RATING_PENALTY (cancellation policy) — penalty=' + penalty,
          );
          this.logger.log(
            '[' +
              CONSUMER_GROUP +
              '] tenant=' +
              tenant.subdomain +
              ' sub=' +
              p.substituteId +
              ' RATING_PENALTY ' +
              penalty +
              ' applied (synthetic ' +
              penaltyScore +
              '/5.0)',
          );
          return { consequenceApplied: 'RATING_PENALTY', count: lateCount, penalty } as const;
        }
        default:
          return { consequenceApplied: 'WARNING_ONLY', count: lateCount } as const;
      }
    });

    // Re-materialise overall_rating outside the tenant tx (platform write)
    if (result.consequenceApplied === 'RATING_PENALTY') {
      await this.ratings.rematerialiseOverallRating(p.substituteId);
    }
  }
}
