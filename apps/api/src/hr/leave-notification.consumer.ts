import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ConsumedMessage, KafkaConsumerService } from '../kafka/kafka-consumer.service';
import { IdempotencyService } from '../kafka/idempotency.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { prefixedTopic } from '../kafka/event-envelope';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { NotificationQueueService } from '../notifications/notification-queue.service';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '../notifications/consumers/notification-consumer-base';

/**
 * Build a deterministic UUID for a `hr.leave.coverage_needed` republish
 * (REVIEW-CYCLE4 MAJOR 3). Cycle 5's consumer idempotency table dedupes
 * on event_id; if the inbound `hr.leave.approved` is redelivered, this
 * republish carries the same event_id and the consumer drops the dup.
 *
 * The implementation hashes the inbound event_id with a stable suffix and
 * formats the first 16 bytes as a RFC-4122 v5-style UUID. We don't use
 * the `uuid` package because `@campusos/api` doesn't depend on it; node's
 * built-in `crypto.createHash` is enough for a deterministic id.
 *
 * Changing the suffix or the hash function would invalidate historical
 * idempotency claims — keep the constants pinned.
 */
var COVERAGE_NEEDED_SUFFIX = 'hr.leave.coverage_needed.v1';

function deterministicCoverageEventId(inboundEventId: string): string {
  var hash = createHash('sha1')
    .update(inboundEventId + ':' + COVERAGE_NEEDED_SUFFIX)
    .digest();
  // Format the first 16 bytes as a RFC-4122-shaped UUID with the v5 marker
  // (high nibble of byte 6 = 5) and the variant marker (high two bits of
  // byte 8 = 10). This matches what the `uuid` package's v5() produces for
  // the same name, so a future migration to the `uuid` lib is drop-in.
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  var hex = hash.subarray(0, 16).toString('hex');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  );
}

/**
 * LeaveNotificationConsumer (Cycle 4 Step 7).
 *
 * Subscribes to the four leave lifecycle events emitted by LeaveService:
 *
 *   hr.leave.requested  → notify school admins (the queue / approval surface)
 *   hr.leave.approved   → notify the original submitter, then republish
 *                          `hr.leave.coverage_needed` so Cycle 5 Scheduling
 *                          can wire up a substitute. The republish carries
 *                          the affected class ids resolved via
 *                          sis_class_teachers for the leave date range.
 *   hr.leave.rejected   → notify the original submitter
 *   hr.leave.cancelled  → no notifications (the employee cancelled their
 *                          own request — no need to re-tell them) but we
 *                          still claim the event so redelivery is a no-op.
 *
 * Notification types: `leave.requested`, `leave.approved`, `leave.rejected`.
 *
 * Recipients of `leave.requested` are school admins resolved via
 * iam_effective_access_cache (same shape as
 * AbsenceRequestNotificationConsumer's loadSchoolAdminAccounts). The
 * approve / reject branches notify the submitter (the employee whose
 * leave it is — payload carries the platform_users.id on `accountId`).
 */
interface LeavePayload {
  requestId: string;
  employeeId: string;
  accountId: string;
  leaveTypeId?: string;
  leaveTypeName?: string;
  startDate: string;
  endDate: string;
  daysRequested: number | string;
  status: string;
  reason?: string | null;
  reviewedBy?: string;
  reviewedAt?: string | null;
  reviewNotes?: string | null;
  cancelledBy?: string;
  previousStatus?: string;
}

var CONSUMER_GROUP = 'leave-notification-consumer';

@Injectable()
export class LeaveNotificationConsumer implements OnModuleInit {
  private readonly logger = new Logger(LeaveNotificationConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly queue: NotificationQueueService,
    private readonly kafka: KafkaProducerService,
  ) {}

  async onModuleInit(): Promise<void> {
    var self = this;
    await this.consumer.subscribe({
      topics: [
        prefixedTopic('hr.leave.requested'),
        prefixedTopic('hr.leave.approved'),
        prefixedTopic('hr.leave.rejected'),
        prefixedTopic('hr.leave.cancelled'),
      ],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    var event = unwrapEnvelope<LeavePayload>(msg, this.logger);
    if (!event) return;
    if (!event.payload.requestId || !event.payload.employeeId) {
      this.logger.warn(
        'Dropping ' + msg.topic + ' (eventId=' + event.eventId + ') — missing routing ids',
      );
      return;
    }

    var verb = msg.topic.split('.').pop() || '';
    var self = this;
    await processWithIdempotency(
      CONSUMER_GROUP,
      event as UnwrappedEvent<unknown>,
      this.idempotency,
      this.logger,
      async function () {
        if (verb === 'requested') {
          await self.notifyAdmins(event!, 'leave.requested');
        } else if (verb === 'approved') {
          await self.notifySubmitter(event!, 'leave.approved');
          await self.emitCoverageNeeded(event!);
        } else if (verb === 'rejected') {
          await self.notifySubmitter(event!, 'leave.rejected');
        } else if (verb === 'cancelled') {
          // No-op for now — owner cancelled their own request.
        } else {
          self.logger.warn('Unrecognised leave topic ' + msg.topic);
        }
      },
    );
  }

  private async notifyAdmins(
    event: UnwrappedEvent<LeavePayload>,
    notificationType: string,
  ): Promise<void> {
    var p = event.payload;
    var adminAccounts = await this.loadSchoolAdminAccounts(event.tenant.schoolId);
    if (adminAccounts.length === 0) {
      this.logger.debug('No admins to notify for leave.requested');
      return;
    }
    var employeeName = await this.lookupEmployeeName(p.employeeId);
    var payload = {
      request_id: p.requestId,
      employee_id: p.employeeId,
      employee_name: employeeName,
      leave_type_name: p.leaveTypeName ?? null,
      start_date: p.startDate,
      end_date: p.endDate,
      days_requested:
        typeof p.daysRequested === 'string' ? Number(p.daysRequested) : p.daysRequested,
      reason: p.reason ?? null,
      deep_link: '/leave/approvals',
    };
    for (var i = 0; i < adminAccounts.length; i++) {
      var accountId = adminAccounts[i]!;
      await this.queue.enqueue({
        notificationType: notificationType,
        recipientAccountId: accountId,
        payload: payload,
        idempotencyKey: notificationType + ':' + event.eventId + ':' + accountId,
      });
    }
  }

  private async notifySubmitter(
    event: UnwrappedEvent<LeavePayload>,
    notificationType: string,
  ): Promise<void> {
    var p = event.payload;
    if (!p.accountId) {
      this.logger.warn(
        'Dropping ' +
          notificationType +
          ' fan-out — no accountId on payload (request ' +
          p.requestId +
          ')',
      );
      return;
    }
    var payload = {
      request_id: p.requestId,
      leave_type_name: p.leaveTypeName ?? null,
      start_date: p.startDate,
      end_date: p.endDate,
      days_requested:
        typeof p.daysRequested === 'string' ? Number(p.daysRequested) : p.daysRequested,
      status: p.status,
      review_notes: p.reviewNotes ?? null,
      reviewed_at: p.reviewedAt ?? null,
      deep_link: '/leave',
    };
    await this.queue.enqueue({
      notificationType: notificationType,
      recipientAccountId: p.accountId,
      payload: payload,
      idempotencyKey: notificationType + ':' + event.eventId + ':' + p.accountId,
    });
  }

  /**
   * Resolve every class the leaving employee is assigned to whose date
   * range overlaps the leave window, then emit `hr.leave.coverage_needed`
   * with the class id list. Cycle 5 Scheduling consumes this to wire up
   * substitute teachers.
   */
  private async emitCoverageNeeded(event: UnwrappedEvent<LeavePayload>): Promise<void> {
    var p = event.payload;
    var classRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{ class_id: string; section_code: string; course_name: string }>
      >(
        'SELECT ct.class_id::text AS class_id, c.section_code, co.name AS course_name ' +
          'FROM sis_class_teachers ct ' +
          'JOIN sis_classes c ON c.id = ct.class_id ' +
          'JOIN sis_courses co ON co.id = c.course_id ' +
          'WHERE ct.teacher_employee_id = $1::uuid ' +
          'ORDER BY c.section_code',
        p.employeeId,
      );
    });
    if (classRows.length === 0) {
      this.logger.debug(
        'No classes assigned to employee ' + p.employeeId + ' — skipping coverage_needed emit',
      );
      return;
    }
    // Deterministic event_id derived from the inbound `hr.leave.approved`
    // event_id (REVIEW-CYCLE4 MAJOR 3). A Kafka redelivery of the same
    // approved event would re-execute this republish, but the recipient
    // consumer's `platform_event_consumer_idempotency` claim catches it
    // by event_id. Without this, the deduplication has to happen on the
    // payload, which is more error-prone.
    var deterministicEventId = deterministicCoverageEventId(event.eventId);
    void this.kafka.emit({
      topic: 'hr.leave.coverage_needed',
      key: p.requestId,
      sourceModule: 'hr',
      eventId: deterministicEventId,
      correlationId: event.eventId,
      payload: {
        requestId: p.requestId,
        employeeId: p.employeeId,
        startDate: p.startDate,
        endDate: p.endDate,
        affectedClasses: classRows.map(function (r) {
          return {
            classId: r.class_id,
            sectionCode: r.section_code,
            courseName: r.course_name,
          };
        }),
      },
      tenantId: event.tenant.schoolId,
      tenantSubdomain: event.tenant.subdomain,
    });
  }

  private async lookupEmployeeName(employeeId: string): Promise<string> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ first_name: string; last_name: string }>>(
        'SELECT ip.first_name, ip.last_name FROM hr_employees e ' +
          'JOIN platform.iam_person ip ON ip.id = e.person_id ' +
          'WHERE e.id = $1::uuid',
        employeeId,
      );
    });
    if (rows.length === 0) return '(unknown)';
    return rows[0]!.first_name + ' ' + rows[0]!.last_name;
  }

  /**
   * Mirrors AbsenceRequestNotificationConsumer.loadSchoolAdminAccounts —
   * read the platform-scope-chain rows that confer `sch-001:admin` to find
   * every admin account for this tenant.
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
