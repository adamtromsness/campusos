import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { RoomService } from '@modules/m22-scheduling/room.service';
import { RoomBookingService } from '@modules/m22-scheduling/room-booking.service';
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
  studentActor,
  TEST_TEACHER_EMPLOYEE_ID,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_STUDENT_PERSON_ID,
} from '../helpers/actor';

/**
 * m22-scheduling rooms + room-bookings DB-backed integration tests.
 *
 * Services under test:
 *   - RoomService (apps/api/src/modules/m22-scheduling/room.service.ts)
 *   - RoomBookingService (apps/api/src/modules/m22-scheduling/room-booking.service.ts)
 *
 * Contracts verified:
 *   - Room CRUD: admin can create / update; non-admin rejected.
 *   - Room booking: CONFIRMED insert with serialised conflict check.
 *   - Double-booking attempt → ConflictException (overlap window).
 *   - Cancel by booker or admin; CANCELLED bookings free the slot.
 *   - List query filters (status / date range / room).
 *   - Cross-school isolation: a School A admin cannot see / mutate
 *     School B rooms.
 */
describe('integration:m22-scheduling/rooms', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let roomService: RoomService;
  let bookingService: RoomBookingService;

  const roomIds: string[] = [];
  const bookingIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    roomService = new RoomService(tenantPrisma);
    bookingService = new RoomBookingService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Wipe everything we create in these tests. Order matters: bookings
    // first (they FK to rooms), then rooms.
    if (bookingIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_room_bookings WHERE id = ANY($1::uuid[])`,
        bookingIds.splice(0),
      );
    }
    // Surgical: also wipe any leftover sch_room_bookings whose rooms we
    // own — defensive against cross-test leakage.
    if (roomIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_room_bookings WHERE room_id = ANY($1::uuid[])`,
        roomIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_rooms WHERE id = ANY($1::uuid[])`,
        roomIds.splice(0),
      );
    }
  });

  async function seedRoom(
    opts: {
      schoolId?: string;
      name?: string;
      capacity?: number | null;
      roomType?: string;
      isActive?: boolean;
    } = {},
  ): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_rooms
         (id, school_id, name, capacity, room_type, has_projector, has_av, is_active)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, false, false, $6)`,
      id,
      opts.schoolId ?? TEST_SCHOOL_ID,
      opts.name ?? 'Room-' + Math.random().toString(36).slice(2, 8),
      opts.capacity ?? 30,
      opts.roomType ?? 'CLASSROOM',
      opts.isActive ?? true,
    );
    roomIds.push(id);
    return id;
  }

  // ────────────────────────────────────────────────────────────────────
  // Room CRUD
  // ────────────────────────────────────────────────────────────────────
  describe('RoomService.create', () => {
    it('admin creates a room → row inserted with school_id set from tenant context', async () => {
      const dto = await withTestTenant(async () =>
        roomService.create(
          {
            name: 'Lab A',
            capacity: 25,
            roomType: 'LAB',
            hasProjector: true,
            hasAv: false,
            floor: '2',
            building: 'East Wing',
          } as any,
          adminActor(),
        ),
      );
      roomIds.push(dto.id);
      expect(dto.schoolId).toBe(TEST_SCHOOL_ID);
      expect(dto.name).toBe('Lab A');
      expect(dto.capacity).toBe(25);
      expect(dto.roomType).toBe('LAB');
      expect(dto.hasProjector).toBe(true);
      expect(dto.isActive).toBe(true);
    });

    it('non-admin (teacher) → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          roomService.create({ name: 'X', roomType: 'CLASSROOM' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('RoomService.getById', () => {
    it('returns the room when it exists in the current tenant school', async () => {
      const id = await seedRoom({ name: 'GetById Test Room' });
      const dto = await withTestTenant(async () => roomService.getById(id));
      expect(dto.id).toBe(id);
      expect(dto.name).toBe('GetById Test Room');
    });

    it('unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => roomService.getById('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('RoomService.update', () => {
    it('admin can rename + toggle isActive', async () => {
      const id = await seedRoom({ name: 'Old Name' });
      const dto = await withTestTenant(async () =>
        roomService.update(
          id,
          { name: 'New Name', isActive: false, hasProjector: true } as any,
          adminActor(),
        ),
      );
      expect(dto.name).toBe('New Name');
      expect(dto.isActive).toBe(false);
      expect(dto.hasProjector).toBe(true);
    });

    it('non-admin → ForbiddenException', async () => {
      const id = await seedRoom();
      await expect(
        withTestTenant(async () => roomService.update(id, { name: 'nope' } as any, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('empty patch returns existing dto unchanged', async () => {
      const id = await seedRoom({ name: 'Untouched' });
      const dto = await withTestTenant(async () => roomService.update(id, {} as any, adminActor()));
      expect(dto.name).toBe('Untouched');
    });
  });

  describe('RoomService.list', () => {
    it('excludes inactive rooms by default; includeInactive=true returns them', async () => {
      const activeId = await seedRoom({ name: 'Active Room', isActive: true });
      const inactiveId = await seedRoom({ name: 'Inactive Room', isActive: false });

      const defaultList = await withTestTenant(async () => roomService.list({} as any));
      const ids = defaultList.map((r) => r.id);
      expect(ids).toContain(activeId);
      expect(ids).not.toContain(inactiveId);

      const includingInactive = await withTestTenant(async () =>
        roomService.list({ includeInactive: true } as any),
      );
      const allIds = includingInactive.map((r) => r.id);
      expect(allIds).toContain(activeId);
      expect(allIds).toContain(inactiveId);
    });

    it('roomType filter narrows to that type', async () => {
      const labId = await seedRoom({ name: 'Lab 1', roomType: 'LAB' });
      const classroomId = await seedRoom({ name: 'CR 1', roomType: 'CLASSROOM' });
      const list = await withTestTenant(async () => roomService.list({ roomType: 'LAB' } as any));
      const ids = list.map((r) => r.id);
      expect(ids).toContain(labId);
      expect(ids).not.toContain(classroomId);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-school isolation
  //
  // PRODUCTION BUG: RoomService.list() does not filter by school_id —
  // it returns every sch_rooms row in the tenant_test schema
  // irrespective of school. The cross-school isolation contract is
  // violated. getById is also unscoped (returns any row). Skipping the
  // failing case until the service is patched to add
  //   AND school_id = $N::uuid
  // to the WHERE clause.
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('a School B room is not visible to a School A admin via list', async () => {
      const bRoomId = await seedRoom({ schoolId: TEST_SCHOOL_B_ID, name: 'School B Room' });
      const list = await withTestTenant(async () =>
        roomService.list({ includeInactive: true } as any),
      );
      expect(list.map((r) => r.id)).not.toContain(bRoomId);

      // When tenant context is pinned to School B, the same id is visible.
      const listB = await withTestTenantB(async () =>
        roomService.list({ includeInactive: true } as any),
      );
      expect(listB.map((r) => r.id)).toContain(bRoomId);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // RoomBookingService — create + conflict + cancel
  // ────────────────────────────────────────────────────────────────────
  describe('RoomBookingService.create', () => {
    it('admin creates a CONFIRMED booking → row inserted', async () => {
      const roomId = await seedRoom();
      const dto = await withTestTenant(async () =>
        bookingService.create(
          {
            roomId,
            bookingPurpose: 'Staff meeting',
            startAt: '2027-03-15T13:00:00.000Z',
            endAt: '2027-03-15T14:00:00.000Z',
          } as any,
          adminActor(),
        ),
      );
      bookingIds.push(dto.id);
      expect(dto.status).toBe('CONFIRMED');
      expect(dto.bookingPurpose).toBe('Staff meeting');
      expect(dto.bookedById).toBe(TEST_ADMIN_EMPLOYEE_ID);
    });

    it('teacher (non-admin staff) with hr_employees row can book a room', async () => {
      const roomId = await seedRoom();
      const dto = await withTestTenant(async () =>
        bookingService.create(
          {
            roomId,
            bookingPurpose: 'Parent meeting',
            startAt: '2027-03-16T13:00:00.000Z',
            endAt: '2027-03-16T14:00:00.000Z',
          } as any,
          teacherActor(),
        ),
      );
      bookingIds.push(dto.id);
      expect(dto.status).toBe('CONFIRMED');
      expect(dto.bookedById).toBe(TEST_TEACHER_EMPLOYEE_ID);
    });

    it('non-employee (student persona) → ForbiddenException', async () => {
      const roomId = await seedRoom();
      await expect(
        withTestTenant(
          async () =>
            bookingService.create(
              {
                roomId,
                bookingPurpose: 'cannot',
                startAt: '2027-03-17T13:00:00.000Z',
                endAt: '2027-03-17T14:00:00.000Z',
              } as any,
              studentActor(),
            ),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('endAt <= startAt → BadRequestException', async () => {
      const roomId = await seedRoom();
      await expect(
        withTestTenant(async () =>
          bookingService.create(
            {
              roomId,
              bookingPurpose: 'invalid',
              startAt: '2027-03-15T14:00:00.000Z',
              endAt: '2027-03-15T13:00:00.000Z',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('overlapping CONFIRMED booking → ConflictException (double-booking rejected)', async () => {
      const roomId = await seedRoom();
      const first = await withTestTenant(async () =>
        bookingService.create(
          {
            roomId,
            bookingPurpose: 'First',
            startAt: '2027-03-20T10:00:00.000Z',
            endAt: '2027-03-20T11:00:00.000Z',
          } as any,
          adminActor(),
        ),
      );
      bookingIds.push(first.id);

      // Overlaps the same window.
      await expect(
        withTestTenant(async () =>
          bookingService.create(
            {
              roomId,
              bookingPurpose: 'Second',
              startAt: '2027-03-20T10:30:00.000Z',
              endAt: '2027-03-20T11:30:00.000Z',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('non-overlapping bookings on the same room both succeed', async () => {
      const roomId = await seedRoom();
      const a = await withTestTenant(async () =>
        bookingService.create(
          {
            roomId,
            bookingPurpose: 'Morning',
            startAt: '2027-03-21T08:00:00.000Z',
            endAt: '2027-03-21T09:00:00.000Z',
          } as any,
          adminActor(),
        ),
      );
      bookingIds.push(a.id);
      const b = await withTestTenant(async () =>
        bookingService.create(
          {
            roomId,
            bookingPurpose: 'Afternoon',
            startAt: '2027-03-21T13:00:00.000Z',
            endAt: '2027-03-21T14:00:00.000Z',
          } as any,
          adminActor(),
        ),
      );
      bookingIds.push(b.id);
      expect(a.status).toBe('CONFIRMED');
      expect(b.status).toBe('CONFIRMED');
    });
  });

  describe('RoomBookingService.cancel', () => {
    it('admin cancels a CONFIRMED booking → status=CANCELLED + reason set', async () => {
      const roomId = await seedRoom();
      const booking = await withTestTenant(async () =>
        bookingService.create(
          {
            roomId,
            bookingPurpose: 'to-cancel',
            startAt: '2027-04-01T10:00:00.000Z',
            endAt: '2027-04-01T11:00:00.000Z',
          } as any,
          adminActor(),
        ),
      );
      bookingIds.push(booking.id);
      const cancelled = await withTestTenant(async () =>
        bookingService.cancel(
          booking.id,
          { cancelledReason: 'changed plans' } as any,
          adminActor(),
        ),
      );
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.cancelledAt).not.toBeNull();
      expect(cancelled.cancelledReason).toBe('changed plans');
    });

    it('original booker can cancel their own booking', async () => {
      const roomId = await seedRoom();
      const booking = await withTestTenant(async () =>
        bookingService.create(
          {
            roomId,
            bookingPurpose: 'teacher-booked',
            startAt: '2027-04-02T10:00:00.000Z',
            endAt: '2027-04-02T11:00:00.000Z',
          } as any,
          teacherActor(),
        ),
      );
      bookingIds.push(booking.id);
      const cancelled = await withTestTenant(async () =>
        bookingService.cancel(booking.id, {} as any, teacherActor()),
      );
      expect(cancelled.status).toBe('CANCELLED');
    });

    it('already-CANCELLED booking → BadRequestException', async () => {
      const roomId = await seedRoom();
      const booking = await withTestTenant(async () =>
        bookingService.create(
          {
            roomId,
            bookingPurpose: 'twice-cancel',
            startAt: '2027-04-03T10:00:00.000Z',
            endAt: '2027-04-03T11:00:00.000Z',
          } as any,
          adminActor(),
        ),
      );
      bookingIds.push(booking.id);
      await withTestTenant(async () => bookingService.cancel(booking.id, {} as any, adminActor()));
      await expect(
        withTestTenant(async () => bookingService.cancel(booking.id, {} as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cancelling a booking frees the room for a new overlapping booking', async () => {
      const roomId = await seedRoom();
      const first = await withTestTenant(async () =>
        bookingService.create(
          {
            roomId,
            bookingPurpose: 'first',
            startAt: '2027-04-04T10:00:00.000Z',
            endAt: '2027-04-04T11:00:00.000Z',
          } as any,
          adminActor(),
        ),
      );
      bookingIds.push(first.id);
      await withTestTenant(async () => bookingService.cancel(first.id, {} as any, adminActor()));
      // Now a new overlapping booking should succeed because the first is
      // CANCELLED and the conflict-check filters on status='CONFIRMED'.
      const second = await withTestTenant(async () =>
        bookingService.create(
          {
            roomId,
            bookingPurpose: 'replacement',
            startAt: '2027-04-04T10:30:00.000Z',
            endAt: '2027-04-04T11:30:00.000Z',
          } as any,
          adminActor(),
        ),
      );
      bookingIds.push(second.id);
      expect(second.status).toBe('CONFIRMED');
    });
  });

  describe('RoomBookingService.list', () => {
    it('roomId filter only returns that room', async () => {
      const roomA = await seedRoom({ name: 'List Room A' });
      const roomB = await seedRoom({ name: 'List Room B' });
      const a = await withTestTenant(async () =>
        bookingService.create(
          {
            roomId: roomA,
            bookingPurpose: 'A',
            startAt: '2027-05-01T10:00:00.000Z',
            endAt: '2027-05-01T11:00:00.000Z',
          } as any,
          adminActor(),
        ),
      );
      bookingIds.push(a.id);
      const b = await withTestTenant(async () =>
        bookingService.create(
          {
            roomId: roomB,
            bookingPurpose: 'B',
            startAt: '2027-05-01T10:00:00.000Z',
            endAt: '2027-05-01T11:00:00.000Z',
          } as any,
          adminActor(),
        ),
      );
      bookingIds.push(b.id);

      const onlyA = await withTestTenant(async () => bookingService.list({ roomId: roomA } as any));
      const ids = onlyA.map((r) => r.id);
      expect(ids).toContain(a.id);
      expect(ids).not.toContain(b.id);
    });

    it('status filter returns only matching status rows', async () => {
      const roomId = await seedRoom();
      const confirmed = await withTestTenant(async () =>
        bookingService.create(
          {
            roomId,
            bookingPurpose: 'kept',
            startAt: '2027-06-01T10:00:00.000Z',
            endAt: '2027-06-01T11:00:00.000Z',
          } as any,
          adminActor(),
        ),
      );
      bookingIds.push(confirmed.id);
      const toCancel = await withTestTenant(async () =>
        bookingService.create(
          {
            roomId,
            bookingPurpose: 'cancelled',
            startAt: '2027-06-02T10:00:00.000Z',
            endAt: '2027-06-02T11:00:00.000Z',
          } as any,
          adminActor(),
        ),
      );
      bookingIds.push(toCancel.id);
      await withTestTenant(async () => bookingService.cancel(toCancel.id, {} as any, adminActor()));

      const confirmedList = await withTestTenant(async () =>
        bookingService.list({ status: 'CONFIRMED' } as any),
      );
      const cancelledList = await withTestTenant(async () =>
        bookingService.list({ status: 'CANCELLED' } as any),
      );
      expect(confirmedList.map((b) => b.id)).toContain(confirmed.id);
      expect(confirmedList.map((b) => b.id)).not.toContain(toCancel.id);
      expect(cancelledList.map((b) => b.id)).toContain(toCancel.id);
      expect(cancelledList.map((b) => b.id)).not.toContain(confirmed.id);
    });
  });
});
