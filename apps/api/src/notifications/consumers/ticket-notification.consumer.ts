import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumedMessage, KafkaConsumerService } from '../../kafka/kafka-consumer.service';
import { IdempotencyService } from '../../kafka/idempotency.service';
import { prefixedTopic } from '../../kafka/event-envelope';
import { TenantPrismaService } from '../../tenant/tenant-prisma.service';
import { NotificationQueueService } from '../notification-queue.service';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from './notification-consumer-base';

/**
 * TicketNotificationConsumer — Cycle 8 Step 6.
 *
 * Subscribes to the four ticket lifecycle events the Step 4/5 services
 * emit and fans out IN_APP notifications via the Cycle 3 pipeline:
 *
 *   - tkt.ticket.submitted → notify school admins (the canonical helpdesk
 *     queue audience). Same school-admin lookup pattern as
 *     AbsenceRequestNotificationConsumer.
 *   - tkt.ticket.assigned  → notify the assignee. The Step 4 emit already
 *     resolves the assignee's platform_users.id and puts it on the
 *     payload as `recipientAccountId` (and `accountId` for the TaskWorker
 *     fallback). When the assignee is a vendor the Step 4 service
 *     deliberately skips this emit, so we never see a vendor here.
 *   - tkt.ticket.commented → notify the OTHER side of the conversation:
 *     - if the comment is internal (`isInternal=true`), notify only
 *       admins / assignee — never the requester.
 *     - if the comment is from the requester, notify the assignee +
 *       admins.
 *     - if the comment is from staff (assignee or admin) and public,
 *       notify the requester.
 *   - tkt.ticket.resolved  → notify the requester ("Your ticket has
 *     been resolved.").
 *
 * Notification types: `ticket.submitted`, `ticket.assigned`,
 * `ticket.commented`, `ticket.resolved` — the bell + /notifications
 * page render these via the descriptor map in `apps/web/src/components/
 * notifications/NotificationBell.tsx` (Step 7).
 */

interface TicketEventBase {
  ticketId: string;
  schoolId: string;
}

interface SubmittedPayload extends TicketEventBase {
  title?: string;
  priority?: string;
  status?: string;
  requesterId?: string;
  slaPolicyId?: string | null;
  categoryId?: string;
  subcategoryId?: string | null;
}

interface AssignedPayload extends TicketEventBase {
  ticket_title?: string;
  priority?: string;
  resolution_hours?: number;
  assigneeEmployeeId?: string;
  accountId?: string;
  recipientAccountId?: string;
  actorAccountId?: string;
}

interface CommentedPayload extends TicketEventBase {
  commentId?: string;
  authorId?: string;
  isInternal?: boolean;
  firstResponseBumped?: boolean;
}

interface ResolvedPayload extends TicketEventBase {
  title?: string;
  priority?: string;
  status?: string;
  assigneeId?: string | null;
  requesterId?: string;
  /**
   * platform_users.id of the actor who resolved the ticket. Added in
   * REVIEW-CYCLE8 follow-up 2 so the consumer can correctly suppress the
   * "your ticket has been resolved" notification when the resolver is
   * the requester (admin resolving their own self-submitted ticket).
   * Compared against `ctx.requesterId` (which is also a platform_users.id)
   * — the previous comparison against `assigneeId` (an hr_employees.id)
   * never matched in practice.
   */
  resolvedByAccountId?: string | null;
  resolvedAt?: string | null;
  resolvedViaProblemId?: string | null;
}

interface TicketContext {
  ticketId: string;
  schoolId: string;
  title: string;
  priority: string;
  status: string;
  requesterId: string;
  assigneeId: string | null;
  assigneeAccountId: string | null;
  categoryName: string | null;
}

var CONSUMER_GROUP = 'ticket-notification-consumer';

@Injectable()
export class TicketNotificationConsumer implements OnModuleInit {
  private readonly logger = new Logger(TicketNotificationConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly queue: NotificationQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    var self = this;
    await this.consumer.subscribe({
      topics: [
        prefixedTopic('tkt.ticket.submitted'),
        prefixedTopic('tkt.ticket.assigned'),
        prefixedTopic('tkt.ticket.commented'),
        prefixedTopic('tkt.ticket.resolved'),
      ],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    var event = unwrapEnvelope<TicketEventBase>(msg, this.logger);
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
        await self.fanOut(msg.topic, event!);
      },
    );
  }

  private async fanOut(topic: string, event: UnwrappedEvent<TicketEventBase>): Promise<void> {
    var ctx = await this.loadTicketContext(event.payload.ticketId);
    if (!ctx) {
      this.logger.warn(
        'Skipping ' + topic + ' fan-out — ticket ' + event.payload.ticketId + ' not in tenant',
      );
      return;
    }

    if (topic.endsWith('tkt.ticket.submitted')) {
      await this.fanOutSubmitted(event as UnwrappedEvent<SubmittedPayload>, ctx);
    } else if (topic.endsWith('tkt.ticket.assigned')) {
      await this.fanOutAssigned(event as UnwrappedEvent<AssignedPayload>, ctx);
    } else if (topic.endsWith('tkt.ticket.commented')) {
      await this.fanOutCommented(event as UnwrappedEvent<CommentedPayload>, ctx);
    } else if (topic.endsWith('tkt.ticket.resolved')) {
      await this.fanOutResolved(event as UnwrappedEvent<ResolvedPayload>, ctx);
    }
  }

  private async fanOutSubmitted(
    event: UnwrappedEvent<SubmittedPayload>,
    ctx: TicketContext,
  ): Promise<void> {
    var admins = await this.loadSchoolAdminAccounts(ctx.schoolId);
    if (admins.length === 0) {
      this.logger.debug('No admins to notify on tkt.ticket.submitted');
      return;
    }
    var payload = this.buildPayload(ctx, event.payload, 'submitted');
    await this.enqueueAll('ticket.submitted', event.eventId, admins, payload);
  }

  private async fanOutAssigned(
    event: UnwrappedEvent<AssignedPayload>,
    ctx: TicketContext,
  ): Promise<void> {
    // Step 4 emit already resolved the assignee's platform_users.id and
    // put it on the payload — preferred path. Fall back to the tenant
    // join in case a future producer (e.g. ProblemService.resolveBatch
    // doesn't currently emit assigned but might in a refactor) emits
    // without the field.
    var recipient: string | null =
      event.payload.recipientAccountId || event.payload.accountId || ctx.assigneeAccountId;
    if (!recipient) {
      this.logger.debug(
        'No recipient resolved for tkt.ticket.assigned (ticket=' + ctx.ticketId + ')',
      );
      return;
    }
    var payload = this.buildPayload(ctx, event.payload, 'assigned');
    await this.enqueueAll('ticket.assigned', event.eventId, [recipient], payload);
  }

  private async fanOutCommented(
    event: UnwrappedEvent<CommentedPayload>,
    ctx: TicketContext,
  ): Promise<void> {
    var p = event.payload;
    var authorId = p.authorId ?? null;
    var isInternal = p.isInternal === true;

    var recipients: string[];
    if (isInternal) {
      // Internal comments stay on the staff side. Notify the assignee
      // and any admins who are not the author.
      var staff = new Set<string>();
      if (ctx.assigneeAccountId && ctx.assigneeAccountId !== authorId) {
        staff.add(ctx.assigneeAccountId);
      }
      var admins = await this.loadSchoolAdminAccounts(ctx.schoolId);
      for (var i = 0; i < admins.length; i++) {
        var a = admins[i]!;
        if (a !== authorId) staff.add(a);
      }
      recipients = Array.from(staff);
    } else if (authorId === ctx.requesterId) {
      // Requester replied — surface to assignee + admins (admins for
      // unassigned tickets so the comment doesn't dead-letter).
      var inboxes = new Set<string>();
      if (ctx.assigneeAccountId && ctx.assigneeAccountId !== authorId) {
        inboxes.add(ctx.assigneeAccountId);
      }
      if (!ctx.assigneeAccountId) {
        var admins2 = await this.loadSchoolAdminAccounts(ctx.schoolId);
        for (var j = 0; j < admins2.length; j++) {
          var a2 = admins2[j]!;
          if (a2 !== authorId) inboxes.add(a2);
        }
      }
      recipients = Array.from(inboxes);
    } else {
      // Staff replied publicly — notify the requester.
      recipients = ctx.requesterId !== authorId ? [ctx.requesterId] : [];
    }

    if (recipients.length === 0) {
      this.logger.debug('No recipients on tkt.ticket.commented (ticket=' + ctx.ticketId + ')');
      return;
    }
    var payload = this.buildPayload(ctx, event.payload, 'commented');
    payload['is_internal'] = isInternal;
    payload['first_response_bumped'] = p.firstResponseBumped === true;
    payload['comment_id'] = p.commentId ?? null;
    await this.enqueueAll('ticket.commented', event.eventId, recipients, payload);
  }

  private async fanOutResolved(
    event: UnwrappedEvent<ResolvedPayload>,
    ctx: TicketContext,
  ): Promise<void> {
    // The requester is the audience here — they want to know their
    // problem is fixed and (if the resolution comment landed) what was
    // done about it. Skip when the requester is the resolver (an admin
    // resolving their own self-submitted ticket — rare but possible).
    //
    // REVIEW-CYCLE8 follow-up 2: compare against `resolvedByAccountId`
    // (a platform_users.id captured by the producer at resolve time)
    // rather than `assigneeId` (an hr_employees.id). The prior
    // comparison was a category-mismatch and never matched, so the
    // self-notification path was effectively dead. Falls back to a
    // never-match string when the field is absent so a future emit
    // without the field doesn't accidentally suppress every requester
    // notification.
    var resolver = (event.payload.resolvedByAccountId as string | undefined | null) ?? null;
    if (resolver !== null && ctx.requesterId === resolver) return;
    var payload = this.buildPayload(ctx, event.payload, 'resolved');
    payload['resolved_at'] = event.payload.resolvedAt ?? null;
    payload['resolved_via_problem_id'] = event.payload.resolvedViaProblemId ?? null;
    await this.enqueueAll('ticket.resolved', event.eventId, [ctx.requesterId], payload);
  }

  private buildPayload(
    ctx: TicketContext,
    eventPayload: TicketEventBase & { title?: string; ticket_title?: string; priority?: string },
    action: 'submitted' | 'assigned' | 'commented' | 'resolved',
  ): Record<string, unknown> {
    return {
      ticket_id: ctx.ticketId,
      ticket_title: eventPayload.ticket_title || eventPayload.title || ctx.title,
      priority: eventPayload.priority || ctx.priority,
      status: ctx.status,
      category_name: ctx.categoryName,
      action,
      // Persona-aware deep link — the bell + /notifications page route
      // every persona to the same staff-facing detail page since both
      // requesters (staff who filed the ticket) and assignees navigate
      // to it. The Step 7 helpdesk UI will key on this.
      deep_link: '/helpdesk/' + ctx.ticketId,
    };
  }

  private async enqueueAll(
    notificationType: string,
    eventId: string,
    recipients: string[],
    payload: Record<string, unknown>,
  ): Promise<void> {
    for (var i = 0; i < recipients.length; i++) {
      var accountId = recipients[i]!;
      try {
        await this.queue.enqueue({
          notificationType: notificationType,
          recipientAccountId: accountId,
          payload: payload,
          idempotencyKey: notificationType + ':' + eventId + ':' + accountId,
        });
      } catch (e: any) {
        this.logger.error(
          'Enqueue failed for ' +
            accountId +
            ' (' +
            notificationType +
            '): ' +
            (e?.stack || e?.message || e),
        );
        throw e;
      }
    }
  }

  /**
   * Load denormalised ticket context for the fan-out logic. Includes
   * the assignee's platform_users.id when a hr_employees → iam_person →
   * platform_users bridge exists, so consumer logic can short-circuit
   * without re-querying. Returns null when the ticket no longer exists
   * (rare — only happens if an admin hard-deleted the ticket between
   * the emit and the consumer's claim).
   */
  private async loadTicketContext(ticketId: string): Promise<TicketContext | null> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          id: string;
          school_id: string;
          title: string;
          priority: string;
          status: string;
          requester_id: string;
          assignee_id: string | null;
          assignee_account_id: string | null;
          category_name: string | null;
        }>
      >(
        'SELECT t.id::text AS id, t.school_id::text AS school_id, t.title, t.priority, t.status, ' +
          't.requester_id::text AS requester_id, ' +
          't.assignee_id::text AS assignee_id, ' +
          'apu.id::text AS assignee_account_id, ' +
          'c.name AS category_name ' +
          'FROM tkt_tickets t ' +
          'JOIN tkt_categories c ON c.id = t.category_id ' +
          'LEFT JOIN hr_employees ae ON ae.id = t.assignee_id ' +
          'LEFT JOIN platform.platform_users apu ON apu.person_id = ae.person_id ' +
          'WHERE t.id = $1::uuid',
        ticketId,
      );
    });
    if (rows.length === 0) return null;
    var r = rows[0]!;
    return {
      ticketId: r.id,
      schoolId: r.school_id,
      title: r.title,
      priority: r.priority,
      status: r.status,
      requesterId: r.requester_id,
      assigneeId: r.assignee_id,
      assigneeAccountId: r.assignee_account_id,
      categoryName: r.category_name,
    };
  }

  /**
   * Same lookup AbsenceRequestNotificationConsumer uses — every account
   * that holds `sch-001:admin` for this school via the IAM cache, plus
   * Platform Admins via the PLATFORM scope row.
   */
  private async loadSchoolAdminAccounts(schoolId: string): Promise<string[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ account_id: string }>>(
        'SELECT DISTINCT eac.account_id::text AS account_id ' +
          'FROM platform.iam_effective_access_cache eac ' +
          'JOIN platform.iam_scope s ON s.id = eac.scope_id ' +
          'JOIN platform.iam_scope_type st ON st.id = s.scope_type_id ' +
          "WHERE 'sch-001:admin' = ANY(eac.permission_codes) " +
          ' AND s.is_active = true ' +
          " AND ((st.code = 'SCHOOL' AND s.entity_id = $1::uuid) " +
          "      OR st.code = 'PLATFORM')",
        schoolId,
      );
    });
    return rows.map(function (r) {
      return r.account_id;
    });
  }
}
