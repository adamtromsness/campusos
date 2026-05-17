import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import {
  CreateRotationCycleDto,
  GenerateCalendarDto,
  RotationCalendarEntryDto,
  RotationCycleResponseDto,
  RotationDayLookupDto,
  UpdateRotationCycleDto,
  UpsertRotationCalendarDto,
} from './dto/scheduling-advanced.dto';

/*
 * RotationService — P2-17a Step 2.
 *
 * Owns sch_rotation_cycles + sch_rotation_calendar. Admin writes only
 * (sch-001:admin). Generation of the calendar over a date range
 * walks Mon..Fri and assigns rotation_day round-robin across the
 * cycle, skipping closures.
 */

interface CycleRow {
  id: string;
  school_id: string;
  name: string;
  cycle_length: number;
  academic_year_id: string | null;
  is_active: boolean;
  description: string | null;
}

interface CalendarRow {
  id: string;
  rotation_cycle_id: string;
  calendar_date: string;
  rotation_day: number;
  is_school_day: boolean;
  notes: string | null;
}

function cycleRowToDto(row: CycleRow): RotationCycleResponseDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    name: row.name,
    cycleLength: row.cycle_length,
    academicYearId: row.academic_year_id,
    isActive: row.is_active,
    description: row.description,
  };
}

function calendarRowToDto(row: CalendarRow): RotationCalendarEntryDto {
  return {
    id: row.id,
    rotationCycleId: row.rotation_cycle_id,
    calendarDate: row.calendar_date,
    rotationDay: row.rotation_day,
    isSchoolDay: row.is_school_day,
    notes: row.notes,
  };
}

const SELECT_CYCLE_BASE =
  'SELECT id::text AS id, school_id::text AS school_id, name, cycle_length, ' +
  'academic_year_id::text AS academic_year_id, is_active, description ' +
  'FROM sch_rotation_cycles ';

const SELECT_CALENDAR_BASE =
  'SELECT id::text AS id, rotation_cycle_id::text AS rotation_cycle_id, ' +
  "TO_CHAR(calendar_date, 'YYYY-MM-DD') AS calendar_date, " +
  'rotation_day, is_school_day, notes FROM sch_rotation_calendar ';

@Injectable()
export class RotationService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertAdmin(actor: ResolvedActor): void {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException(
        'Rotation cycle / calendar writes require sch-001:admin (school admin).',
      );
    }
  }

  async listCycles(): Promise<RotationCycleResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CycleRow[]>(
        SELECT_CYCLE_BASE + 'WHERE school_id = $1::uuid ORDER BY is_active DESC, name ASC',
        tenant.schoolId,
      );
    });
    return rows.map(cycleRowToDto);
  }

  async getCycle(id: string): Promise<RotationCycleResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CycleRow[]>(
        SELECT_CYCLE_BASE + 'WHERE school_id = $1::uuid AND id = $2::uuid',
        tenant.schoolId,
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Rotation cycle not found');
    return cycleRowToDto(rows[0]!);
  }

  async createCycle(
    body: CreateRotationCycleDto,
    actor: ResolvedActor,
  ): Promise<RotationCycleResponseDto> {
    this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO sch_rotation_cycles (id, school_id, name, cycle_length, academic_year_id, is_active, description) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4::int, $5::uuid, $6, $7)',
          id,
          tenant.schoolId,
          body.name,
          body.cycleLength,
          body.academicYearId ?? null,
          body.isActive ?? true,
          body.description ?? null,
        );
      });
    } catch (e: unknown) {
      const err = e as { code?: string; meta?: { code?: string } };
      if (err.code === 'P2010' || err.meta?.code === '23505') {
        throw new ConflictException('A rotation cycle with this name already exists.');
      }
      throw e;
    }
    return this.getCycle(id);
  }

  async updateCycle(
    id: string,
    body: UpdateRotationCycleDto,
    actor: ResolvedActor,
  ): Promise<RotationCycleResponseDto> {
    this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const updates: string[] = [];
    const args: unknown[] = [];
    let p = 1;
    if (body.name !== undefined) {
      updates.push('name = $' + p);
      args.push(body.name);
      p++;
    }
    if (body.isActive !== undefined) {
      updates.push('is_active = $' + p);
      args.push(body.isActive);
      p++;
    }
    if (body.description !== undefined) {
      updates.push('description = $' + p);
      args.push(body.description);
      p++;
    }
    if (updates.length === 0) return this.getCycle(id);
    updates.push('updated_at = now()');
    args.push(tenant.schoolId, id);
    const result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'UPDATE sch_rotation_cycles SET ' +
          updates.join(', ') +
          ' WHERE school_id = $' +
          p +
          '::uuid AND id = $' +
          (p + 1) +
          '::uuid',
        ...args,
      );
    });
    if (result === 0) throw new NotFoundException('Rotation cycle not found');
    return this.getCycle(id);
  }

  async listCalendar(
    cycleId: string,
    fromDate?: string,
    toDate?: string,
  ): Promise<RotationCalendarEntryDto[]> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CalendarRow[]>(
        SELECT_CALENDAR_BASE +
          'WHERE rotation_cycle_id = $1::uuid ' +
          'AND ($2::date IS NULL OR calendar_date >= $2::date) ' +
          'AND ($3::date IS NULL OR calendar_date <= $3::date) ' +
          'ORDER BY calendar_date ASC',
        cycleId,
        fromDate ?? null,
        toDate ?? null,
      );
    });
    return rows.map(calendarRowToDto);
  }

  async upsertCalendarEntry(
    cycleId: string,
    body: UpsertRotationCalendarDto,
    actor: ResolvedActor,
  ): Promise<RotationCalendarEntryDto> {
    this.assertAdmin(actor);
    // Validate that rotation_day is within the cycle length.
    const cycle = await this.getCycle(cycleId);
    if (body.rotationDay < 1 || body.rotationDay > cycle.cycleLength) {
      throw new BadRequestException(
        'rotationDay must be between 1 and ' + cycle.cycleLength + ' (parent cycle_length).',
      );
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO sch_rotation_calendar (id, rotation_cycle_id, calendar_date, rotation_day, is_school_day, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::date, $4::int, $5, $6) ' +
          'ON CONFLICT (rotation_cycle_id, calendar_date) DO UPDATE SET ' +
          'rotation_day = EXCLUDED.rotation_day, is_school_day = EXCLUDED.is_school_day, notes = EXCLUDED.notes, updated_at = now()',
        id,
        cycleId,
        body.calendarDate,
        body.rotationDay,
        body.isSchoolDay ?? true,
        body.notes ?? null,
      );
    });
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CalendarRow[]>(
        SELECT_CALENDAR_BASE + 'WHERE rotation_cycle_id = $1::uuid AND calendar_date = $2::date',
        cycleId,
        body.calendarDate,
      );
    });
    if (rows.length === 0)
      throw new NotFoundException('Calendar entry could not be loaded after upsert');
    return calendarRowToDto(rows[0]!);
  }

  async deleteCalendarEntry(
    cycleId: string,
    calendarDate: string,
    actor: ResolvedActor,
  ): Promise<{ deleted: boolean }> {
    this.assertAdmin(actor);
    const result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'DELETE FROM sch_rotation_calendar WHERE rotation_cycle_id = $1::uuid AND calendar_date = $2::date',
        cycleId,
        calendarDate,
      );
    });
    if (result === 0) throw new NotFoundException('Calendar entry not found');
    return { deleted: true };
  }

  /**
   * Generate a rotation calendar across [startDate, endDate] for the
   * supplied cycle. Mon..Fri only. Rotation day cycles through 1..N
   * round-robin across school days; closures consume no rotation slot
   * (the next school day picks up where we left off). Re-runnable —
   * ON CONFLICT DO UPDATE updates the row.
   */
  async generateCalendar(
    cycleId: string,
    body: GenerateCalendarDto,
    actor: ResolvedActor,
  ): Promise<{ created: number; updated: number; closed: number }> {
    this.assertAdmin(actor);
    const cycle = await this.getCycle(cycleId);
    const start = new Date(body.startDate + 'T00:00:00Z');
    const end = new Date(body.endDate + 'T00:00:00Z');
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('startDate / endDate must be ISO YYYY-MM-DD');
    }
    if (end < start) throw new BadRequestException('endDate must be on or after startDate');
    const closures = new Set<string>(body.closureDates ?? []);

    let created = 0;
    let updated = 0;
    let closed = 0;
    let rotationCursor = 1;

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      for (
        let cursor = new Date(start);
        cursor.getTime() <= end.getTime();
        cursor.setUTCDate(cursor.getUTCDate() + 1)
      ) {
        const dayOfWeek = cursor.getUTCDay(); // 0=Sun .. 6=Sat
        if (dayOfWeek === 0 || dayOfWeek === 6) continue;
        const iso =
          cursor.getUTCFullYear() +
          '-' +
          String(cursor.getUTCMonth() + 1).padStart(2, '0') +
          '-' +
          String(cursor.getUTCDate()).padStart(2, '0');
        const isClosure = closures.has(iso);
        if (isClosure) {
          await client.$executeRawUnsafe(
            'INSERT INTO sch_rotation_calendar (id, rotation_cycle_id, calendar_date, rotation_day, is_school_day, notes) ' +
              "VALUES ($1::uuid, $2::uuid, $3::date, $4::int, false, 'Closure') " +
              'ON CONFLICT (rotation_cycle_id, calendar_date) DO UPDATE SET is_school_day = false, ' +
              'rotation_day = EXCLUDED.rotation_day, updated_at = now()',
            generateId(),
            cycleId,
            iso,
            rotationCursor,
          );
          closed++;
          continue;
        }
        const beforeUpdate = await client.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT id::text AS id FROM sch_rotation_calendar WHERE rotation_cycle_id = $1::uuid AND calendar_date = $2::date',
          cycleId,
          iso,
        );
        await client.$executeRawUnsafe(
          'INSERT INTO sch_rotation_calendar (id, rotation_cycle_id, calendar_date, rotation_day, is_school_day) ' +
            'VALUES ($1::uuid, $2::uuid, $3::date, $4::int, true) ' +
            'ON CONFLICT (rotation_cycle_id, calendar_date) DO UPDATE SET ' +
            'rotation_day = EXCLUDED.rotation_day, is_school_day = true, updated_at = now()',
          generateId(),
          cycleId,
          iso,
          rotationCursor,
        );
        if (beforeUpdate.length === 0) created++;
        else updated++;
        rotationCursor = (rotationCursor % cycle.cycleLength) + 1;
      }
    });
    return { created, updated, closed };
  }

  /**
   * Lookup the rotation day for a single date. Returns 404 if no
   * calendar entry exists for that (cycle, date) pair.
   */
  async lookupRotationDay(date: string): Promise<RotationDayLookupDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        {
          cycle_id: string;
          rotation_day: number;
          is_school_day: boolean;
        }[]
      >(
        'SELECT c.id::text AS cycle_id, rc.rotation_day, rc.is_school_day ' +
          'FROM sch_rotation_calendar rc ' +
          'JOIN sch_rotation_cycles c ON c.id = rc.rotation_cycle_id ' +
          'WHERE c.school_id = $1::uuid AND c.is_active = true AND rc.calendar_date = $2::date ' +
          'LIMIT 1',
        tenant.schoolId,
        date,
      );
    });
    if (rows.length === 0) throw new NotFoundException('No rotation calendar entry for ' + date);
    return {
      date,
      rotationCycleId: rows[0]!.cycle_id,
      rotationDay: rows[0]!.rotation_day,
      isSchoolDay: rows[0]!.is_school_day,
    };
  }
}
