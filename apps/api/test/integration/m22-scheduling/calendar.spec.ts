import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { CalendarService } from '@modules/m22-scheduling/calendar.service';
import { CalendarRsvpService } from '@modules/m22-scheduling/calendar-rsvp.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  TEST_ADMIN_PERSON_ID,
  TEST_TEACHER_PERSON_ID,
} from '../helpers/actor';

/**
 * m22-scheduling calendar + RSVPs integration tests. Covers:
 *   - CalendarService (403 lines)
 *   - CalendarRsvpService (189 lines)
 */
describe('integration:m22-scheduling/calendar', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let calendarService: CalendarService;
  let rsvpService: CalendarRsvpService;

  // Stable infrastructure
  let bellScheduleId: string;
  let bellScheduleBId: string;

  const eventIds: string[] = [];
  const overrideIds: string[] = [];
  const rsvpIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    calendarService = new CalendarService(tenantPrisma);
    rsvpService = new CalendarRsvpService(tenantPrisma);

    // Wipe leftovers from prior runs.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_calendar_event_rsvps WHERE calendar_event_id IN (SELECT id FROM ${TEST_SCHEMA}.sch_calendar_events WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_calendar_events WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_calendar_day_overrides WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE name LIKE 'Cal Test%' AND school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );

    bellScheduleId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_bell_schedules
         (id, school_id, name, schedule_type, is_default)
       VALUES ($1::uuid, $2::uuid, $3, 'STANDARD', true)`,
      bellScheduleId,
      TEST_SCHOOL_ID,
      'Cal Test Default ' + Math.random().toString(36).slice(2, 6),
    );

    bellScheduleBId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_bell_schedules
         (id, school_id, name, schedule_type, is_default)
       VALUES ($1::uuid, $2::uuid, $3, 'STANDARD', true)`,
      bellScheduleBId,
      TEST_SCHOOL_B_ID,
      'Cal Test Default B ' + Math.random().toString(36).slice(2, 6),
    );
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_calendar_event_rsvps WHERE calendar_event_id IN (SELECT id FROM ${TEST_SCHEMA}.sch_calendar_events WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_calendar_events WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_calendar_day_overrides WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE id IN ($1::uuid, $2::uuid)`,
      bellScheduleId,
      bellScheduleBId,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_calendar_event_rsvps WHERE calendar_event_id IN (SELECT id FROM ${TEST_SCHEMA}.sch_calendar_events WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_calendar_events WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_calendar_day_overrides WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    eventIds.length = 0;
    overrideIds.length = 0;
    rsvpIds.length = 0;
  });

  // ────────────────────────────────────────────────────────────────────
  // CalendarService.create / update / delete
  // ────────────────────────────────────────────────────────────────────
  describe('create', () => {
    it('admin creates an all-day published event', async () => {
      const dto = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'Holiday',
            eventType: 'HOLIDAY',
            startDate: '2027-12-25',
            endDate: '2027-12-25',
            allDay: true,
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(dto.id);
      expect(dto.title).toBe('Holiday');
      expect(dto.allDay).toBe(true);
      expect(dto.startTime).toBeNull();
      expect(dto.endTime).toBeNull();
      expect(dto.isPublished).toBe(true);
    });

    it('admin creates a timed event', async () => {
      const dto = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'Assembly',
            eventType: 'ASSEMBLY',
            startDate: '2027-09-15',
            endDate: '2027-09-15',
            allDay: false,
            startTime: '09:00',
            endTime: '10:30',
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(dto.id);
      expect(dto.allDay).toBe(false);
      expect(dto.startTime).toBe('09:00');
      expect(dto.endTime).toBe('10:30');
    });

    it('non-admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          calendarService.create(
            {
              title: 'x',
              eventType: 'CUSTOM',
              startDate: '2027-05-01',
              endDate: '2027-05-01',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('endDate before startDate → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          calendarService.create(
            {
              title: 'bad',
              eventType: 'CUSTOM',
              startDate: '2027-05-10',
              endDate: '2027-05-01',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('all-day with startTime → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          calendarService.create(
            {
              title: 'bad',
              eventType: 'CUSTOM',
              startDate: '2027-05-01',
              endDate: '2027-05-01',
              allDay: true,
              startTime: '09:00',
              endTime: '10:00',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-all-day without endTime → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          calendarService.create(
            {
              title: 'bad',
              eventType: 'CUSTOM',
              startDate: '2027-05-01',
              endDate: '2027-05-01',
              allDay: false,
              startTime: '09:00',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-all-day with startTime >= endTime → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          calendarService.create(
            {
              title: 'bad',
              eventType: 'CUSTOM',
              startDate: '2027-05-01',
              endDate: '2027-05-01',
              allDay: false,
              startTime: '11:00',
              endTime: '10:00',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('update / delete', () => {
    it('admin patches title and isPublished', async () => {
      const dto = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'Draft',
            eventType: 'CUSTOM',
            startDate: '2027-09-01',
            endDate: '2027-09-01',
            isPublished: false,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(dto.id);
      const upd = await withTestTenant(async () =>
        calendarService.update(
          dto.id,
          { title: 'Published', isPublished: true } as any,
          adminActor(),
        ),
      );
      expect(upd.title).toBe('Published');
      expect(upd.isPublished).toBe(true);
    });

    it('update toggling allDay=true clears times', async () => {
      const dto = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'Timed',
            eventType: 'CUSTOM',
            startDate: '2027-09-15',
            endDate: '2027-09-15',
            allDay: false,
            startTime: '09:00',
            endTime: '10:00',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(dto.id);
      const upd = await withTestTenant(async () =>
        calendarService.update(dto.id, { allDay: true } as any, adminActor()),
      );
      expect(upd.allDay).toBe(true);
      expect(upd.startTime).toBeNull();
      expect(upd.endTime).toBeNull();
    });

    it('update with no fields returns existing', async () => {
      const dto = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'Noop',
            eventType: 'CUSTOM',
            startDate: '2027-09-01',
            endDate: '2027-09-01',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(dto.id);
      const noop = await withTestTenant(async () =>
        calendarService.update(dto.id, {} as any, adminActor()),
      );
      expect(noop.id).toBe(dto.id);
    });

    it('non-admin update → ForbiddenException', async () => {
      const dto = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'x',
            eventType: 'CUSTOM',
            startDate: '2027-09-01',
            endDate: '2027-09-01',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(dto.id);
      await expect(
        withTestTenant(async () =>
          calendarService.update(dto.id, { title: 'Y' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('update unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          calendarService.update(
            '00000000-0000-0000-0000-000000000000',
            { title: 'X' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('admin deletes a calendar event', async () => {
      const dto = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'To delete',
            eventType: 'CUSTOM',
            startDate: '2027-09-01',
            endDate: '2027-09-01',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      const res = await withTestTenant(async () =>
        calendarService.delete(dto.id, adminActor()),
      );
      expect(res.deleted).toBe(true);
      await expect(
        withTestTenant(async () => calendarService.getById(dto.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin delete → ForbiddenException', async () => {
      const dto = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'x',
            eventType: 'CUSTOM',
            startDate: '2027-09-01',
            endDate: '2027-09-01',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(dto.id);
      await expect(
        withTestTenant(async () => calendarService.delete(dto.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('getById visibility', () => {
    it('non-admin cannot see draft (404)', async () => {
      const dto = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'Draft',
            eventType: 'CUSTOM',
            startDate: '2027-09-01',
            endDate: '2027-09-01',
            isPublished: false,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(dto.id);
      await expect(
        withTestTenant(async () => calendarService.getById(dto.id, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('admin sees draft', async () => {
      const dto = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'Draft',
            eventType: 'CUSTOM',
            startDate: '2027-09-01',
            endDate: '2027-09-01',
            isPublished: false,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(dto.id);
      const got = await withTestTenant(async () =>
        calendarService.getById(dto.id, adminActor()),
      );
      expect(got.id).toBe(dto.id);
    });
  });

  describe('list filters', () => {
    it('admin includeDrafts=true sees published + draft', async () => {
      const pub = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'Pub',
            eventType: 'CUSTOM',
            startDate: '2027-09-01',
            endDate: '2027-09-01',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(pub.id);
      const dr = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'Dr',
            eventType: 'CUSTOM',
            startDate: '2027-09-02',
            endDate: '2027-09-02',
            isPublished: false,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(dr.id);
      const list = await withTestTenant(async () =>
        calendarService.list({ includeDrafts: true } as any, adminActor()),
      );
      const ids = list.map((r) => r.id);
      expect(ids).toContain(pub.id);
      expect(ids).toContain(dr.id);
    });

    it('non-admin only sees published', async () => {
      const pub = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'Pub2',
            eventType: 'CUSTOM',
            startDate: '2027-09-01',
            endDate: '2027-09-01',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(pub.id);
      const dr = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'Dr2',
            eventType: 'CUSTOM',
            startDate: '2027-09-02',
            endDate: '2027-09-02',
            isPublished: false,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(dr.id);
      const list = await withTestTenant(async () =>
        calendarService.list({} as any, teacherActor()),
      );
      const ids = list.map((r) => r.id);
      expect(ids).toContain(pub.id);
      expect(ids).not.toContain(dr.id);
    });

    it('list filters by eventType', async () => {
      const holiday = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'Holiday',
            eventType: 'HOLIDAY',
            startDate: '2027-09-01',
            endDate: '2027-09-01',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(holiday.id);
      const custom = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'Custom',
            eventType: 'CUSTOM',
            startDate: '2027-09-02',
            endDate: '2027-09-02',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(custom.id);
      const list = await withTestTenant(async () =>
        calendarService.list({ eventType: 'HOLIDAY' } as any, adminActor()),
      );
      const ids = list.map((r) => r.id);
      expect(ids).toContain(holiday.id);
      expect(ids).not.toContain(custom.id);
    });

    it('list filters by date range', async () => {
      const early = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'Early',
            eventType: 'CUSTOM',
            startDate: '2027-01-01',
            endDate: '2027-01-01',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(early.id);
      const mid = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'Mid',
            eventType: 'CUSTOM',
            startDate: '2027-06-15',
            endDate: '2027-06-15',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(mid.id);
      const list = await withTestTenant(async () =>
        calendarService.list(
          { fromDate: '2027-06-01', toDate: '2027-06-30' } as any,
          adminActor(),
        ),
      );
      const ids = list.map((r) => r.id);
      expect(ids).toContain(mid.id);
      expect(ids).not.toContain(early.id);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // CalendarService.resolveDay
  // ────────────────────────────────────────────────────────────────────
  describe('resolveDay', () => {
    it('returns DEFAULT when no override or event applies', async () => {
      const resolution = await withTestTenant(async () =>
        calendarService.resolveDay('2030-04-15'),
      );
      expect(resolution.resolvedFrom).toBe('DEFAULT');
      expect(resolution.isSchoolDay).toBe(true);
      expect(resolution.bellScheduleId).toBe(bellScheduleId);
    });

    it('returns OVERRIDE when a day override exists', async () => {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sch_calendar_day_overrides
           (id, school_id, override_date, bell_schedule_id, is_school_day, reason)
         VALUES ($1::uuid, $2::uuid, '2030-04-16'::date, NULL, false, 'snow')`,
        generateId(),
        TEST_SCHOOL_ID,
      );
      const resolution = await withTestTenant(async () =>
        calendarService.resolveDay('2030-04-16'),
      );
      expect(resolution.resolvedFrom).toBe('OVERRIDE');
      expect(resolution.isSchoolDay).toBe(false);
      expect(resolution.overrideReason).toBe('snow');
    });

    it('returns EVENT when a published event with a bell schedule covers the date', async () => {
      const ev = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'Exam day',
            eventType: 'EXAM_PERIOD',
            startDate: '2030-05-01',
            endDate: '2030-05-05',
            bellScheduleId: bellScheduleId,
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(ev.id);
      const resolution = await withTestTenant(async () =>
        calendarService.resolveDay('2030-05-03'),
      );
      expect(resolution.resolvedFrom).toBe('EVENT');
      expect(resolution.bellScheduleId).toBe(bellScheduleId);
      expect(resolution.eventIds).toContain(ev.id);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // CalendarRsvpService
  // ────────────────────────────────────────────────────────────────────
  describe('CalendarRsvpService', () => {
    it('admin sets a GOING response', async () => {
      const ev = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'Open House',
            eventType: 'PARENT_EVENT',
            startDate: '2027-09-15',
            endDate: '2027-09-15',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(ev.id);
      const rsvp = await withTestTenant(async () =>
        rsvpService.setResponse(ev.id, 'GOING', adminActor()),
      );
      rsvpIds.push(rsvp.id);
      expect(rsvp.response).toBe('GOING');
      expect(rsvp.personId).toBe(TEST_ADMIN_PERSON_ID);
    });

    it('upserts on second call (changes response)', async () => {
      const ev = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'Open House 2',
            eventType: 'PARENT_EVENT',
            startDate: '2027-09-16',
            endDate: '2027-09-16',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(ev.id);
      await withTestTenant(async () =>
        rsvpService.setResponse(ev.id, 'TENTATIVE', adminActor()),
      );
      const updated = await withTestTenant(async () =>
        rsvpService.setResponse(ev.id, 'NOT_GOING', adminActor()),
      );
      expect(updated.response).toBe('NOT_GOING');
    });

    it('non-admin cannot RSVP to draft (404)', async () => {
      const ev = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'Draft event',
            eventType: 'CUSTOM',
            startDate: '2027-09-15',
            endDate: '2027-09-15',
            isPublished: false,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(ev.id);
      await expect(
        withTestTenant(async () =>
          rsvpService.setResponse(ev.id, 'GOING', teacherActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('unknown event → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          rsvpService.setResponse(
            '00000000-0000-0000-0000-000000000000',
            'GOING',
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('admin list returns every RSVP for the event', async () => {
      const ev = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'Event',
            eventType: 'PARENT_EVENT',
            startDate: '2027-09-15',
            endDate: '2027-09-15',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(ev.id);
      await withTestTenant(async () =>
        rsvpService.setResponse(ev.id, 'GOING', adminActor()),
      );
      await withTestTenant(async () =>
        rsvpService.setResponse(ev.id, 'TENTATIVE', teacherActor()),
      );
      const list = await withTestTenant(async () => rsvpService.list(ev.id, adminActor()));
      expect(list.length).toBe(2);
    });

    it('non-admin list only returns own response', async () => {
      const ev = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'Event',
            eventType: 'PARENT_EVENT',
            startDate: '2027-09-15',
            endDate: '2027-09-15',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(ev.id);
      await withTestTenant(async () =>
        rsvpService.setResponse(ev.id, 'GOING', adminActor()),
      );
      await withTestTenant(async () =>
        rsvpService.setResponse(ev.id, 'TENTATIVE', teacherActor()),
      );
      const list = await withTestTenant(async () =>
        rsvpService.list(ev.id, teacherActor()),
      );
      expect(list.length).toBe(1);
      expect(list[0]!.personId).toBe(TEST_TEACHER_PERSON_ID);
    });

    it('summary aggregates counts and reports my response', async () => {
      const ev = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'Big Event',
            eventType: 'PARENT_EVENT',
            startDate: '2027-09-15',
            endDate: '2027-09-15',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(ev.id);
      await withTestTenant(async () =>
        rsvpService.setResponse(ev.id, 'GOING', adminActor()),
      );
      await withTestTenant(async () =>
        rsvpService.setResponse(ev.id, 'TENTATIVE', teacherActor()),
      );
      const summary = await withTestTenant(async () =>
        rsvpService.summary(ev.id, adminActor()),
      );
      expect(summary.going).toBe(1);
      expect(summary.tentative).toBe(1);
      expect(summary.notGoing).toBe(0);
      expect(summary.myResponse).toBe('GOING');
    });

    it('summary on unknown event → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          rsvpService.summary('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('eventIdsForPersons returns event ids where the listed persons RSVPd', async () => {
      const ev = await withTestTenant(async () =>
        calendarService.create(
          {
            title: 'Event',
            eventType: 'PARENT_EVENT',
            startDate: '2027-09-15',
            endDate: '2027-09-15',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      eventIds.push(ev.id);
      await withTestTenant(async () =>
        rsvpService.setResponse(ev.id, 'GOING', teacherActor()),
      );
      const result = await withTestTenant(async () =>
        rsvpService.eventIdsForPersons([TEST_TEACHER_PERSON_ID]),
      );
      expect(result).toContain(ev.id);
    });

    it('eventIdsForPersons returns [] for empty input', async () => {
      const result = await withTestTenant(async () => rsvpService.eventIdsForPersons([]));
      expect(result).toEqual([]);
    });
  });
});
