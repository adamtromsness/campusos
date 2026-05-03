import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumedMessage, KafkaConsumerService } from '../kafka/kafka-consumer.service';
import { IdempotencyService } from '../kafka/idempotency.service';
import { prefixedTopic } from '../kafka/event-envelope';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '../notifications/consumers/notification-consumer-base';
import { LeaveService } from './leave.service';

/**
 * LeaveApprovalConsumer (Cycle 7 Step 7).
 *
 * Subscribes to approval.request.resolved under group
 * `leave-approval-consumer`. Filters by requestType='LEAVE_REQUEST'.
 *
 * Resolution path:
 *   APPROVED  → LeaveService.approveInternal(referenceId, comments,
 *               approverAccountId). This applies the balance shift
 *               (pending → used), flips the row PENDING→APPROVED, and
 *               emits hr.leave.approved which the existing Cycle 4
 *               LeaveNotificationConsumer republishes as
 *               hr.leave.coverage_needed for Cycle 5 Scheduling.
 *   REJECTED  → LeaveService.rejectInternal(referenceId, comments,
 *               approverAccountId). Reverses pending and emits
 *               hr.leave.rejected.
 *
 * Idempotency: the standard processWithIdempotency wrapper claims the
 * event_id after a successful process so a Kafka redelivery is dropped.
 * If the leave row is already APPROVED / REJECTED (e.g. an admin used
 * the direct PATCH override), `lockAndValidate('PENDING')` 400's and
 * the consumer logs + drops the event — no double-application.
 */

interface ResolvedPayload {
  requestId: string;
  requestType: string;
  referenceId: string | null;
  referenceTable: string | null;
  requesterId: string;
  status: 'APPROVED' | 'REJECTED' | 'WITHDRAWN';
  approverAccountId?: string;
}

const CONSUMER_GROUP = 'leave-approval-consumer';

@Injectable()
export class LeaveApprovalConsumer implements OnModuleInit {
  private readonly logger = new Logger(LeaveApprovalConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly leave: LeaveService,
  ) {}

  async onModuleInit(): Promise<void> {
    var self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic('approval.request.resolved')],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    const event = unwrapEnvelope<ResolvedPayload>(msg, this.logger);
    if (!event) return;
    const p = event.payload;
    if (p.requestType !== 'LEAVE_REQUEST') {
      // Other request types belong to other consumers (future
      // ChildLinkApprovalConsumer, etc.). Drop silently.
      return;
    }
    if (!p.referenceId) {
      this.logger.warn(
        '[' +
          CONSUMER_GROUP +
          '] LEAVE_REQUEST resolved without referenceId (eventId=' +
          event.eventId +
          ') — drop',
      );
      return;
    }
    if (p.status !== 'APPROVED' && p.status !== 'REJECTED' && p.status !== 'WITHDRAWN') {
      this.logger.warn(
        '[' +
          CONSUMER_GROUP +
          '] LEAVE_REQUEST resolved with unexpected status=' +
          p.status +
          ' — drop',
      );
      return;
    }

    var self = this;
    await processWithIdempotency(
      CONSUMER_GROUP,
      event as UnwrappedEvent<unknown>,
      this.idempotency,
      this.logger,
      async function () {
        await self.applyDecision(event!);
      },
    );
  }

  private async applyDecision(event: UnwrappedEvent<ResolvedPayload>): Promise<void> {
    const p = event.payload;
    // The workflow engine doesn't expose the final approver's account
    // id on approval.request.resolved (only requesterId + status). For
    // the audit trail on hr_leave_requests.reviewed_by we use the
    // requester's account as a placeholder — admins acting via the
    // direct PATCH path still get their own id recorded. This is a
    // documented Phase 2 carry-over: future cycles can extend the
    // resolved payload with the final approver id so the audit trail
    // is fully accurate.
    const reviewerAccountId = p.approverAccountId ?? p.requesterId;
    const referenceId = p.referenceId!;
    try {
      if (p.status === 'APPROVED') {
        await this.leave.approveInternal(referenceId, null, reviewerAccountId);
        this.logger.log(
          '[' + CONSUMER_GROUP + '] APPROVED leave ' + referenceId + ' via workflow engine',
        );
      } else if (p.status === 'REJECTED') {
        await this.leave.rejectInternal(referenceId, null, reviewerAccountId);
        this.logger.log(
          '[' + CONSUMER_GROUP + '] REJECTED leave ' + referenceId + ' via workflow engine',
        );
      } else {
        // WITHDRAWN — requester pulled the approval back, cascade-cancel
        // the leave row so balance + status stay consistent.
        await this.leave.cancelInternal(referenceId, reviewerAccountId);
        this.logger.log(
          '[' + CONSUMER_GROUP + '] CANCELLED leave ' + referenceId + ' via workflow withdraw',
        );
      }
    } catch (e: any) {
      // The most common race: an admin used the direct PATCH override
      // (PATCH /leave-requests/:id/approve) and the row is no longer
      // PENDING. lockAndValidate throws BadRequestException; we log
      // and drop. The consumer-group claim still fires on success-path
      // exit, so a retry won't re-apply.
      var msg = e?.message || '';
      if (/already (APPROVED|REJECTED|CANCELLED)/.test(msg) || /not in PENDING/.test(msg)) {
        this.logger.log(
          '[' +
            CONSUMER_GROUP +
            '] leave ' +
            referenceId +
            ' already in a terminal state (' +
            msg +
            ') — drop, the direct admin path likely won the race',
        );
        return;
      }
      throw e;
    }
  }
}
