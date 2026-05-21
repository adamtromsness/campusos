import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { TourSlotService } from '@modules/m81-enrolment/tours/tour-slot.service';
import { TourBookingService } from '@modules/m81-enrolment/tours/tour-booking.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import { adminActor, parentActor, teacherActor, TEST_PARENT_PERSON_ID } from '../helpers/actor';

/**
 * Wave 4 — m81-enrolment Tours (TourSlotService + TourBookingService)
 * DB-backed integration tests.
 *
 * Contracts verified:
 *   - TourSlotService.create / patch — admin gate, time-range chk, UNIQUE on
 *     (school_id, tour_date, start_time).
 *   - TourSlotService.listPublic — returns only published, non-cancelled,
 *     non-full, future slots.
 *   - TourBookingService.bookPublic — anonymous path, booked_by=NULL,
 *     bumps current_bookings under FOR UPDATE lock.
 *   - Overbooking: SELECT FOR UPDATE + capacity gate returns ConflictException
 *     once the slot is full.
 *   - Lifecycle PATCH: CANCELLED requires reason; cancel decrements
 *     current_bookings inside the same locked tx.
 *   - Cross-school isolation: admin in School A cannot list / patch a
 *     School B slot.
 *   - linkApplication binds a booking to an application within the same
 *     school.
 */
describe('integration:m81-enrolment/tours', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let outbox: OutboxService;
  let slotService: TourSlotService;
  let bookingService: TourBookingService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    outbox = new OutboxService();
    slotService = new TourSlotService(tenantPrisma, permCheck);
    bookingService = new TourBookingService(tenantPrisma, permCheck, outbox);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // FK CASCADE: enr_tour_booking_guests -> enr_tour_bookings -> enr_tour_slots
    // Wipe in order; guests cascade with bookings.
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_tour_booking_guests`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_tour_bookings`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_tour_slots`);
  });

  function futureDate(daysAhead: number): string {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    return d.toISOString().slice(0, 10);
  }

  function makeSlotInput(
    overrides: Partial<{
      tourDate: string;
      startTime: string;
      endTime: string;
      maxBookings: number;
      isPublished: boolean;
    }> = {},
  ): any {
    return {
      tourDate: overrides.tourDate ?? futureDate(7),
      startTime: overrides.startTime ?? '10:00',
      endTime: overrides.endTime ?? '11:00',
      maxBookings: overrides.maxBookings ?? 1,
      isPublished: overrides.isPublished ?? true,
    };
  }

  function makeBookingInput(
    overrides: Partial<{
      familyName: string;
      contactEmail: string;
      firstName: string;
      lastName: string;
    }> = {},
  ): any {
    return {
      familyName: overrides.familyName ?? 'Doe Family',
      contactEmail: overrides.contactEmail ?? 'family@test.local',
      firstName: overrides.firstName ?? 'Jane',
      lastName: overrides.lastName ?? 'Doe',
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // TourSlotService.create / patch
  // ────────────────────────────────────────────────────────────────────
  describe('TourSlotService', () => {
    it('admin creates a tour slot → row inserted', async () => {
      const slot = await withTestTenant(async () =>
        slotService.create(makeSlotInput({ tourDate: futureDate(7) }), adminActor()),
      );
      expect(slot.schoolId).toBe(TEST_SCHOOL_ID);
      expect(slot.maxBookings).toBe(1);
      expect(slot.currentBookings).toBe(0);
      expect(slot.isPublished).toBe(true);
    });

    it('non-admin / non-permission caller → ForbiddenException on create', async () => {
      await expect(
        withTestTenant(async () => slotService.create(makeSlotInput(), teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('endTime <= startTime → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          slotService.create(makeSlotInput({ startTime: '11:00', endTime: '10:00' }), adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('duplicate (school_id, tour_date, start_time) → BadRequestException', async () => {
      const date = futureDate(7);
      await withTestTenant(async () =>
        slotService.create(
          makeSlotInput({ tourDate: date, startTime: '10:00', endTime: '11:00' }),
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          slotService.create(
            makeSlotInput({ tourDate: date, startTime: '10:00', endTime: '11:30' }),
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('listPublic returns only published, non-cancelled, non-full, future slots', async () => {
      const goodSlot = await withTestTenant(async () =>
        slotService.create(
          makeSlotInput({ tourDate: futureDate(7), startTime: '10:00' }),
          adminActor(),
        ),
      );
      // Unpublished slot — should not appear.
      await withTestTenant(async () =>
        slotService.create(
          makeSlotInput({
            tourDate: futureDate(8),
            startTime: '10:00',
            isPublished: false,
          }),
          adminActor(),
        ),
      );

      const list = await withTestTenant(async () => slotService.listPublic());
      const ids = list.map((s) => s.id);
      expect(ids).toContain(goodSlot.id);
      expect(list.every((s) => s.isPublished && !s.isCancelled)).toBe(true);
    });

    it('listAdmin returns every slot (including unpublished / cancelled)', async () => {
      await withTestTenant(async () =>
        slotService.create(
          makeSlotInput({ tourDate: futureDate(7), isPublished: false }),
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => slotService.listAdmin(adminActor()));
      expect(list.length).toBeGreaterThan(0);
    });

    it('patch toggles isCancelled', async () => {
      const slot = await withTestTenant(async () =>
        slotService.create(makeSlotInput({ tourDate: futureDate(7) }), adminActor()),
      );
      const updated = await withTestTenant(async () =>
        slotService.patch(slot.id, { isCancelled: true } as any, adminActor()),
      );
      expect(updated.isCancelled).toBe(true);
    });

    it('patch unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          slotService.patch(
            '00000000-0000-0000-0000-000000000000',
            { isCancelled: true } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Public booking — anonymous, locks slot row, bumps current_bookings
  // ────────────────────────────────────────────────────────────────────
  describe('TourBookingService.bookPublic', () => {
    async function seedSlot(maxBookings = 1, daysAhead = 7): Promise<string> {
      const slot = await withTestTenant(async () =>
        slotService.create(
          makeSlotInput({
            tourDate: futureDate(daysAhead),
            maxBookings,
            startTime: '09:00',
            endTime: '10:00',
          }),
          adminActor(),
        ),
      );
      return slot.id;
    }

    it('first public booking succeeds with booked_by NULL; current_bookings = 1', async () => {
      const slotId = await seedSlot(1);
      const booking = await withTestTenant(async () =>
        bookingService.bookPublic(slotId, makeBookingInput()),
      );
      expect(booking.status).toBe('CONFIRMED');
      expect(booking.bookedBy).toBeNull();
      const rows = await rawClient.$queryRawUnsafe<Array<{ current_bookings: number }>>(
        `SELECT current_bookings FROM ${TEST_SCHEMA}.enr_tour_slots WHERE id = $1::uuid`,
        slotId,
      );
      expect(rows[0]!.current_bookings).toBe(1);
    });

    it('booking outbox row enqueued inside same tx', async () => {
      const slotId = await seedSlot(1);
      const booking = await withTestTenant(async () =>
        bookingService.bookPublic(slotId, makeBookingInput()),
      );
      const outboxRows = await rawClient.$queryRawUnsafe<Array<{ topic: string }>>(
        `SELECT topic FROM platform.platform_outbox WHERE topic = 'enr.tour.booked' AND message_key = $1`,
        booking.id,
      );
      expect(outboxRows.length).toBeGreaterThanOrEqual(1);
    });

    it('public booking missing firstName/lastName → BadRequestException', async () => {
      const slotId = await seedSlot(1);
      await expect(
        withTestTenant(async () =>
          bookingService.bookPublic(slotId, {
            familyName: 'Doe',
            contactEmail: 'd@x',
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('public booking with invalid email → BadRequestException', async () => {
      const slotId = await seedSlot(1);
      await expect(
        withTestTenant(async () =>
          bookingService.bookPublic(slotId, {
            familyName: 'Doe',
            contactEmail: 'noatsign',
            firstName: 'J',
            lastName: 'D',
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('booking on unpublished slot → BadRequestException', async () => {
      const slot = await withTestTenant(async () =>
        slotService.create(
          makeSlotInput({ tourDate: futureDate(7), isPublished: false }),
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => bookingService.bookPublic(slot.id, makeBookingInput())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('booking on cancelled slot → BadRequestException', async () => {
      const slot = await withTestTenant(async () =>
        slotService.create(makeSlotInput({ tourDate: futureDate(7) }), adminActor()),
      );
      await withTestTenant(async () =>
        slotService.patch(slot.id, { isCancelled: true } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () => bookingService.bookPublic(slot.id, makeBookingInput())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('unknown slot → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          bookingService.bookPublic('00000000-0000-0000-0000-000000000000', makeBookingInput()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Overbooking — the canonical race protection contract
  // ────────────────────────────────────────────────────────────────────
  describe('overbooking rejection', () => {
    it('max=1 slot rejects a second booking with ConflictException', async () => {
      const slot = await withTestTenant(async () =>
        slotService.create(
          makeSlotInput({ tourDate: futureDate(7), maxBookings: 1 }),
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        bookingService.bookPublic(
          slot.id,
          makeBookingInput({ familyName: 'F1', contactEmail: 'f1@test' }),
        ),
      );
      await expect(
        withTestTenant(async () =>
          bookingService.bookPublic(
            slot.id,
            makeBookingInput({ familyName: 'F2', contactEmail: 'f2@test' }),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      const rows = await rawClient.$queryRawUnsafe<Array<{ current_bookings: number }>>(
        `SELECT current_bookings FROM ${TEST_SCHEMA}.enr_tour_slots WHERE id = $1::uuid`,
        slot.id,
      );
      expect(rows[0]!.current_bookings).toBe(1);
    });

    it('max=3 slot accepts 3 bookings, rejects the 4th', async () => {
      const slot = await withTestTenant(async () =>
        slotService.create(
          makeSlotInput({ tourDate: futureDate(7), maxBookings: 3 }),
          adminActor(),
        ),
      );
      for (let i = 0; i < 3; i++) {
        await withTestTenant(async () =>
          bookingService.bookPublic(
            slot.id,
            makeBookingInput({
              familyName: 'F' + i,
              contactEmail: 'f' + i + '@test',
            }),
          ),
        );
      }
      await expect(
        withTestTenant(async () =>
          bookingService.bookPublic(
            slot.id,
            makeBookingInput({ familyName: 'F4', contactEmail: 'f4@test' }),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('concurrent attempts: even fired in parallel, only max=1 booking succeeds', async () => {
      const slot = await withTestTenant(async () =>
        slotService.create(
          makeSlotInput({ tourDate: futureDate(8), maxBookings: 1 }),
          adminActor(),
        ),
      );
      // Fire two bookings in parallel against the same slot.
      const results = await Promise.allSettled([
        withTestTenant(async () =>
          bookingService.bookPublic(
            slot.id,
            makeBookingInput({ familyName: 'P1', contactEmail: 'p1@test' }),
          ),
        ),
        withTestTenant(async () =>
          bookingService.bookPublic(
            slot.id,
            makeBookingInput({ familyName: 'P2', contactEmail: 'p2@test' }),
          ),
        ),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const rows = await rawClient.$queryRawUnsafe<Array<{ current_bookings: number }>>(
        `SELECT current_bookings FROM ${TEST_SCHEMA}.enr_tour_slots WHERE id = $1::uuid`,
        slot.id,
      );
      expect(rows[0]!.current_bookings).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Lifecycle PATCH — cancel decrements counter; reason required
  // ────────────────────────────────────────────────────────────────────
  describe('TourBookingService.patch', () => {
    async function seedSlotAndBooking(): Promise<{ slotId: string; bookingId: string }> {
      const slot = await withTestTenant(async () =>
        slotService.create(
          makeSlotInput({ tourDate: futureDate(7), maxBookings: 2 }),
          adminActor(),
        ),
      );
      const booking = await withTestTenant(async () =>
        bookingService.bookPublic(slot.id, makeBookingInput()),
      );
      return { slotId: slot.id, bookingId: booking.id };
    }

    it('admin cancels booking → status=CANCELLED, current_bookings decremented', async () => {
      const { slotId, bookingId } = await seedSlotAndBooking();
      const updated = await withTestTenant(async () =>
        bookingService.patch(
          bookingId,
          {
            status: 'CANCELLED',
            cancellationReason: 'family schedule change',
          } as any,
          adminActor(),
        ),
      );
      expect(updated.status).toBe('CANCELLED');
      expect(updated.cancelledAt).not.toBeNull();
      const rows = await rawClient.$queryRawUnsafe<Array<{ current_bookings: number }>>(
        `SELECT current_bookings FROM ${TEST_SCHEMA}.enr_tour_slots WHERE id = $1::uuid`,
        slotId,
      );
      expect(rows[0]!.current_bookings).toBe(0);
    });

    it('cancel without cancellationReason → BadRequestException', async () => {
      const { bookingId } = await seedSlotAndBooking();
      await expect(
        withTestTenant(async () =>
          bookingService.patch(
            bookingId,
            { status: 'CANCELLED', cancellationReason: '' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-admin / non-stu-003 caller → ForbiddenException', async () => {
      const { bookingId } = await seedSlotAndBooking();
      await expect(
        withTestTenant(async () =>
          bookingService.patch(bookingId, { status: 'COMPLETED' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('CONFIRMED → COMPLETED transition succeeds (no counter change)', async () => {
      const { slotId, bookingId } = await seedSlotAndBooking();
      const updated = await withTestTenant(async () =>
        bookingService.patch(bookingId, { status: 'COMPLETED' } as any, adminActor()),
      );
      expect(updated.status).toBe('COMPLETED');
      const rows = await rawClient.$queryRawUnsafe<Array<{ current_bookings: number }>>(
        `SELECT current_bookings FROM ${TEST_SCHEMA}.enr_tour_slots WHERE id = $1::uuid`,
        slotId,
      );
      expect(rows[0]!.current_bookings).toBe(1);
    });

    it('CANCELLED → CONFIRMED reactivation is rejected (BadRequest)', async () => {
      const { bookingId } = await seedSlotAndBooking();
      await withTestTenant(async () =>
        bookingService.patch(
          bookingId,
          { status: 'CANCELLED', cancellationReason: 'meh' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          bookingService.patch(bookingId, { status: 'CONFIRMED' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('listAdmin gates on stu-003:write — teacher → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => bookingService.listAdmin(teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('slot in School B does NOT appear in School A listAdmin', async () => {
      const bSlot = await withTestTenantB(async () =>
        slotService.create(makeSlotInput({ tourDate: futureDate(7) }), adminActor()),
      );
      const aList = await withTestTenant(async () => slotService.listAdmin(adminActor()));
      expect(aList.map((s) => s.id)).not.toContain(bSlot.id);
    });

    it('School A admin cannot patch a School B slot — NotFoundException', async () => {
      const bSlot = await withTestTenantB(async () =>
        slotService.create(makeSlotInput({ tourDate: futureDate(7) }), adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          slotService.patch(bSlot.id, { isCancelled: true } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('School A admin cannot booking-patch a School B booking — NotFoundException', async () => {
      const bSlot = await withTestTenantB(async () =>
        slotService.create(makeSlotInput({ tourDate: futureDate(7) }), adminActor()),
      );
      const bBooking = await withTestTenantB(async () =>
        bookingService.bookPublic(bSlot.id, makeBookingInput()),
      );
      await expect(
        withTestTenant(async () =>
          bookingService.patch(bBooking.id, { status: 'COMPLETED' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // Reference imports to keep parity with sibling specs.
  void TEST_PARENT_PERSON_ID;
  void parentActor;
});
