import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  CalendarDayResolutionDto,
  CalendarEventResponseDto,
  CreateCalendarEventDto,
  ListCalendarEventsQueryDto,
  UpdateCalendarEventDto,
} from './dto/calendar.dto';

interface EventRow {
  id: string;
  school_id: string;
  title: string;
  description: string | null;
  event_type: string;
  start_date: string;
  end_date: string;
  all_day: boolean;
  start_time: string | null;
  end_time: string | null;
  bell_schedule_id: string | null;
  bell_schedule_name: string | null;
  affects_attendance: boolean;
  is_published: boolean;
  created_by: string | null;
  created_by_first_name: string | null;
  created_by_last_name: string | null;
  created_at: string;
  updated_at: string;
}

function rowToDto(row: EventRow): CalendarEventResponseDto {
  var createdByName: string | null = null;
  if (row.created_by_first_name && row.created_by_last_name) {
    createdByName = row.created_by_first_name + ' ' + row.created_by_last_name;
  }
  return {
    id: row.id,
    schoolId: row.school_id,
    title: row.title,
    description: row.description,
    eventType: row.event_type as CalendarEventResponseDto['eventType'],
    startDate: row.start_date,
    endDate: row.end_date,
    allDay: row.all_day,
    startTime: row.start_time,
    endTime: row.end_time,
    bellScheduleId: row.bell_schedule_id,
    bellScheduleName: row.bell_schedule_name,
    affectsAttendance: row.affects_attendance,
    isPublished: row.is_published,
    createdById: row.created_by,
    createdByName: createdByName,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

var SELECT_EVENT_BASE =
  'SELECT e.id, e.school_id, e.title, e.description, e.event_type, ' +
  "TO_CHAR(e.start_date, 'YYYY-MM-DD') AS start_date, " +
  "TO_CHAR(e.end_date, 'YYYY-MM-DD') AS end_date, " +
  'e.all_day, ' +
  "TO_CHAR(e.start_time, 'HH24:MI') AS start_time, " +
  "TO_CHAR(e.end_time, 'HH24:MI') AS end_time, " +
  'e.bell_schedule_id, bs.name AS bell_schedule_name, ' +
  'e.affects_attendance, e.is_published, ' +
  'e.created_by, ip.first_name AS created_by_first_name, ip.last_name AS created_by_last_name, ' +
  'e.created_at, e.updated_at ' +
  'FROM sch_calendar_events e ' +
  'LEFT JOIN sch_bell_schedules bs ON bs.id = e.bell_schedule_id ' +
  'LEFT JOIN platform.platform_users u ON u.id = e.created_by ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = u.person_id ';

@Injectable()
export class CalendarService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * List events overlapping the supplied date range. Non-admins always
   * receive only published events; admins can pass `includeDrafts=true` to
   * see unpublished work-in-progress.
   */
  async list(
    query: ListCalendarEventsQueryDto,
    actor: ResolvedActor,
  ): Promise<CalendarEventResponseDto[]> {
    var includeDrafts = actor.isSchoolAdmin && query.includeDrafts === true;
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<EventRow[]>(
        SELECT_EVENT_BASE +
          'WHERE ($1::boolean = true OR e.is_published = true) ' +
          'AND ($2::date IS NULL OR e.end_date >= $2::date) ' +
          'AND ($3::date IS NULL OR e.start_date <= $3::date) ' +
          'AND ($4::text IS NULL OR e.event_type = $4::text) ' +
          'ORDER BY e.start_date, e.start_time NULLS FIRST, e.created_at',
        includeDrafts,
        query.fromDate ?? null,
        query.toDate ?? null,
        query.eventType ?? null,
      );
    });
    return rows.map(rowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<CalendarEventResponseDto> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<EventRow[]>(SELECT_EVENT_BASE + 'WHERE e.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Calendar event ' + id + ' not found');
    var row = rows[0]!;
    if (!row.is_published && !actor.isSchoolAdmin) {
      throw new NotFoundException('Calendar event ' + id + ' not found');
    }
    return rowToDto(row);
  }

  async create(
    body: CreateCalendarEventDto,
    actor: ResolvedActor,
  ): Promise<CalendarEventResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can create calendar events');
    }
    var allDayInput = body.allDay !== false;
    this.assertTimeShape(allDayInput, body.startTime, body.endTime);
    if (new Date(body.endDate) < new Date(body.startDate)) {
      throw new BadRequestException('endDate must be on or after startDate');
    }
    var schoolId = getCurrentTenant().schoolId;
    var eventId = generateId();
    var allDay = allDayInput;
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO sch_calendar_events (id, school_id, title, description, event_type, start_date, end_date, all_day, start_time, end_time, bell_schedule_id, affects_attendance, is_published, created_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7::date, $8, $9::time, $10::time, $11::uuid, $12, $13, $14::uuid)',
        eventId,
        schoolId,
        body.title,
        body.description ?? null,
        body.eventType,
        body.startDate,
        body.endDate,
        allDay,
        allDay ? null : (body.startTime ?? null),
        allDay ? null : (body.endTime ?? null),
        body.bellScheduleId ?? null,
        body.affectsAttendance === true,
        body.isPublished === true,
        actor.accountId,
      );
    });
    return this.getById(eventId, actor);
  }

  async update(
    id: string,
    body: UpdateCalendarEventDto,
    actor: ResolvedActor,
  ): Promise<CalendarEventResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can update calendar events');
    }
    var existing = await this.getById(id, actor);
    var nextAllDay = body.allDay !== undefined ? body.allDay : existing.allDay;
    var nextStart = body.startTime !== undefined ? body.startTime : existing.startTime;
    var nextEnd = body.endTime !== undefined ? body.endTime : existing.endTime;
    this.assertTimeShape(nextAllDay, nextStart ?? undefined, nextEnd ?? undefined);

    var setClauses: string[] = [];
    var params: any[] = [];
    var idx = 1;
    if (body.title !== undefined) {
      setClauses.push('title = $' + idx);
      params.push(body.title);
      idx++;
    }
    if (body.description !== undefined) {
      setClauses.push('description = $' + idx);
      params.push(body.description);
      idx++;
    }
    if (body.eventType !== undefined) {
      setClauses.push('event_type = $' + idx);
      params.push(body.eventType);
      idx++;
    }
    if (body.startDate !== undefined) {
      setClauses.push('start_date = $' + idx + '::date');
      params.push(body.startDate);
      idx++;
    }
    if (body.endDate !== undefined) {
      setClauses.push('end_date = $' + idx + '::date');
      params.push(body.endDate);
      idx++;
    }
    if (body.allDay !== undefined) {
      setClauses.push('all_day = $' + idx);
      params.push(body.allDay);
      idx++;
      // When toggling to all_day, clear the times in the same UPDATE so the
      // time-consistency CHECK passes.
      if (body.allDay === true) {
        setClauses.push('start_time = NULL');
        setClauses.push('end_time = NULL');
      }
    }
    if (body.startTime !== undefined && body.allDay !== true) {
      setClauses.push('start_time = $' + idx + '::time');
      params.push(body.startTime);
      idx++;
    }
    if (body.endTime !== undefined && body.allDay !== true) {
      setClauses.push('end_time = $' + idx + '::time');
      params.push(body.endTime);
      idx++;
    }
    if (body.bellScheduleId !== undefined) {
      setClauses.push('bell_schedule_id = $' + idx + '::uuid');
      params.push(body.bellScheduleId);
      idx++;
    }
    if (body.affectsAttendance !== undefined) {
      setClauses.push('affects_attendance = $' + idx);
      params.push(body.affectsAttendance);
      idx++;
    }
    if (body.isPublished !== undefined) {
      setClauses.push('is_published = $' + idx);
      params.push(body.isPublished);
      idx++;
    }
    if (setClauses.length === 0) return existing;

    setClauses.push('updated_at = now()');
    params.push(id);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE sch_calendar_events SET ' +
          setClauses.join(', ') +
          ' WHERE id = $' +
          idx +
          '::uuid',
        ...params,
      );
    });
    return this.getById(id, actor);
  }

  async delete(id: string, actor: ResolvedActor): Promise<{ deleted: boolean }> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can delete calendar events');
    }
    await this.getById(id, actor);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe('DELETE FROM sch_calendar_events WHERE id = $1::uuid', id);
    });
    return { deleted: true };
  }

  /**
   * Resolve the effective bell schedule for a specific date. Resolution
   * order matches the schema's COMMENT documentation:
   *   1) sch_calendar_day_overrides for (school, date) — wins outright.
   *      If is_school_day=false, no schedule applies (closure).
   *   2) sch_calendar_events whose date range covers the date AND that
   *      carries a bell_schedule_id — first matching wins.
   *   3) The school's default sch_bell_schedule (is_default=true).
   *   4) Nothing — `resolvedFrom='NONE'`, `bellScheduleId=null`.
   */
  async resolveDay(date: string): Promise<CalendarDayResolutionDto> {
    var schoolId = getCurrentTenant().schoolId;
    var resolution = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var override = (await client.$queryRawUnsafe(
        'SELECT o.id, o.bell_schedule_id, bs.name AS bell_schedule_name, o.is_school_day, o.reason ' +
          'FROM sch_calendar_day_overrides o ' +
          'LEFT JOIN sch_bell_schedules bs ON bs.id = o.bell_schedule_id ' +
          'WHERE o.school_id = $1::uuid AND o.override_date = $2::date',
        schoolId,
        date,
      )) as Array<{
        id: string;
        bell_schedule_id: string | null;
        bell_schedule_name: string | null;
        is_school_day: boolean;
        reason: string | null;
      }>;

      var events = (await client.$queryRawUnsafe(
        'SELECT e.id, e.bell_schedule_id, bs.name AS bell_schedule_name ' +
          'FROM sch_calendar_events e ' +
          'LEFT JOIN sch_bell_schedules bs ON bs.id = e.bell_schedule_id ' +
          'WHERE e.school_id = $1::uuid AND e.is_published = true ' +
          'AND e.start_date <= $2::date AND e.end_date >= $2::date ' +
          'ORDER BY e.bell_schedule_id NULLS LAST, e.created_at',
        schoolId,
        date,
      )) as Array<{
        id: string;
        bell_schedule_id: string | null;
        bell_schedule_name: string | null;
      }>;

      var defaultSchedule = (await client.$queryRawUnsafe(
        'SELECT id, name FROM sch_bell_schedules WHERE school_id = $1::uuid AND is_default = true LIMIT 1',
        schoolId,
      )) as Array<{ id: string; name: string }>;

      return { override: override, events: events, defaultSchedule: defaultSchedule };
    });

    var eventIds = resolution.events.map(function (e) {
      return e.id;
    });

    if (resolution.override.length > 0) {
      var o = resolution.override[0]!;
      return {
        date: date,
        resolvedFrom: 'OVERRIDE',
        isSchoolDay: o.is_school_day,
        bellScheduleId: o.bell_schedule_id,
        bellScheduleName: o.bell_schedule_name,
        overrideId: o.id,
        overrideReason: o.reason,
        eventIds: eventIds,
      };
    }
    var firstEventWithSchedule = resolution.events.filter(function (e) {
      return e.bell_schedule_id !== null;
    })[0];
    if (firstEventWithSchedule) {
      return {
        date: date,
        resolvedFrom: 'EVENT',
        isSchoolDay: true,
        bellScheduleId: firstEventWithSchedule.bell_schedule_id,
        bellScheduleName: firstEventWithSchedule.bell_schedule_name,
        overrideId: null,
        overrideReason: null,
        eventIds: eventIds,
      };
    }
    if (resolution.defaultSchedule.length > 0) {
      var d = resolution.defaultSchedule[0]!;
      return {
        date: date,
        resolvedFrom: 'DEFAULT',
        isSchoolDay: true,
        bellScheduleId: d.id,
        bellScheduleName: d.name,
        overrideId: null,
        overrideReason: null,
        eventIds: eventIds,
      };
    }
    return {
      date: date,
      resolvedFrom: 'NONE',
      isSchoolDay: true,
      bellScheduleId: null,
      bellScheduleName: null,
      overrideId: null,
      overrideReason: null,
      eventIds: eventIds,
    };
  }

  private assertTimeShape(allDay: boolean, startTime?: string, endTime?: string): void {
    if (allDay) {
      if (startTime || endTime) {
        throw new BadRequestException('all-day events must not carry startTime / endTime');
      }
      return;
    }
    if (!startTime || !endTime) {
      throw new BadRequestException('non-all-day events require startTime and endTime');
    }
    if (startTime >= endTime) {
      throw new BadRequestException('startTime must be strictly before endTime');
    }
  }
}
