import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import { assertConferenceAdmin, isUniqueViolation } from './access';
import type {
  ConferenceEventDto,
  ConferenceEventStatus,
  CreateConferenceEventDto,
  UpdateConferenceEventDto,
} from './dto/engagement.dto';

interface ConferenceEventRow {
  id: string;
  school_id: string;
  title: string;
  description: string | null;
  start_date: string;
  end_date: string;
  booking_opens_at: string;
  booking_closes_at: string;
  default_slot_duration_minutes: number;
  default_break_minutes: number;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const ALLOWED_TRANSITIONS: Record<ConferenceEventStatus, ConferenceEventStatus[]> = {
  DRAFT: ['BOOKING_OPEN'],
  BOOKING_OPEN: ['IN_PROGRESS', 'COMPLETED'],
  IN_PROGRESS: ['COMPLETED'],
  COMPLETED: [],
};

@Injectable()
export class ConferenceEventService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private toDto(row: ConferenceEventRow): ConferenceEventDto {
    return {
      id: row.id,
      schoolId: row.school_id,
      title: row.title,
      description: row.description,
      startDate: row.start_date,
      endDate: row.end_date,
      bookingOpensAt: row.booking_opens_at,
      bookingClosesAt: row.booking_closes_at,
      defaultSlotDurationMinutes: Number(row.default_slot_duration_minutes),
      defaultBreakMinutes: Number(row.default_break_minutes),
      status: row.status as ConferenceEventStatus,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private selectBase(extraWhere: string, args: unknown[]): { sql: string; args: unknown[] } {
    const sql =
      `SELECT id::text AS id, school_id::text AS school_id, title, description,
              start_date::text AS start_date, end_date::text AS end_date,
              booking_opens_at::text AS booking_opens_at,
              booking_closes_at::text AS booking_closes_at,
              default_slot_duration_minutes, default_break_minutes, status,
              created_by::text AS created_by,
              created_at::text AS created_at, updated_at::text AS updated_at
       FROM eng_conference_events
       WHERE school_id = $1::uuid ` +
      extraWhere +
      ` ORDER BY start_date DESC, created_at DESC`;
    return { sql, args };
  }

  async list(actor: ResolvedActor, status?: string): Promise<ConferenceEventDto[]> {
    const tenant = getCurrentTenant();
    const args: unknown[] = [tenant.schoolId];
    let where = '';

    // Parents only see BOOKING_OPEN + IN_PROGRESS + COMPLETED events
    // (no DRAFT visibility). Staff/admin see everything.
    if (actor.personType === 'GUARDIAN' || actor.personType === 'STUDENT') {
      where = " AND status <> 'DRAFT'";
    } else if (status) {
      args.push(status);
      where = ' AND status = $2';
    }

    const built = this.selectBase(where, args);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(built.sql, ...built.args);
    })) as ConferenceEventRow[];
    return rows.map((r) => this.toDto(r));
  }

  async getById(actor: ResolvedActor, id: string): Promise<ConferenceEventDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, title, description,
                start_date::text AS start_date, end_date::text AS end_date,
                booking_opens_at::text AS booking_opens_at,
                booking_closes_at::text AS booking_closes_at,
                default_slot_duration_minutes, default_break_minutes, status,
                created_by::text AS created_by,
                created_at::text AS created_at, updated_at::text AS updated_at
         FROM eng_conference_events
         WHERE school_id = $1::uuid AND id = $2::uuid
         LIMIT 1`,
        tenant.schoolId,
        id,
      );
    })) as ConferenceEventRow[];
    if (rows.length === 0) {
      throw new NotFoundException(`Conference event ${id} not found`);
    }
    const row = rows[0]!;
    // Hide DRAFT events from non-staff
    if (
      row.status === 'DRAFT' &&
      (actor.personType === 'GUARDIAN' || actor.personType === 'STUDENT')
    ) {
      throw new NotFoundException(`Conference event ${id} not found`);
    }
    return this.toDto(row);
  }

  async create(actor: ResolvedActor, input: CreateConferenceEventDto): Promise<ConferenceEventDto> {
    await assertConferenceAdmin(actor, this.permCheck, 'Creating a conference event');
    const tenant = getCurrentTenant();

    if (new Date(input.endDate) < new Date(input.startDate)) {
      throw new BadRequestException('endDate must be on or after startDate');
    }
    if (new Date(input.bookingClosesAt) <= new Date(input.bookingOpensAt)) {
      throw new BadRequestException('bookingClosesAt must be after bookingOpensAt');
    }

    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `INSERT INTO eng_conference_events
             (id, school_id, title, description, start_date, end_date,
              booking_opens_at, booking_closes_at,
              default_slot_duration_minutes, default_break_minutes,
              status, created_by)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, $6::date,
                   $7::timestamptz, $8::timestamptz, $9, $10, 'DRAFT', $11::uuid)`,
          id,
          tenant.schoolId,
          input.title.trim(),
          input.description ?? null,
          input.startDate,
          input.endDate,
          input.bookingOpensAt,
          input.bookingClosesAt,
          input.defaultSlotDurationMinutes ?? 10,
          input.defaultBreakMinutes ?? 5,
          actor.accountId,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('Conference event already exists');
      }
      throw err;
    }
    return this.getById(actor, id);
  }

  async patch(
    actor: ResolvedActor,
    id: string,
    input: UpdateConferenceEventDto,
  ): Promise<ConferenceEventDto> {
    await assertConferenceAdmin(actor, this.permCheck, 'Updating a conference event');
    const tenant = getCurrentTenant();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = (await tx.$queryRawUnsafe(
        `SELECT status, start_date::text AS start_date, end_date::text AS end_date,
                booking_opens_at::text AS booking_opens_at,
                booking_closes_at::text AS booking_closes_at
         FROM eng_conference_events
         WHERE school_id = $1::uuid AND id = $2::uuid
         FOR UPDATE`,
        tenant.schoolId,
        id,
      )) as Array<{
        status: string;
        start_date: string;
        end_date: string;
        booking_opens_at: string;
        booking_closes_at: string;
      }>;
      if (locked.length === 0) {
        throw new NotFoundException(`Conference event ${id} not found`);
      }
      const before = locked[0]!;

      // Build merged effective shape for validation
      const startDate = input.startDate ?? before.start_date;
      const endDate = input.endDate ?? before.end_date;
      const bookingOpensAt = input.bookingOpensAt ?? before.booking_opens_at;
      const bookingClosesAt = input.bookingClosesAt ?? before.booking_closes_at;

      if (new Date(endDate) < new Date(startDate)) {
        throw new BadRequestException('endDate must be on or after startDate');
      }
      if (new Date(bookingClosesAt) <= new Date(bookingOpensAt)) {
        throw new BadRequestException('bookingClosesAt must be after bookingOpensAt');
      }

      if (input.status && input.status !== before.status) {
        const allowed = ALLOWED_TRANSITIONS[before.status as ConferenceEventStatus] ?? [];
        if (!allowed.includes(input.status)) {
          throw new BadRequestException(
            `Cannot transition conference event from ${before.status} to ${input.status}. Allowed: ${allowed.join(', ') || 'none'}`,
          );
        }
      }

      const fields: string[] = [];
      const args: unknown[] = [];
      let pos = 1;
      const push = (col: string, val: unknown, cast?: string): void => {
        const placeholder = '$' + pos + (cast ? '::' + cast : '');
        fields.push(`${col} = ${placeholder}`);
        args.push(val);
        pos += 1;
      };
      if (input.title !== undefined) push('title', input.title.trim());
      if (input.description !== undefined) push('description', input.description);
      if (input.startDate !== undefined) push('start_date', input.startDate, 'date');
      if (input.endDate !== undefined) push('end_date', input.endDate, 'date');
      if (input.bookingOpensAt !== undefined)
        push('booking_opens_at', input.bookingOpensAt, 'timestamptz');
      if (input.bookingClosesAt !== undefined)
        push('booking_closes_at', input.bookingClosesAt, 'timestamptz');
      if (input.defaultSlotDurationMinutes !== undefined)
        push('default_slot_duration_minutes', input.defaultSlotDurationMinutes);
      if (input.defaultBreakMinutes !== undefined)
        push('default_break_minutes', input.defaultBreakMinutes);
      if (input.status !== undefined) push('status', input.status);
      fields.push('updated_at = now()');

      if (fields.length === 1) {
        return; // only updated_at — no-op
      }

      const sql =
        'UPDATE eng_conference_events SET ' +
        fields.join(', ') +
        ' WHERE school_id = $' +
        pos +
        '::uuid AND id = $' +
        (pos + 1) +
        '::uuid';
      args.push(tenant.schoolId, id);
      await tx.$executeRawUnsafe(sql, ...args);
    });

    return this.getById(actor, id);
  }
}
