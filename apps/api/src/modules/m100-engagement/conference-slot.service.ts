import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import { assertConferenceAdmin, isUniqueViolation } from './access';
import type {
  ConferenceSlotDto,
  ConferenceSlotStatus,
  GenerateSlotsDto,
  UpdateSlotDto,
} from './dto/engagement.dto';

interface SlotRow {
  id: string;
  conference_event_id: string;
  school_id: string;
  teacher_id: string;
  teacher_name: string | null;
  slot_date: string;
  start_time: string;
  end_time: string;
  location: string | null;
  meeting_url: string | null;
  status: string;
  max_bookings: number;
  current_bookings: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class ConferenceSlotService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private toDto(row: SlotRow): ConferenceSlotDto {
    return {
      id: row.id,
      conferenceEventId: row.conference_event_id,
      schoolId: row.school_id,
      teacherId: row.teacher_id,
      teacherName: row.teacher_name,
      slotDate: row.slot_date,
      startTime: row.start_time,
      endTime: row.end_time,
      location: row.location,
      meetingUrl: row.meeting_url,
      status: row.status as ConferenceSlotStatus,
      maxBookings: Number(row.max_bookings),
      currentBookings: Number(row.current_bookings),
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private slotSelectSql(): string {
    // REVIEW-P2C24 BLOCKING 2 (defence-in-depth) — the LEFT JOIN on
    // hr_employees ANDs `e.school_id = s.school_id` so a historical row
    // with a foreign-school teacher_id (planted before BLOCKING 2 fix)
    // resolves the teacher name to NULL rather than leaking the
    // cross-school employee's name into the slot DTO.
    return `SELECT s.id::text AS id, s.conference_event_id::text AS conference_event_id,
                   s.school_id::text AS school_id, s.teacher_id::text AS teacher_id,
                   (TRIM(BOTH ' ' FROM COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, ''))) AS teacher_name,
                   s.slot_date::text AS slot_date,
                   s.start_time::text AS start_time, s.end_time::text AS end_time,
                   s.location, s.meeting_url, s.status,
                   s.max_bookings, s.current_bookings, s.notes,
                   s.created_at::text AS created_at, s.updated_at::text AS updated_at
            FROM eng_conference_slots s
            LEFT JOIN hr_employees e
              ON e.id = s.teacher_id AND e.school_id = s.school_id
            LEFT JOIN platform.iam_person p ON p.id = e.person_id`;
  }

  async listForEvent(
    _actor: ResolvedActor,
    eventId: string,
    filters: { teacherId?: string; availableOnly?: boolean } = {},
  ): Promise<ConferenceSlotDto[]> {
    const tenant = getCurrentTenant();
    const args: unknown[] = [tenant.schoolId, eventId];
    let where = ' WHERE s.school_id = $1::uuid AND s.conference_event_id = $2::uuid';
    if (filters.teacherId) {
      args.push(filters.teacherId);
      where += ' AND s.teacher_id = $' + args.length + '::uuid';
    }
    if (filters.availableOnly) {
      where += " AND s.status = 'AVAILABLE'";
    }
    const sql = this.slotSelectSql() + where + ' ORDER BY s.slot_date ASC, s.start_time ASC';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql, ...args);
    })) as SlotRow[];
    return rows.map((r) => this.toDto(r));
  }

  async getById(_actor: ResolvedActor, id: string): Promise<ConferenceSlotDto> {
    const row = await this.loadOrFail(id);
    return this.toDto(row);
  }

  async loadOrFail(id: string): Promise<SlotRow> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        this.slotSelectSql() + ' WHERE s.school_id = $1::uuid AND s.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      );
    })) as SlotRow[];
    if (rows.length === 0) {
      throw new NotFoundException(`Slot ${id} not found`);
    }
    return rows[0]!;
  }

  /**
   * Generate slots for a teacher across a time window. Pure helper —
   * the caller has already authorised the operation. Returns the list
   * of inserted slot ids. Idempotent on (event, teacher, date,
   * start_time) — duplicate slots are skipped via ON CONFLICT.
   */
  async generateSlots(
    actor: ResolvedActor,
    eventId: string,
    input: GenerateSlotsDto,
  ): Promise<ConferenceSlotDto[]> {
    await assertConferenceAdmin(actor, this.permCheck, 'Generating conference slots');
    const tenant = getCurrentTenant();

    // Validate event exists + load defaults
    const evt = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, default_slot_duration_minutes, default_break_minutes, status
         FROM eng_conference_events
         WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1`,
        tenant.schoolId,
        eventId,
      );
    })) as Array<{
      id: string;
      default_slot_duration_minutes: number;
      default_break_minutes: number;
      status: string;
    }>;
    if (evt.length === 0) {
      throw new NotFoundException(`Conference event ${eventId} not found`);
    }
    if (evt[0]!.status === 'COMPLETED') {
      throw new BadRequestException('Cannot generate slots for a COMPLETED conference event');
    }

    const duration = input.slotDurationMinutes ?? Number(evt[0]!.default_slot_duration_minutes);
    const breakMin = input.breakMinutes ?? Number(evt[0]!.default_break_minutes);
    if (duration <= 0) {
      throw new BadRequestException('slotDurationMinutes must be > 0');
    }

    // REVIEW-P2C24 BLOCKING 2 — Validate teacher belongs to THIS school.
    // Prior version checked hr_employees.id only, allowing a multi-school
    // tenant admin to mint slots against a foreign-school employee UUID.
    const teacher = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text FROM hr_employees
         WHERE id = $1::uuid AND school_id = $2::uuid
         LIMIT 1`,
        input.teacherId,
        tenant.schoolId,
      );
    })) as Array<{ id: string }>;
    if (teacher.length === 0) {
      throw new BadRequestException(
        `teacherId ${input.teacherId} does not match an employee in this school`,
      );
    }

    // Walk the window in (duration + break) increments
    const startMin = parseTimeToMinutes(input.startTime);
    const endMin = parseTimeToMinutes(input.endTime);
    if (endMin <= startMin) {
      throw new BadRequestException('endTime must be after startTime');
    }

    const insertedIds: string[] = [];
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      let cur = startMin;
      while (cur + duration <= endMin) {
        const slotStart = formatMinutes(cur);
        const slotEnd = formatMinutes(cur + duration);
        const id = generateId();
        try {
          await tx.$executeRawUnsafe(
            `INSERT INTO eng_conference_slots
               (id, conference_event_id, school_id, teacher_id, slot_date,
                start_time, end_time, location, meeting_url, status,
                max_bookings, current_bookings)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date,
                     $6::time, $7::time, $8, $9, 'AVAILABLE', 1, 0)
             ON CONFLICT ON CONSTRAINT eng_conference_slots_event_teacher_slot_uq DO NOTHING`,
            id,
            eventId,
            tenant.schoolId,
            input.teacherId,
            input.slotDate,
            slotStart,
            slotEnd,
            input.location ?? null,
            input.meetingUrl ?? null,
          );
          insertedIds.push(id);
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
        }
        cur += duration + breakMin;
      }
    });

    return this.listForEvent(actor, eventId, { teacherId: input.teacherId });
  }

  async patch(actor: ResolvedActor, id: string, input: UpdateSlotDto): Promise<ConferenceSlotDto> {
    await assertConferenceAdmin(actor, this.permCheck, 'Updating a conference slot');
    const tenant = getCurrentTenant();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = (await tx.$queryRawUnsafe(
        `SELECT status, current_bookings, max_bookings
         FROM eng_conference_slots
         WHERE school_id = $1::uuid AND id = $2::uuid
         FOR UPDATE`,
        tenant.schoolId,
        id,
      )) as Array<{ status: string; current_bookings: number; max_bookings: number }>;
      if (locked.length === 0) {
        throw new NotFoundException(`Slot ${id} not found`);
      }
      const before = locked[0]!;

      // Refuse status flips on BOOKED slots — admin must cancel the
      // booking first.
      if (input.status && input.status !== before.status && before.status === 'BOOKED') {
        throw new BadRequestException(
          'Cannot change status of a BOOKED slot. Cancel the underlying booking first.',
        );
      }
      if (input.status === 'AVAILABLE' && Number(before.current_bookings) > 0) {
        throw new BadRequestException('Cannot set slot AVAILABLE while current_bookings > 0');
      }

      const fields: string[] = [];
      const args: unknown[] = [];
      let pos = 1;
      if (input.status !== undefined) {
        fields.push(`status = $${pos}`);
        args.push(input.status);
        pos += 1;
      }
      if (input.location !== undefined) {
        fields.push(`location = $${pos}`);
        args.push(input.location);
        pos += 1;
      }
      if (input.meetingUrl !== undefined) {
        fields.push(`meeting_url = $${pos}`);
        args.push(input.meetingUrl);
        pos += 1;
      }
      if (input.notes !== undefined) {
        fields.push(`notes = $${pos}`);
        args.push(input.notes);
        pos += 1;
      }
      fields.push('updated_at = now()');

      if (fields.length === 1) return;

      args.push(tenant.schoolId, id);
      const sql =
        'UPDATE eng_conference_slots SET ' +
        fields.join(', ') +
        ` WHERE school_id = $${pos}::uuid AND id = $${pos + 1}::uuid`;
      await tx.$executeRawUnsafe(sql, ...args);
    });

    return this.getById(actor, id);
  }
}

function parseTimeToMinutes(t: string): number {
  const [h, m] = t.split(':').map((p) => Number(p));
  if (!Number.isFinite(h) || !Number.isFinite(m)) {
    throw new BadRequestException(`Invalid time format: ${t} (expected HH:MM)`);
  }
  return h! * 60 + m!;
}

function formatMinutes(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const pad = (n: number): string => (n < 10 ? '0' + n : String(n));
  return pad(h) + ':' + pad(m);
}
