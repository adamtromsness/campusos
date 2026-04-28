import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  CancelRoomBookingDto,
  CreateRoomBookingDto,
  ListRoomBookingsQueryDto,
  RoomBookingResponseDto,
} from './dto/room-booking.dto';

interface BookingRow {
  id: string;
  school_id: string;
  room_id: string;
  room_name: string;
  booked_by: string;
  booked_by_first_name: string | null;
  booked_by_last_name: string | null;
  booking_purpose: string;
  start_at: string;
  end_at: string;
  status: string;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  created_at: string;
}

function rowToDto(row: BookingRow): RoomBookingResponseDto {
  var bookedByName: string | null = null;
  if (row.booked_by_first_name && row.booked_by_last_name) {
    bookedByName = row.booked_by_first_name + ' ' + row.booked_by_last_name;
  }
  return {
    id: row.id,
    schoolId: row.school_id,
    roomId: row.room_id,
    roomName: row.room_name,
    bookedById: row.booked_by,
    bookedByName: bookedByName,
    bookingPurpose: row.booking_purpose,
    startAt: row.start_at,
    endAt: row.end_at,
    status: row.status as RoomBookingResponseDto['status'],
    cancelledAt: row.cancelled_at,
    cancelledReason: row.cancelled_reason,
    createdAt: row.created_at,
  };
}

var SELECT_BOOKING_BASE =
  'SELECT b.id, b.school_id, b.room_id, r.name AS room_name, ' +
  'b.booked_by, ip.first_name AS booked_by_first_name, ip.last_name AS booked_by_last_name, ' +
  'b.booking_purpose, b.start_at, b.end_at, b.status, ' +
  'b.cancelled_at, b.cancelled_reason, b.created_at ' +
  'FROM sch_room_bookings b ' +
  'JOIN sch_rooms r ON r.id = b.room_id ' +
  'LEFT JOIN hr_employees e ON e.id = b.booked_by ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = e.person_id ';

@Injectable()
export class RoomBookingService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(query: ListRoomBookingsQueryDto): Promise<RoomBookingResponseDto[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<BookingRow[]>(
        SELECT_BOOKING_BASE +
          'WHERE ($1::uuid IS NULL OR b.room_id = $1::uuid) ' +
          'AND ($2::text IS NULL OR b.status = $2::text) ' +
          'AND ($3::date IS NULL OR b.start_at >= $3::date) ' +
          "AND ($4::date IS NULL OR b.start_at < ($4::date + INTERVAL '1 day')) " +
          'ORDER BY b.start_at',
        query.roomId ?? null,
        query.status ?? null,
        query.fromDate ?? null,
        query.toDate ?? null,
      );
    });
    return rows.map(rowToDto);
  }

  async getById(id: string): Promise<RoomBookingResponseDto> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<BookingRow[]>(
        SELECT_BOOKING_BASE + 'WHERE b.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Room booking ' + id + ' not found');
    return rowToDto(rows[0]!);
  }

  /**
   * Create a CONFIRMED booking. Cross-checks against existing CONFIRMED
   * bookings in the same window AND against active timetable slots whose
   * period clock-time overlaps the booking window. The schema does not
   * enforce booking-vs-slot conflict, so this app-layer check is the gate.
   */
  async create(
    body: CreateRoomBookingDto,
    actor: ResolvedActor,
  ): Promise<RoomBookingResponseDto> {
    if (!actor.employeeId && !actor.isSchoolAdmin) {
      throw new ForbiddenException(
        'Only employees can book rooms — non-staff personas have no booking identity',
      );
    }
    var startAt = new Date(body.startAt);
    var endAt = new Date(body.endAt);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      throw new BadRequestException('startAt and endAt must be valid ISO 8601 timestamps');
    }
    if (endAt <= startAt) {
      throw new BadRequestException('endAt must be strictly after startAt');
    }

    var schoolId = getCurrentTenant().schoolId;
    var bookedById = actor.employeeId;
    if (!bookedById) {
      // Admin (e.g. Platform Admin synthetic persona) without an
      // hr_employees row tries to book — fall back to looking up an
      // employee row keyed on the account if any exists.
      var fallbackRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT id FROM hr_employees WHERE account_id = $1::uuid LIMIT 1',
          actor.accountId,
        );
      });
      bookedById = fallbackRows[0]?.id ?? null;
      if (!bookedById) {
        throw new ForbiddenException(
          'Bookings require an hr_employees row linked to the calling user',
        );
      }
    }

    await this.assertNoConflicts(body.roomId, body.startAt, body.endAt, null);

    var bookingId = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO sch_room_bookings (id, school_id, room_id, booked_by, booking_purpose, start_at, end_at, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::timestamptz, $7::timestamptz, 'CONFIRMED')",
        bookingId,
        schoolId,
        body.roomId,
        bookedById,
        body.bookingPurpose,
        body.startAt,
        body.endAt,
      );
    });
    return this.getById(bookingId);
  }

  async cancel(
    id: string,
    body: CancelRoomBookingDto,
    actor: ResolvedActor,
  ): Promise<RoomBookingResponseDto> {
    var existing = await this.getById(id);
    if (existing.status === 'CANCELLED') {
      throw new BadRequestException('Booking is already CANCELLED');
    }
    if (!actor.isSchoolAdmin && actor.employeeId !== existing.bookedById) {
      throw new ForbiddenException(
        'Only the original booker or an admin can cancel this booking',
      );
    }
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        "UPDATE sch_room_bookings SET status = 'CANCELLED', cancelled_at = now(), cancelled_reason = $1, updated_at = now() WHERE id = $2::uuid",
        body.cancelledReason ?? null,
        id,
      );
    });
    return this.getById(id);
  }

  /**
   * Reject a request if the room is already taken in the requested window.
   * Two conflict sources: existing CONFIRMED bookings whose time range
   * overlaps; and active timetable slots whose period start/end on the
   * matching weekday overlaps the booking window.
   */
  private async assertNoConflicts(
    roomId: string,
    startAt: string,
    endAt: string,
    excludeBookingId: string | null,
  ): Promise<void> {
    var conflicts = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var bookingHits = await client.$queryRawUnsafe<Array<{ id: string }>>(
        "SELECT id FROM sch_room_bookings WHERE status = 'CONFIRMED' AND room_id = $1::uuid " +
          'AND start_at < $3::timestamptz AND end_at > $2::timestamptz ' +
          'AND ($4::uuid IS NULL OR id <> $4::uuid) ' +
          'LIMIT 1',
        roomId,
        startAt,
        endAt,
        excludeBookingId,
      );
      if (bookingHits.length > 0) {
        return { kind: 'booking', id: bookingHits[0]!.id };
      }
      // Day-overlap check: a timetable slot whose period clock-time on the
      // booking's weekday overlaps the booking window. The slot's date range
      // must also cover the booking's date.
      var slotHits = await client.$queryRawUnsafe<
        Array<{ section_code: string; period_name: string }>
      >(
        'SELECT c.section_code, p.name AS period_name ' +
          'FROM sch_timetable_slots s ' +
          'JOIN sch_periods p ON p.id = s.period_id ' +
          'JOIN sis_classes c ON c.id = s.class_id ' +
          'WHERE s.room_id = $1::uuid ' +
          'AND s.effective_from <= $3::date ' +
          'AND (s.effective_to IS NULL OR s.effective_to >= $2::date) ' +
          'AND (p.day_of_week IS NULL OR p.day_of_week = ((EXTRACT(ISODOW FROM $2::timestamptz) - 1)::int)) ' +
          "AND (($2::timestamptz)::time < p.end_time AND ($3::timestamptz)::time > p.start_time) " +
          'LIMIT 1',
        roomId,
        startAt,
        endAt,
      );
      if (slotHits.length > 0) {
        return {
          kind: 'slot',
          label: slotHits[0]!.section_code + ' / ' + slotHits[0]!.period_name,
        };
      }
      return null;
    });
    if (!conflicts) return;
    if (conflicts.kind === 'booking') {
      throw new ConflictException(
        'Room is already booked for an overlapping window (booking ' + conflicts.id + ')',
      );
    }
    throw new ConflictException(
      'Room is in use by the timetable during the requested window: ' +
        conflicts.label,
    );
  }
}
