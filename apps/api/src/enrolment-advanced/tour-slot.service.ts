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
import { PermissionCheckService } from '../iam/permission-check.service';
import { CreateTourSlotDto, TourSlotResponseDto, UpdateTourSlotDto } from './dto/tour.dto';

interface TourSlotRow {
  id: string;
  school_id: string;
  tour_date: string;
  start_time: string;
  end_time: string;
  max_bookings: number;
  current_bookings: number;
  tour_type: string;
  led_by: string | null;
  led_by_first_name: string | null;
  led_by_last_name: string | null;
  meeting_point: string | null;
  notes: string | null;
  is_published: boolean;
  is_cancelled: boolean;
  created_at: string;
  updated_at: string;
}

const SELECT_SLOT_BASE =
  'SELECT s.id, s.school_id, s.tour_date::text AS tour_date, s.start_time::text AS start_time, ' +
  '       s.end_time::text AS end_time, s.max_bookings, s.current_bookings, s.tour_type, ' +
  '       s.led_by, p.first_name AS led_by_first_name, p.last_name AS led_by_last_name, ' +
  '       s.meeting_point, s.notes, s.is_published, s.is_cancelled, ' +
  '       s.created_at::text AS created_at, s.updated_at::text AS updated_at ' +
  'FROM enr_tour_slots s ' +
  'LEFT JOIN hr_employees e ON e.id = s.led_by ' +
  'LEFT JOIN platform.iam_person p ON p.id = e.person_id ';

function rowToDto(r: TourSlotRow): TourSlotResponseDto {
  const ledName =
    r.led_by_first_name && r.led_by_last_name
      ? r.led_by_first_name + ' ' + r.led_by_last_name
      : null;
  return {
    id: r.id,
    schoolId: r.school_id,
    tourDate: r.tour_date,
    startTime: r.start_time,
    endTime: r.end_time,
    maxBookings: r.max_bookings,
    currentBookings: r.current_bookings,
    availableSpots: Math.max(0, r.max_bookings - r.current_bookings),
    tourType: r.tour_type as TourSlotResponseDto['tourType'],
    ledByEmployeeId: r.led_by,
    ledByName: ledName,
    meetingPoint: r.meeting_point,
    notes: r.notes,
    isPublished: r.is_published,
    isCancelled: r.is_cancelled,
    isFull: r.current_bookings >= r.max_bookings,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * TourSlotService — campus tour slot management.
 *
 * Authorisation contract:
 *   - listPublic — public (no auth). Returns published, non-cancelled,
 *     non-full slots in the future. The TourBookingController passes
 *     the slot id straight through to TourBookingService.create which
 *     enforces capacity inside a locked tx.
 *   - listAdmin — admin or stu-003:read holder. Returns every slot
 *     including drafts, cancelled, and past slots.
 *   - create / patch — admin only (sch-001:admin OR stu-003:admin).
 */
@Injectable()
export class TourSlotService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-003:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Tour slot management requires stu-003:admin or sch-001:admin');
    }
  }

  /** Public — published + future + non-cancelled + non-full. */
  async listPublic(): Promise<TourSlotResponseDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_SLOT_BASE +
          'WHERE s.school_id = $1::uuid ' +
          '  AND s.is_published = true ' +
          '  AND s.is_cancelled = false ' +
          '  AND s.tour_date >= CURRENT_DATE ' +
          '  AND s.current_bookings < s.max_bookings ' +
          'ORDER BY s.tour_date, s.start_time',
        tenant.schoolId,
      )) as TourSlotRow[];
      return rows.map(rowToDto);
    });
  }

  /** Admin — every slot. */
  async listAdmin(actor: ResolvedActor): Promise<TourSlotResponseDto[]> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_SLOT_BASE +
          'WHERE s.school_id = $1::uuid ' +
          'ORDER BY s.tour_date DESC, s.start_time',
        tenant.schoolId,
      )) as TourSlotRow[];
      return rows.map(rowToDto);
    });
  }

  async getById(id: string): Promise<TourSlotResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return (await client.$queryRawUnsafe(
        SELECT_SLOT_BASE + 'WHERE s.school_id = $1::uuid AND s.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as TourSlotRow[];
    });
    if (rows.length === 0) throw new NotFoundException('Tour slot not found');
    return rowToDto(rows[0] as TourSlotRow);
  }

  async create(input: CreateTourSlotDto, actor: ResolvedActor): Promise<TourSlotResponseDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    const max = input.maxBookings ?? 1;
    const tourType = input.tourType ?? 'INDIVIDUAL_FAMILY_TOUR';
    if (input.endTime <= input.startTime) {
      throw new BadRequestException('endTime must be after startTime');
    }
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO enr_tour_slots ' +
            '(id, school_id, tour_date, start_time, end_time, max_bookings, current_bookings, tour_type, led_by, meeting_point, notes, is_published) ' +
            'VALUES ($1::uuid, $2::uuid, $3::date, $4::time, $5::time, $6, 0, $7, $8::uuid, $9, $10, $11)',
          id,
          tenant.schoolId,
          input.tourDate,
          input.startTime,
          input.endTime,
          max,
          tourType,
          input.ledByEmployeeId ?? null,
          input.meetingPoint ?? null,
          input.notes ?? null,
          input.isPublished ?? false,
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'A tour slot already exists at this date and start time. Pick a different time.',
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  async patch(
    id: string,
    input: UpdateTourSlotDto,
    actor: ResolvedActor,
  ): Promise<TourSlotResponseDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT id FROM enr_tour_slots WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string }>;
      if (rows.length === 0) throw new NotFoundException('Tour slot not found');
      const sets: string[] = ['updated_at = now()'];
      const args: unknown[] = [];
      if (input.isPublished !== undefined) {
        sets.push('is_published = $' + (args.length + 1));
        args.push(input.isPublished);
      }
      if (input.isCancelled !== undefined) {
        sets.push('is_cancelled = $' + (args.length + 1));
        args.push(input.isCancelled);
      }
      if (input.meetingPoint !== undefined) {
        sets.push('meeting_point = $' + (args.length + 1));
        args.push(input.meetingPoint);
      }
      if (input.notes !== undefined) {
        sets.push('notes = $' + (args.length + 1));
        args.push(input.notes);
      }
      if (input.ledByEmployeeId !== undefined) {
        sets.push('led_by = $' + (args.length + 1) + '::uuid');
        args.push(input.ledByEmployeeId);
      }
      if (sets.length === 1) return;
      args.push(id);
      await tx.$executeRawUnsafe(
        'UPDATE enr_tour_slots SET ' + sets.join(', ') + ' WHERE id = $' + args.length + '::uuid',
        ...args,
      );
    });
    return this.getById(id);
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  if (e.code === '23505') return true;
  const meta = e.meta as Record<string, unknown> | undefined;
  if (meta && meta.code === '23505') return true;
  const msg = typeof e.message === 'string' ? e.message : '';
  return msg.includes('duplicate key') || msg.includes('unique constraint');
}
