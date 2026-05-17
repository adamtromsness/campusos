import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { CreateSlotsDto, MeetingSlotResponseDto } from './dto/meeting.dto';
import { MeetingService } from './meeting.service';

interface SlotRow {
  id: string;
  meeting_id: string;
  start_time: string;
  end_time: string;
  is_booked: boolean;
  booked_by: string | null;
  booked_by_name: string | null;
  booked_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_SLOT =
  'SELECT s.id::text AS id, s.meeting_id::text AS meeting_id, ' +
  'TO_CHAR(s.start_time, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS start_time, ' +
  'TO_CHAR(s.end_time, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS end_time, ' +
  's.is_booked, s.booked_by::text AS booked_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.platform_users pu " +
  '  JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
  '  WHERE pu.id = s.booked_by) AS booked_by_name, ' +
  'TO_CHAR(s.booked_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS booked_at, ' +
  's.notes, ' +
  'TO_CHAR(s.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(s.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM mtg_meeting_slots s ';

function rowToDto(r: SlotRow): MeetingSlotResponseDto {
  return {
    id: r.id,
    meetingId: r.meeting_id,
    startTime: r.start_time,
    endTime: r.end_time,
    isBooked: r.is_booked,
    bookedBy: r.booked_by,
    bookedByName: r.booked_by_name,
    bookedAt: r.booked_at,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class SlotService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly meetings: MeetingService,
  ) {}

  /**
   * REVIEW-CYCLE15 BLOCKING 2. Slot listing strips other parents'
   * booking identity. Only the meeting organiser, school admins, and
   * the booker themselves see booked_by + booked_by_name + booked_at
   * + booking notes. Other readers see is_booked but the row's
   * identity columns are nulled out so a parent cannot enumerate
   * which other parents booked which conference slots.
   */
  async listForMeeting(meetingId: string, actor: ResolvedActor): Promise<MeetingSlotResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_SLOT + 'WHERE s.meeting_id = $1::uuid ORDER BY s.start_time ASC',
        meetingId,
      );
    })) as SlotRow[];

    // Resolve whether the actor is the meeting organiser. Admins
    // bypass automatically. Everyone else gets the privacy-stripped
    // projection unless they are the booker of a particular row.
    let isOrganiser = false;
    if (!actor.isSchoolAdmin) {
      const owners = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT organiser_id::text AS organiser_id FROM mtg_meetings WHERE id = $1::uuid',
          meetingId,
        );
      })) as Array<{ organiser_id: string }>;
      isOrganiser = owners.length > 0 && owners[0]!.organiser_id === actor.accountId;
    }
    const fullVisibility = actor.isSchoolAdmin || isOrganiser;

    return rows.map((r) => {
      const dto = rowToDto(r);
      if (fullVisibility) return dto;
      const isMine = !!dto.bookedBy && dto.bookedBy === actor.accountId;
      if (isMine) return dto;
      // Strip identity columns for other-parent bookings
      return {
        ...dto,
        bookedBy: null,
        bookedByName: null,
        bookedAt: null,
        notes: null,
      };
    });
  }

  async createBulk(
    meetingId: string,
    input: CreateSlotsDto,
    actor: ResolvedActor,
  ): Promise<MeetingSlotResponseDto[]> {
    await this.meetings.assertOrganiserOrAdmin(meetingId, actor);
    const created: string[] = [];
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      for (const s of input.slots) {
        if (new Date(s.endTime) <= new Date(s.startTime)) {
          throw new BadRequestException('Slot endTime must be after startTime');
        }
        const id = generateId();
        await tx.$executeRawUnsafe(
          'INSERT INTO mtg_meeting_slots (id, meeting_id, start_time, end_time, is_booked) ' +
            'VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz, false)',
          id,
          meetingId,
          s.startTime,
          s.endTime,
        );
        created.push(id);
      }
    });
    if (created.length === 0) return [];
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_SLOT + 'WHERE s.id = ANY($1::uuid[]) ORDER BY s.start_time ASC',
        created,
      );
    })) as SlotRow[];
    return rows.map(rowToDto);
  }

  /**
   * PARENT BOOKING KEYSTONE. Locks the slot row with SELECT FOR
   * UPDATE inside executeInTenantTransaction so concurrent booking
   * attempts serialise; the loser sees is_booked=true and gets a
   * friendly 400. The booking auto-creates a participant row so
   * the booker appears on the meeting roster.
   *
   * REVIEW-CYCLE15 MAJOR 5. Booking authority is restricted to
   * guardians (parent self-service), school admins, and the meeting
   * organiser (so a teacher running the conference can fill in a
   * slot for a parent who phoned in). Teachers + non-organiser
   * staff cannot use the parent self-service path even though they
   * hold mtg-002:read.
   */
  async book(slotId: string, actor: ResolvedActor): Promise<MeetingSlotResponseDto> {
    let bookedSlotId: string | null = null;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, meeting_id::text AS meeting_id, is_booked, booked_by::text AS booked_by ' +
          'FROM mtg_meeting_slots WHERE id = $1::uuid FOR UPDATE',
        slotId,
      )) as Array<{
        id: string;
        meeting_id: string;
        is_booked: boolean;
        booked_by: string | null;
      }>;
      if (lock.length === 0) throw new NotFoundException('Slot not found');

      // Booking authority: GUARDIAN (parent self-service) OR admin
      // OR the meeting organiser. Everyone else is refused even if
      // they hold mtg-002:read.
      if (actor.personType !== 'GUARDIAN' && !actor.isSchoolAdmin) {
        const m = (await tx.$queryRawUnsafe(
          'SELECT organiser_id::text AS organiser_id FROM mtg_meetings WHERE id = $1::uuid',
          lock[0]!.meeting_id,
        )) as Array<{ organiser_id: string }>;
        if (m.length === 0 || m[0]!.organiser_id !== actor.accountId) {
          throw new ForbiddenException(
            'Slot booking is parent self-service. Admins and the meeting organiser can also book on behalf.',
          );
        }
      }

      if (lock[0]!.is_booked) {
        throw new BadRequestException(
          'Slot is already booked' + (lock[0]!.booked_by === actor.accountId ? ' (by you)' : ''),
        );
      }

      // Stamp booked_chk lockstep atomically
      await tx.$executeRawUnsafe(
        'UPDATE mtg_meeting_slots SET is_booked = true, booked_by = $1::uuid, booked_at = now(), updated_at = now() WHERE id = $2::uuid',
        actor.accountId,
        slotId,
      );

      // Auto-create participant row so the booker appears on the
      // meeting roster. Idempotent via ON CONFLICT.
      await tx.$executeRawUnsafe(
        'INSERT INTO mtg_meeting_participants (id, meeting_id, participant_id, role) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, 'ATTENDEE') " +
          'ON CONFLICT (meeting_id, participant_id) DO NOTHING',
        generateId(),
        lock[0]!.meeting_id,
        actor.accountId,
      );

      bookedSlotId = lock[0]!.id;
    });

    if (!bookedSlotId) throw new NotFoundException('Slot not found');
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_SLOT + 'WHERE s.id = $1::uuid', bookedSlotId);
    })) as SlotRow[];
    return rowToDto(rows[0]!);
  }

  async cancel(slotId: string, actor: ResolvedActor): Promise<MeetingSlotResponseDto> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, meeting_id::text AS meeting_id, is_booked, booked_by::text AS booked_by ' +
          'FROM mtg_meeting_slots WHERE id = $1::uuid FOR UPDATE',
        slotId,
      )) as Array<{
        id: string;
        meeting_id: string;
        is_booked: boolean;
        booked_by: string | null;
      }>;
      if (lock.length === 0) throw new NotFoundException('Slot not found');
      if (!lock[0]!.is_booked) {
        throw new BadRequestException('Slot is not currently booked');
      }
      // Cancel scope: the parent who booked it OR the meeting organiser/admin
      const isBooker = lock[0]!.booked_by === actor.accountId;
      let isOrganiserOrAdmin = actor.isSchoolAdmin;
      if (!isOrganiserOrAdmin) {
        const m = (await tx.$queryRawUnsafe(
          'SELECT organiser_id::text AS organiser_id FROM mtg_meetings WHERE id = $1::uuid',
          lock[0]!.meeting_id,
        )) as Array<{ organiser_id: string }>;
        isOrganiserOrAdmin = m.length > 0 && m[0]!.organiser_id === actor.accountId;
      }
      if (!isBooker && !isOrganiserOrAdmin) {
        throw new ForbiddenException(
          'Only the booking parent or the meeting organiser can cancel this slot',
        );
      }
      const previousBooker = lock[0]!.booked_by;
      await tx.$executeRawUnsafe(
        'UPDATE mtg_meeting_slots SET is_booked = false, booked_by = NULL, booked_at = NULL, updated_at = now() WHERE id = $1::uuid',
        slotId,
      );
      // Remove the auto-created participant row for the cancelled
      // booker. Skip if they were already a participant outside
      // this booking (rare but possible).
      if (previousBooker) {
        const otherSlots = (await tx.$queryRawUnsafe(
          'SELECT 1 FROM mtg_meeting_slots WHERE meeting_id = $1::uuid AND booked_by = $2::uuid AND id <> $3::uuid LIMIT 1',
          lock[0]!.meeting_id,
          previousBooker,
          slotId,
        )) as Array<unknown>;
        if (otherSlots.length === 0) {
          await tx.$executeRawUnsafe(
            'DELETE FROM mtg_meeting_participants WHERE meeting_id = $1::uuid AND participant_id = $2::uuid',
            lock[0]!.meeting_id,
            previousBooker,
          );
        }
      }
    });

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_SLOT + 'WHERE s.id = $1::uuid', slotId);
    })) as SlotRow[];
    return rowToDto(rows[0]!);
  }
}
