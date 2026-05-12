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
 * CleaningIssueTicketConsumer — P2-18a Step 2.
 *
 * Closes the loop on the CleaningRouteService keystone: when a custodian
 * notes an issue while completing a route stop, the service emits
 * `fac.route_stop.issue_noted` with `sourceRefId: stopCompletionId`.
 * This consumer materialises a `tkt_tickets` row so the issue lands on
 * the helpdesk queue for follow-up — fulfilling the plan contract
 * "Task Worker creates tkt_ticket" via the standard
 * domain-emits-consumer-materialises pattern (Cycles 9 + 10 + 11).
 *
 * The ticket is created under a Facilities category if one exists in
 * the tenant (best-effort lookup by name). If none matches the consumer
 * logs and drops without committing the idempotency claim so a future
 * redelivery (after the school configures the category) lands cleanly.
 *
 * The idempotency belt-and-braces is two layers:
 *   1. processWithIdempotency claim-after-success on the inbound
 *      event_id (deterministic UUID v5 from the helper so retries land
 *      the same id),
 *   2. WHERE NOT EXISTS check against tkt_tickets by description prefix
 *      threading the stop_completion_id so the same physical issue
 *      cannot land two tickets even if upstream emits twice.
 */

interface RouteStopIssuePayload {
  sourceRefId?: string;
  stopCompletionId?: string;
  completionId?: string;
  routeId?: string;
  stopId?: string;
  spaceId?: string;
  issuesNoted?: string;
  reportedByAccountId?: string;
  schoolId?: string;
}

var CONSUMER_GROUP = 'cleaning-issue-ticket-consumer';

@Injectable()
export class CleaningIssueTicketConsumer implements OnModuleInit {
  private readonly logger = new Logger(CleaningIssueTicketConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    var self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic('fac.route_stop.issue_noted')],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    var event = unwrapEnvelope<RouteStopIssuePayload>(msg, this.logger);
    if (!event) return;
    var p = event.payload;
    var stopCompletionId = p.stopCompletionId ?? p.sourceRefId;
    if (!stopCompletionId || !p.issuesNoted) {
      this.logger.warn(
        'Dropping ' +
          msg.topic +
          ' (eventId=' +
          event.eventId +
          ') — missing stopCompletionId or issuesNoted',
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
        await self.materialiseTicket(
          event!.payload,
          stopCompletionId!,
          event!.payload.reportedByAccountId ?? null,
        );
      },
    );
  }

  private async materialiseTicket(
    payload: RouteStopIssuePayload,
    stopCompletionId: string,
    reportedByAccountId: string | null,
  ): Promise<void> {
    var self = this;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Idempotency belt-and-braces — refuse to insert a second ticket
      // for the same stop_completion_id. The description prefix carries
      // the threading marker so the WHERE NOT EXISTS is constant cost.
      var existing = (await tx.$queryRawUnsafe(
        'SELECT id FROM tkt_tickets WHERE description LIKE $1 LIMIT 1',
        '[cleaning-route-issue:' + stopCompletionId + ']%',
      )) as Array<{ id: string }>;
      if (existing.length > 0) {
        self.logger.debug(
          '[cleaning-issue-ticket] ticket already exists for stop completion ' +
            stopCompletionId +
            ' — no-op',
        );
        return;
      }

      // Resolve a Facilities category by name fallbacks. If none
      // matches, log + return without inserting. The
      // processWithIdempotency wrapper claims AFTER success, so a
      // future redelivery (after the school adds the category) will
      // retry cleanly.
      var cat = (await tx.$queryRawUnsafe(
        "SELECT id::text AS id, name FROM tkt_categories WHERE is_active = true AND (name ILIKE '%facilit%' OR name ILIKE '%custodial%' OR name ILIKE '%maintenance%' OR name ILIKE '%cleaning%') ORDER BY (CASE WHEN name ILIKE '%cleaning%' THEN 1 WHEN name ILIKE '%custodial%' THEN 2 WHEN name ILIKE '%facilit%' THEN 3 ELSE 4 END) LIMIT 1",
      )) as Array<{ id: string; name: string }>;
      if (cat.length === 0) {
        self.logger.warn(
          '[cleaning-issue-ticket] no Facilities category configured — cannot materialise ticket for stop completion ' +
            stopCompletionId,
        );
        throw new Error('NO_FACILITIES_CATEGORY');
      }

      // Resolve the requester. Fall back to a school admin if the
      // emitted reportedByAccountId is missing.
      var requesterId = reportedByAccountId;
      if (!requesterId) {
        var admin = (await tx.$queryRawUnsafe(
          "SELECT eac.account_id::text AS account_id FROM platform.iam_effective_access_cache eac WHERE 'sch-001:admin' = ANY(eac.permission_codes) LIMIT 1",
        )) as Array<{ account_id: string }>;
        if (admin.length === 0) {
          self.logger.warn(
            '[cleaning-issue-ticket] no requester available for stop completion ' +
              stopCompletionId,
          );
          throw new Error('NO_REQUESTER');
        }
        requesterId = admin[0]!.account_id;
      }

      var ticketId = generateId();
      var title = 'Cleaning issue: ' + payload.issuesNoted!.slice(0, 100);
      var desc =
        '[cleaning-route-issue:' +
        stopCompletionId +
        '] Auto-created from custodial route completion. Issue noted: ' +
        payload.issuesNoted;
      await tx.$executeRawUnsafe(
        'INSERT INTO tkt_tickets (id, school_id, category_id, requester_id, title, description, priority, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'MEDIUM', 'OPEN')",
        ticketId,
        payload.schoolId,
        cat[0]!.id,
        requesterId,
        title,
        desc,
      );
      // Best-effort activity row for the immutable timeline.
      await tx.$executeRawUnsafe(
        'INSERT INTO tkt_ticket_activity (id, ticket_id, actor_id, activity_type, metadata) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, 'COMMENT', $4::jsonb)",
        generateId(),
        ticketId,
        requesterId,
        JSON.stringify({
          autoCreated: true,
          source: 'fac.route_stop.issue_noted',
          stopCompletionId: stopCompletionId,
          routeId: payload.routeId,
        }),
      );
      self.logger.log(
        '[cleaning-issue-ticket] created ticket ' +
          ticketId +
          ' for stop completion ' +
          stopCompletionId,
      );
    });
  }
}
