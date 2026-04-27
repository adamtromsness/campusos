import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { ConsumedMessage, KafkaConsumerService } from '../kafka/kafka-consumer.service';
import { IdempotencyService } from '../kafka/idempotency.service';
import { prefixedTopic } from '../kafka/event-envelope';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { NotificationQueueService } from '../notifications/notification-queue.service';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '../notifications/consumers/notification-consumer-base';

/**
 * AudienceFanOutWorker — Cycle 3 Step 7.
 *
 * Kafka consumer on `msg.announcement.published`. Resolves the audience
 * implied by `(audience_type, audience_ref)`, inserts one row per recipient
 * into `msg_announcement_audiences` (idempotent — UNIQUE constraint), and
 * enqueues an `announcement.published` notification for each recipient via
 * the Step 5 NotificationQueueService.
 *
 * The pre-computed audience model (writing one row per recipient even for
 * ALL_SCHOOL) is the design called out in the plan: it eliminates real-time
 * fan-out at read-time and lets `GET /announcements` be a single
 * `WHERE platform_user_id = ?` lookup against the audiences table.
 *
 * Idempotency follows the REVIEW-CYCLE2 BLOCKING 2 pattern (claim-after-success):
 *   - read-only `IdempotencyService.isClaimed` on arrival,
 *   - process inside `runWithTenantContextAsync`,
 *   - claim only after the process resolves so a transient platform DB blip
 *     leaves the event-id un-claimed and the next Kafka redelivery rebuilds
 *     the work. The audience UNIQUE + Redis SET NX on enqueue keep duplicate
 *     processing harmless.
 *
 * Audience resolution:
 *   - ALL_SCHOOL: every account holding any active role assignment in the
 *     school's scope chain (school + platform).
 *   - CLASS: students enrolled in the class (active enrollments) + their
 *     portal-enabled guardians + the class's assigned teachers.
 *   - YEAR_GROUP: students with sis_students.grade_level = audience_ref +
 *     their portal-enabled guardians.
 *   - ROLE: every account whose IAM role token (`name.toUpperCase().replace(' ', '_')`)
 *     equals audience_ref.
 *   - CUSTOM: not implemented in Cycle 3 — logs and skips. Reserved for the
 *     forthcoming Communication Groups feature.
 */
interface AnnouncementPublishedPayload {
  announcementId: string;
  authorId: string;
  title: string;
  audienceType: 'ALL_SCHOOL' | 'CLASS' | 'YEAR_GROUP' | 'ROLE' | 'CUSTOM';
  audienceRef: string | null;
  publishedAt: string;
}

interface AnnouncementContext {
  alertTypeName: string | null;
  alertTypeSeverity: string | null;
  body: string;
  expiresAt: string | null;
  authorName: string | null;
}

const CONSUMER_GROUP = 'audience-fan-out-worker';

@Injectable()
export class AudienceFanOutWorker implements OnModuleInit {
  private readonly logger = new Logger(AudienceFanOutWorker.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly queue: NotificationQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    var self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic('msg.announcement.published')],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    var event = unwrapEnvelope<AnnouncementPublishedPayload>(msg, this.logger);
    if (!event) return;
    if (!event.payload.announcementId || !event.payload.audienceType) {
      this.logger.warn(
        'Dropping ' + msg.topic + ' (eventId=' + event.eventId + ') — missing announcement routing fields',
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

  private async fanOut(p: AnnouncementPublishedPayload, eventId: string): Promise<void> {
    var ctx = await this.loadAnnouncementContext(p.announcementId);
    if (!ctx) {
      this.logger.warn('Announcement ' + p.announcementId + ' not found in tenant; dropping');
      return;
    }
    var recipients = await this.resolveAudience(p.audienceType, p.audienceRef);
    if (recipients.length === 0) {
      this.logger.warn(
        'Announcement ' +
          p.announcementId +
          ' (audience=' +
          p.audienceType +
          (p.audienceRef ? '/' + p.audienceRef : '') +
          ') resolved to 0 recipients',
      );
      return;
    }
    this.logger.log(
      'Fanning out announcement ' +
        p.announcementId +
        ' (audience=' +
        p.audienceType +
        (p.audienceRef ? '/' + p.audienceRef : '') +
        ') to ' +
        recipients.length +
        ' recipients',
    );

    // Insert audience rows in a single tenant tx to avoid per-row round-trips.
    await this.writeAudienceRows(p.announcementId, recipients);

    var preview = ctx.body.length > 240 ? ctx.body.slice(0, 237) + '…' : ctx.body;
    var payload = {
      announcement_id: p.announcementId,
      title: p.title,
      preview: preview,
      author_name: ctx.authorName,
      author_id: p.authorId,
      audience_type: p.audienceType,
      audience_ref: p.audienceRef,
      alert_type: ctx.alertTypeName,
      severity: ctx.alertTypeSeverity,
      published_at: p.publishedAt,
      expires_at: ctx.expiresAt,
      deep_link: '/announcements/' + p.announcementId,
    };

    for (var i = 0; i < recipients.length; i++) {
      var accountId = recipients[i]!;
      try {
        await this.queue.enqueue({
          notificationType: 'announcement.published',
          recipientAccountId: accountId,
          payload: payload,
          idempotencyKey: 'announcement.published:' + eventId + ':' + accountId,
        });
      } catch (e: any) {
        this.logger.error(
          'Enqueue failed for ' + accountId + ' (announcement.published): ' + (e?.stack || e?.message || e),
        );
        throw e;
      }
    }
  }

  /**
   * Resolve the audience for a given (audience_type, audience_ref). Returns
   * a deduplicated list of platform_users.id strings.
   */
  private async resolveAudience(
    audienceType: AnnouncementPublishedPayload['audienceType'],
    audienceRef: string | null,
  ): Promise<string[]> {
    switch (audienceType) {
      case 'ALL_SCHOOL':
        return this.audienceAllSchool();
      case 'CLASS':
        if (!audienceRef) return [];
        return this.audienceClass(audienceRef);
      case 'YEAR_GROUP':
        if (!audienceRef) return [];
        return this.audienceYearGroup(audienceRef);
      case 'ROLE':
        if (!audienceRef) return [];
        return this.audienceRole(audienceRef);
      case 'CUSTOM':
        this.logger.warn(
          'CUSTOM audience type is not yet implemented — Communication Groups (deferred)',
        );
        return [];
      default:
        return [];
    }
  }

  /**
   * Every account holding any active role assignment in the school's scope
   * chain (SCHOOL or PLATFORM). Reads the platform schema directly — the
   * no-FK rule is about constraints, not joins. We DISTINCT to dedupe a user
   * who holds multiple roles.
   */
  private async audienceAllSchool(): Promise<string[]> {
    var tenant = getCurrentTenant();
    var rows = await this.tenantPrisma.getPlatformClient().$queryRawUnsafe<
      Array<{ account_id: string }>
    >(
      'SELECT DISTINCT ra.account_id::text AS account_id ' +
        'FROM platform.iam_role_assignment ra ' +
        'JOIN platform.iam_scope sc ON sc.id = ra.scope_id ' +
        'JOIN platform.iam_scope_type stp ON stp.id = sc.scope_type_id ' +
        "WHERE ra.status = 'ACTIVE' " +
        " AND ((stp.code = 'SCHOOL' AND sc.entity_id = $1::uuid) OR stp.code = 'PLATFORM')",
      tenant.schoolId,
    );
    return rows.map(function (r) {
      return r.account_id;
    });
  }

  /**
   * For audience_type=CLASS, audience_ref holds a sis_classes.id UUID.
   * Audience is: enrolled students + their portal-enabled guardians + the
   * class's assigned teachers.
   *
   * Teachers: sis_class_teachers.teacher_employee_id is iam_person.id (per
   * REVIEW-CYCLE2 DEVIATION 4 — temporary HR-employee identity mapping).
   */
  private async audienceClass(classId: string): Promise<string[]> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      var rows = await client.$queryRawUnsafe<Array<{ account_id: string }>>(
        'SELECT DISTINCT account_id FROM ( ' +
          // Students enrolled in this class
          ' SELECT u.id::text AS account_id ' +
          ' FROM sis_enrollments e ' +
          ' JOIN sis_students s ON s.id = e.student_id ' +
          ' JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          ' JOIN platform.platform_users u ON u.person_id = ps.person_id ' +
          " WHERE e.class_id = $1::uuid AND e.status = 'ACTIVE' " +
          ' UNION ' +
          // Portal-enabled guardians of those students
          ' SELECT g.account_id::text AS account_id ' +
          ' FROM sis_enrollments e ' +
          ' JOIN sis_student_guardians sg ON sg.student_id = e.student_id ' +
          ' JOIN sis_guardians g ON g.id = sg.guardian_id ' +
          " WHERE e.class_id = $1::uuid AND e.status = 'ACTIVE' " +
          '   AND sg.portal_access = true AND g.account_id IS NOT NULL ' +
          ' UNION ' +
          // Teachers assigned to the class — teacher_employee_id is iam_person.id
          ' SELECT u.id::text AS account_id ' +
          ' FROM sis_class_teachers ct ' +
          ' JOIN platform.platform_users u ON u.person_id = ct.teacher_employee_id ' +
          ' WHERE ct.class_id = $1::uuid ' +
          ') sub ' +
          'WHERE account_id IS NOT NULL',
        classId,
      );
      return rows.map(function (r) {
        return r.account_id;
      });
    });
  }

  /**
   * For audience_type=YEAR_GROUP, audience_ref is the grade-level label
   * stored on sis_students.grade_level. Audience = students in that grade +
   * their portal-enabled guardians. Teachers are not included — a year-group
   * announcement is aimed at families.
   */
  private async audienceYearGroup(grade: string): Promise<string[]> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      var rows = await client.$queryRawUnsafe<Array<{ account_id: string }>>(
        'SELECT DISTINCT account_id FROM ( ' +
          ' SELECT u.id::text AS account_id ' +
          ' FROM sis_students s ' +
          ' JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          ' JOIN platform.platform_users u ON u.person_id = ps.person_id ' +
          ' WHERE s.grade_level = $1 ' +
          ' UNION ' +
          ' SELECT g.account_id::text AS account_id ' +
          ' FROM sis_students s ' +
          ' JOIN sis_student_guardians sg ON sg.student_id = s.id ' +
          ' JOIN sis_guardians g ON g.id = sg.guardian_id ' +
          ' WHERE s.grade_level = $1 ' +
          '   AND sg.portal_access = true AND g.account_id IS NOT NULL ' +
          ') sub ' +
          'WHERE account_id IS NOT NULL',
        grade,
      );
      return rows.map(function (r) {
        return r.account_id;
      });
    });
  }

  /**
   * For audience_type=ROLE, audience_ref is the role token (e.g. PARENT,
   * TEACHER, STUDENT, SCHOOL_ADMIN). The token is the IAM role name
   * uppercased with spaces → underscores — same convention used by
   * msg_thread_types.allowed_participant_roles in the seed.
   */
  private async audienceRole(roleToken: string): Promise<string[]> {
    var tenant = getCurrentTenant();
    var rows = await this.tenantPrisma.getPlatformClient().$queryRawUnsafe<
      Array<{ account_id: string }>
    >(
      'SELECT DISTINCT ra.account_id::text AS account_id ' +
        'FROM platform.iam_role_assignment ra ' +
        'JOIN platform.roles r ON r.id = ra.role_id ' +
        'JOIN platform.iam_scope sc ON sc.id = ra.scope_id ' +
        'JOIN platform.iam_scope_type stp ON stp.id = sc.scope_type_id ' +
        "WHERE ra.status = 'ACTIVE' " +
        " AND UPPER(REGEXP_REPLACE(r.name, '\\s+', '_', 'g')) = $1 " +
        " AND ((stp.code = 'SCHOOL' AND sc.entity_id = $2::uuid) OR stp.code = 'PLATFORM')",
      roleToken,
      tenant.schoolId,
    );
    return rows.map(function (r) {
      return r.account_id;
    });
  }

  /**
   * Bulk-insert audience rows for the resolved recipient set. ON CONFLICT
   * DO NOTHING handles redelivery — the unique constraint on
   * `(announcement_id, platform_user_id)` makes this safe.
   *
   * We mark fresh rows DELIVERED at insert time. Schema-wise PENDING is the
   * default but the worker has effectively "delivered" the audience (the
   * notification queue takes over from here); leaving everything PENDING
   * forever would skew the stats endpoint.
   */
  private async writeAudienceRows(
    announcementId: string,
    accountIds: string[],
  ): Promise<void> {
    if (accountIds.length === 0) return;
    var tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      for (var i = 0; i < accountIds.length; i++) {
        await tx.$executeRawUnsafe(
          'INSERT INTO msg_announcement_audiences ' +
            '(id, school_id, announcement_id, platform_user_id, delivery_status, delivered_at) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'DELIVERED', now()) " +
            'ON CONFLICT (announcement_id, platform_user_id) DO NOTHING',
          generateId(),
          tenant.schoolId,
          announcementId,
          accountIds[i]!,
        );
      }
    });
  }

  private async loadAnnouncementContext(
    announcementId: string,
  ): Promise<AnnouncementContext | null> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          body: string;
          expires_at: Date | string | null;
          alert_type_name: string | null;
          alert_type_severity: string | null;
          author_first_name: string | null;
          author_last_name: string | null;
          author_display_name: string | null;
        }>
      >(
        'SELECT a.body, a.expires_at, ' +
          ' at.name AS alert_type_name, at.severity AS alert_type_severity, ' +
          ' u.display_name AS author_display_name, ' +
          ' ip.first_name AS author_first_name, ip.last_name AS author_last_name ' +
          'FROM msg_announcements a ' +
          'LEFT JOIN msg_alert_types at ON at.id = a.alert_type_id ' +
          'LEFT JOIN platform.platform_users u ON u.id = a.author_id ' +
          'LEFT JOIN platform.iam_person ip ON ip.id = u.person_id ' +
          'WHERE a.id = $1::uuid',
        announcementId,
      );
    });
    if (rows.length === 0) return null;
    var r = rows[0]!;
    var name =
      r.author_first_name && r.author_last_name
        ? r.author_first_name + ' ' + r.author_last_name
        : r.author_display_name || null;
    return {
      alertTypeName: r.alert_type_name,
      alertTypeSeverity: r.alert_type_severity,
      body: r.body,
      expiresAt: r.expires_at instanceof Date ? r.expires_at.toISOString() : r.expires_at,
      authorName: name,
    };
  }
}
