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
 * BehaviourNotificationConsumer — Cycle 9 Step 6.
 *
 * Subscribes to all four Cycle 9 Kafka topics under one consumer group:
 *
 *   - beh.incident.reported               → notify school admins (same
 *     IAM-cache lookup as AbsenceRequestNotificationConsumer +
 *     TicketNotificationConsumer for sch-001:admin holders).
 *   - beh.action.parent_notification_required → iterate the
 *     payload.guardianAccountIds (ActionService resolved them at emit
 *     time via sis_student_guardians + portal_access=true) and enqueue
 *     one IN_APP notification per guardian account.
 *   - beh.bip.feedback_requested          → notify the recipient teacher
 *     via payload.recipientAccountId (FeedbackService pre-resolved the
 *     teacher's platform_users.id at emit time).
 *   - beh.incident.resolved               → notify the original reporter
 *     via the bridge from payload.reportedById (hr_employees.id) →
 *     hr_employees.person_id → platform_users.id, with self-suppression
 *     when the resolver is the reporter (mirrors Cycle 8 follow-up 2 —
 *     uses payload.resolvedByAccountId for the comparison).
 *
 * Auto-task integration: the Step 3 seeded auto-task rules on
 * `beh.incident.reported` (target_role=SCHOOL_ADMIN, ADMINISTRATIVE/24h)
 * and `beh.bip.feedback_requested` (target_role=NULL with worker
 * recipientAccountId fallback, ADMINISTRATIVE/72h) feed the existing
 * Cycle 7 Task Worker. The worker auto-discovers rules at boot, so
 * picking up the two new triggers requires a worker restart (documented
 * Cycle 7 limitation — production deploys naturally restart so this is
 * dev-only).
 *
 * Notification types match the seed-messaging.ts NOTIFICATION_TYPES
 * convention plus four new entries this cycle adds:
 *   - behaviour.incident_reported
 *   - behaviour.action_assigned
 *   - behaviour.bip_feedback_requested
 *   - behaviour.incident_resolved
 */

interface IncidentBasePayload {
  incidentId?: string;
  schoolId?: string;
  studentId?: string;
  studentName?: string | null;
  studentGradeLevel?: string | null;
  categoryId?: string;
  categoryName?: string;
  severity?: string;
  reportedById?: string | null;
  reportedByName?: string | null;
  reporterName?: string | null;
  incidentDate?: string;
  description?: string;
  status?: string;
}

interface IncidentResolvedPayload extends IncidentBasePayload {
  resolvedById?: string | null;
  resolvedByName?: string | null;
  resolvedByAccountId?: string | null;
  resolvedAt?: string | null;
}

interface ActionParentNotifyPayload {
  actionId?: string;
  incidentId?: string;
  schoolId?: string;
  studentId?: string;
  studentName?: string | null;
  categoryName?: string;
  severity?: string;
  actionTypeId?: string;
  actionTypeName?: string;
  startDate?: string | null;
  endDate?: string | null;
  guardianAccountIds?: string[];
  assignedById?: string | null;
  assignedByAccountId?: string | null;
}

interface FeedbackRequestedPayload {
  feedbackId?: string;
  planId?: string;
  schoolId?: string;
  studentId?: string;
  studentName?: string | null;
  planType?: string;
  teacherId?: string | null;
  teacherName?: string | null;
  recipientAccountId?: string | null;
  accountId?: string | null;
  requesterId?: string | null;
  requesterName?: string | null;
  sourceRefId?: string;
}

var CONSUMER_GROUP = 'behaviour-notification-consumer';

@Injectable()
export class BehaviourNotificationConsumer implements OnModuleInit {
  private readonly logger = new Logger(BehaviourNotificationConsumer.name);

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
        prefixedTopic('beh.incident.reported'),
        prefixedTopic('beh.incident.resolved'),
        prefixedTopic('beh.action.parent_notification_required'),
        prefixedTopic('beh.bip.feedback_requested'),
      ],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    var event = unwrapEnvelope<Record<string, unknown>>(msg, this.logger);
    if (!event) return;

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

  private async fanOut(
    topic: string,
    event: UnwrappedEvent<Record<string, unknown>>,
  ): Promise<void> {
    if (topic.endsWith('beh.incident.reported')) {
      await this.fanOutIncidentReported(event as UnwrappedEvent<IncidentBasePayload>);
    } else if (topic.endsWith('beh.incident.resolved')) {
      await this.fanOutIncidentResolved(event as UnwrappedEvent<IncidentResolvedPayload>);
    } else if (topic.endsWith('beh.action.parent_notification_required')) {
      await this.fanOutActionParentNotify(event as UnwrappedEvent<ActionParentNotifyPayload>);
    } else if (topic.endsWith('beh.bip.feedback_requested')) {
      await this.fanOutFeedbackRequested(event as UnwrappedEvent<FeedbackRequestedPayload>);
    }
  }

  // ─── beh.incident.reported ────────────────────────────────────

  private async fanOutIncidentReported(event: UnwrappedEvent<IncidentBasePayload>): Promise<void> {
    var p = event.payload;
    if (!p.incidentId || !p.schoolId) {
      this.logger.warn(
        'Dropping beh.incident.reported (eventId=' + event.eventId + ') — missing routing ids',
      );
      return;
    }
    var admins = await this.loadSchoolAdminAccounts(p.schoolId);
    if (admins.length === 0) {
      this.logger.debug('No admins to notify on beh.incident.reported');
      return;
    }
    var payload = {
      incident_id: p.incidentId,
      student_id: p.studentId ?? null,
      student_name: p.studentName ?? null,
      student_grade_level: p.studentGradeLevel ?? null,
      category_name: p.categoryName ?? null,
      severity: p.severity ?? null,
      reporter_name: p.reporterName ?? p.reportedByName ?? null,
      incident_date: p.incidentDate ?? null,
      // Admin reviews from the queue page; clicking through opens the
      // Step 7 admin queue detail. Until that ships the deep link is a
      // forward-compat string.
      deep_link: '/behaviour/' + p.incidentId,
    };
    await this.enqueueAll('behaviour.incident_reported', event.eventId, admins, payload);
  }

  // ─── beh.incident.resolved ────────────────────────────────────

  private async fanOutIncidentResolved(
    event: UnwrappedEvent<IncidentResolvedPayload>,
  ): Promise<void> {
    var p = event.payload;
    if (!p.incidentId || !p.reportedById) {
      this.logger.debug(
        'Skip beh.incident.resolved fan-out — missing reportedById; nothing to notify',
      );
      return;
    }
    // Bridge the reporter from hr_employees.id → platform_users.id so
    // the IN_APP notification lands on the right account (the audit
    // column stores the employee id; the notification recipient is the
    // employee's login account).
    var reporterAccountId = await this.lookupAccountForEmployee(p.reportedById);
    if (!reporterAccountId) {
      this.logger.debug(
        'Skip beh.incident.resolved — reporter ' + p.reportedById + ' has no platform_users row',
      );
      return;
    }
    // Self-suppress when the resolver is the reporter (mirrors Cycle 8
    // follow-up 2: the resolver receives no "your incident has been
    // resolved" notification because they did the resolving themselves).
    if (p.resolvedByAccountId && p.resolvedByAccountId === reporterAccountId) {
      this.logger.debug('Suppress beh.incident.resolved self-notification (reporter === resolver)');
      return;
    }
    var payload = {
      incident_id: p.incidentId,
      student_id: p.studentId ?? null,
      student_name: p.studentName ?? null,
      category_name: p.categoryName ?? null,
      severity: p.severity ?? null,
      resolved_by_name: p.resolvedByName ?? null,
      resolved_at: p.resolvedAt ?? null,
      deep_link: '/behaviour/' + p.incidentId,
    };
    await this.enqueueAll(
      'behaviour.incident_resolved',
      event.eventId,
      [reporterAccountId],
      payload,
    );
  }

  // ─── beh.action.parent_notification_required ──────────────────

  private async fanOutActionParentNotify(
    event: UnwrappedEvent<ActionParentNotifyPayload>,
  ): Promise<void> {
    var p = event.payload;
    if (!p.actionId || !p.incidentId) {
      this.logger.warn(
        'Dropping beh.action.parent_notification_required (eventId=' +
          event.eventId +
          ') — missing routing ids',
      );
      return;
    }
    var guardianAccounts = Array.isArray(p.guardianAccountIds) ? p.guardianAccountIds : [];
    if (guardianAccounts.length === 0) {
      // Step 4 ActionService already filtered to portal-enabled guardians
      // with non-NULL platform_users.id at emit time — an empty array
      // means the student has no portal-enabled guardian. Log + drop.
      this.logger.debug(
        'No portal-enabled guardians on beh.action.parent_notification_required (incident=' +
          p.incidentId +
          ')',
      );
      return;
    }
    var payload = {
      action_id: p.actionId,
      incident_id: p.incidentId,
      student_id: p.studentId ?? null,
      student_name: p.studentName ?? null,
      category_name: p.categoryName ?? null,
      severity: p.severity ?? null,
      action_type_name: p.actionTypeName ?? null,
      start_date: p.startDate ?? null,
      end_date: p.endDate ?? null,
      // Parent navigates from the bell straight to the per-child
      // behaviour view; Step 9 will add the route. Forward-compat link.
      deep_link: '/children/' + (p.studentId ?? '') + '/behaviour',
    };
    await this.enqueueAll('behaviour.action_assigned', event.eventId, guardianAccounts, payload);
  }

  // ─── beh.bip.feedback_requested ───────────────────────────────

  private async fanOutFeedbackRequested(
    event: UnwrappedEvent<FeedbackRequestedPayload>,
  ): Promise<void> {
    var p = event.payload;
    if (!p.feedbackId || !p.planId) {
      this.logger.warn(
        'Dropping beh.bip.feedback_requested (eventId=' + event.eventId + ') — missing routing ids',
      );
      return;
    }
    // FeedbackService pre-resolved the teacher's platform_users.id at
    // emit time. Fall back to a tenant lookup if a future producer
    // emits without the field (defence in depth, mirrors Cycle 8
    // tkt.ticket.assigned).
    var recipient = p.recipientAccountId ?? p.accountId ?? null;
    if (!recipient && p.teacherId) {
      recipient = await this.lookupAccountForEmployee(p.teacherId);
    }
    if (!recipient) {
      this.logger.debug(
        'No recipient resolved for beh.bip.feedback_requested (feedback=' + p.feedbackId + ')',
      );
      return;
    }
    var payload = {
      feedback_id: p.feedbackId,
      plan_id: p.planId,
      student_id: p.studentId ?? null,
      student_name: p.studentName ?? null,
      plan_type: p.planType ?? null,
      requester_name: p.requesterName ?? null,
      // Teacher navigates from the bell to the pending-feedback queue.
      deep_link: '/behavior-plans/feedback',
    };
    await this.enqueueAll('behaviour.bip_feedback_requested', event.eventId, [recipient], payload);
  }

  // ─── Internal helpers ─────────────────────────────────────────

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
   * Same lookup AbsenceRequestNotificationConsumer + TicketNotificationConsumer
   * use — every account that holds `sch-001:admin` for this school via the
   * IAM cache, plus Platform Admins via the PLATFORM scope row.
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

  /**
   * Bridge an hr_employees.id to its login account (platform_users.id)
   * via hr_employees.person_id → platform_users.person_id. Returns null
   * when the employee has no portal account yet (e.g. the synthetic
   * Platform Admin persona that is intentionally not bridged per Cycle 4
   * Step 0).
   */
  private async lookupAccountForEmployee(employeeId: string): Promise<string | null> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ account_id: string }>>(
        'SELECT pu.id::text AS account_id ' +
          'FROM hr_employees he ' +
          'JOIN platform.iam_person p ON p.id = he.person_id ' +
          'JOIN platform.platform_users pu ON pu.person_id = p.id ' +
          'WHERE he.id = $1::uuid LIMIT 1',
        employeeId,
      );
    });
    if (rows.length === 0) return null;
    return rows[0]!.account_id;
  }
}
