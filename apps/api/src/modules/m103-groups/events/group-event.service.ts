import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { KafkaProducerService } from '@shared/kafka';
import type { ResolvedActor } from '@modules/m00-platform';
import { GroupService } from '../groups/group.service';
import { assertGroupInCurrentSchool } from '../groups/access';
import {
  CreateEventDto,
  EventResponseDto,
  EventType,
  RsvpDto,
  RsvpStatus,
  UpdateEventDto,
} from '../groups/dto/groups.dto';

interface EventRow {
  id: string;
  group_id: string;
  created_by: string;
  created_by_name: string | null;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: Date;
  ends_at: Date | null;
  event_type: string;
  requires_rsvp: boolean;
  rsvp_deadline: Date | null;
  max_attendees: number | null;
  is_public: boolean;
  going_count: number;
  maybe_count: number;
  not_going_count: number;
  my_rsvp: string | null;
  created_at: Date;
}

const SELECT_EVENT_BASE =
  'SELECT e.id::text AS id, e.group_id::text AS group_id, e.created_by::text AS created_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip WHERE ip.id = e.created_by) AS created_by_name, " +
  'e.title, e.description, e.location, e.starts_at, e.ends_at, e.event_type, ' +
  'e.requires_rsvp, e.rsvp_deadline, e.max_attendees, e.is_public, ' +
  "(SELECT COUNT(*)::int FROM grp_event_rsvps WHERE event_id = e.id AND status = 'GOING') AS going_count, " +
  "(SELECT COUNT(*)::int FROM grp_event_rsvps WHERE event_id = e.id AND status = 'MAYBE') AS maybe_count, " +
  "(SELECT COUNT(*)::int FROM grp_event_rsvps WHERE event_id = e.id AND status = 'NOT_GOING') AS not_going_count, " +
  '(SELECT status FROM grp_event_rsvps WHERE event_id = e.id AND responder_id = $READER::uuid LIMIT 1) AS my_rsvp, ' +
  'e.created_at ' +
  'FROM grp_events e ';

function buildSelect(readerIndex: number): string {
  return SELECT_EVENT_BASE.replace(/\$READER/g, '$' + readerIndex);
}

function rowToDto(r: EventRow): EventResponseDto {
  return {
    id: r.id,
    groupId: r.group_id,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    title: r.title,
    description: r.description,
    location: r.location,
    startsAt: r.starts_at.toISOString(),
    endsAt: r.ends_at ? r.ends_at.toISOString() : null,
    eventType: r.event_type as EventType,
    requiresRsvp: r.requires_rsvp,
    rsvpDeadline: r.rsvp_deadline ? r.rsvp_deadline.toISOString() : null,
    maxAttendees: r.max_attendees,
    isPublic: r.is_public,
    goingCount: r.going_count,
    maybeCount: r.maybe_count,
    notGoingCount: r.not_going_count,
    myRsvp: (r.my_rsvp as RsvpStatus | null) ?? null,
    createdAt: r.created_at.toISOString(),
  };
}

@Injectable()
export class GroupEventService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly groups: GroupService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * Read scope: members can read every event on the group; non-members
   * can read public events only.
   */
  private async assertCanRead(
    groupId: string,
    eventIsPublic: boolean,
    actor: ResolvedActor,
  ): Promise<void> {
    // Cross-school isolation — admins must still validate the group
    // belongs to the current school. getById is now school-scoped via
    // loadGroup, so threading admin reads through it keeps the school
    // gate tight.
    if (actor.isSchoolAdmin) {
      await this.groups.getById(groupId, actor);
      return;
    }
    if (eventIsPublic) {
      // Anyone in the school can see a public event provided they can
      // see the group (handles INVITE_ONLY hiding).
      await this.groups.getById(groupId, actor);
      return;
    }
    const group = await this.groups.getById(groupId, actor);
    if (!group.myMembership || group.myMembership.status !== 'ACTIVE') {
      throw new ForbiddenException('Only active members can see this event');
    }
  }

  async listForGroup(groupId: string, actor: ResolvedActor): Promise<EventResponseDto[]> {
    const group = await this.groups.getById(groupId, actor);
    if (!actor.personId) return [];
    const isMember = group.myMembership?.status === 'ACTIVE';

    const sql =
      buildSelect(1) +
      'WHERE e.group_id = $2::uuid ' +
      (actor.isSchoolAdmin || isMember ? '' : 'AND e.is_public = true ') +
      'ORDER BY e.starts_at ASC LIMIT 200';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql, actor.personId, groupId);
    })) as EventRow[];
    return rows.map(rowToDto);
  }

  async getById(eventId: string, actor: ResolvedActor): Promise<EventResponseDto> {
    if (!actor.personId) throw new ForbiddenException('No person record');
    const baseRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT group_id::text AS group_id, is_public FROM grp_events WHERE id = $1::uuid LIMIT 1',
        eventId,
      );
    })) as Array<{ group_id: string; is_public: boolean }>;
    if (baseRows.length === 0) throw new NotFoundException('Event not found');
    await this.assertCanRead(baseRows[0]!.group_id, baseRows[0]!.is_public, actor);

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        buildSelect(1) + 'WHERE e.id = $2::uuid LIMIT 1',
        actor.personId,
        eventId,
      );
    })) as EventRow[];
    if (rows.length === 0) throw new NotFoundException('Event not found');
    return rowToDto(rows[0]!);
  }

  async create(
    groupId: string,
    input: CreateEventDto,
    actor: ResolvedActor,
  ): Promise<EventResponseDto> {
    if (!actor.personId) {
      throw new ForbiddenException('Cannot create events without a person record');
    }
    // Cross-school isolation — even school admins must validate the
    // target group belongs to the current school before inserting an
    // event. Mirrors PollService / ResourceLibraryService / InvitationService.
    await assertGroupInCurrentSchool(this.tenantPrisma, groupId);
    if (!actor.isSchoolAdmin) {
      await this.groups.assertCanManageGroup(groupId, actor);
    }

    if (input.endsAt && new Date(input.endsAt).getTime() < new Date(input.startsAt).getTime()) {
      throw new BadRequestException('endsAt must be on or after startsAt');
    }
    if (
      input.rsvpDeadline &&
      new Date(input.rsvpDeadline).getTime() > new Date(input.startsAt).getTime()
    ) {
      throw new BadRequestException('rsvpDeadline must be on or before startsAt');
    }
    if (input.maxAttendees !== undefined && input.maxAttendees <= 0) {
      throw new BadRequestException('maxAttendees must be greater than 0');
    }

    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO grp_events (id, group_id, created_by, title, description, location, starts_at, ends_at, event_type, requires_rsvp, rsvp_deadline, max_attendees, is_public) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9, $10, $11::timestamptz, $12, $13)',
        id,
        groupId,
        actor.personId,
        input.title,
        input.description ?? null,
        input.location ?? null,
        input.startsAt,
        input.endsAt ?? null,
        input.eventType,
        input.requiresRsvp ?? false,
        input.rsvpDeadline ?? null,
        input.maxAttendees ?? null,
        input.isPublic ?? false,
      );
    });

    try {
      await this.kafka.emit({
        topic: 'grp.event.created',
        key: id,
        sourceModule: 'groups',
        payload: {
          eventId: id,
          groupId,
          createdBy: actor.personId,
          createdByAccountId: actor.accountId,
          title: input.title,
          startsAt: input.startsAt,
          eventType: input.eventType,
          requiresRsvp: input.requiresRsvp ?? false,
          isPublic: input.isPublic ?? false,
        },
      });
    } catch {
      // best-effort emit
    }

    return this.getById(id, actor);
  }

  async patch(
    eventId: string,
    input: UpdateEventDto,
    actor: ResolvedActor,
  ): Promise<EventResponseDto> {
    const baseRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT group_id::text AS group_id, created_by::text AS created_by FROM grp_events WHERE id = $1::uuid LIMIT 1',
        eventId,
      );
    })) as Array<{ group_id: string; created_by: string }>;
    if (baseRows.length === 0) throw new NotFoundException('Event not found');

    if (!actor.isSchoolAdmin && baseRows[0]!.created_by !== actor.personId) {
      await this.groups.assertCanManageGroup(baseRows[0]!.group_id, actor);
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
    if (input.location !== undefined) {
      sets.push('location = $' + (params.length + 1));
      params.push(input.location);
    }
    if (input.startsAt !== undefined) {
      sets.push('starts_at = $' + (params.length + 1) + '::timestamptz');
      params.push(input.startsAt);
    }
    if (input.endsAt !== undefined) {
      sets.push('ends_at = $' + (params.length + 1) + '::timestamptz');
      params.push(input.endsAt);
    }
    if (input.eventType !== undefined) {
      sets.push('event_type = $' + (params.length + 1));
      params.push(input.eventType);
    }
    if (input.requiresRsvp !== undefined) {
      sets.push('requires_rsvp = $' + (params.length + 1));
      params.push(input.requiresRsvp);
    }
    if (input.rsvpDeadline !== undefined) {
      sets.push('rsvp_deadline = $' + (params.length + 1) + '::timestamptz');
      params.push(input.rsvpDeadline);
    }
    if (input.maxAttendees !== undefined) {
      sets.push('max_attendees = $' + (params.length + 1));
      params.push(input.maxAttendees);
    }
    if (input.isPublic !== undefined) {
      sets.push('is_public = $' + (params.length + 1));
      params.push(input.isPublic);
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(eventId);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE grp_events SET ' + sets.join(', ') + ' WHERE id = $' + params.length + '::uuid',
          ...params,
        );
      });
    }
    return this.getById(eventId, actor);
  }

  /**
   * RSVP keystone — runs in one tx so the (event, responder) UNIQUE
   * + max_attendees + rsvp_deadline checks happen atomically against
   * the latest state.
   */
  async rsvp(eventId: string, input: RsvpDto, actor: ResolvedActor): Promise<EventResponseDto> {
    if (!actor.personId) throw new ForbiddenException('No person record');

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const ev = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, group_id::text AS group_id, requires_rsvp, rsvp_deadline, max_attendees, is_public, starts_at FROM grp_events WHERE id = $1::uuid FOR UPDATE',
        eventId,
      )) as Array<{
        id: string;
        group_id: string;
        requires_rsvp: boolean;
        rsvp_deadline: Date | null;
        max_attendees: number | null;
        is_public: boolean;
        starts_at: Date;
      }>;
      if (ev.length === 0) throw new NotFoundException('Event not found');
      const e = ev[0]!;

      // Read scope: members can RSVP; for public events any user with
      // group visibility can RSVP.
      await this.assertCanRead(e.group_id, e.is_public, actor);

      if (e.rsvp_deadline && e.rsvp_deadline.getTime() < Date.now()) {
        throw new BadRequestException('RSVP deadline has passed');
      }
      if (e.starts_at.getTime() < Date.now()) {
        throw new BadRequestException('Event has already started');
      }

      // Capacity check: only counts GOING. Switching from GOING to
      // NOT_GOING releases the slot. Switching from MAYBE/NOT_GOING to
      // GOING must respect the cap.
      if (input.status === 'GOING' && e.max_attendees !== null) {
        const goingRows = (await tx.$queryRawUnsafe(
          "SELECT COUNT(*)::int AS c FROM grp_event_rsvps WHERE event_id = $1::uuid AND status = 'GOING' AND responder_id <> $2::uuid",
          eventId,
          actor.personId,
        )) as Array<{ c: number }>;
        const otherGoing = goingRows[0]!.c;
        if (otherGoing >= e.max_attendees) {
          throw new BadRequestException(
            'Event is at capacity (' + e.max_attendees + ' attendees max)',
          );
        }
      }

      const id = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO grp_event_rsvps (id, event_id, responder_id, status) VALUES ($1::uuid, $2::uuid, $3::uuid, $4) ' +
          'ON CONFLICT (event_id, responder_id) DO UPDATE SET status = $4, responded_at = now()',
        id,
        eventId,
        actor.personId,
        input.status,
      );
    });

    return this.getById(eventId, actor);
  }

  async listMyRsvps(actor: ResolvedActor): Promise<EventResponseDto[]> {
    if (!actor.personId) return [];
    const sql =
      buildSelect(1) +
      'JOIN grp_event_rsvps r ON r.event_id = e.id WHERE r.responder_id = $1::uuid AND e.starts_at > now() ORDER BY e.starts_at ASC LIMIT 200';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql, actor.personId);
    })) as EventRow[];
    return rows.map(rowToDto);
  }

  async remove(eventId: string, actor: ResolvedActor): Promise<{ ok: true }> {
    const baseRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT group_id::text AS group_id, created_by::text AS created_by FROM grp_events WHERE id = $1::uuid LIMIT 1',
        eventId,
      );
    })) as Array<{ group_id: string; created_by: string }>;
    if (baseRows.length === 0) throw new NotFoundException('Event not found');
    if (!actor.isSchoolAdmin && baseRows[0]!.created_by !== actor.personId) {
      await this.groups.assertCanManageGroup(baseRows[0]!.group_id, actor);
    }
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe('DELETE FROM grp_events WHERE id = $1::uuid', eventId);
    });
    return { ok: true };
  }
}
