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
 * AbsenceRequestNotificationConsumer — listens for `att.absence.requested`
 * (Cycle 1 — guardian submits) and `att.absence.reviewed` (admin
 * approves/rejects).
 *
 * Routing:
 *   - att.absence.requested → notify every account holding `sch-001:admin`
 *     in this tenant (the same code ActorContextService uses for
 *     `isSchoolAdmin`). The simplification is fine for Cycle 3 — the
 *     authoritative review queue is on `AdminDashboard`, the notification
 *     is just a nudge.
 *   - att.absence.reviewed → notify the original submitter (the parent who
 *     filed the request). The submitter is `sis_absence_requests.submitted_by`,
 *     a soft ref to platform_users.id, so we use it directly as the
 *     recipient account id.
 *
 * Notification types: `absence.requested` and `absence.reviewed` —
 * matching seed-messaging.ts NOTIFICATION_TYPES.
 */
interface AbsenceRequestPayload {
  requestId: string;
  studentId: string;
  submittedBy?: string;
  requestType?: string;
  absenceDateFrom?: string;
  absenceDateTo?: string;
  status?: string;
  decision?: string;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
}

interface RequestContext {
  studentName: string;
  schoolId: string;
}

var CONSUMER_GROUP = 'absence-request-notification-consumer';

@Injectable()
export class AbsenceRequestNotificationConsumer implements OnModuleInit {
  private readonly logger = new Logger(AbsenceRequestNotificationConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly queue: NotificationQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    var self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic('att.absence.requested'), prefixedTopic('att.absence.reviewed')],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    var event = unwrapEnvelope<AbsenceRequestPayload>(msg, this.logger);
    if (!event) return;
    if (!event.payload.requestId || !event.payload.studentId) {
      this.logger.warn(
        'Dropping ' + msg.topic + ' (eventId=' + event.eventId + ') — missing routing ids',
      );
      return;
    }

    var isReviewed = msg.topic.endsWith('absence.reviewed');
    var notificationType = isReviewed ? 'absence.reviewed' : 'absence.requested';

    var self = this;
    await processWithIdempotency(
      CONSUMER_GROUP,
      event as UnwrappedEvent<unknown>,
      this.idempotency,
      this.logger,
      async function () {
        await self.fanOut(event!.payload, event!.eventId, notificationType, isReviewed);
      },
    );
  }

  private async fanOut(
    p: AbsenceRequestPayload,
    eventId: string,
    notificationType: string,
    isReviewed: boolean,
  ): Promise<void> {
    var ctx = await this.loadContext(p.studentId);
    if (!ctx) {
      this.logger.warn('Skipping fan-out — student ' + p.studentId + ' not found in tenant');
      return;
    }

    var recipients: string[];
    if (isReviewed) {
      // Notify the original submitter only. The request payload carries it
      // on the ATT-001 emit; the submitted_by column is a soft ref to
      // platform_users(id) so we can use it as a recipient directly.
      var submitter = await this.lookupSubmitter(p.requestId);
      recipients = submitter ? [submitter] : [];
    } else {
      recipients = await this.loadSchoolAdminAccounts(ctx.schoolId);
    }

    if (recipients.length === 0) {
      this.logger.debug(
        'No recipients for absence-request notification (' + notificationType + ')',
      );
      return;
    }

    var payload = {
      request_id: p.requestId,
      student_id: p.studentId,
      student_name: ctx.studentName,
      request_type: p.requestType ?? null,
      absence_date_from: p.absenceDateFrom ?? null,
      absence_date_to: p.absenceDateTo ?? null,
      status: p.status ?? p.decision ?? null,
      decision: p.decision ?? null,
      reviewed_at: p.reviewedAt ?? null,
      // Reviewers land on the admin dashboard; submitters on their own
      // children's page. We send both so the bell can pick by persona.
      deep_link_admin: '/dashboard',
      deep_link_guardian: '/children/' + p.studentId + '/absence-request',
    };

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

  private async loadContext(studentId: string): Promise<RequestContext | null> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{ first_name: string; last_name: string; school_id: string }>
      >(
        'SELECT ip.first_name, ip.last_name, s.school_id::text AS school_id ' +
          'FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
          'WHERE s.id = $1::uuid',
        studentId,
      );
    });
    if (rows.length === 0) return null;
    var r = rows[0]!;
    return {
      studentName: r.first_name + ' ' + r.last_name,
      schoolId: r.school_id,
    };
  }

  private async lookupSubmitter(requestId: string): Promise<string | null> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ submitted_by: string }>>(
        'SELECT submitted_by::text AS submitted_by FROM sis_absence_requests WHERE id = $1::uuid',
        requestId,
      );
    });
    if (rows.length === 0) return null;
    return rows[0]!.submitted_by;
  }

  /**
   * Look up every account that holds `sch-001:admin` for this school via
   * the IAM cache. Reads platform tables directly (cross-schema join is
   * read-only and fine — the no-FK rule is about constraints, not joins).
   *
   * The cache table is keyed on `(account_id, scope_id)` with the
   * permission set materialised in `permission_codes TEXT[]`. We resolve
   * the scope chain (school then platform) the same way
   * PermissionCheckService does: a row in the SCHOOL scope answers
   * directly; a Platform Admin matches via the PLATFORM scope row.
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
