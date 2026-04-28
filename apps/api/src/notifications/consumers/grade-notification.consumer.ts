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
 * GradeNotificationConsumer — listens for `cls.grade.published` (Cycle 2)
 * and fans out to the student themself + every portal-enabled guardian.
 *
 * Notification type: `grade.published` (matches the seed-messaging
 * notification-types catalogue).
 *
 * Quiet behaviour for `cls.grade.unpublished`: not subscribed. Unpublishing
 * a grade quietly removes it from the gradebook; pushing a "this grade is
 * gone" notification would be more surprising than helpful, and the snapshot
 * worker already moves the displayed average. If we ever need it, add the
 * topic here and emit a separate `grade.unpublished` notification type.
 */
interface GradePayload {
  gradeId: string;
  assignmentId: string;
  classId: string;
  studentId: string;
  gradeValue: number;
  maxPoints: number;
  letterGrade: string | null;
  termId: string | null;
  publishedAt: string | null;
}

interface GradeContext {
  studentName: string;
  studentAccountId: string | null;
  className: string;
  assignmentTitle: string;
}

var CONSUMER_GROUP = 'grade-notification-consumer';

@Injectable()
export class GradeNotificationConsumer implements OnModuleInit {
  private readonly logger = new Logger(GradeNotificationConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly queue: NotificationQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    var self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic('cls.grade.published')],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    var event = unwrapEnvelope<GradePayload>(msg, this.logger);
    if (!event) return;
    if (!event.payload.studentId || !event.payload.classId || !event.payload.assignmentId) {
      this.logger.warn(
        'Dropping ' + msg.topic + ' (eventId=' + event.eventId + ') — missing routing ids',
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
        await self.fanOut(event!.payload, event!.eventId);
      },
    );
  }

  private async fanOut(p: GradePayload, eventId: string): Promise<void> {
    var ctx = await this.loadContext(p.studentId, p.classId, p.assignmentId);
    if (!ctx) {
      this.logger.warn(
        'Skipping fan-out — student/class/assignment lookup failed for grade ' + p.gradeId,
      );
      return;
    }

    var guardianAccounts = await this.loadGuardianAccounts(p.studentId);
    var recipients: string[] = guardianAccounts.slice();
    if (ctx.studentAccountId) recipients.push(ctx.studentAccountId);

    if (recipients.length === 0) {
      this.logger.debug('Grade ' + p.gradeId + ' has no notifiable recipients');
      return;
    }

    var pct =
      p.maxPoints > 0 ? Math.round((Number(p.gradeValue) / Number(p.maxPoints)) * 10000) / 100 : 0;
    var payload = {
      grade_id: p.gradeId,
      assignment_id: p.assignmentId,
      assignment_title: ctx.assignmentTitle,
      class_id: p.classId,
      class_name: ctx.className,
      student_id: p.studentId,
      student_name: ctx.studentName,
      grade_value: Number(p.gradeValue),
      max_points: Number(p.maxPoints),
      percentage: pct,
      letter_grade: p.letterGrade,
      published_at: p.publishedAt,
      // STUDENT viewers go to /grades/:classId; GUARDIAN viewers to
      // /children/:studentId/grades/:classId. We send both — the UI picks
      // one based on persona.
      deep_link_student: '/grades/' + p.classId,
      deep_link_guardian: '/children/' + p.studentId + '/grades/' + p.classId,
    };

    for (var i = 0; i < recipients.length; i++) {
      var accountId = recipients[i]!;
      try {
        await this.queue.enqueue({
          notificationType: 'grade.published',
          recipientAccountId: accountId,
          payload: payload,
          idempotencyKey: 'grade.published:' + eventId + ':' + accountId,
        });
      } catch (e: any) {
        this.logger.error(
          'Enqueue failed for ' +
            accountId +
            ' (grade.published): ' +
            (e?.stack || e?.message || e),
        );
        throw e;
      }
    }
  }

  private async loadContext(
    studentId: string,
    classId: string,
    assignmentId: string,
  ): Promise<GradeContext | null> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          first_name: string;
          last_name: string;
          student_account_id: string | null;
          class_name: string;
          assignment_title: string;
        }>
      >(
        'SELECT ip.first_name, ip.last_name, ' +
          ' u.id::text AS student_account_id, ' +
          " co.name || ' (' || c.section_code || ')' AS class_name, " +
          ' a.title AS assignment_title ' +
          'FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
          'LEFT JOIN platform.platform_users u ON u.person_id = ps.person_id ' +
          'JOIN sis_classes c ON c.id = $2::uuid ' +
          'JOIN sis_courses co ON co.id = c.course_id ' +
          'JOIN cls_assignments a ON a.id = $3::uuid ' +
          'WHERE s.id = $1::uuid',
        studentId,
        classId,
        assignmentId,
      );
    });
    if (rows.length === 0) return null;
    var r = rows[0]!;
    return {
      studentName: r.first_name + ' ' + r.last_name,
      studentAccountId: r.student_account_id,
      className: r.class_name,
      assignmentTitle: r.assignment_title,
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
