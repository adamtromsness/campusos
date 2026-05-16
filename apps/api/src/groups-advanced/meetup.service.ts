import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { GroupService } from '../groups/group.service';
import { assertGroupInCurrentSchool } from './access';
import {
  CreateGroupMeetupDto,
  MeetupResponseDto,
  RsvpMeetupDto,
  RsvpStatus,
  UpdateGroupMeetupDto,
} from './dto/groups-advanced.dto';

interface MeetupRow {
  id: string;
  group_id: string;
  title: string;
  description: string | null;
  event_date: Date;
  location: string | null;
  max_attendees: number | null;
  created_by: string;
  created_at: Date;
}

/**
 * GroupMeetupService — P2-28a Step 2.
 *
 * Informal group meetups distinct from Cycle 18 grp_events and P2-12
 * evt_events. RSVP CONFIRMED count enforced at the service layer
 * inside the locked tx so two concurrent confirms cannot both pass
 * the cap check.
 */
@Injectable()
export class GroupMeetupService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly groups: GroupService,
  ) {}

  private async assertGroupMember(groupId: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const group = await this.groups.getById(groupId, actor);
    if (!group.myMembership || group.myMembership.status !== 'ACTIVE') {
      throw new ForbiddenException('Only active group members can use this meetup');
    }
  }

  async create(
    groupId: string,
    input: CreateGroupMeetupDto,
    actor: ResolvedActor,
  ): Promise<MeetupResponseDto> {
    // REVIEW-P2C28 BLOCKING 2 — school admins must still validate the
    // target group belongs to the current school.
    await assertGroupInCurrentSchool(this.tenantPrisma, groupId);
    if (!actor.isSchoolAdmin) {
      await this.groups.assertCanManageGroup(groupId, actor);
    }
    if (input.maxAttendees !== undefined && input.maxAttendees < 1) {
      throw new BadRequestException('maxAttendees must be greater than 0');
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO grp_group_events (id, group_id, title, description, event_date, location, max_attendees, created_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $6, $7, $8::uuid)',
        id,
        groupId,
        input.title,
        input.description ?? null,
        input.eventDate,
        input.location ?? null,
        input.maxAttendees ?? null,
        actor.accountId,
      );
    });
    return this.getById(id, actor);
  }

  async listForGroup(groupId: string, actor: ResolvedActor): Promise<MeetupResponseDto[]> {
    await this.assertGroupMember(groupId, actor);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, group_id::text AS group_id, title, description, event_date, location, max_attendees, ' +
          'created_by::text AS created_by, created_at ' +
          'FROM grp_group_events WHERE group_id = $1::uuid ORDER BY event_date ASC LIMIT 200',
        groupId,
      );
    })) as MeetupRow[];
    const result: MeetupResponseDto[] = [];
    for (const r of rows) {
      result.push(await this.hydrate(r, actor));
    }
    return result;
  }

  async getById(meetupId: string, actor: ResolvedActor): Promise<MeetupResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, group_id::text AS group_id, title, description, event_date, location, max_attendees, ' +
          'created_by::text AS created_by, created_at ' +
          'FROM grp_group_events WHERE id = $1::uuid LIMIT 1',
        meetupId,
      );
    })) as MeetupRow[];
    if (rows.length === 0) throw new NotFoundException('Meetup not found');
    const row = rows[0]!;
    await this.assertGroupMember(row.group_id, actor);
    return this.hydrate(row, actor);
  }

  async patch(
    meetupId: string,
    input: UpdateGroupMeetupDto,
    actor: ResolvedActor,
  ): Promise<MeetupResponseDto> {
    const baseRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT group_id::text AS group_id, created_by::text AS created_by FROM grp_group_events WHERE id = $1::uuid LIMIT 1',
        meetupId,
      );
    })) as Array<{ group_id: string; created_by: string }>;
    if (baseRows.length === 0) throw new NotFoundException('Meetup not found');
    if (!actor.isSchoolAdmin && baseRows[0]!.created_by !== actor.accountId) {
      await this.groups.assertCanManageGroup(baseRows[0]!.group_id, actor);
    }

    if (input.maxAttendees !== undefined && input.maxAttendees < 1) {
      throw new BadRequestException('maxAttendees must be greater than 0');
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.title !== undefined) {
      sets.push('title = $' + (params.length + 1));
      params.push(input.title);
    }
    if (input.description !== undefined) {
      sets.push('description = $' + (params.length + 1));
      params.push(input.description);
    }
    if (input.eventDate !== undefined) {
      sets.push('event_date = $' + (params.length + 1) + '::timestamptz');
      params.push(input.eventDate);
    }
    if (input.location !== undefined) {
      sets.push('location = $' + (params.length + 1));
      params.push(input.location);
    }
    if (input.maxAttendees !== undefined) {
      sets.push('max_attendees = $' + (params.length + 1));
      params.push(input.maxAttendees);
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(meetupId);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE grp_group_events SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
    }
    return this.getById(meetupId, actor);
  }

  async remove(meetupId: string, actor: ResolvedActor): Promise<{ ok: true }> {
    const baseRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT group_id::text AS group_id, created_by::text AS created_by FROM grp_group_events WHERE id = $1::uuid LIMIT 1',
        meetupId,
      );
    })) as Array<{ group_id: string; created_by: string }>;
    if (baseRows.length === 0) throw new NotFoundException('Meetup not found');
    if (!actor.isSchoolAdmin && baseRows[0]!.created_by !== actor.accountId) {
      await this.groups.assertCanManageGroup(baseRows[0]!.group_id, actor);
    }
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe('DELETE FROM grp_group_events WHERE id = $1::uuid', meetupId);
    });
    return { ok: true };
  }

  /**
   * RSVP KEYSTONE — atomic CONFIRMED count vs max_attendees.
   *
   * Runs inside one tenant tx with SELECT ... FOR UPDATE on the
   * grp_group_events row so two concurrent confirms cannot both pass
   * the cap check. CONFIRMED count is recomputed under the lock from
   * grp_group_event_rsvps.
   */
  async rsvp(
    meetupId: string,
    input: RsvpMeetupDto,
    actor: ResolvedActor,
  ): Promise<MeetupResponseDto> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, group_id::text AS group_id, max_attendees FROM grp_group_events WHERE id = $1::uuid FOR UPDATE',
        meetupId,
      )) as Array<{ id: string; group_id: string; max_attendees: number | null }>;
      if (rows.length === 0) throw new NotFoundException('Meetup not found');
      const meetup = rows[0]!;
      await this.assertGroupMember(meetup.group_id, actor);

      // Look up current RSVP for this (event, member) pair
      const existing = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, status FROM grp_group_event_rsvps WHERE event_id = $1::uuid AND member_id = $2::uuid LIMIT 1',
        meetupId,
        actor.accountId,
      )) as Array<{ id: string; status: string }>;

      // Cap check applies only on transitions INTO CONFIRMED
      if (input.status === 'CONFIRMED' && meetup.max_attendees !== null) {
        const currentConfirmed = (await tx.$queryRawUnsafe(
          "SELECT COUNT(*)::int AS n FROM grp_group_event_rsvps WHERE event_id = $1::uuid AND status = 'CONFIRMED'",
          meetupId,
        )) as Array<{ n: number }>;
        const wasConfirmed = existing.length > 0 && existing[0]!.status === 'CONFIRMED';
        const projected = wasConfirmed ? currentConfirmed[0]!.n : currentConfirmed[0]!.n + 1;
        if (projected > meetup.max_attendees) {
          throw new BadRequestException(
            'Meetup has reached its maximum attendee cap of ' + meetup.max_attendees,
          );
        }
      }

      const respondedExpr = input.status === 'PENDING' ? 'NULL' : 'now()';
      if (existing.length === 0) {
        await tx.$executeRawUnsafe(
          'INSERT INTO grp_group_event_rsvps (id, event_id, member_id, status, responded_at) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, ' +
            respondedExpr +
            ')',
          generateId(),
          meetupId,
          actor.accountId,
          input.status,
        );
      } else {
        await tx.$executeRawUnsafe(
          'UPDATE grp_group_event_rsvps SET status = $1, responded_at = ' +
            respondedExpr +
            ', updated_at = now() WHERE id = $2::uuid',
          input.status,
          existing[0]!.id,
        );
      }
    });
    return this.getById(meetupId, actor);
  }

  private async hydrate(row: MeetupRow, actor: ResolvedActor): Promise<MeetupResponseDto> {
    const counts = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT ' +
          "COUNT(*) FILTER (WHERE status = 'CONFIRMED')::int AS confirmed, " +
          "COUNT(*) FILTER (WHERE status = 'DECLINED')::int AS declined, " +
          "COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending " +
          'FROM grp_group_event_rsvps WHERE event_id = $1::uuid',
        row.id,
      );
    })) as Array<{ confirmed: number; declined: number; pending: number }>;

    const my = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT status FROM grp_group_event_rsvps WHERE event_id = $1::uuid AND member_id = $2::uuid LIMIT 1',
        row.id,
        actor.accountId,
      );
    })) as Array<{ status: string }>;

    return {
      id: row.id,
      groupId: row.group_id,
      title: row.title,
      description: row.description,
      eventDate: row.event_date.toISOString(),
      location: row.location,
      maxAttendees: row.max_attendees,
      createdBy: row.created_by,
      confirmedCount: counts[0]?.confirmed ?? 0,
      declinedCount: counts[0]?.declined ?? 0,
      pendingCount: counts[0]?.pending ?? 0,
      myRsvp: my.length > 0 ? (my[0]!.status as RsvpStatus) : null,
      createdAt: row.created_at.toISOString(),
    };
  }
}
