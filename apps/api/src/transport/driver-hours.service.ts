import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  CompleteDriverHoursDto,
  CreateDriverHoursDto,
  DriverApproachingLimitRowDto,
  DriverHoursLimitResponseDto,
  DriverHoursResponseDto,
  DriverHoursWeeklySummaryDto,
  UpdateDriverHoursLimitDto,
} from './dto/fleet-maintenance.dto';

interface HoursRow {
  id: string;
  driver_id: string | null;
  run_id: string | null;
  log_date: Date;
  duty_start_at: Date;
  duty_end_at: Date | null;
  driving_minutes: number | null;
  break_minutes: number;
  cumulative_weekly_minutes: number | null;
  notes: string | null;
  created_at: Date;
}

const SELECT_HOURS_BASE =
  'SELECT id::text AS id, driver_id::text AS driver_id, run_id::text AS run_id, ' +
  'log_date, duty_start_at, duty_end_at, driving_minutes, break_minutes, ' +
  'cumulative_weekly_minutes, notes, created_at ' +
  'FROM trn_driver_hours_logs ';

const DEFAULTS = {
  weekly_driving_limit_minutes: 2880,
  daily_driving_limit_minutes: 600,
  mandatory_break_after_minutes: 270,
  approaching_limit_threshold_pct: 90,
  jurisdiction: 'US_FEDERAL',
};

function rowToDto(r: HoursRow): DriverHoursResponseDto {
  return {
    id: r.id,
    driverId: r.driver_id,
    runId: r.run_id,
    logDate: r.log_date.toISOString().slice(0, 10),
    dutyStartAt: r.duty_start_at.toISOString(),
    dutyEndAt: r.duty_end_at ? r.duty_end_at.toISOString() : null,
    drivingMinutes: r.driving_minutes,
    breakMinutes: r.break_minutes,
    cumulativeWeeklyMinutes: r.cumulative_weekly_minutes,
    notes: r.notes,
    createdAt: r.created_at.toISOString(),
  };
}

/** ISO week boundary helper — Monday 00:00:00 UTC of the week containing `d`. */
function isoWeekStartUtc(d: Date): Date {
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = tmp.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  tmp.setUTCDate(tmp.getUTCDate() + diff);
  tmp.setUTCHours(0, 0, 0, 0);
  return tmp;
}

@Injectable()
export class DriverHoursService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  private assertCanManage(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STAFF') return;
    throw new ForbiddenException(
      'Only school admins or transportation staff can manage driver hours',
    );
  }

  async listForDriver(
    driverId: string,
    args: { fromDate?: string; toDate?: string } = {},
  ): Promise<DriverHoursResponseDto[]> {
    const where: string[] = ['driver_id = $1::uuid'];
    const params: unknown[] = [driverId];
    if (args.fromDate) {
      where.push('log_date >= $' + (params.length + 1) + '::date');
      params.push(args.fromDate);
    }
    if (args.toDate) {
      where.push('log_date <= $' + (params.length + 1) + '::date');
      params.push(args.toDate);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_HOURS_BASE +
          'WHERE ' +
          where.join(' AND ') +
          ' ORDER BY log_date DESC, duty_start_at DESC LIMIT 500',
        ...params,
      );
    })) as HoursRow[];
    return rows.map(rowToDto);
  }

  async weeklySummary(driverId: string): Promise<DriverHoursWeeklySummaryDto> {
    const weekStart = isoWeekStartUtc(new Date());
    const limits = await this.getLimit();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT COALESCE(SUM(driving_minutes), 0)::int AS total ' +
          'FROM trn_driver_hours_logs ' +
          'WHERE driver_id = $1::uuid AND duty_end_at IS NOT NULL ' +
          "AND duty_end_at >= $2::timestamptz AND duty_end_at < $2::timestamptz + INTERVAL '7 days'",
        driverId,
        weekStart.toISOString(),
      );
    })) as Array<{ total: number }>;
    const total = rows[0]!.total;
    const remaining = Math.max(0, limits.weeklyDrivingLimitMinutes - total);
    const pct = (total / limits.weeklyDrivingLimitMinutes) * 100;
    return {
      driverId,
      weekStartDate: weekStart.toISOString().slice(0, 10),
      totalDrivingMinutes: total,
      weeklyLimitMinutes: limits.weeklyDrivingLimitMinutes,
      remainingMinutes: remaining,
      thresholdPct: limits.approachingLimitThresholdPct,
      approachingLimit: pct >= limits.approachingLimitThresholdPct && pct < 100,
      overLimit: total > limits.weeklyDrivingLimitMinutes,
    };
  }

  async create(
    driverId: string,
    input: CreateDriverHoursDto,
    actor: ResolvedActor,
  ): Promise<DriverHoursResponseDto> {
    this.assertCanManage(actor);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const eRows = (await client.$queryRawUnsafe(
        'SELECT id FROM hr_employees WHERE id = $1::uuid LIMIT 1',
        driverId,
      )) as Array<{ id: string }>;
      if (eRows.length === 0) {
        throw new BadRequestException('driverId does not match an employee in this school');
      }
      await client.$executeRawUnsafe(
        'INSERT INTO trn_driver_hours_logs (id, driver_id, run_id, log_date, duty_start_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::timestamptz)',
        id,
        driverId,
        input.runId ?? null,
        input.logDate,
        input.dutyStartAt,
      );
    });
    const rows = await this.listForDriver(driverId);
    const found = rows.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Driver hours row not found after insert');
    return found;
  }

  /**
   * Close out a duty period. Recomputes cumulative_weekly_minutes from
   * the ISO week of duty_end_at + sums all the closed driving_minutes
   * inside that week (including this one), then emits
   * trn.driver.hours_approaching_limit when the new cumulative crosses
   * the configured threshold (default 90 percent) AND was previously
   * below it.
   */
  async complete(
    hoursId: string,
    input: CompleteDriverHoursDto,
    actor: ResolvedActor,
  ): Promise<DriverHoursResponseDto> {
    this.assertCanManage(actor);
    const limits = await this.getLimit();
    const tenant = getCurrentTenant();
    let driverId: string | null = null;
    let priorCumulative = 0;
    let newCumulative = 0;
    let crossedApproaching = false;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT driver_id::text AS driver_id, duty_start_at, duty_end_at, cumulative_weekly_minutes ' +
          'FROM trn_driver_hours_logs WHERE id = $1::uuid FOR UPDATE',
        hoursId,
      )) as Array<{
        driver_id: string | null;
        duty_start_at: Date;
        duty_end_at: Date | null;
        cumulative_weekly_minutes: number | null;
      }>;
      if (rows.length === 0) throw new NotFoundException('Driver hours row not found');
      const prior = rows[0]!;
      if (prior.duty_end_at !== null) {
        throw new BadRequestException('Duty period is already closed');
      }
      driverId = prior.driver_id;
      if (!driverId) {
        throw new BadRequestException('Driver row missing driver_id; cannot complete');
      }
      const endAt = new Date(input.dutyEndAt);
      if (endAt <= prior.duty_start_at) {
        throw new BadRequestException('dutyEndAt must be strictly after dutyStartAt');
      }

      // Compute cumulative across the ISO week containing duty_end_at
      const weekStart = isoWeekStartUtc(endAt);
      const weekEnd = new Date(weekStart);
      weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

      // Sum already-closed rows in week (excluding this one) plus the
      // incoming driving_minutes.
      const sumRows = (await tx.$queryRawUnsafe(
        'SELECT COALESCE(SUM(driving_minutes), 0)::int AS s ' +
          'FROM trn_driver_hours_logs ' +
          'WHERE driver_id = $1::uuid AND duty_end_at IS NOT NULL ' +
          'AND duty_end_at >= $2::timestamptz AND duty_end_at < $3::timestamptz ' +
          'AND id <> $4::uuid',
        driverId,
        weekStart.toISOString(),
        weekEnd.toISOString(),
        hoursId,
      )) as Array<{ s: number }>;
      priorCumulative = sumRows[0]!.s;
      newCumulative = priorCumulative + input.drivingMinutes;

      const thresholdMinutes = Math.round(
        (limits.weeklyDrivingLimitMinutes * limits.approachingLimitThresholdPct) / 100,
      );
      crossedApproaching = priorCumulative < thresholdMinutes && newCumulative >= thresholdMinutes;

      await tx.$executeRawUnsafe(
        'UPDATE trn_driver_hours_logs SET ' +
          'duty_end_at = $1::timestamptz, ' +
          'driving_minutes = $2, ' +
          'break_minutes = COALESCE($3, break_minutes), ' +
          'cumulative_weekly_minutes = $4, ' +
          'notes = COALESCE($5, notes), ' +
          'updated_at = now() ' +
          'WHERE id = $6::uuid',
        input.dutyEndAt,
        input.drivingMinutes,
        input.breakMinutes ?? null,
        newCumulative,
        input.notes ?? null,
        hoursId,
      );
    });

    if (crossedApproaching && driverId) {
      await this.kafka.emit({
        topic: 'trn.driver.hours_approaching_limit',
        key: driverId,
        sourceModule: 'transport',
        payload: {
          driverId,
          schoolId: tenant.schoolId,
          weeklyDrivingLimitMinutes: limits.weeklyDrivingLimitMinutes,
          approachingLimitThresholdPct: limits.approachingLimitThresholdPct,
          priorCumulativeMinutes: priorCumulative,
          newCumulativeMinutes: newCumulative,
          jurisdiction: limits.jurisdiction,
          actorAccountId: actor.accountId,
          detectedAt: new Date().toISOString(),
        },
      });
    }

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_HOURS_BASE + 'WHERE id = $1::uuid LIMIT 1', hoursId);
    })) as HoursRow[];
    return rowToDto(rows[0]!);
  }

  async listApproachingLimit(): Promise<DriverApproachingLimitRowDto[]> {
    const tenant = getCurrentTenant();
    const limits = await this.getLimit();
    const weekStart = isoWeekStartUtc(new Date());
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
    const thresholdMinutes = Math.round(
      (limits.weeklyDrivingLimitMinutes * limits.approachingLimitThresholdPct) / 100,
    );
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT h.driver_id::text AS driver_id, ' +
          "COALESCE(p.first_name || ' ' || p.last_name, '') AS driver_name, " +
          'SUM(h.driving_minutes)::int AS minutes ' +
          'FROM trn_driver_hours_logs h ' +
          'LEFT JOIN hr_employees e ON e.id = h.driver_id ' +
          'LEFT JOIN platform.iam_person p ON p.id = e.person_id ' +
          'WHERE e.school_id = $1::uuid AND h.duty_end_at IS NOT NULL ' +
          'AND h.duty_end_at >= $2::timestamptz AND h.duty_end_at < $3::timestamptz ' +
          'GROUP BY h.driver_id, p.first_name, p.last_name ' +
          'HAVING SUM(h.driving_minutes) >= $4 ' +
          'ORDER BY minutes DESC LIMIT 200',
        tenant.schoolId,
        weekStart.toISOString(),
        weekEnd.toISOString(),
        thresholdMinutes,
      );
    })) as Array<{ driver_id: string; driver_name: string; minutes: number }>;
    return rows.map((r) => ({
      driverId: r.driver_id,
      driverName: r.driver_name || null,
      drivingMinutes: r.minutes,
      weeklyLimitMinutes: limits.weeklyDrivingLimitMinutes,
      percentOfLimit: Math.round((r.minutes / limits.weeklyDrivingLimitMinutes) * 100),
    }));
  }

  async getLimit(): Promise<DriverHoursLimitResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, weekly_driving_limit_minutes, ' +
          'daily_driving_limit_minutes, mandatory_break_after_minutes, ' +
          'approaching_limit_threshold_pct, jurisdiction ' +
          'FROM trn_driver_hours_limits WHERE school_id = $1::uuid LIMIT 1',
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      weekly_driving_limit_minutes: number;
      daily_driving_limit_minutes: number;
      mandatory_break_after_minutes: number;
      approaching_limit_threshold_pct: number;
      jurisdiction: string;
    }>;
    if (rows.length === 0) {
      return {
        id: '',
        schoolId: tenant.schoolId,
        weeklyDrivingLimitMinutes: DEFAULTS.weekly_driving_limit_minutes,
        dailyDrivingLimitMinutes: DEFAULTS.daily_driving_limit_minutes,
        mandatoryBreakAfterMinutes: DEFAULTS.mandatory_break_after_minutes,
        approachingLimitThresholdPct: DEFAULTS.approaching_limit_threshold_pct,
        jurisdiction: DEFAULTS.jurisdiction,
      };
    }
    const r = rows[0]!;
    return {
      id: r.id,
      schoolId: r.school_id,
      weeklyDrivingLimitMinutes: r.weekly_driving_limit_minutes,
      dailyDrivingLimitMinutes: r.daily_driving_limit_minutes,
      mandatoryBreakAfterMinutes: r.mandatory_break_after_minutes,
      approachingLimitThresholdPct: r.approaching_limit_threshold_pct,
      jurisdiction: r.jurisdiction,
    };
  }

  async updateLimit(
    input: UpdateDriverHoursLimitDto,
    actor: ResolvedActor,
  ): Promise<DriverHoursLimitResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can update driver hours limits');
    }
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const existing = (await client.$queryRawUnsafe(
        'SELECT id FROM trn_driver_hours_limits WHERE school_id = $1::uuid LIMIT 1',
        tenant.schoolId,
      )) as Array<{ id: string }>;
      if (existing.length === 0) {
        await client.$executeRawUnsafe(
          'INSERT INTO trn_driver_hours_limits (id, school_id, weekly_driving_limit_minutes, daily_driving_limit_minutes, mandatory_break_after_minutes, approaching_limit_threshold_pct, jurisdiction) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)',
          generateId(),
          tenant.schoolId,
          input.weeklyDrivingLimitMinutes ?? DEFAULTS.weekly_driving_limit_minutes,
          input.dailyDrivingLimitMinutes ?? DEFAULTS.daily_driving_limit_minutes,
          input.mandatoryBreakAfterMinutes ?? DEFAULTS.mandatory_break_after_minutes,
          input.approachingLimitThresholdPct ?? DEFAULTS.approaching_limit_threshold_pct,
          input.jurisdiction ?? DEFAULTS.jurisdiction,
        );
        return;
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      if (input.weeklyDrivingLimitMinutes !== undefined) {
        sets.push('weekly_driving_limit_minutes = $' + (params.length + 1));
        params.push(input.weeklyDrivingLimitMinutes);
      }
      if (input.dailyDrivingLimitMinutes !== undefined) {
        sets.push('daily_driving_limit_minutes = $' + (params.length + 1));
        params.push(input.dailyDrivingLimitMinutes);
      }
      if (input.mandatoryBreakAfterMinutes !== undefined) {
        sets.push('mandatory_break_after_minutes = $' + (params.length + 1));
        params.push(input.mandatoryBreakAfterMinutes);
      }
      if (input.approachingLimitThresholdPct !== undefined) {
        sets.push('approaching_limit_threshold_pct = $' + (params.length + 1));
        params.push(input.approachingLimitThresholdPct);
      }
      if (input.jurisdiction !== undefined) {
        sets.push('jurisdiction = $' + (params.length + 1));
        params.push(input.jurisdiction);
      }
      if (sets.length === 0) return;
      sets.push('updated_at = now()');
      params.push(tenant.schoolId);
      await client.$executeRawUnsafe(
        'UPDATE trn_driver_hours_limits SET ' +
          sets.join(', ') +
          ' WHERE school_id = $' +
          params.length +
          '::uuid',
        ...params,
      );
    });
    return this.getLimit();
  }
}
