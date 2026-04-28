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
import {
  BellScheduleResponseDto,
  CreateBellScheduleDto,
  PeriodInputDto,
  PeriodResponseDto,
  UpdateBellScheduleDto,
  UpsertPeriodsDto,
} from './dto/bell-schedule.dto';

interface BellScheduleRow {
  id: string;
  school_id: string;
  name: string;
  schedule_type: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

interface PeriodRow {
  id: string;
  bell_schedule_id: string;
  name: string;
  day_of_week: number | null;
  start_time: string;
  end_time: string;
  period_type: string;
  sort_order: number;
}

function bellScheduleRowToDto(row: BellScheduleRow, periods: PeriodRow[]): BellScheduleResponseDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    name: row.name,
    scheduleType: row.schedule_type as BellScheduleResponseDto['scheduleType'],
    isDefault: row.is_default,
    periods: periods
      .filter(function (p) {
        return p.bell_schedule_id === row.id;
      })
      .map(periodRowToDto),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function periodRowToDto(row: PeriodRow): PeriodResponseDto {
  return {
    id: row.id,
    bellScheduleId: row.bell_schedule_id,
    name: row.name,
    dayOfWeek: row.day_of_week,
    startTime: row.start_time,
    endTime: row.end_time,
    periodType: row.period_type as PeriodResponseDto['periodType'],
    sortOrder: Number(row.sort_order),
  };
}

@Injectable()
export class BellScheduleService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * List bell schedules for the current tenant. Includes their periods so the
   * Step 7 editor can render the timeline grid in one round-trip.
   */
  async list(): Promise<BellScheduleResponseDto[]> {
    var result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var schedules = await client.$queryRawUnsafe<BellScheduleRow[]>(
        'SELECT id, school_id, name, schedule_type, is_default, created_at, updated_at ' +
          'FROM sch_bell_schedules ' +
          'ORDER BY is_default DESC, name',
      );
      var ids = schedules.map(function (s) {
        return s.id;
      });
      var periods = await this.loadPeriodsFor(client, ids);
      return { schedules: schedules, periods: periods };
    });
    return result.schedules.map(function (s) {
      return bellScheduleRowToDto(s, result.periods);
    });
  }

  async getById(id: string): Promise<BellScheduleResponseDto> {
    var result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var rows = await client.$queryRawUnsafe<BellScheduleRow[]>(
        'SELECT id, school_id, name, schedule_type, is_default, created_at, updated_at ' +
          'FROM sch_bell_schedules WHERE id = $1::uuid',
        id,
      );
      if (rows.length === 0) return null;
      var periods = await this.loadPeriodsFor(client, [id]);
      return { row: rows[0]!, periods: periods };
    });
    if (!result) throw new NotFoundException('Bell schedule ' + id + ' not found');
    return bellScheduleRowToDto(result.row, result.periods);
  }

  async create(
    body: CreateBellScheduleDto,
    actor: ResolvedActor,
  ): Promise<BellScheduleResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can create bell schedules');
    }
    var schoolId = getCurrentTenant().schoolId;
    var scheduleId = generateId();
    var makeDefault = body.isDefault === true;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      if (makeDefault) {
        await tx.$executeRawUnsafe(
          'UPDATE sch_bell_schedules SET is_default = false, updated_at = now() ' +
            'WHERE school_id = $1::uuid AND is_default = true',
          schoolId,
        );
      }
      await tx.$executeRawUnsafe(
        'INSERT INTO sch_bell_schedules (id, school_id, name, schedule_type, is_default) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
        scheduleId,
        schoolId,
        body.name,
        body.scheduleType,
        makeDefault,
      );
    });
    return this.getById(scheduleId);
  }

  async update(
    id: string,
    body: UpdateBellScheduleDto,
    actor: ResolvedActor,
  ): Promise<BellScheduleResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can update bell schedules');
    }
    var existing = await this.getById(id);

    var setClauses: string[] = [];
    var params: any[] = [];
    var idx = 1;
    if (body.name !== undefined) {
      setClauses.push('name = $' + idx);
      params.push(body.name);
      idx++;
    }
    if (body.scheduleType !== undefined) {
      setClauses.push('schedule_type = $' + idx);
      params.push(body.scheduleType);
      idx++;
    }
    var schoolId = getCurrentTenant().schoolId;
    var flippingToDefault = body.isDefault === true && !existing.isDefault;
    if (body.isDefault !== undefined) {
      setClauses.push('is_default = $' + idx);
      params.push(body.isDefault);
      idx++;
    }
    if (setClauses.length === 0) return existing;

    setClauses.push('updated_at = now()');
    params.push(id);
    var whereIdx = idx;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // If we're flipping this schedule to default, clear any other default
      // first so the partial UNIQUE INDEX(school_id) WHERE is_default doesn't
      // reject the UPDATE.
      if (flippingToDefault) {
        await tx.$executeRawUnsafe(
          'UPDATE sch_bell_schedules SET is_default = false, updated_at = now() ' +
            'WHERE school_id = $1::uuid AND is_default = true AND id <> $2::uuid',
          schoolId,
          id,
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE sch_bell_schedules SET ' +
          setClauses.join(', ') +
          ' WHERE id = $' +
          whereIdx +
          '::uuid',
        ...params,
      );
    });
    return this.getById(id);
  }

  /**
   * Set a bell schedule as the default. Atomically clears any other default
   * inside the same transaction so the partial UNIQUE never rejects the flip.
   */
  async setDefault(id: string, actor: ResolvedActor): Promise<BellScheduleResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can set the default bell schedule');
    }
    var schoolId = getCurrentTenant().schoolId;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var existingRows = (await tx.$queryRawUnsafe(
        'SELECT id FROM sch_bell_schedules WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        schoolId,
      )) as Array<{ id: string }>;
      if (existingRows.length === 0) {
        throw new NotFoundException('Bell schedule ' + id + ' not found');
      }
      await tx.$executeRawUnsafe(
        'UPDATE sch_bell_schedules SET is_default = false, updated_at = now() ' +
          'WHERE school_id = $1::uuid AND is_default = true AND id <> $2::uuid',
        schoolId,
        id,
      );
      await tx.$executeRawUnsafe(
        'UPDATE sch_bell_schedules SET is_default = true, updated_at = now() WHERE id = $1::uuid',
        id,
      );
    });
    return this.getById(id);
  }

  /**
   * Replace the schedule's periods with a supplied set. The whole list is
   * applied as a single transaction: existing rows for this schedule are
   * deleted, then the new ones inserted. Any UNIQUE / CHECK violation aborts
   * the whole replacement so the schedule never lands half-applied.
   */
  async upsertPeriods(
    scheduleId: string,
    body: UpsertPeriodsDto,
    actor: ResolvedActor,
  ): Promise<BellScheduleResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can edit periods');
    }
    if (body.periods.length === 0) {
      throw new BadRequestException('At least one period is required');
    }
    // Validate existence + format up front so we don't acquire a lock just to
    // throw.
    await this.getById(scheduleId);
    body.periods.forEach(function (p: PeriodInputDto) {
      if (p.startTime >= p.endTime) {
        throw new BadRequestException('Period "' + p.name + '" has startTime >= endTime');
      }
    });

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'DELETE FROM sch_periods WHERE bell_schedule_id = $1::uuid',
        scheduleId,
      );
      for (var i = 0; i < body.periods.length; i++) {
        var p = body.periods[i]!;
        await tx.$executeRawUnsafe(
          'INSERT INTO sch_periods (id, bell_schedule_id, name, day_of_week, start_time, end_time, period_type, sort_order) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4::smallint, $5::time, $6::time, $7, $8::int)',
          generateId(),
          scheduleId,
          p.name,
          p.dayOfWeek === undefined || p.dayOfWeek === null ? null : p.dayOfWeek,
          p.startTime,
          p.endTime,
          p.periodType,
          p.sortOrder ?? i,
        );
      }
    });
    return this.getById(scheduleId);
  }

  private async loadPeriodsFor(client: any, scheduleIds: string[]): Promise<PeriodRow[]> {
    if (scheduleIds.length === 0) return [];
    var placeholders = scheduleIds
      .map(function (_: string, i: number) {
        return '$' + (i + 1) + '::uuid';
      })
      .join(',');
    return client.$queryRawUnsafe(
      'SELECT id, bell_schedule_id, name, day_of_week, ' +
        "TO_CHAR(start_time, 'HH24:MI') AS start_time, " +
        "TO_CHAR(end_time, 'HH24:MI') AS end_time, " +
        'period_type, sort_order ' +
        'FROM sch_periods ' +
        'WHERE bell_schedule_id IN (' +
        placeholders +
        ') ' +
        'ORDER BY bell_schedule_id, sort_order, start_time',
      ...scheduleIds,
    );
  }
}
