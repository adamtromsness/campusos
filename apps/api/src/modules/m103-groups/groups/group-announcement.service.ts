import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { KafkaProducerService } from '@shared/kafka/kafka-producer.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { GroupService } from './group.service';
import {
  AnnouncementResponseDto,
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
} from './dto/groups.dto';

interface AnnouncementRow {
  id: string;
  group_id: string;
  author_id: string;
  author_name: string | null;
  title: string;
  body: string;
  pinned: boolean;
  attachments: unknown[] | null;
  publish_at: Date;
  expires_at: Date | null;
  read_count: number;
  i_have_read: boolean;
  created_at: Date;
}

const SELECT_ANNOUNCEMENT_BASE =
  'SELECT a.id::text AS id, a.group_id::text AS group_id, a.author_id::text AS author_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip WHERE ip.id = a.author_id) AS author_name, " +
  'a.title, a.body, a.pinned, a.attachments, a.publish_at, a.expires_at, ' +
  '(SELECT COUNT(*)::int FROM grp_announcement_reads r WHERE r.announcement_id = a.id) AS read_count, ' +
  'EXISTS (SELECT 1 FROM grp_announcement_reads r WHERE r.announcement_id = a.id AND r.reader_id = $READER::uuid) AS i_have_read, ' +
  'a.created_at ' +
  'FROM grp_announcements a ';

function buildSelect(readerIndex: number): string {
  return SELECT_ANNOUNCEMENT_BASE.replace(/\$READER/g, '$' + readerIndex);
}

function rowToDto(r: AnnouncementRow): AnnouncementResponseDto {
  return {
    id: r.id,
    groupId: r.group_id,
    authorId: r.author_id,
    authorName: r.author_name,
    title: r.title,
    body: r.body,
    pinned: r.pinned,
    attachments: r.attachments,
    publishAt: r.publish_at.toISOString(),
    expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
    readCount: r.read_count,
    iHaveRead: r.i_have_read,
    createdAt: r.created_at.toISOString(),
  };
}

@Injectable()
export class GroupAnnouncementService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly groups: GroupService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /** Reader scope: caller must see the group AND be a member (or admin). */
  async assertCanRead(groupId: string, actor: ResolvedActor): Promise<void> {
    const group = await this.groups.getById(groupId, actor);
    if (actor.isSchoolAdmin) return;
    if (!group.myMembership || group.myMembership.status !== 'ACTIVE') {
      throw new ForbiddenException('Only active members can read announcements');
    }
  }

  /** Author scope: must be OWNER or ADMIN of the group. */
  async assertCanAuthor(groupId: string, actor: ResolvedActor): Promise<{ personId: string }> {
    if (!actor.personId) {
      throw new ForbiddenException('Cannot author announcements without a person record');
    }
    if (actor.isSchoolAdmin) return { personId: actor.personId };
    await this.groups.assertCanManageGroup(groupId, actor);
    return { personId: actor.personId };
  }

  async listForGroup(groupId: string, actor: ResolvedActor): Promise<AnnouncementResponseDto[]> {
    await this.assertCanRead(groupId, actor);
    if (!actor.personId) return [];
    const sql =
      buildSelect(1) +
      'WHERE a.group_id = $2::uuid AND (a.expires_at IS NULL OR a.expires_at > now()) AND a.publish_at <= now() ' +
      'ORDER BY a.pinned DESC, a.publish_at DESC LIMIT 100';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql, actor.personId, groupId);
    })) as AnnouncementRow[];
    return rows.map(rowToDto);
  }

  async getById(announcementId: string, actor: ResolvedActor): Promise<AnnouncementResponseDto> {
    if (!actor.personId) throw new ForbiddenException('No person record');
    const groupRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT group_id::text AS group_id FROM grp_announcements WHERE id = $1::uuid LIMIT 1',
        announcementId,
      );
    })) as Array<{ group_id: string }>;
    if (groupRows.length === 0) throw new NotFoundException('Announcement not found');
    await this.assertCanRead(groupRows[0]!.group_id, actor);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        buildSelect(1) + 'WHERE a.id = $2::uuid LIMIT 1',
        actor.personId,
        announcementId,
      );
    })) as AnnouncementRow[];
    if (rows.length === 0) throw new NotFoundException('Announcement not found');
    return rowToDto(rows[0]!);
  }

  async create(
    groupId: string,
    input: CreateAnnouncementDto,
    actor: ResolvedActor,
  ): Promise<AnnouncementResponseDto> {
    const { personId } = await this.assertCanAuthor(groupId, actor);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO grp_announcements (id, group_id, author_id, title, body, pinned, attachments, expires_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb, $8::timestamptz)',
        id,
        groupId,
        personId,
        input.title,
        input.body,
        input.pinned ?? false,
        input.attachments ? JSON.stringify(input.attachments) : null,
        input.expiresAt ?? null,
      );
    });

    try {
      await this.kafka.emit({
        topic: 'grp.announcement.posted',
        key: id,
        sourceModule: 'groups',
        payload: {
          announcementId: id,
          groupId,
          authorId: personId,
          authorAccountId: actor.accountId,
          title: input.title,
          pinned: input.pinned ?? false,
        },
      });
    } catch {
      // best-effort emit
    }

    return this.getById(id, actor);
  }

  async patch(
    announcementId: string,
    input: UpdateAnnouncementDto,
    actor: ResolvedActor,
  ): Promise<AnnouncementResponseDto> {
    const groupRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT group_id::text AS group_id, author_id::text AS author_id FROM grp_announcements WHERE id = $1::uuid LIMIT 1',
        announcementId,
      );
    })) as Array<{ group_id: string; author_id: string }>;
    if (groupRows.length === 0) throw new NotFoundException('Announcement not found');

    if (!actor.isSchoolAdmin && groupRows[0]!.author_id !== actor.personId) {
      // Non-author admins of the group can edit too.
      await this.groups.assertCanManageGroup(groupRows[0]!.group_id, actor);
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.title !== undefined) {
      sets.push('title = $' + (params.length + 1));
      params.push(input.title);
    }
    if (input.body !== undefined) {
      sets.push('body = $' + (params.length + 1));
      params.push(input.body);
    }
    if (input.pinned !== undefined) {
      sets.push('pinned = $' + (params.length + 1));
      params.push(input.pinned);
    }
    if (input.expiresAt !== undefined) {
      sets.push('expires_at = $' + (params.length + 1) + '::timestamptz');
      params.push(input.expiresAt);
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(announcementId);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE grp_announcements SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
    }
    return this.getById(announcementId, actor);
  }

  async markRead(announcementId: string, actor: ResolvedActor): Promise<{ ok: true }> {
    if (!actor.personId) throw new ForbiddenException('No person record');
    // Confirm reader can see the group.
    const groupRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT group_id::text AS group_id FROM grp_announcements WHERE id = $1::uuid LIMIT 1',
        announcementId,
      );
    })) as Array<{ group_id: string }>;
    if (groupRows.length === 0) throw new NotFoundException('Announcement not found');
    await this.assertCanRead(groupRows[0]!.group_id, actor);

    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO grp_announcement_reads (id, announcement_id, reader_id) VALUES ($1::uuid, $2::uuid, $3::uuid) ' +
          'ON CONFLICT (announcement_id, reader_id) DO NOTHING',
        id,
        announcementId,
        actor.personId,
      );
    });
    return { ok: true };
  }

  async remove(announcementId: string, actor: ResolvedActor): Promise<{ ok: true }> {
    const groupRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT group_id::text AS group_id, author_id::text AS author_id FROM grp_announcements WHERE id = $1::uuid LIMIT 1',
        announcementId,
      );
    })) as Array<{ group_id: string; author_id: string }>;
    if (groupRows.length === 0) throw new NotFoundException('Announcement not found');
    if (!actor.isSchoolAdmin && groupRows[0]!.author_id !== actor.personId) {
      await this.groups.assertCanManageGroup(groupRows[0]!.group_id, actor);
    }
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'DELETE FROM grp_announcements WHERE id = $1::uuid',
        announcementId,
      );
    });
    return { ok: true };
  }
}
