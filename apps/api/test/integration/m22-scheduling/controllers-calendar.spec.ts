import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { BellScheduleController } from '@modules/m22-scheduling/bell-schedule.controller';
import { CalendarController } from '@modules/m22-scheduling/calendar.controller';
import {
  SubjectChoiceController,
  SubjectChoiceWindowController,
} from '@modules/m22-scheduling/subject-choice.controller';
import { BellScheduleService } from '@modules/m22-scheduling/bell-schedule.service';
import { CalendarService } from '@modules/m22-scheduling/calendar.service';
import { CalendarRsvpService } from '@modules/m22-scheduling/calendar-rsvp.service';
import { DayOverrideService } from '@modules/m22-scheduling/day-override.service';
import { SubjectChoiceService } from '@modules/m22-scheduling/subject-choice.service';
import { StudentService } from '@modules/m20-sis/students/student.service';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { TEST_SIS_ACADEMIC_YEAR_ID } from '../fixtures/sis';

/**
 * Controller-layer integration tests for m22-scheduling — calendar,
 * bell-schedule, and subject-choice controllers. Each controller is
 * constructed with the real service tree and invoked with a synthetic
 * AuthedRequest carrying the test admin's identity. The IAM cache is
 * seeded so ActorContextService.resolveActor returns isSchoolAdmin=true.
 *
 * Purpose: lifts the m22 controller code from 0% to ≥80% to bring the
 * module's combined coverage to the 80% target.
 */
describe('integration:m22-scheduling/controllers-calendar', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let actorContext: ActorContextService;

  let bellService: BellScheduleService;
  let calendarService: CalendarService;
  let rsvpService: CalendarRsvpService;
  let dayOverrideService: DayOverrideService;
  let subjectChoiceService: SubjectChoiceService;
  let studentService: StudentService;

  let bellController: BellScheduleController;
  let calendarController: CalendarController;
  let subjectChoiceController: SubjectChoiceController;
  let subjectChoiceWindowController: SubjectChoiceWindowController;

  function fakeAdminReq(): any {
    return {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
        email: 'admin@test.integration.local',
        displayName: 'Integration Admin',
        sessionId: 'test-session',
      },
    };
  }

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    actorContext = new ActorContextService(rawClient, permCheck, tenantPrisma);

    bellService = new BellScheduleService(tenantPrisma);
    calendarService = new CalendarService(tenantPrisma);
    rsvpService = new CalendarRsvpService(tenantPrisma);
    dayOverrideService = new DayOverrideService(tenantPrisma);
    subjectChoiceService = new SubjectChoiceService(tenantPrisma, permCheck);
    studentService = new StudentService(tenantPrisma);

    bellController = new BellScheduleController(bellService, actorContext);
    calendarController = new CalendarController(
      calendarService,
      rsvpService,
      dayOverrideService,
      actorContext,
      studentService,
    );
    subjectChoiceController = new SubjectChoiceController(
      subjectChoiceService,
      actorContext,
    );
    subjectChoiceWindowController = new SubjectChoiceWindowController(
      subjectChoiceService,
      actorContext,
    );

    // Seed admin permission cache so resolveActor returns isSchoolAdmin=true.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, ARRAY['sch-001:admin','sch-001:write','sch-001:read','sch-002:admin','sch-002:write','sch-002:read','sch-003:admin','sch-003:write','sch-003:read']::text[], now(), 'test')
       ON CONFLICT (account_id, scope_id) DO UPDATE SET permission_codes = EXCLUDED.permission_codes`,
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
    );

    // Clean any leftover rows from prior test runs.
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
      `DELETE FROM ${TEST_SCHEMA}.sch_student_subject_choices`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_subject_choice_windows WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_periods WHERE bell_schedule_id IN (SELECT id FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE name LIKE 'Ctrl Cal%' OR name LIKE 'Ctrl Bell%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE name LIKE 'Ctrl Cal%' OR name LIKE 'Ctrl Bell%'`,
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
      `DELETE FROM ${TEST_SCHEMA}.sch_student_subject_choices`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_subject_choice_windows WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_periods WHERE bell_schedule_id IN (SELECT id FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE name LIKE 'Ctrl Cal%' OR name LIKE 'Ctrl Bell%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE name LIKE 'Ctrl Cal%' OR name LIKE 'Ctrl Bell%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid AND scope_id = $2::uuid`,
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Wipe per-test rows but keep the IAM cache seed.
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
      `DELETE FROM ${TEST_SCHEMA}.sch_student_subject_choices`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_subject_choice_windows WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_periods WHERE bell_schedule_id IN (SELECT id FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE name LIKE 'Ctrl Cal%' OR name LIKE 'Ctrl Bell%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE name LIKE 'Ctrl Cal%' OR name LIKE 'Ctrl Bell%'`,
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // BellScheduleController
  // ──────────────────────────────────────────────────────────────────
  describe('BellScheduleController', () => {
    it('create + list + getById', async () => {
      const created = await withTestTenant(async () =>
        bellController.create(
          { name: 'Ctrl Bell A', scheduleType: 'STANDARD' } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.name).toBe('Ctrl Bell A');

      const list = await withTestTenant(async () => bellController.list());
      expect(list.map((b) => b.id)).toContain(created.id);

      const detail = await withTestTenant(async () => bellController.getById(created.id));
      expect(detail.id).toBe(created.id);
    });

    it('update + setDefault + upsertPeriods', async () => {
      const created = await withTestTenant(async () =>
        bellController.create(
          { name: 'Ctrl Bell U', scheduleType: 'STANDARD' } as any,
          fakeAdminReq(),
        ),
      );
      const updated = await withTestTenant(async () =>
        bellController.update(
          created.id,
          { name: 'Ctrl Bell U Renamed' } as any,
          fakeAdminReq(),
        ),
      );
      expect(updated.name).toBe('Ctrl Bell U Renamed');

      const withDefault = await withTestTenant(async () =>
        bellController.setDefault(created.id, fakeAdminReq()),
      );
      expect(withDefault.isDefault).toBe(true);

      const withPeriods = await withTestTenant(async () =>
        bellController.upsertPeriods(
          created.id,
          {
            periods: [
              {
                name: 'P1',
                dayOfWeek: 0,
                startTime: '08:00',
                endTime: '09:00',
                periodType: 'LESSON',
                sortOrder: 1,
              },
              {
                name: 'P2',
                dayOfWeek: 0,
                startTime: '09:05',
                endTime: '10:05',
                periodType: 'LESSON',
                sortOrder: 2,
              },
            ],
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(withPeriods.periods.length).toBe(2);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // CalendarController
  // ──────────────────────────────────────────────────────────────────
  describe('CalendarController', () => {
    let defaultBellId: string;

    beforeEach(async () => {
      // Seed a default bell schedule for the resolveDay code path.
      defaultBellId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sch_bell_schedules
           (id, school_id, name, schedule_type, is_default)
         VALUES ($1::uuid, $2::uuid, $3, 'STANDARD', true)`,
        defaultBellId,
        TEST_SCHOOL_ID,
        'Ctrl Cal Default ' + Math.random().toString(36).slice(2, 6),
      );
    });

    it('create + list + getById + update + delete event', async () => {
      const created = await withTestTenant(async () =>
        calendarController.create(
          {
            title: 'Ctrl Event',
            eventType: 'ASSEMBLY',
            startDate: '2027-10-01',
            endDate: '2027-10-01',
            allDay: false,
            startTime: '09:00',
            endTime: '10:00',
            isPublished: true,
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.title).toBe('Ctrl Event');

      const list = await withTestTenant(async () =>
        calendarController.list({ fromDate: '2027-09-01', toDate: '2027-12-01' } as any, fakeAdminReq()),
      );
      expect(list.map((e) => e.id)).toContain(created.id);

      const detail = await withTestTenant(async () =>
        calendarController.getById(created.id, fakeAdminReq()),
      );
      expect(detail.id).toBe(created.id);

      const updated = await withTestTenant(async () =>
        calendarController.update(
          created.id,
          { title: 'Renamed' } as any,
          fakeAdminReq(),
        ),
      );
      expect(updated.title).toBe('Renamed');

      const deleted = await withTestTenant(async () =>
        calendarController.delete(created.id, fakeAdminReq()),
      );
      expect(deleted.deleted).toBe(true);
    });

    it('list with myKidsOnly=true falls through to non-guardian path for admin', async () => {
      // Admin's personType is STAFF, not GUARDIAN, so myKidsOnly is a no-op.
      const list = await withTestTenant(async () =>
        calendarController.list({ myKidsOnly: true } as any, fakeAdminReq()),
      );
      expect(Array.isArray(list)).toBe(true);
    });

    it('createOverride + listOverrides + deleteOverride', async () => {
      const created = await withTestTenant(async () =>
        calendarController.createOverride(
          {
            overrideDate: '2027-11-15',
            bellScheduleId: defaultBellId,
            note: 'Half day',
            isNonAttendance: false,
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.overrideDate).toBe('2027-11-15');

      const list = await withTestTenant(async () =>
        calendarController.listOverrides({ fromDate: '2027-11-01', toDate: '2027-11-30' } as any),
      );
      expect(list.length).toBeGreaterThanOrEqual(1);

      const deleted = await withTestTenant(async () =>
        calendarController.deleteOverride('2027-11-15', fakeAdminReq()),
      );
      expect(deleted.deleted).toBe(true);
    });

    it('resolveDay returns CalendarDayResolutionDto', async () => {
      const day = await withTestTenant(async () =>
        calendarController.resolveDay('2027-10-15'),
      );
      // The default bell schedule should resolve.
      expect(day).toBeTruthy();
    });

    it('rsvp lifecycle: setRsvp + listRsvps + rsvpSummary', async () => {
      const event = await withTestTenant(async () =>
        calendarController.create(
          {
            title: 'RSVP Event',
            eventType: 'ASSEMBLY',
            startDate: '2027-10-05',
            endDate: '2027-10-05',
            allDay: true,
            isPublished: true,
            rsvpEnabled: true,
          } as any,
          fakeAdminReq(),
        ),
      );

      const rsvp = await withTestTenant(async () =>
        calendarController.setRsvp(event.id, { response: 'GOING' } as any, fakeAdminReq()),
      );
      expect(rsvp.response).toBe('GOING');

      const rsvps = await withTestTenant(async () =>
        calendarController.listRsvps(event.id, fakeAdminReq()),
      );
      expect(rsvps.length).toBeGreaterThanOrEqual(1);

      const summary = await withTestTenant(async () =>
        calendarController.rsvpSummary(event.id, fakeAdminReq()),
      );
      expect(summary).toBeTruthy();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // SubjectChoiceController + SubjectChoiceWindowController
  // ──────────────────────────────────────────────────────────────────
  describe('SubjectChoice controllers', () => {
    it('createWindow + listWindows', async () => {
      const created = await withTestTenant(async () =>
        subjectChoiceWindowController.create(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            opensAt: '2027-01-01T00:00:00.000Z',
            closesAt: '2027-03-01T00:00:00.000Z',
            isPublished: true,
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.academicYearId).toBe(TEST_SIS_ACADEMIC_YEAR_ID);

      const list = await withTestTenant(async () =>
        subjectChoiceWindowController.list(),
      );
      expect(list.map((w) => w.id)).toContain(created.id);
    });

    it('subjectChoiceController.list (admin sees all)', async () => {
      const list = await withTestTenant(async () =>
        subjectChoiceController.list(
          fakeAdminReq(),
          undefined,
          TEST_SIS_ACADEMIC_YEAR_ID,
          undefined,
        ),
      );
      expect(Array.isArray(list)).toBe(true);
    });

    it('subjectChoiceController.demand (admin only)', async () => {
      const rows = await withTestTenant(async () =>
        subjectChoiceController.demand(TEST_SIS_ACADEMIC_YEAR_ID, fakeAdminReq()),
      );
      expect(Array.isArray(rows)).toBe(true);
    });
  });
});
