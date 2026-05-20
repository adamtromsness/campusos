import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ConferenceEventService } from '@modules/m100-engagement/conference-event.service';
import { ConferenceSlotService } from '@modules/m100-engagement/conference-slot.service';
import { ConferenceBookingService } from '@modules/m100-engagement/conference-booking.service';
import { ConferenceStatusWorker } from '@modules/m100-engagement/conference-status.worker';
import { deterministicConferenceBookingOpenEventId } from '@modules/m100-engagement/event-ids';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_SUBDOMAIN,
} from '../helpers/tenant-context';
import {
  adminActor,
  studentActor,
  parentActor,
  teacherActor,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_TEACHER_EMPLOYEE_ID,
  TEST_PARENT_PERSON_ID,
  TEST_PARENT_ACCOUNT_ID,
  TEST_ADMIN_ACCOUNT_ID,
} from '../helpers/actor';
import { resetEngagementTables } from '../fixtures/engagement';
import {
  seedStudent,
  seedGuardian,
  linkStudentGuardian,
  ensureGuardianForPerson,
  cleanupSeededIds,
} from '../m20-sis/sis-helpers';

/**
 * Wave 7 — m100-engagement conferences suite.
 *
 * Exercises ConferenceEventService (DRAFT→BOOKING_OPEN→IN_PROGRESS→COMPLETED
 * state machine + parent DRAFT visibility filter), ConferenceSlotService
 * (school-scope teacher_id validation, idempotent slot generation, BOOKED
 * status guard), ConferenceBookingService (ATOMIC slot booking keystone,
 * cross-school isolation, guardian-link enforcement, cancel decrement),
 * and ConferenceStatusWorker (DRAFT→BOOKING_OPEN flip + outbox enqueue).
 */
describe('integration:m100-engagement/conferences', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let events: ConferenceEventService;
  let slots: ConferenceSlotService;
  let bookings: ConferenceBookingService;
  let outbox: OutboxService;
  let statusWorker: ConferenceStatusWorker;

  const studentIds: string[] = [];
  const platformStudentIds: string[] = [];
  const guardianIds: string[] = [];
  const personIds: string[] = [];
  const accountIds: string[] = [];
  const familyAccountIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    outbox = new OutboxService();
    events = new ConferenceEventService(tenantPrisma, permCheck);
    slots = new ConferenceSlotService(tenantPrisma, permCheck);
    bookings = new ConferenceBookingService(tenantPrisma, permCheck);
    statusWorker = new ConferenceStatusWorker(tenantPrisma, outbox);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetEngagementTables(rawClient, {
      familyAccountIds: familyAccountIds.splice(0),
    });
    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
    });
  });

  function isoFuture(hours: number): string {
    return new Date(Date.now() + hours * 3600_000).toISOString();
  }

  function isoPast(hours: number): string {
    return new Date(Date.now() - hours * 3600_000).toISOString();
  }

  function dateFuture(days: number): string {
    return new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
  }

  /**
   * Create a conference event with the given status — used by tests that
   * need an event in a non-default status without driving it through
   * the patch state machine. Inserts directly to avoid the DRAFT-only
   * create + transition dance.
   */
  async function seedEventDirect(opts: {
    schoolId?: string;
    status?: 'DRAFT' | 'BOOKING_OPEN' | 'IN_PROGRESS' | 'COMPLETED';
    bookingOpensAt?: string;
    bookingClosesAt?: string;
    startDate?: string;
    endDate?: string;
    title?: string;
  } = {}): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.eng_conference_events
         (id, school_id, title, start_date, end_date, booking_opens_at, booking_closes_at,
          default_slot_duration_minutes, default_break_minutes, status, created_by)
       VALUES ($1::uuid, $2::uuid, $3, $4::date, $5::date, $6::timestamptz, $7::timestamptz,
               10, 5, $8, $9::uuid)`,
      id,
      opts.schoolId ?? TEST_SCHOOL_ID,
      opts.title ?? 'PTC Fall',
      opts.startDate ?? dateFuture(7),
      opts.endDate ?? dateFuture(8),
      opts.bookingOpensAt ?? isoPast(2),
      opts.bookingClosesAt ?? isoFuture(48),
      opts.status ?? 'BOOKING_OPEN',
      TEST_ADMIN_ACCOUNT_ID,
    );
    return id;
  }

  async function seedSlotDirect(eventId: string, opts: {
    teacherId?: string;
    schoolId?: string;
    slotDate?: string;
    startTime?: string;
    endTime?: string;
    status?: 'AVAILABLE' | 'BOOKED' | 'BLOCKED';
    maxBookings?: number;
    currentBookings?: number;
  } = {}): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.eng_conference_slots
         (id, conference_event_id, school_id, teacher_id, slot_date, start_time, end_time,
          status, max_bookings, current_bookings)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::time, $7::time,
               $8, $9, $10)`,
      id,
      eventId,
      opts.schoolId ?? TEST_SCHOOL_ID,
      opts.teacherId ?? TEST_TEACHER_EMPLOYEE_ID,
      opts.slotDate ?? dateFuture(7),
      opts.startTime ?? '09:00',
      opts.endTime ?? '09:10',
      opts.status ?? 'AVAILABLE',
      opts.maxBookings ?? 1,
      opts.currentBookings ?? 0,
    );
    return id;
  }

  async function seedFamilyAccount(opts?: { schoolId?: string; holderId?: string }): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pay_family_accounts (id, school_id, account_holder_id, account_number, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ACTIVE')`,
      id,
      opts?.schoolId ?? TEST_SCHOOL_ID,
      opts?.holderId ?? TEST_PARENT_PERSON_ID,
      'FA-CONF-' + id.slice(0, 8),
    );
    familyAccountIds.push(id);
    return id;
  }

  /**
   * Seed a student + guardian link so parent actor can book on
   * behalf of the student. Returns the student id.
   */
  async function seedStudentForParent(opts?: { schoolId?: string }): Promise<string> {
    const student = await seedStudent(rawClient, { schoolId: opts?.schoolId ?? TEST_SCHOOL_ID });
    personIds.push(student.personId);
    platformStudentIds.push(student.platformStudentId);
    studentIds.push(student.studentId);

    const guardianId = await ensureGuardianForPerson(
      rawClient,
      TEST_PARENT_PERSON_ID,
      TEST_PARENT_ACCOUNT_ID,
      opts?.schoolId ?? TEST_SCHOOL_ID,
    );
    guardianIds.push(guardianId);

    await linkStudentGuardian(rawClient, student.studentId, guardianId, {
      hasCustody: true,
    });

    return student.studentId;
  }

  // ────────────────────────────────────────────────────────────────────
  // ConferenceEventService
  // ────────────────────────────────────────────────────────────────────
  describe('ConferenceEventService', () => {
    it('create: admin creates DRAFT conference event', async () => {
      const dto = await withTestTenant(async () =>
        events.create(adminActor(), {
          title: 'Fall PTC',
          startDate: dateFuture(7),
          endDate: dateFuture(8),
          bookingOpensAt: isoFuture(24),
          bookingClosesAt: isoFuture(72),
        } as any),
      );
      expect(dto.status).toBe('DRAFT');
      expect(dto.title).toBe('Fall PTC');
      expect(dto.defaultSlotDurationMinutes).toBe(10);
      expect(dto.defaultBreakMinutes).toBe(5);
    });

    it('create: parent → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          events.create(parentActor(), {
            title: 'PTC',
            startDate: dateFuture(7),
            endDate: dateFuture(8),
            bookingOpensAt: isoFuture(24),
            bookingClosesAt: isoFuture(72),
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create: endDate < startDate → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          events.create(adminActor(), {
            title: 'Bad dates',
            startDate: dateFuture(10),
            endDate: dateFuture(5),
            bookingOpensAt: isoFuture(24),
            bookingClosesAt: isoFuture(72),
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create: bookingClosesAt <= bookingOpensAt → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          events.create(adminActor(), {
            title: 'Bad window',
            startDate: dateFuture(7),
            endDate: dateFuture(8),
            bookingOpensAt: isoFuture(72),
            bookingClosesAt: isoFuture(24),
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('list: admin sees DRAFT + non-DRAFT', async () => {
      await seedEventDirect({ status: 'DRAFT' });
      await seedEventDirect({ status: 'BOOKING_OPEN' });
      const list = await withTestTenant(async () => events.list(adminActor()));
      expect(list.length).toBe(2);
    });

    it('list: parent sees only non-DRAFT', async () => {
      await seedEventDirect({ status: 'DRAFT' });
      const visible = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const list = await withTestTenant(async () => events.list(parentActor()));
      expect(list.length).toBe(1);
      expect(list[0]!.id).toBe(visible);
    });

    it('list: admin filtered by status', async () => {
      await seedEventDirect({ status: 'DRAFT' });
      await seedEventDirect({ status: 'BOOKING_OPEN' });
      const list = await withTestTenant(async () => events.list(adminActor(), 'DRAFT'));
      expect(list.length).toBe(1);
      expect(list[0]!.status).toBe('DRAFT');
    });

    it('getById: admin reads DRAFT', async () => {
      const id = await seedEventDirect({ status: 'DRAFT' });
      const dto = await withTestTenant(async () => events.getById(adminActor(), id));
      expect(dto.id).toBe(id);
    });

    it('getById: parent reading DRAFT → NotFoundException', async () => {
      const id = await seedEventDirect({ status: 'DRAFT' });
      await expect(
        withTestTenant(async () => events.getById(parentActor(), id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          events.getById(adminActor(), '00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch: DRAFT → BOOKING_OPEN allowed; BOOKING_OPEN → DRAFT rejected', async () => {
      const id = await seedEventDirect({ status: 'DRAFT' });
      const opened = await withTestTenant(async () =>
        events.patch(adminActor(), id, { status: 'BOOKING_OPEN' } as any),
      );
      expect(opened.status).toBe('BOOKING_OPEN');

      // Cannot go backwards
      await expect(
        withTestTenant(async () =>
          events.patch(adminActor(), id, { status: 'DRAFT' } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch: COMPLETED terminal — no further transitions', async () => {
      const id = await seedEventDirect({ status: 'COMPLETED' });
      await expect(
        withTestTenant(async () =>
          events.patch(adminActor(), id, { status: 'IN_PROGRESS' } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch: title + dates merge applies; missing endDate uses before-row', async () => {
      const id = await seedEventDirect({ status: 'DRAFT' });
      const patched = await withTestTenant(async () =>
        events.patch(adminActor(), id, {
          title: 'Renamed',
          description: 'Notes added',
          defaultSlotDurationMinutes: 20,
        } as any),
      );
      expect(patched.title).toBe('Renamed');
      expect(patched.description).toBe('Notes added');
      expect(patched.defaultSlotDurationMinutes).toBe(20);
    });

    it('patch: empty body is a no-op DTO read', async () => {
      const id = await seedEventDirect({ status: 'DRAFT' });
      const dto = await withTestTenant(async () =>
        events.patch(adminActor(), id, {} as any),
      );
      expect(dto.id).toBe(id);
    });

    it('patch: window violation in merged shape → BadRequestException', async () => {
      const id = await seedEventDirect({ status: 'DRAFT' });
      // Existing bookingOpensAt < bookingClosesAt. Send new closesAt < opensAt.
      await expect(
        withTestTenant(async () =>
          events.patch(adminActor(), id, { bookingClosesAt: isoPast(48) } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch: date violation in merged shape → BadRequestException', async () => {
      const id = await seedEventDirect({ status: 'DRAFT' });
      await expect(
        withTestTenant(async () =>
          events.patch(adminActor(), id, { endDate: dateFuture(3) } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          events.patch(adminActor(), '00000000-0000-0000-0000-000000000000', {
            title: 'X',
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school: School A admin cannot see School B event', async () => {
      const bEvent = await seedEventDirect({ schoolId: TEST_SCHOOL_B_ID, status: 'BOOKING_OPEN' });
      const listA = await withTestTenant(async () => events.list(adminActor()));
      expect(listA.find((e) => e.id === bEvent)).toBeUndefined();

      await expect(
        withTestTenant(async () => events.getById(adminActor(), bEvent)),
      ).rejects.toBeInstanceOf(NotFoundException);

      // School B can see it
      const listB = await withTestTenantB(async () => events.list(adminActor()));
      expect(listB.map((e) => e.id)).toContain(bEvent);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // ConferenceSlotService
  // ────────────────────────────────────────────────────────────────────
  describe('ConferenceSlotService', () => {
    it('generateSlots: admin walks window in (duration + break) increments', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotsOut = await withTestTenant(async () =>
        slots.generateSlots(adminActor(), eventId, {
          teacherId: TEST_TEACHER_EMPLOYEE_ID,
          slotDate: dateFuture(7),
          startTime: '09:00',
          endTime: '10:00',
          slotDurationMinutes: 10,
          breakMinutes: 5,
        } as any),
      );
      // 9:00→10:00 with 15-min stride = 09:00, 09:15, 09:30, 09:45 (4 slots)
      expect(slotsOut.length).toBe(4);
      expect(slotsOut[0]!.startTime).toMatch(/^09:00/);
      expect(slotsOut[0]!.teacherName).toBeTruthy();
    });

    it('generateSlots: idempotent on (event,teacher,date,start_time) ON CONFLICT', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      await withTestTenant(async () =>
        slots.generateSlots(adminActor(), eventId, {
          teacherId: TEST_TEACHER_EMPLOYEE_ID,
          slotDate: dateFuture(7),
          startTime: '09:00',
          endTime: '09:30',
        } as any),
      );
      // Re-generate over same window — no duplicate rows
      const second = await withTestTenant(async () =>
        slots.generateSlots(adminActor(), eventId, {
          teacherId: TEST_TEACHER_EMPLOYEE_ID,
          slotDate: dateFuture(7),
          startTime: '09:00',
          endTime: '09:30',
        } as any),
      );
      expect(second.length).toBe(2);
    });

    it('generateSlots: teacher in another school → BadRequestException', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      // Create an employee in School B and try to assign in School A context.
      const otherEmpId = generateId();
      const otherPersonId = generateId();
      const otherAccountId = generateId();
      personIds.push(otherPersonId);
      accountIds.push(otherAccountId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Other', 'Teacher', 'STAFF', true)`,
        otherPersonId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_users (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
         VALUES ($1::uuid, $2::uuid, $3, 'Other Teacher', 'ACTIVE', 'HUMAN', false)`,
        otherAccountId,
        otherPersonId,
        'other-' + otherAccountId.slice(0, 8) + '@test.local',
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hr_employees
           (id, person_id, account_id, school_id, employee_number, employment_type, employment_status, hire_date)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'FULL_TIME', 'ACTIVE', '2024-01-01')`,
        otherEmpId,
        otherPersonId,
        otherAccountId,
        TEST_SCHOOL_B_ID,
        'OTHER-' + otherEmpId.slice(-6),
      );
      await expect(
        withTestTenant(async () =>
          slots.generateSlots(adminActor(), eventId, {
            teacherId: otherEmpId,
            slotDate: dateFuture(7),
            startTime: '09:00',
            endTime: '09:30',
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Cleanup
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.hr_employees WHERE id = $1::uuid`,
        otherEmpId,
      );
    });

    it('generateSlots: event COMPLETED → BadRequestException', async () => {
      const eventId = await seedEventDirect({ status: 'COMPLETED' });
      await expect(
        withTestTenant(async () =>
          slots.generateSlots(adminActor(), eventId, {
            teacherId: TEST_TEACHER_EMPLOYEE_ID,
            slotDate: dateFuture(7),
            startTime: '09:00',
            endTime: '09:30',
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('generateSlots: endTime <= startTime → BadRequestException', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      await expect(
        withTestTenant(async () =>
          slots.generateSlots(adminActor(), eventId, {
            teacherId: TEST_TEACHER_EMPLOYEE_ID,
            slotDate: dateFuture(7),
            startTime: '10:00',
            endTime: '09:00',
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('generateSlots: duration <= 0 → BadRequestException', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      await expect(
        withTestTenant(async () =>
          slots.generateSlots(adminActor(), eventId, {
            teacherId: TEST_TEACHER_EMPLOYEE_ID,
            slotDate: dateFuture(7),
            startTime: '09:00',
            endTime: '10:00',
            slotDurationMinutes: 0,
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('generateSlots: invalid time format → BadRequestException', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      await expect(
        withTestTenant(async () =>
          slots.generateSlots(adminActor(), eventId, {
            teacherId: TEST_TEACHER_EMPLOYEE_ID,
            slotDate: dateFuture(7),
            startTime: 'aa:bb',
            endTime: '10:00',
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('generateSlots: missing event → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          slots.generateSlots(adminActor(), '00000000-0000-0000-0000-000000000000', {
            teacherId: TEST_TEACHER_EMPLOYEE_ID,
            slotDate: dateFuture(7),
            startTime: '09:00',
            endTime: '09:30',
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listForEvent: filters by teacherId + availableOnly', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      await seedSlotDirect(eventId, { status: 'AVAILABLE', startTime: '09:00', endTime: '09:10' });
      await seedSlotDirect(eventId, { status: 'BOOKED', startTime: '09:15', endTime: '09:25' });
      const all = await withTestTenant(async () => slots.listForEvent(adminActor(), eventId));
      expect(all.length).toBe(2);
      const available = await withTestTenant(async () =>
        slots.listForEvent(adminActor(), eventId, { availableOnly: true }),
      );
      expect(available.length).toBe(1);
      expect(available[0]!.status).toBe('AVAILABLE');

      const byTeacher = await withTestTenant(async () =>
        slots.listForEvent(adminActor(), eventId, { teacherId: TEST_TEACHER_EMPLOYEE_ID }),
      );
      expect(byTeacher.length).toBe(2);
    });

    it('getById: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          slots.getById(adminActor(), '00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch: BLOCK an AVAILABLE slot then unblock', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const blocked = await withTestTenant(async () =>
        slots.patch(adminActor(), slotId, { status: 'BLOCKED', notes: 'sick' } as any),
      );
      expect(blocked.status).toBe('BLOCKED');
      expect(blocked.notes).toBe('sick');

      const unblocked = await withTestTenant(async () =>
        slots.patch(adminActor(), slotId, { status: 'AVAILABLE' } as any),
      );
      expect(unblocked.status).toBe('AVAILABLE');
    });

    it('patch: BOOKED slot status flip → BadRequestException', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, { status: 'BOOKED', currentBookings: 1 });
      await expect(
        withTestTenant(async () =>
          slots.patch(adminActor(), slotId, { status: 'AVAILABLE' } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch: set AVAILABLE while current_bookings > 0 → BadRequestException', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, {
        status: 'BLOCKED',
        currentBookings: 1,
        maxBookings: 2,
      });
      await expect(
        withTestTenant(async () =>
          slots.patch(adminActor(), slotId, { status: 'AVAILABLE' } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch: location/url/notes update', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const updated = await withTestTenant(async () =>
        slots.patch(adminActor(), slotId, {
          location: 'Room 12',
          meetingUrl: 'https://zoom.example.com/x',
        } as any),
      );
      expect(updated.location).toBe('Room 12');
      expect(updated.meetingUrl).toBe('https://zoom.example.com/x');
    });

    it('patch: empty body — no-op', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const dto = await withTestTenant(async () =>
        slots.patch(adminActor(), slotId, {} as any),
      );
      expect(dto.id).toBe(slotId);
    });

    it('patch: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          slots.patch(adminActor(), '00000000-0000-0000-0000-000000000000', {
            location: 'X',
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // ConferenceBookingService — THE ATOMIC BOOKING KEYSTONE
  // ────────────────────────────────────────────────────────────────────
  describe('ConferenceBookingService', () => {
    it('book: parent → ATOMIC AVAILABLE→BOOKED transition + booking row', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const studentId = await seedStudentForParent();

      const dto = await withTestTenant(async () =>
        bookings.book(parentActor(), slotId, { studentId } as any),
      );
      expect(dto.slotId).toBe(slotId);
      expect(dto.parentId).toBe(TEST_PARENT_ACCOUNT_ID);

      // Verify the slot is now BOOKED
      const rows = await rawClient.$queryRawUnsafe<
        Array<{ status: string; current_bookings: number }>
      >(
        `SELECT status, current_bookings FROM ${TEST_SCHEMA}.eng_conference_slots WHERE id = $1::uuid`,
        slotId,
      );
      expect(rows[0]!.status).toBe('BOOKED');
      expect(Number(rows[0]!.current_bookings)).toBe(1);
    });

    it('book: concurrent overbook → second attempt 409 ConflictException', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const studentId = await seedStudentForParent();

      await withTestTenant(async () =>
        bookings.book(parentActor(), slotId, { studentId } as any),
      );

      // Different parent (admin actor as conference admin) tries to book the same slot
      await expect(
        withTestTenant(async () =>
          bookings.book(adminActor(), slotId, { studentId } as any),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('book: parent re-booking same slot for same student → 409 duplicate', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, {
        status: 'AVAILABLE',
        maxBookings: 5,
      });
      const studentId = await seedStudentForParent();

      await withTestTenant(async () =>
        bookings.book(parentActor(), slotId, { studentId } as any),
      );

      // Second booking by same parent for same student against the same slot
      // — the partial UNIQUE catches the duplicate; surfaces as 409.
      await expect(
        withTestTenant(async () =>
          bookings.book(parentActor(), slotId, { studentId } as any),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('book: group slot — current_bookings increments, status flips at max', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, {
        status: 'AVAILABLE',
        maxBookings: 2,
        currentBookings: 0,
      });
      const studentId = await seedStudentForParent();

      await withTestTenant(async () =>
        bookings.book(parentActor(), slotId, { studentId } as any),
      );

      // After 1/2 — still AVAILABLE
      let rows = await rawClient.$queryRawUnsafe<
        Array<{ status: string; current_bookings: number }>
      >(
        `SELECT status, current_bookings FROM ${TEST_SCHEMA}.eng_conference_slots WHERE id = $1::uuid`,
        slotId,
      );
      expect(rows[0]!.status).toBe('AVAILABLE');
      expect(Number(rows[0]!.current_bookings)).toBe(1);

      // Second booking by admin (conference admin) on behalf of a second student
      const secondStudent = await seedStudent(rawClient, { schoolId: TEST_SCHOOL_ID });
      personIds.push(secondStudent.personId);
      platformStudentIds.push(secondStudent.platformStudentId);
      studentIds.push(secondStudent.studentId);
      await withTestTenant(async () =>
        bookings.book(adminActor(), slotId, { studentId: secondStudent.studentId } as any),
      );

      rows = await rawClient.$queryRawUnsafe(
        `SELECT status, current_bookings FROM ${TEST_SCHEMA}.eng_conference_slots WHERE id = $1::uuid`,
        slotId,
      );
      expect(rows[0]!.status).toBe('BOOKED');
      expect(Number(rows[0]!.current_bookings)).toBe(2);
    });

    it('book: student persona → ForbiddenException', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      await expect(
        withTestTenant(async () =>
          bookings.book(studentActor(), slotId, {
            studentId: '00000000-0000-0000-0000-000000000000',
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('book: parent not linked to student → BadRequestException', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      // Seed a student in School A WITHOUT a guardian link to the parent actor
      const stranger = await seedStudent(rawClient, { schoolId: TEST_SCHOOL_ID });
      personIds.push(stranger.personId);
      platformStudentIds.push(stranger.platformStudentId);
      studentIds.push(stranger.studentId);

      await expect(
        withTestTenant(async () =>
          bookings.book(parentActor(), slotId, { studentId: stranger.studentId } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('book: admin path validates student is in current school (rejects cross-school student)', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const otherStudent = await seedStudent(rawClient, { schoolId: TEST_SCHOOL_B_ID });
      personIds.push(otherStudent.personId);
      platformStudentIds.push(otherStudent.platformStudentId);
      studentIds.push(otherStudent.studentId);
      await expect(
        withTestTenant(async () =>
          bookings.book(adminActor(), slotId, { studentId: otherStudent.studentId } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('book: window not open yet → BadRequestException (parent)', async () => {
      const eventId = await seedEventDirect({
        status: 'BOOKING_OPEN', // status alone doesn't bypass the window
        bookingOpensAt: isoFuture(24),
        bookingClosesAt: isoFuture(72),
      });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const studentId = await seedStudentForParent();
      await expect(
        withTestTenant(async () =>
          bookings.book(parentActor(), slotId, { studentId } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('book: window closed → BadRequestException (parent)', async () => {
      const eventId = await seedEventDirect({
        status: 'BOOKING_OPEN',
        bookingOpensAt: isoPast(96),
        bookingClosesAt: isoPast(24),
      });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const studentId = await seedStudentForParent();
      await expect(
        withTestTenant(async () =>
          bookings.book(parentActor(), slotId, { studentId } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('book: admin bypasses window', async () => {
      const eventId = await seedEventDirect({
        status: 'BOOKING_OPEN',
        bookingOpensAt: isoFuture(24),
        bookingClosesAt: isoFuture(72),
      });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const studentId = await seedStudentForParent();
      const dto = await withTestTenant(async () =>
        bookings.book(adminActor(), slotId, { studentId } as any),
      );
      expect(dto.id).toBeTruthy();
    });

    it('book: event COMPLETED → BadRequestException', async () => {
      const eventId = await seedEventDirect({ status: 'COMPLETED' });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const studentId = await seedStudentForParent();
      await expect(
        withTestTenant(async () =>
          bookings.book(adminActor(), slotId, { studentId } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('book: BOOKED already → 409 Conflict', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, {
        status: 'BOOKED',
        currentBookings: 1,
        maxBookings: 1,
      });
      const studentId = await seedStudentForParent();
      await expect(
        withTestTenant(async () =>
          bookings.book(parentActor(), slotId, { studentId } as any),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('book: missing slot → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          bookings.book(parentActor(), '00000000-0000-0000-0000-000000000000', {
            studentId: '00000000-0000-0000-0000-000000000000',
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cancel: parent owner cancels — slot AVAILABLE again', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const studentId = await seedStudentForParent();
      const dto = await withTestTenant(async () =>
        bookings.book(parentActor(), slotId, { studentId } as any),
      );

      const cancelled = await withTestTenant(async () =>
        bookings.cancel(parentActor(), dto.id, { reason: 'conflict' } as any),
      );
      expect(cancelled.cancelledAt).not.toBeNull();
      expect(cancelled.cancellationReason).toBe('conflict');

      const rows = await rawClient.$queryRawUnsafe<
        Array<{ status: string; current_bookings: number }>
      >(
        `SELECT status, current_bookings FROM ${TEST_SCHEMA}.eng_conference_slots WHERE id = $1::uuid`,
        slotId,
      );
      expect(rows[0]!.status).toBe('AVAILABLE');
      expect(Number(rows[0]!.current_bookings)).toBe(0);
    });

    it('cancel: already-cancelled → BadRequestException', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const studentId = await seedStudentForParent();
      const dto = await withTestTenant(async () =>
        bookings.book(parentActor(), slotId, { studentId } as any),
      );
      await withTestTenant(async () =>
        bookings.cancel(parentActor(), dto.id, {} as any),
      );
      await expect(
        withTestTenant(async () =>
          bookings.cancel(parentActor(), dto.id, {} as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cancel: non-owner non-admin → ForbiddenException', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const studentId = await seedStudentForParent();
      const dto = await withTestTenant(async () =>
        bookings.book(parentActor(), slotId, { studentId } as any),
      );

      // student persona attempting to cancel another's booking
      await expect(
        withTestTenant(async () =>
          bookings.cancel(studentActor(), dto.id, {} as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cancel: admin can cancel any', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const studentId = await seedStudentForParent();
      const dto = await withTestTenant(async () =>
        bookings.book(parentActor(), slotId, { studentId } as any),
      );
      const cancelled = await withTestTenant(async () =>
        bookings.cancel(adminActor(), dto.id, {} as any),
      );
      expect(cancelled.cancelledAt).not.toBeNull();
    });

    it('cancel: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          bookings.cancel(
            adminActor(),
            '00000000-0000-0000-0000-000000000000',
            {} as any,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listMine: parent sees own bookings', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const studentId = await seedStudentForParent();
      await withTestTenant(async () =>
        bookings.book(parentActor(), slotId, { studentId } as any),
      );
      const mine = await withTestTenant(async () => bookings.listMine(parentActor()));
      expect(mine.length).toBe(1);
    });

    it('list: admin filters by slotId/parentId/studentId', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const studentId = await seedStudentForParent();
      await withTestTenant(async () =>
        bookings.book(parentActor(), slotId, { studentId } as any),
      );
      const list = await withTestTenant(async () =>
        bookings.list(adminActor(), { slotId, parentId: TEST_PARENT_ACCOUNT_ID, studentId }),
      );
      expect(list.length).toBe(1);
    });

    it('list: parent → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => bookings.list(parentActor(), {})),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getById: parent reads own; other parent → NotFoundException', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const studentId = await seedStudentForParent();
      const dto = await withTestTenant(async () =>
        bookings.book(parentActor(), slotId, { studentId } as any),
      );
      const seen = await withTestTenant(async () => bookings.getById(parentActor(), dto.id));
      expect(seen.id).toBe(dto.id);

      // synthetic foreign parent
      const otherParent = {
        accountId: '00000000-0000-0000-0000-0000000000aa',
        personId: '00000000-0000-0000-0000-0000000000ab',
        employeeId: null,
        personType: 'GUARDIAN' as const,
        isSchoolAdmin: false,
      };
      await expect(
        withTestTenant(async () => bookings.getById(otherParent, dto.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById: student persona → ForbiddenException', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const studentId = await seedStudentForParent();
      const dto = await withTestTenant(async () =>
        bookings.book(parentActor(), slotId, { studentId } as any),
      );
      await expect(
        withTestTenant(async () => bookings.getById(studentActor(), dto.id)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getById: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          bookings.getById(adminActor(), '00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch: admin writes staff fields (attended/notes/followUp)', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const studentId = await seedStudentForParent();
      const dto = await withTestTenant(async () =>
        bookings.book(parentActor(), slotId, { studentId } as any),
      );
      const patched = await withTestTenant(async () =>
        bookings.patch(adminActor(), dto.id, {
          attended: true,
          conferenceNotes: 'Productive meeting',
          followUpActions: [
            { description: 'Send reading list', due_date: '2026-12-31', status: 'PENDING' },
          ],
        } as any),
      );
      expect(patched.attended).toBe(true);
      expect(patched.conferenceNotes).toBe('Productive meeting');
      expect(Array.isArray(patched.followUpActions)).toBe(true);
      expect(patched.followUpActions!.length).toBe(1);
    });

    it('patch: parent writes own feedback (rating + comments)', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const studentId = await seedStudentForParent();
      const dto = await withTestTenant(async () =>
        bookings.book(parentActor(), slotId, { studentId } as any),
      );
      const patched = await withTestTenant(async () =>
        bookings.patch(parentActor(), dto.id, {
          parentFeedbackRating: 5,
          parentFeedbackComments: 'Loved it',
        } as any),
      );
      expect(patched.parentFeedbackRating).toBe(5);
      expect(patched.parentFeedbackComments).toBe('Loved it');
    });

    it('patch: parent writing staff fields → ForbiddenException', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const studentId = await seedStudentForParent();
      const dto = await withTestTenant(async () =>
        bookings.book(parentActor(), slotId, { studentId } as any),
      );
      await expect(
        withTestTenant(async () =>
          bookings.patch(parentActor(), dto.id, { attended: true } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch: non-owner staff writing parent feedback → ForbiddenException', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const studentId = await seedStudentForParent();
      const dto = await withTestTenant(async () =>
        bookings.book(parentActor(), slotId, { studentId } as any),
      );
      await expect(
        withTestTenant(async () =>
          bookings.patch(adminActor(), dto.id, {
            parentFeedbackRating: 4,
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch: empty body — no-op', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const studentId = await seedStudentForParent();
      const dto = await withTestTenant(async () =>
        bookings.book(parentActor(), slotId, { studentId } as any),
      );
      const ret = await withTestTenant(async () =>
        bookings.patch(adminActor(), dto.id, {} as any),
      );
      expect(ret.id).toBe(dto.id);
    });

    it('patch: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          bookings.patch(
            adminActor(),
            '00000000-0000-0000-0000-000000000000',
            { attended: true } as any,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school: School B parent cannot cancel School A booking via NotFound', async () => {
      const eventId = await seedEventDirect({ status: 'BOOKING_OPEN' });
      const slotId = await seedSlotDirect(eventId, { status: 'AVAILABLE' });
      const studentId = await seedStudentForParent();
      const dto = await withTestTenant(async () =>
        bookings.book(parentActor(), slotId, { studentId } as any),
      );
      await expect(
        withTestTenantB(async () => bookings.cancel(parentActor(), dto.id, {} as any)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // ConferenceStatusWorker
  // ────────────────────────────────────────────────────────────────────
  describe('ConferenceStatusWorker', () => {
    it('tickForSchool: flips DRAFT→BOOKING_OPEN when booking_opens_at ≤ now()', async () => {
      const id = await seedEventDirect({ status: 'DRAFT', bookingOpensAt: isoPast(1) });
      const flipped = await statusWorker.tickForSchool(
        TEST_SCHEMA,
        TEST_SCHOOL_ID,
        TEST_SUBDOMAIN,
      );
      expect(flipped).toBe(1);

      const rows = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.eng_conference_events WHERE id = $1::uuid`,
        id,
      );
      expect(rows[0]!.status).toBe('BOOKING_OPEN');
    });

    it('tickForSchool: enqueues eng.conference.booking_open outbox row with deterministic event_id', async () => {
      const id = await seedEventDirect({ status: 'DRAFT', bookingOpensAt: isoPast(1) });
      await statusWorker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN);

      const rows = await rawClient.$queryRawUnsafe<
        Array<{ topic: string; envelope: string; message_key: string; tenant_id: string }>
      >(
        `SELECT topic, envelope::text AS envelope, message_key, tenant_id::text AS tenant_id
           FROM platform.platform_outbox
          WHERE topic = 'eng.conference.booking_open' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );
      expect(rows.length).toBe(1);
      expect(rows[0]!.message_key).toBe(id);
      const env = JSON.parse(rows[0]!.envelope);
      expect(env.event_id).toBe(deterministicConferenceBookingOpenEventId(id));
      expect(env.payload.conferenceEventId).toBe(id);
      expect(env.payload.schoolId).toBe(TEST_SCHOOL_ID);
    });

    it('tickForSchool: idempotent — second run flips zero rows', async () => {
      await seedEventDirect({ status: 'DRAFT', bookingOpensAt: isoPast(1) });
      const first = await statusWorker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN);
      expect(first).toBe(1);
      const second = await statusWorker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN);
      expect(second).toBe(0);
    });

    it('tickForSchool: ignores events with bookingOpensAt in the future', async () => {
      await seedEventDirect({ status: 'DRAFT', bookingOpensAt: isoFuture(24) });
      const flipped = await statusWorker.tickForSchool(
        TEST_SCHEMA,
        TEST_SCHOOL_ID,
        TEST_SUBDOMAIN,
      );
      expect(flipped).toBe(0);
    });

    it('tickForSchool: school-scoped — only flips current school', async () => {
      const a = await seedEventDirect({
        schoolId: TEST_SCHOOL_ID,
        status: 'DRAFT',
        bookingOpensAt: isoPast(1),
      });
      const b = await seedEventDirect({
        schoolId: TEST_SCHOOL_B_ID,
        status: 'DRAFT',
        bookingOpensAt: isoPast(1),
      });
      await statusWorker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN);
      const rowsA = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.eng_conference_events WHERE id = $1::uuid`,
        a,
      );
      const rowsB = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.eng_conference_events WHERE id = $1::uuid`,
        b,
      );
      expect(rowsA[0]!.status).toBe('BOOKING_OPEN');
      expect(rowsB[0]!.status).toBe('DRAFT');
    });
  });
});
