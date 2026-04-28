import {
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
  CreateDayOverrideDto,
  DayOverrideResponseDto,
  ListDayOverridesQueryDto,
} from './dto/calendar.dto';

interface OverrideRow {
  id: string;
  school_id: string;
  override_date: string;
  bell_schedule_id: string | null;
  bell_schedule_name: string | null;
  is_school_day: boolean;
  reason: string | null;
  created_at: string;
}

function rowToDto(row: OverrideRow): DayOverrideResponseDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    overrideDate: row.override_date,
    bellScheduleId: row.bell_schedule_id,
    bellScheduleName: row.bell_schedule_name,
    isSchoolDay: row.is_school_day,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

var SELECT_OVERRIDE_BASE =
  'SELECT o.id, o.school_id, ' +
  "TO_CHAR(o.override_date, 'YYYY-MM-DD') AS override_date, " +
  'o.bell_schedule_id, bs.name AS bell_schedule_name, o.is_school_day, o.reason, o.created_at ' +
  'FROM sch_calendar_day_overrides o ' +
  'LEFT JOIN sch_bell_schedules bs ON bs.id = o.bell_schedule_id ';

@Injectable()
export class DayOverrideService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(query: ListDayOverridesQueryDto): Promise<DayOverrideResponseDto[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<OverrideRow[]>(
        SELECT_OVERRIDE_BASE +
          'WHERE ($1::date IS NULL OR o.override_date >= $1::date) ' +
          'AND ($2::date IS NULL OR o.override_date <= $2::date) ' +
          'ORDER BY o.override_date',
        query.fromDate ?? null,
        query.toDate ?? null,
      );
    });
    return rows.map(rowToDto);
  }

  async create(body: CreateDayOverrideDto, actor: ResolvedActor): Promise<DayOverrideResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can create day overrides');
    }
    var schoolId = getCurrentTenant().schoolId;
    var existing = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM sch_calendar_day_overrides WHERE school_id = $1::uuid AND override_date = $2::date',
        schoolId,
        body.overrideDate,
      );
    });
    if (existing.length > 0) {
      throw new ConflictException(
        'A day override already exists for ' + body.overrideDate + ' — DELETE it first',
      );
    }
    var overrideId = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO sch_calendar_day_overrides (id, school_id, override_date, bell_schedule_id, is_school_day, reason, created_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3::date, $4::uuid, $5, $6, $7::uuid)',
        overrideId,
        schoolId,
        body.overrideDate,
        body.bellScheduleId ?? null,
        body.isSchoolDay !== false,
        body.reason ?? null,
        actor.accountId,
      );
    });
    return this.getByDate(body.overrideDate);
  }

  async deleteByDate(overrideDate: string, actor: ResolvedActor): Promise<{ deleted: boolean }> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can delete day overrides');
    }
    var schoolId = getCurrentTenant().schoolId;
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'DELETE FROM sch_calendar_day_overrides WHERE school_id = $1::uuid AND override_date = $2::date',
        schoolId,
        overrideDate,
      );
    });
    if (rows === 0) {
      throw new NotFoundException('No day override for ' + overrideDate);
    }
    return { deleted: true };
  }

  async getByDate(overrideDate: string): Promise<DayOverrideResponseDto> {
    var schoolId = getCurrentTenant().schoolId;
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<OverrideRow[]>(
        SELECT_OVERRIDE_BASE + 'WHERE o.school_id = $1::uuid AND o.override_date = $2::date',
        schoolId,
        overrideDate,
      );
    });
    if (rows.length === 0) {
      throw new NotFoundException('No day override for ' + overrideDate);
    }
    return rowToDto(rows[0]!);
  }
}
