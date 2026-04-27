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
 * AttendanceNotificationConsumer — listens for `att.student.marked_tardy`
 * and `att.student.marked_absent` (Cycle 1) and fans them out to the
 * student's portal-enabled guardians as in-app notifications.
 *
 * Notification type names match seed-messaging.ts:
 *   - att.student.marked_tardy  → 'attendance.tardy'
 *   - att.student.marked_absent → 'attendance.absent'
 *
 * Recipient resolution:
 *   sis_student_guardians sg → sis_guardians g where
 *     sg.portal_access = true AND sg.receives_reports = true
 *     AND g.account_id IS NOT NULL
 *
 *   `account_id` is the soft-typed UUID into `platform_users.id`. We don't
 *   join across schemas inside the tenant tx — `account_id` is what the
 *   notification queue stores as `recipient_id`, and the Step 8
 *   notification bell will resolve display names on its own.
 *
 * Recipients with no portal access are skipped: there's no surface to
 * deliver to. `receives_reports` mirrors the existing absence-request
 * authorisation rule — guardians who opted out of reports also opt out of
 * push notifications.
 */
interface AttendancePayload {
  recordId: string;
  studentId: string;
  classId: string;
  date: string;
  period: string;
  markedAt?: string | null;
}

interface StudentContext {
  studentName: string;
  studentNumber: string | null;
  className: string;
}

var CONSUMER_GROUP = 'attendance-notification-consumer';

@Injectable()
export class AttendanceNotificationConsumer implements OnModuleInit {
  private readonly logger = new Logger(AttendanceNotificationConsumer.name);

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
        prefixedTopic('att.student.marked_tardy'),
        prefixedTopic('att.student.marked_absent'),
      ],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    var event = unwrapEnvelope<AttendancePayload>(msg, this.logger);
    if (!event) return;
    if (!event.payload.studentId || !event.payload.classId) {
      this.logger.warn(
        'Dropping ' + msg.topic + ' (eventId=' + event.eventId + ') — missing student/class id',
      );
      return;
    }

    var notificationType = msg.topic.endsWith('marked_tardy')
      ? 'attendance.tardy'
      : 'attendance.absent';
    var statusLabel = notificationType === 'attendance.tardy' ? 'TARDY' : 'ABSENT';

    var self = this;
    await processWithIdempotency(
      CONSUMER_GROUP,
      event as UnwrappedEvent<unknown>,
      this.idempotency,
      this.logger,
      async function () {
        await self.fanOut(event!.payload, event!.eventId, notificationType, statusLabel);
      },
    );
  }

  private async fanOut(
    p: AttendancePayload,
    eventId: string,
    notificationType: string,
    statusLabel: string,
  ): Promise<void> {
    var ctx = await this.loadContext(p.studentId, p.classId);
    if (!ctx) {
      this.logger.warn(
        'Skipping fan-out — student ' +
          p.studentId +
          ' or class ' +
          p.classId +
          ' not found in tenant',
      );
      return;
    }

    var guardians = await this.loadGuardianAccounts(p.studentId);
    if (guardians.length === 0) {
      this.logger.debug(
        'No portal-enabled guardians for student ' + p.studentId + ' — nothing to enqueue',
      );
      return;
    }

    var payload = {
      student_id: p.studentId,
      student_name: ctx.studentName,
      student_number: ctx.studentNumber,
      class_id: p.classId,
      class_name: ctx.className,
      period: p.period,
      date: p.date,
      status: statusLabel,
      record_id: p.recordId,
      occurred_at: p.markedAt ?? null,
      deep_link: '/children/' + p.studentId + '/attendance',
    };

    for (var i = 0; i < guardians.length; i++) {
      var accountId = guardians[i]!;
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

  private async loadContext(studentId: string, classId: string): Promise<StudentContext | null> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          first_name: string;
          last_name: string;
          student_number: string | null;
          class_name: string;
        }>
      >(
        'SELECT ip.first_name, ip.last_name, s.student_number, ' +
          " c.title || ' (' || c.section_code || ')' AS class_name " +
          'FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
          'JOIN sis_classes c ON c.id = $2::uuid ' +
          'WHERE s.id = $1::uuid',
        studentId,
        classId,
      );
    });
    if (rows.length === 0) return null;
    var r = rows[0]!;
    return {
      studentName: r.first_name + ' ' + r.last_name,
      studentNumber: r.student_number,
      className: r.class_name,
    };
  }

  private async loadGuardianAccounts(studentId: string): Promise<string[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ account_id: string }>>(
        'SELECT g.account_id::text AS account_id ' +
          'FROM sis_student_guardians sg ' +
          'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
          'WHERE sg.student_id = $1::uuid ' +
          ' AND sg.portal_access = true ' +
          ' AND sg.receives_reports = true ' +
          ' AND g.account_id IS NOT NULL',
        studentId,
      );
    });
    return rows.map(function (r) {
      return r.account_id;
    });
  }
}
