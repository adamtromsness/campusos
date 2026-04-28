import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import {
  AUDIENCE_TYPES,
  AnnouncementResponseDto,
  AnnouncementStatsResponseDto,
  AudienceType,
  CreateAnnouncementDto,
  ListAnnouncementsQueryDto,
  MarkAnnouncementReadResponseDto,
  UpdateAnnouncementDto,
} from './dto/announcement.dto';

interface AnnouncementRow {
  id: string;
  school_id: string;
  author_id: string;
  author_first_name: string | null;
  author_last_name: string | null;
  author_display_name: string | null;
  title: string;
  body: string;
  audience_type: string;
  audience_ref: string | null;
  alert_type_id: string | null;
  alert_type_name: string | null;
  alert_type_severity: string | null;
  publish_at: Date | string | null;
  expires_at: Date | string | null;
  is_published: boolean;
  is_recurring: boolean;
  recurrence_rule: string | null;
  is_read: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

const SELECT_ANNOUNCEMENT_BASE =
  'SELECT a.id, a.school_id, a.author_id, a.title, a.body, a.audience_type, a.audience_ref, ' +
  ' a.alert_type_id, a.publish_at, a.expires_at, a.is_published, a.is_recurring, ' +
  ' a.recurrence_rule, a.created_at, a.updated_at, ' +
  ' at.name AS alert_type_name, at.severity AS alert_type_severity, ' +
  ' u.display_name AS author_display_name, ' +
  ' ip.first_name AS author_first_name, ip.last_name AS author_last_name, ' +
  ' EXISTS (SELECT 1 FROM msg_announcement_reads ar ' +
  '         WHERE ar.announcement_id = a.id AND ar.reader_id = $1::uuid) AS is_read ' +
  'FROM msg_announcements a ' +
  'LEFT JOIN msg_alert_types at ON at.id = a.alert_type_id ' +
  'LEFT JOIN platform.platform_users u ON u.id = a.author_id ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = u.person_id ';

function toIso(v: Date | string | null): string | null {
  if (v === null) return null;
  return typeof v === 'string' ? v : v.toISOString();
}

function rowToDto(r: AnnouncementRow): AnnouncementResponseDto {
  var name =
    r.author_first_name && r.author_last_name
      ? r.author_first_name + ' ' + r.author_last_name
      : r.author_display_name || null;
  return {
    id: r.id,
    schoolId: r.school_id,
    authorId: r.author_id,
    authorName: name,
    title: r.title,
    body: r.body,
    audienceType: r.audience_type as AudienceType,
    audienceRef: r.audience_ref,
    alertTypeId: r.alert_type_id,
    alertTypeName: r.alert_type_name,
    alertTypeSeverity: r.alert_type_severity,
    publishAt: toIso(r.publish_at),
    expiresAt: toIso(r.expires_at),
    isPublished: r.is_published,
    isRecurring: r.is_recurring,
    recurrenceRule: r.recurrence_rule,
    isRead: r.is_read,
    createdAt: toIso(r.created_at) || '',
    updatedAt: toIso(r.updated_at) || '',
  };
}

function validateAudience(audienceType: AudienceType, audienceRef: string | undefined | null) {
  if (AUDIENCE_TYPES.indexOf(audienceType) === -1) {
    throw new BadRequestException('Invalid audienceType');
  }
  if (audienceType === 'ALL_SCHOOL') {
    if (audienceRef && audienceRef.length > 0) {
      throw new BadRequestException('audienceRef must be empty when audienceType=ALL_SCHOOL');
    }
    return;
  }
  if (!audienceRef || audienceRef.trim().length === 0) {
    throw new BadRequestException('audienceRef is required for audienceType=' + audienceType);
  }
}

/**
 * AnnouncementService — Cycle 3 Step 7.
 *
 * Request-path service for the M40 Announcements feature. Owns CRUD on
 * `msg_announcements` and the read tracker (`msg_announcement_reads`).
 * Publishing emits `msg.announcement.published` so the AudienceFanOutWorker
 * can resolve the audience and pre-populate `msg_announcement_audiences`.
 *
 * Read scope:
 *   - com-002:write holders (Teacher, School Admin, Platform Admin) see every
 *     announcement in the tenant — including drafts authored by anyone.
 *     Drafts are filtered out by default; pass `includeDrafts=true` to opt in.
 *   - readers (com-002:read only — Parent, Student, Staff) see only published,
 *     non-expired announcements where they have a row in
 *     `msg_announcement_audiences`. ALL_SCHOOL announcements get fanned out
 *     to every active platform user, so this filter still works for them.
 */
@Injectable()
export class AnnouncementService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly permissions: PermissionCheckService,
  ) {}

  /**
   * Caller is allowed to author / edit announcements and read every
   * announcement in the tenant (including drafts authored by anyone).
   *
   * REVIEW-CYCLE3 MAJOR fix: previously this returned true for any actor
   * with `personType === 'STAFF'`, which leaked tenant-wide announcements
   * (and drafts when the includeDrafts flag was set) to staff who only
   * held com-002:read. The seed gives Staff just com-002:read, not
   * com-002:write, so they should be readers not managers. We now gate
   * manager status on actually holding com-002:write in this tenant's
   * scope chain (school + platform per ADR-036), which matches the IAM
   * seed exactly: Teachers and School Admins hold com-002:write, Staff
   * does not.
   */
  private async isManager(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    var tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'com-002:write',
    ]);
  }

  async list(
    query: ListAnnouncementsQueryDto,
    actor: ResolvedActor,
  ): Promise<AnnouncementResponseDto[]> {
    var tenant = getCurrentTenant();
    var manager = await this.isManager(actor);
    var includeDrafts = manager && query.includeDrafts === true;
    var includeExpired = query.includeExpired === true;

    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var sql = SELECT_ANNOUNCEMENT_BASE + 'WHERE a.school_id = $2::uuid ';
      var params: any[] = [actor.accountId, tenant.schoolId];
      if (!manager) {
        // Reader scope: must have an audience row.
        sql +=
          'AND EXISTS (SELECT 1 FROM msg_announcement_audiences aa ' +
          ' WHERE aa.announcement_id = a.id AND aa.platform_user_id = $1::uuid) ';
        sql += 'AND a.is_published = true ';
      } else if (!includeDrafts) {
        sql += 'AND a.is_published = true ';
      }
      if (!includeExpired) {
        sql += 'AND (a.expires_at IS NULL OR a.expires_at > now()) ';
      }
      sql += 'ORDER BY a.publish_at DESC NULLS FIRST, a.created_at DESC';
      return client.$queryRawUnsafe<AnnouncementRow[]>(sql, ...params);
    });
    return rows.map(rowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<AnnouncementResponseDto> {
    var tenant = getCurrentTenant();
    var manager = await this.isManager(actor);
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var sql = SELECT_ANNOUNCEMENT_BASE + 'WHERE a.id = $2::uuid AND a.school_id = $3::uuid ';
      var params: any[] = [actor.accountId, id, tenant.schoolId];
      if (!manager) {
        sql +=
          'AND a.is_published = true ' +
          'AND EXISTS (SELECT 1 FROM msg_announcement_audiences aa ' +
          ' WHERE aa.announcement_id = a.id AND aa.platform_user_id = $1::uuid) ';
      }
      return client.$queryRawUnsafe<AnnouncementRow[]>(sql, ...params);
    });
    if (rows.length === 0) throw new NotFoundException('Announcement ' + id + ' not found');
    return rowToDto(rows[0]!);
  }

  /**
   * Create a draft or publish-now announcement. When `isPublished=true` the
   * row is inserted with `publish_at = now()` (or the supplied timestamp if
   * it has already passed) and `msg.announcement.published` fires so the
   * AudienceFanOutWorker pre-populates `msg_announcement_audiences`.
   */
  async create(
    input: CreateAnnouncementDto,
    actor: ResolvedActor,
  ): Promise<AnnouncementResponseDto> {
    if (!(await this.isManager(actor))) {
      throw new ForbiddenException(
        'Only com-002:write holders (Teacher, School Admin) may create announcements',
      );
    }
    validateAudience(input.audienceType, input.audienceRef ?? null);
    if (input.alertTypeId) {
      await this.assertAlertTypeBelongsToTenant(input.alertTypeId);
    }

    var tenant = getCurrentTenant();
    var id = generateId();
    var publishImmediately = input.isPublished === true;
    var publishAt: string | null;
    if (publishImmediately) {
      publishAt = input.publishAt ?? new Date().toISOString();
    } else {
      publishAt = input.publishAt ?? null;
    }

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO msg_announcements ' +
          '(id, school_id, author_id, title, body, audience_type, audience_ref, alert_type_id, ' +
          ' publish_at, expires_at, is_published) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid, ' +
          ' $9::timestamptz, $10::timestamptz, $11)',
        id,
        tenant.schoolId,
        actor.accountId,
        input.title,
        input.body,
        input.audienceType,
        input.audienceType === 'ALL_SCHOOL' ? null : (input.audienceRef ?? null),
        input.alertTypeId ?? null,
        publishAt,
        input.expiresAt ?? null,
        publishImmediately,
      );
    });

    if (publishImmediately) {
      await this.emitPublished(
        id,
        actor.accountId,
        input.audienceType,
        input.audienceRef ?? null,
        input.title,
        publishAt,
      );
    }

    return this.getByIdInternal(id);
  }

  /**
   * Edit an existing draft. Refuses to edit a published announcement (the UI
   * is expected to surface drafts vs. published explicitly). Flipping
   * `isPublished` from false → true publishes it and emits
   * `msg.announcement.published`. Author-or-admin only.
   */
  async update(
    id: string,
    input: UpdateAnnouncementDto,
    actor: ResolvedActor,
  ): Promise<AnnouncementResponseDto> {
    if (!(await this.isManager(actor))) {
      throw new ForbiddenException(
        'Only com-002:write holders (Teacher, School Admin) may edit announcements',
      );
    }
    var tenant = getCurrentTenant();
    var existing = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          id: string;
          author_id: string;
          is_published: boolean;
          audience_type: string;
          audience_ref: string | null;
          title: string;
          publish_at: Date | string | null;
        }>
      >(
        'SELECT id::text AS id, author_id::text AS author_id, is_published, audience_type, ' +
          ' audience_ref, title, publish_at ' +
          'FROM msg_announcements WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    if (existing.length === 0) throw new NotFoundException('Announcement ' + id + ' not found');
    var current = existing[0]!;
    var isAuthor = current.author_id === actor.accountId;
    if (!isAuthor && !actor.isSchoolAdmin) {
      throw new ForbiddenException(
        'Only the author or a school administrator may edit this announcement',
      );
    }
    if (current.is_published) {
      throw new BadRequestException('Published announcements cannot be edited');
    }
    if (input.isPublished === false) {
      throw new BadRequestException(
        'Cannot set isPublished=false on a draft (already unpublished)',
      );
    }

    var newAudienceType = (input.audienceType ?? current.audience_type) as AudienceType;
    var newAudienceRef =
      input.audienceType !== undefined ? (input.audienceRef ?? null) : current.audience_ref;
    validateAudience(newAudienceType, newAudienceRef);
    if (input.alertTypeId) {
      await this.assertAlertTypeBelongsToTenant(input.alertTypeId);
    }

    var willPublish = input.isPublished === true;
    var nextPublishAt: string | null;
    if (willPublish) {
      nextPublishAt = input.publishAt ?? new Date().toISOString();
    } else {
      nextPublishAt = input.publishAt ?? toIso(current.publish_at);
    }

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      var sets: string[] = [];
      var params: any[] = [];
      var idx = 1;
      function setField(col: string, value: any, cast?: string) {
        sets.push(col + ' = $' + idx + (cast ? '::' + cast : ''));
        params.push(value);
        idx++;
      }
      if (input.title !== undefined) setField('title', input.title);
      if (input.body !== undefined) setField('body', input.body);
      if (input.audienceType !== undefined) setField('audience_type', newAudienceType);
      if (input.audienceType !== undefined || input.audienceRef !== undefined) {
        setField('audience_ref', newAudienceType === 'ALL_SCHOOL' ? null : newAudienceRef);
      }
      if (input.alertTypeId !== undefined) setField('alert_type_id', input.alertTypeId, 'uuid');
      if (input.expiresAt !== undefined) setField('expires_at', input.expiresAt, 'timestamptz');
      if (input.publishAt !== undefined || willPublish) {
        setField('publish_at', nextPublishAt, 'timestamptz');
      }
      if (willPublish) setField('is_published', true);
      sets.push('updated_at = now()');
      params.push(id);
      var sql =
        'UPDATE msg_announcements SET ' + sets.join(', ') + ' WHERE id = $' + idx + '::uuid';
      await client.$executeRawUnsafe(sql, ...params);
    });

    if (willPublish) {
      await this.emitPublished(
        id,
        current.author_id,
        newAudienceType,
        newAudienceRef,
        input.title ?? current.title,
        nextPublishAt,
      );
    }

    return this.getByIdInternal(id);
  }

  /**
   * Idempotent mark-as-read. Inserts a `msg_announcement_reads` row for
   * (announcement, reader) and returns whether it was a new insert. Also
   * flips the matching `msg_announcement_audiences.delivery_status` to
   * DELIVERED if the row was still PENDING.
   */
  async markRead(id: string, actor: ResolvedActor): Promise<MarkAnnouncementReadResponseDto> {
    // Authorize visibility — manager has implicit visibility, reader needs
    // an audience row OR can mark-read what's published in general.
    var snapshot = await this.getById(id, actor);
    if (!snapshot.isPublished) {
      throw new BadRequestException('Cannot mark a draft as read');
    }
    var tenant = getCurrentTenant();
    var readId = generateId();
    var newlyRead = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var n = await tx.$executeRawUnsafe(
        'INSERT INTO msg_announcement_reads (id, school_id, announcement_id, reader_id) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid) ' +
          'ON CONFLICT (announcement_id, reader_id) DO NOTHING',
        readId,
        tenant.schoolId,
        id,
        actor.accountId,
      );
      // delivery_status bookkeeping — readers reaching the announcement before
      // the worker fans out is rare, but the audience row may also have been
      // pre-seeded as PENDING. Flip to DELIVERED for the convenience of stats.
      await tx.$executeRawUnsafe(
        "UPDATE msg_announcement_audiences SET delivery_status = 'DELIVERED', " +
          ' delivered_at = COALESCE(delivered_at, now()) ' +
          "WHERE announcement_id = $1::uuid AND platform_user_id = $2::uuid AND delivery_status = 'PENDING'",
        id,
        actor.accountId,
      );
      return typeof n === 'number' && n > 0;
    });
    return {
      announcementId: id,
      readAt: new Date().toISOString(),
      newlyRead: newlyRead,
    };
  }

  /**
   * Stats: total audience, read count + percentage, delivery breakdown.
   * Author or school admin only — the controller pins the permission gate
   * to com-002:write but the row check happens here.
   */
  async getStats(id: string, actor: ResolvedActor): Promise<AnnouncementStatsResponseDto> {
    var tenant = getCurrentTenant();
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ author_id: string }>>(
        'SELECT author_id::text AS author_id FROM msg_announcements ' +
          'WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Announcement ' + id + ' not found');
    var authorId = rows[0]!.author_id;
    if (!actor.isSchoolAdmin && authorId !== actor.accountId) {
      throw new ForbiddenException('Only the author or a school administrator may view stats');
    }

    var stats = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var aud = await client.$queryRawUnsafe<
        Array<{
          total: bigint;
          pending: bigint;
          delivered: bigint;
          failed: bigint;
        }>
      >(
        'SELECT COUNT(*)::bigint AS total, ' +
          " COUNT(*) FILTER (WHERE delivery_status = 'PENDING')::bigint AS pending, " +
          " COUNT(*) FILTER (WHERE delivery_status = 'DELIVERED')::bigint AS delivered, " +
          " COUNT(*) FILTER (WHERE delivery_status = 'FAILED')::bigint AS failed " +
          'FROM msg_announcement_audiences WHERE announcement_id = $1::uuid',
        id,
      );
      var reads = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
        'SELECT COUNT(*)::bigint AS count FROM msg_announcement_reads ' +
          'WHERE announcement_id = $1::uuid',
        id,
      );
      return { aud: aud[0]!, reads: reads[0]! };
    });

    var total = Number(stats.aud.total);
    var read = Number(stats.reads.count);
    var pct = total > 0 ? Math.round((read / total) * 10000) / 100 : 0;
    return {
      announcementId: id,
      totalAudience: total,
      readCount: read,
      readPercentage: pct,
      pendingCount: Number(stats.aud.pending),
      deliveredCount: Number(stats.aud.delivered),
      failedCount: Number(stats.aud.failed),
    };
  }

  // ──────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────

  private async getByIdInternal(id: string): Promise<AnnouncementResponseDto> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AnnouncementRow[]>(
        // Use a sentinel zero-uuid as the "reader" for is_read here — the row
        // is fetched right after a write, the caller reads through getById()
        // for actor-scoped reads.
        SELECT_ANNOUNCEMENT_BASE + 'WHERE a.id = $2::uuid',
        '00000000-0000-0000-0000-000000000000',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Announcement ' + id + ' not found');
    return rowToDto(rows[0]!);
  }

  private async assertAlertTypeBelongsToTenant(alertTypeId: string): Promise<void> {
    var tenant = getCurrentTenant();
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM msg_alert_types WHERE id = $1::uuid AND school_id = $2::uuid AND is_active = true LIMIT 1',
        alertTypeId,
        tenant.schoolId,
      );
    });
    if (rows.length === 0)
      throw new BadRequestException('Alert type ' + alertTypeId + ' not found or inactive');
  }

  private async emitPublished(
    announcementId: string,
    authorAccountId: string,
    audienceType: AudienceType,
    audienceRef: string | null,
    title: string,
    publishAt: string | null,
  ): Promise<void> {
    void this.kafka.emit({
      topic: 'msg.announcement.published',
      key: announcementId,
      sourceModule: 'communications',
      occurredAt: publishAt ?? new Date().toISOString(),
      payload: {
        announcementId: announcementId,
        authorId: authorAccountId,
        title: title,
        audienceType: audienceType,
        audienceRef: audienceRef,
        publishedAt: publishAt ?? new Date().toISOString(),
      },
    });
  }
}
