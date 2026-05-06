import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { ActivityScheduleDto, CreateScheduleDto, UpdateScheduleDto } from './dto/clubs.dto';

interface ScheduleRow {
  id: string;
  activity_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  location: string | null;
  is_active: boolean;
}

const SELECT_SCHEDULE =
  'SELECT id::text AS id, activity_id::text AS activity_id, day_of_week, ' +
  "TO_CHAR(start_time, 'HH24:MI') AS start_time, " +
  "TO_CHAR(end_time, 'HH24:MI') AS end_time, " +
  'location, is_active FROM ext_activity_schedules ';

function rowToDto(r: ScheduleRow): ActivityScheduleDto {
  return {
    id: r.id,
    activityId: r.activity_id,
    dayOfWeek: r.day_of_week,
    startTime: r.start_time,
    endTime: r.end_time,
    location: r.location,
    isActive: r.is_active,
  };
}

@Injectable()
export class ScheduleService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private isManager(actor: ResolvedActor): boolean {
    return actor.isSchoolAdmin || actor.personType === 'STAFF';
  }

  async listForActivity(activityId: string): Promise<ActivityScheduleDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_SCHEDULE + 'WHERE activity_id = $1::uuid ORDER BY day_of_week, start_time',
        activityId,
      );
    })) as ScheduleRow[];
    return rows.map(rowToDto);
  }

  async create(
    activityId: string,
    input: CreateScheduleDto,
    actor: ResolvedActor,
  ): Promise<ActivityScheduleDto> {
    if (!this.isManager(actor)) {
      throw new ForbiddenException('Only Staff or admins can add schedule entries');
    }
    if (input.dayOfWeek < 0 || input.dayOfWeek > 6) {
      throw new BadRequestException('dayOfWeek must be 0..6');
    }
    if (input.startTime >= input.endTime) {
      throw new BadRequestException('startTime must be before endTime');
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO ext_activity_schedules (id, activity_id, day_of_week, start_time, end_time, location) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4::time, $5::time, $6)',
        id,
        activityId,
        input.dayOfWeek,
        input.startTime,
        input.endTime,
        input.location ?? null,
      );
    });
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_SCHEDULE + 'WHERE id = $1::uuid', id);
    })) as ScheduleRow[];
    return rowToDto(rows[0]!);
  }

  async patch(
    id: string,
    input: UpdateScheduleDto,
    actor: ResolvedActor,
  ): Promise<ActivityScheduleDto> {
    if (!this.isManager(actor)) {
      throw new ForbiddenException('Only Staff or admins can update schedule entries');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.dayOfWeek !== undefined) {
      params.push(input.dayOfWeek);
      sets.push('day_of_week = $' + params.length);
    }
    if (input.startTime !== undefined) {
      params.push(input.startTime);
      sets.push('start_time = $' + params.length + '::time');
    }
    if (input.endTime !== undefined) {
      params.push(input.endTime);
      sets.push('end_time = $' + params.length + '::time');
    }
    if (input.location !== undefined) {
      params.push(input.location);
      sets.push('location = $' + params.length);
    }
    if (input.isActive !== undefined) {
      params.push(input.isActive);
      sets.push('is_active = $' + params.length);
    }
    if (sets.length === 0) {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(SELECT_SCHEDULE + 'WHERE id = $1::uuid', id);
      })) as ScheduleRow[];
      if (rows.length === 0) throw new NotFoundException('Schedule not found');
      return rowToDto(rows[0]!);
    }
    sets.push('updated_at = now()');
    params.push(id);
    const updated = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'UPDATE ext_activity_schedules SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          params.length +
          '::uuid',
        ...params,
      );
    });
    if (updated === 0) throw new NotFoundException('Schedule not found');
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_SCHEDULE + 'WHERE id = $1::uuid', id);
    })) as ScheduleRow[];
    return rowToDto(rows[0]!);
  }

  async remove(id: string, actor: ResolvedActor): Promise<void> {
    if (!this.isManager(actor)) {
      throw new ForbiddenException('Only Staff or admins can delete schedule entries');
    }
    const removed = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe('DELETE FROM ext_activity_schedules WHERE id = $1::uuid', id);
    });
    if (removed === 0) throw new NotFoundException('Schedule not found');
  }
}
