import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumedMessage, KafkaConsumerService } from '../kafka/kafka-consumer.service';
import { IdempotencyService } from '../kafka/idempotency.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { prefixedTopic } from '../kafka/event-envelope';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '../notifications/consumers/notification-consumer-base';

/**
 * TicketTaskCompletionConsumer — Cycle 8 Step 6.
 *
 * Closes the loop on the Cycle 7 auto-task rule from Step 3:
 *
 *   1. Step 3 seeded a `tkt.ticket.assigned` rule that creates an
 *      AUTO/ADMINISTRATIVE task on the assignee's list when a ticket is
 *      assigned (the Cycle 7 TaskWorker reaction).
 *   2. Step 4 emits `tkt.ticket.assigned` with `sourceRefId: ticketId`
 *      so the worker stores the linkage on `tsk_tasks.source_ref_id`.
 *   3. This consumer subscribes to `tkt.ticket.resolved` (emitted by
 *      Step 4 ticket resolve + Step 5 problem batch-resolve) and
 *      flips every linked auto-task to DONE in a single UPDATE inside
 *      the calling tenant's schema.
 *
 * UPDATE filter: `source = 'AUTO' AND source_ref_id = $ticketId AND
 * status NOT IN ('DONE', 'CANCELLED')`. The `NOT IN` clause is the
 * idempotency belt-and-braces — a Kafka redelivery of the same event
 * lands a no-op on the second pass since the rows are already DONE.
 * The idempotency service's claim-after-success pattern is the primary
 * gate; the WHERE filter is the schema-side fail-safe.
 *
 * Per row that flips, emit `task.completed` so the Cycle 3
 * notification pipeline can fan out the completion (the existing
 * `task.completed` consumer downstream will pick it up). Without this
 * emit, the linked task would silently flip in the DB but the
 * assignee's bell would never refresh until the next /tasks fetch.
 *
 * Why a separate consumer rather than a new auto-task rule
 * `MARK_TASK_DONE` action_type? The schema's
 * `tsk_auto_task_actions.action_type` enum is fixed at CREATE_TASK /
 * CREATE_ACKNOWLEDGEMENT / SEND_NOTIFICATION; extending it would
 * require a migration + worker change. A dedicated consumer is the
 * lighter touch and keeps the TaskWorker focused on creation. Future
 * cycles can generalise into a rule-engine if more inverse flows
 * arrive.
 */

interface TicketResolvedPayload {
  ticketId: string;
  schoolId: string;
  title?: string;
  priority?: string;
  status?: string;
  assigneeId?: string | null;
  requesterId?: string;
  resolvedAt?: string | null;
  resolvedViaProblemId?: string | null;
}

interface FlippedTask {
  id: string;
  owner_id: string;
  title: string;
  task_category: string;
  source: string;
  source_ref_id: string;
  completed_at: string;
}

var CONSUMER_GROUP = 'ticket-task-completion-consumer';

@Injectable()
export class TicketTaskCompletionConsumer implements OnModuleInit {
  private readonly logger = new Logger(TicketTaskCompletionConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  async onModuleInit(): Promise<void> {
    var self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic('tkt.ticket.resolved')],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    var event = unwrapEnvelope<TicketResolvedPayload>(msg, this.logger);
    if (!event) return;
    if (!event.payload.ticketId) {
      this.logger.warn(
        'Dropping ' + msg.topic + ' (eventId=' + event.eventId + ') — missing ticketId',
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
        await self.cascadeDone(event!);
      },
    );
  }

  private async cascadeDone(event: UnwrappedEvent<TicketResolvedPayload>): Promise<void> {
    var ticketId = event.payload.ticketId;
    var rows = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // UPDATE … RETURNING captures the rows we flipped so we can emit
      // a task.completed per row outside the tx. The row order from
      // RETURNING is unspecified across partitions but doesn't matter
      // for fan-out.
      return tx.$queryRawUnsafe<FlippedTask[]>(
        "UPDATE tsk_tasks SET status = 'DONE', completed_at = COALESCE(completed_at, now()), updated_at = now() " +
          "WHERE source = 'AUTO' AND source_ref_id = $1::uuid AND status NOT IN ('DONE', 'CANCELLED') " +
          'RETURNING id::text AS id, owner_id::text AS owner_id, title, task_category, source, ' +
          'source_ref_id::text AS source_ref_id, ' +
          'TO_CHAR(completed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS completed_at',
        ticketId,
      );
    });

    if (!rows || rows.length === 0) {
      this.logger.debug(
        '[ticket-task-completion] no auto-tasks linked to ticket ' + ticketId + ' — nothing to flip',
      );
      return;
    }

    this.logger.log(
      '[ticket-task-completion] flipped ' +
        rows.length +
        ' auto-task(s) DONE for ticket ' +
        ticketId,
    );

    var tenant = event.tenant;
    for (var i = 0; i < rows.length; i++) {
      var t = rows[i]!;
      void this.kafka.emit({
        topic: 'task.completed',
        key: t.id,
        sourceModule: 'tasks',
        payload: {
          taskId: t.id,
          ownerId: t.owner_id,
          title: t.title,
          taskCategory: t.task_category,
          source: t.source,
          sourceRefId: t.source_ref_id,
          completedAt: t.completed_at,
          completedViaTicketId: ticketId,
        },
        tenantId: tenant.schoolId,
        tenantSubdomain: tenant.subdomain,
      });
    }
  }
}
