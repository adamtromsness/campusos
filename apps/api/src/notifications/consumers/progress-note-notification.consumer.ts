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
 * ProgressNoteNotificationConsumer — listens for
 * `cls.progress_note.published` (Cycle 2) and notifies the parties the
 * teacher chose to expose: guardians when `is_parent_visible`, the student
 * themself when `is_student_visible`. The teacher-side visibility flags
 * mirror the row scope used by ProgressNoteService.listForStudent.
 *
 * Notification type: `progress_note.published`.
 */
interface ProgressNotePayload {
  noteId: string;
  classId: string;
  studentId: string;
  termId: string;
  isParentVisible: boolean;
  isStudentVisible: boolean;
  authorId: string;
  publishedAt: string;
}

interface NoteContext {
  studentName: string;
  studentAccountId: string | null;
  className: string;
  termName: string;
  authorName: string;
}

var CONSUMER_GROUP = 'progress-note-notification-consumer';

@Injectable()
export class ProgressNoteNotificationConsumer implements OnModuleInit {
  private readonly logger = new Logger(ProgressNoteNotificationConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly queue: NotificationQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    var self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic('cls.progress_note.published')],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    var event = unwrapEnvelope<ProgressNotePayload>(msg, this.logger);
    if (!event) return;
    if (!event.payload.studentId || !event.payload.classId || !event.payload.termId) {
      this.logger.warn(
        'Dropping ' + msg.topic + ' (eventId=' + event.eventId + ') — missing routing ids',
      );
      return;
    }
    if (!event.payload.isParentVisible && !event.payload.isStudentVisible) {
      this.logger.debug(
        'Skip note ' + event.payload.noteId + ' — neither parent nor student visible',
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

  private async fanOut(p: ProgressNotePayload, eventId: string): Promise<void> {
    var ctx = await this.loadContext(p.studentId, p.classId, p.termId, p.authorId);
    if (!ctx) {
      this.logger.warn('Skipping fan-out — context lookup failed for note ' + p.noteId);
      return;
    }

    var recipients: string[] = [];
    if (p.isParentVisible) {
      recipients = recipients.concat(await this.loadGuardianAccounts(p.studentId));
    }
    if (p.isStudentVisible && ctx.studentAccountId) {
      recipients.push(ctx.studentAccountId);
    }
    if (recipients.length === 0) {
      this.logger.debug('Note ' + p.noteId + ' has no notifiable recipients');
      return;
    }

    var payload = {
      note_id: p.noteId,
      class_id: p.classId,
      class_name: ctx.className,
      student_id: p.studentId,
      student_name: ctx.studentName,
      term_id: p.termId,
      term_name: ctx.termName,
      author_name: ctx.authorName,
      published_at: p.publishedAt,
      deep_link_guardian: '/children/' + p.studentId + '/grades/' + p.classId,
      deep_link_student: '/grades/' + p.classId,
    };

    for (var i = 0; i < recipients.length; i++) {
      var accountId = recipients[i]!;
      try {
        await this.queue.enqueue({
          notificationType: 'progress_note.published',
          recipientAccountId: accountId,
          payload: payload,
          idempotencyKey: 'progress_note.published:' + eventId + ':' + accountId,
        });
      } catch (e: any) {
        this.logger.error(
          'Enqueue failed for ' +
            accountId +
            ' (progress_note.published): ' +
            (e?.stack || e?.message || e),
        );
        throw e;
      }
    }
  }

  private async loadContext(
    studentId: string,
    classId: string,
    termId: string,
    authorPersonId: string,
  ): Promise<NoteContext | null> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          first_name: string;
          last_name: string;
          student_account_id: string | null;
          class_name: string;
          term_name: string;
          author_first_name: string | null;
          author_last_name: string | null;
        }>
      >(
        'SELECT ip.first_name, ip.last_name, ' +
          ' u.id::text AS student_account_id, ' +
          " co.name || ' (' || c.section_code || ')' AS class_name, " +
          ' t.name AS term_name, ' +
          ' ap.first_name AS author_first_name, ' +
          ' ap.last_name AS author_last_name ' +
          'FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
          'LEFT JOIN platform.platform_users u ON u.person_id = ps.person_id ' +
          'JOIN sis_classes c ON c.id = $2::uuid ' +
          'JOIN sis_courses co ON co.id = c.course_id ' +
          'JOIN sis_terms t ON t.id = $3::uuid ' +
          'LEFT JOIN platform.iam_person ap ON ap.id = $4::uuid ' +
          'WHERE s.id = $1::uuid',
        studentId,
        classId,
        termId,
        authorPersonId,
      );
    });
    if (rows.length === 0) return null;
    var r = rows[0]!;
    var authorName =
      r.author_first_name && r.author_last_name
        ? r.author_first_name + ' ' + r.author_last_name
        : 'Teacher';
    return {
      studentName: r.first_name + ' ' + r.last_name,
      studentAccountId: r.student_account_id,
      className: r.class_name,
      termName: r.term_name,
      authorName: authorName,
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
