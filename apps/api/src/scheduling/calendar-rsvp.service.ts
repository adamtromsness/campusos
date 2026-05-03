import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';

export interface CalendarEventRsvpDto {
  id: string;
  calendarEventId: string;
  personId: string;
  personName: string | null;
  response: 'GOING' | 'TENTATIVE' | 'NOT_GOING';
  respondedAt: string;
}

export interface CalendarEventRsvpSummaryDto {
  going: number;
  tentative: number;
  notGoing: number;
  myResponse: 'GOING' | 'TENTATIVE' | 'NOT_GOING' | null;
}

interface RsvpRow {
  id: string;
  calendar_event_id: string;
  person_id: string;
  first_name: string | null;
  last_name: string | null;
  response: string;
  responded_at: string;
}

function rowToDto(row: RsvpRow): CalendarEventRsvpDto {
  let personName: string | null = null;
  if (row.first_name && row.last_name) personName = row.first_name + ' ' + row.last_name;
  return {
    id: row.id,
    calendarEventId: row.calendar_event_id,
    personId: row.person_id,
    personName,
    response: row.response as CalendarEventRsvpDto['response'],
    respondedAt: row.responded_at,
  };
}

const SELECT_RSVP_BASE =
  'SELECT r.id, r.calendar_event_id, r.person_id, ' +
  'ip.first_name, ip.last_name, ' +
  'r.response, r.responded_at ' +
  'FROM sch_calendar_event_rsvps r ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = r.person_id ';

@Injectable()
export class CalendarRsvpService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Set or change my response to a calendar event. Idempotent UPSERT keyed on
   * (calendar_event_id, person_id). Returns the resulting row.
   */
  async setResponse(
    eventId: string,
    response: 'GOING' | 'TENTATIVE' | 'NOT_GOING',
    actor: ResolvedActor,
  ): Promise<CalendarEventRsvpDto> {
    if (!actor.personId) {
      throw new ForbiddenException('You must be a person to respond to calendar events');
    }
    const id = generateId();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      // Confirm the event exists and is published (or admin) before we write.
      const eventRows = (await client.$queryRawUnsafe(
        'SELECT is_published FROM sch_calendar_events WHERE id = $1::uuid',
        eventId,
      )) as Array<{ is_published: boolean }>;
      if (eventRows.length === 0) throw new NotFoundException('Calendar event ' + eventId);
      if (!eventRows[0]!.is_published && !actor.isSchoolAdmin) {
        throw new NotFoundException('Calendar event ' + eventId);
      }

      await client.$executeRawUnsafe(
        'INSERT INTO sch_calendar_event_rsvps (id, calendar_event_id, person_id, response, responded_at, created_at, updated_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now(), now(), now()) ' +
          'ON CONFLICT (calendar_event_id, person_id) DO UPDATE SET ' +
          'response = EXCLUDED.response, responded_at = now(), updated_at = now()',
        id,
        eventId,
        actor.personId,
        response,
      );
      return client.$queryRawUnsafe<RsvpRow[]>(
        SELECT_RSVP_BASE + 'WHERE r.calendar_event_id = $1::uuid AND r.person_id = $2::uuid',
        eventId,
        actor.personId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Calendar event ' + eventId);
    return rowToDto(rows[0]!);
  }

  /**
   * List all RSVPs for an event. Admins see every row; non-admin callers see
   * only their own row (returns empty array if they haven't responded yet).
   */
  async list(eventId: string, actor: ResolvedActor): Promise<CalendarEventRsvpDto[]> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const eventRows = (await client.$queryRawUnsafe(
        'SELECT is_published FROM sch_calendar_events WHERE id = $1::uuid',
        eventId,
      )) as Array<{ is_published: boolean }>;
      if (eventRows.length === 0) throw new NotFoundException('Calendar event ' + eventId);
      if (!eventRows[0]!.is_published && !actor.isSchoolAdmin) {
        throw new NotFoundException('Calendar event ' + eventId);
      }
      if (actor.isSchoolAdmin) {
        return client.$queryRawUnsafe<RsvpRow[]>(
          SELECT_RSVP_BASE + 'WHERE r.calendar_event_id = $1::uuid ORDER BY r.responded_at DESC',
          eventId,
        );
      }
      if (!actor.personId) return [] as RsvpRow[];
      return client.$queryRawUnsafe<RsvpRow[]>(
        SELECT_RSVP_BASE + 'WHERE r.calendar_event_id = $1::uuid AND r.person_id = $2::uuid',
        eventId,
        actor.personId,
      );
    });
    return rows.map(rowToDto);
  }

  /**
   * Aggregate counts + my response for an event. Used by the event detail
   * Modal to render "X going · Y tentative · Z not going" inline.
   */
  async summary(eventId: string, actor: ResolvedActor): Promise<CalendarEventRsvpSummaryDto> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const eventRows = (await client.$queryRawUnsafe(
        'SELECT is_published FROM sch_calendar_events WHERE id = $1::uuid',
        eventId,
      )) as Array<{ is_published: boolean }>;
      if (eventRows.length === 0) throw new NotFoundException('Calendar event ' + eventId);
      if (!eventRows[0]!.is_published && !actor.isSchoolAdmin) {
        throw new NotFoundException('Calendar event ' + eventId);
      }
      const counts = (await client.$queryRawUnsafe(
        'SELECT response, COUNT(*)::int AS c FROM sch_calendar_event_rsvps ' +
          'WHERE calendar_event_id = $1::uuid GROUP BY response',
        eventId,
      )) as Array<{ response: string; c: number }>;
      let going = 0;
      let tentative = 0;
      let notGoing = 0;
      for (const row of counts) {
        if (row.response === 'GOING') going = row.c;
        else if (row.response === 'TENTATIVE') tentative = row.c;
        else if (row.response === 'NOT_GOING') notGoing = row.c;
      }
      let myResponse: CalendarEventRsvpSummaryDto['myResponse'] = null;
      if (actor.personId) {
        const mine = (await client.$queryRawUnsafe(
          'SELECT response FROM sch_calendar_event_rsvps WHERE calendar_event_id = $1::uuid AND person_id = $2::uuid',
          eventId,
          actor.personId,
        )) as Array<{ response: string }>;
        if (mine.length > 0) {
          myResponse = mine[0]!.response as CalendarEventRsvpSummaryDto['myResponse'];
        }
      }
      return { going, tentative, notGoing, myResponse };
    });
  }

  /**
   * Return the set of event IDs where the given persons have a non-NOT_GOING
   * RSVP. Used by the calendar list endpoint to build the my-children filter
   * on the parent calendar view.
   */
  async eventIdsForPersons(personIds: string[]): Promise<string[]> {
    if (personIds.length === 0) return [];
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ calendar_event_id: string }>>(
        'SELECT DISTINCT calendar_event_id FROM sch_calendar_event_rsvps ' +
          'WHERE person_id = ANY($1::uuid[]) AND response IN (' +
          "'GOING', 'TENTATIVE') ",
        personIds,
      );
    });
    return rows.map((r) => r.calendar_event_id);
  }
}
