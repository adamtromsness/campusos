import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { ConsumedMessage, KafkaConsumerService } from '@shared/kafka/kafka-consumer.service';
import { IdempotencyService } from '@shared/kafka/idempotency.service';
import { prefixedTopic } from '@shared/kafka/event-envelope';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '@modules/m40-communications/notifications/consumers/notification-consumer-base';

/**
 * CleaningIssueTicketConsumer — P2-18a Step 2.
 *
 * REVIEW-P2C18 BLOCKING 2 — DOCUMENTED CROSS-MODULE EXCEPTION.
 *
 * This consumer lives in the Facilities module but materialises rows
 * into Tickets-owned tables (`tkt_tickets` + `tkt_ticket_activity`).
 * The canonical CampusOS rule is that the owning module writes its own
 * tables; the long-term landing for this code is a Tickets-owned
 * consumer (or a `tsk_auto_task_rules` row driving the Cycle 7
 * TaskWorker via a Tickets-owned action). That refactor is on the
 * Phase 2 / pre-pilot punch list. Until it lands, this consumer
 * defends the cross-module write with three guards added in
 * REVIEW-P2C18 Round 1:
 *
 *   (a) envelope-vs-payload school validation — drop the event when
 *       `payload.schoolId !== event.tenant.schoolId` with a WARN log,
 *       claiming the idempotency record so a redelivery of the bad
 *       envelope doesn't loop forever;
 *   (b) school-scoped category lookup — the JOIN includes the tenant
 *       school id;
 *   (c) school-scoped requester fallback — the school admin lookup
 *       JOINs the iam_scope row to require a SCHOOL-scope assignment
 *       matching the current tenant.
 *
 * The ticket is created under a Facilities category if one exists in
 * the tenant (best-effort lookup by name). If none matches the consumer
 * throws so processWithIdempotency does NOT claim — a future
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
    // REVIEW-P2C18 BLOCKING 2 (a) — envelope-vs-payload tenant
    // validation. Drop events whose payload schoolId disagrees with
    // the envelope tenant_id; claim the idempotency record so the
    // bad envelope doesn't loop forever on redelivery.
    if (p.schoolId && p.schoolId !== event.tenant.schoolId) {
      this.logger.warn(
        '[cleaning-issue-ticket] tenant mismatch — envelope tenant_id=' +
          event.tenant.schoolId +
          ' vs payload.schoolId=' +
          p.schoolId +
          ' (eventId=' +
          event.eventId +
          '). Dropping the event and claiming idempotency to prevent retry loop.',
      );
      await this.idempotency.claim(CONSUMER_GROUP, event.eventId, event.topic);
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
          event!.tenant.schoolId,
          event!.payload,
          stopCompletionId!,
          event!.payload.reportedByAccountId ?? null,
        );
      },
    );
  }

  private async materialiseTicket(
    envelopeSchoolId: string,
    payload: RouteStopIssuePayload,
    stopCompletionId: string,
    reportedByAccountId: string | null,
  ): Promise<void> {
    var self = this;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Idempotency belt-and-braces — refuse to insert a second ticket
      // for the same stop_completion_id. The description prefix carries
      // the threading marker so the WHERE NOT EXISTS is constant cost.
      // Tenant context is already SET LOCAL'd so the tkt_tickets table
      // resolves to the right tenant schema and a cross-tenant
      // description match cannot fire from this query.
      var existing = (await tx.$queryRawUnsafe(
        'SELECT id FROM tkt_tickets WHERE school_id = $1::uuid AND description LIKE $2 LIMIT 1',
        envelopeSchoolId,
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

      // REVIEW-P2C18 BLOCKING 2 (b) — school-scope the category lookup.
      // Resolve a Facilities category by name fallbacks for the
      // envelope tenant ONLY. If none matches, throw so
      // processWithIdempotency does NOT claim and a future redelivery
      // (after the school adds the category) retries cleanly.
      var cat = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, name FROM tkt_categories ' +
          'WHERE school_id = $1::uuid AND is_active = true ' +
          "AND (name ILIKE '%facilit%' OR name ILIKE '%custodial%' OR name ILIKE '%maintenance%' OR name ILIKE '%cleaning%') " +
          "ORDER BY (CASE WHEN name ILIKE '%cleaning%' THEN 1 WHEN name ILIKE '%custodial%' THEN 2 WHEN name ILIKE '%facilit%' THEN 3 ELSE 4 END) LIMIT 1",
        envelopeSchoolId,
      )) as Array<{ id: string; name: string }>;
      if (cat.length === 0) {
        self.logger.warn(
          '[cleaning-issue-ticket] no Facilities category configured for school=' +
            envelopeSchoolId +
            ' — cannot materialise ticket for stop completion ' +
            stopCompletionId,
        );
        throw new Error('NO_FACILITIES_CATEGORY');
      }

      // REVIEW-P2C18 BLOCKING 2 (c) — school-scoped requester fallback.
      // The school admin lookup now JOINs iam_scope + iam_scope_type so
      // only a SCHOOL-scope assignment matching the envelope's school
      // can become the requester. PLATFORM-scope admins are
      // intentionally excluded — they sit above any individual school
      // and are not the right "originator" for an auto-ticket.
      var requesterId = reportedByAccountId;
      if (!requesterId) {
        var admin = (await tx.$queryRawUnsafe(
          'SELECT eac.account_id::text AS account_id ' +
            'FROM platform.iam_effective_access_cache eac ' +
            'JOIN platform.iam_scope sc ON sc.id = eac.scope_id ' +
            'JOIN platform.iam_scope_type st ON st.id = sc.scope_type_id ' +
            "WHERE 'sch-001:admin' = ANY(eac.permission_codes) " +
            "AND st.code = 'SCHOOL' AND sc.entity_id = $1::uuid LIMIT 1",
          envelopeSchoolId,
        )) as Array<{ account_id: string }>;
        if (admin.length === 0) {
          self.logger.warn(
            '[cleaning-issue-ticket] no requester available for stop completion ' +
              stopCompletionId +
              ' in school=' +
              envelopeSchoolId,
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
      // REVIEW-P2C18 BLOCKING 2 — use envelope tenant_id (authoritative)
      // as the ticket school_id, not the potentially-attacker-controlled
      // payload.schoolId. The two were already cross-validated upstream
      // in handle().
      await tx.$executeRawUnsafe(
        'INSERT INTO tkt_tickets (id, school_id, category_id, requester_id, title, description, priority, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'MEDIUM', 'OPEN')",
        ticketId,
        envelopeSchoolId,
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
