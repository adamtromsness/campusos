import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import { OutboxService, OutboxTxClient } from '@shared/kafka/outbox.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
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

// REVIEW-P2C11 ROUND 1 BLOCKING 2 — every read joins through hr_employees
// so a school predicate can attach at the WHERE level.
const SELECT_HOURS_BASE =
  'SELECT h.id::text AS id, h.driver_id::text AS driver_id, h.run_id::text AS run_id, ' +
  'h.log_date, h.duty_start_at, h.duty_end_at, h.driving_minutes, h.break_minutes, ' +
  'h.cumulative_weekly_minutes, h.notes, h.created_at ' +
  'FROM trn_driver_hours_logs h ' +
  'JOIN hr_employees e ON e.id = h.driver_id ';

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

/**
 * REVIEW-P2C11 ROUND 1 BLOCKING 3 — deterministic event id for the
 * trn.driver.hours_approaching_limit outbox row. Keys on the hours log
 * id so a redelivery of the same close-out always lands the same
 * envelope.
 */
export function deterministicDriverHoursApproachingEventId(hoursLogId: string): string {
  const hash = createHash('sha256')
    .update(hoursLogId + ':trn.driver.hours_approaching_limit:v1')
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  );
}

@Injectable()
export class DriverHoursService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  /**
   * REVIEW-P2C11 ROUND 1 BLOCKING 6 — TRN-003:write is the canonical
   * Driver Operations management permission. Replaces the broad
   * `personType === 'STAFF'` shortcut.
   */
  private async assertCanManageDrivers(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'trn-003:write',
      'trn-003:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Only school admins or transportation staff with trn-003:write can manage driver hours',
      );
    }
  }

  /**
   * REVIEW-P2C11 ROUND 1 BLOCKING 2 — validate driver belongs to the
   * calling school via hr_employees.school_id. A School A actor cannot
   * read or mutate hours for a School B driver by guessing the UUID.
   */
  private async assertDriverInCurrentSchool(driverId: string): Promise<void> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM hr_employees WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        driverId,
        tenant.schoolId,
      );
    })) as Array<{ ok: number }>;
    if (rows.length === 0) {
      throw new BadRequestException('driverId does not match an employee in this school');
    }
  }

  async listForDriver(
    driverId: string,
    args: { fromDate?: string; toDate?: string } = {},
  ): Promise<DriverHoursResponseDto[]> {
    await this.assertDriverInCurrentSchool(driverId);
    const tenant = getCurrentTenant();
    const where: string[] = ['h.driver_id = $1::uuid', 'e.school_id = $2::uuid'];
    const params: unknown[] = [driverId, tenant.schoolId];
    if (args.fromDate) {
      where.push('h.log_date >= $' + (params.length + 1) + '::date');
      params.push(args.fromDate);
    }
    if (args.toDate) {
      where.push('h.log_date <= $' + (params.length + 1) + '::date');
      params.push(args.toDate);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_HOURS_BASE +
          'WHERE ' +
          where.join(' AND ') +
          ' ORDER BY h.log_date DESC, h.duty_start_at DESC LIMIT 500',
        ...params,
      );
    })) as HoursRow[];
    return rows.map(rowToDto);
  }

  async weeklySummary(driverId: string): Promise<DriverHoursWeeklySummaryDto> {
    await this.assertDriverInCurrentSchool(driverId);
    const tenant = getCurrentTenant();
    const weekStart = isoWeekStartUtc(new Date());
    const limits = await this.getLimit();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT COALESCE(SUM(h.driving_minutes), 0)::int AS total ' +
          'FROM trn_driver_hours_logs h ' +
          'JOIN hr_employees e ON e.id = h.driver_id ' +
          'WHERE h.driver_id = $1::uuid AND e.school_id = $2::uuid ' +
          'AND h.duty_end_at IS NOT NULL AND h.duty_end_at >= $3::timestamptz ' +
          "AND h.duty_end_at < $3::timestamptz + INTERVAL '7 days'",
        driverId,
        tenant.schoolId,
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
    await this.assertCanManageDrivers(actor);
    // REVIEW-P2C11 BLOCKING 2 — validate driver belongs to current school.
    await this.assertDriverInCurrentSchool(driverId);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
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
   * Close out a duty period. REVIEW-P2C11 ROUND 1 BLOCKING 2 — the
   * row lock joins through hr_employees so the school predicate
   * defends the mutation; the final reload also carries the school
   * predicate. REVIEW-P2C11 BLOCKING 3 — the approaching-limit emit
   * now goes through OutboxService.enqueueInTx with a deterministic
   * event_id keyed on the hours log id.
   */
  async complete(
    hoursId: string,
    input: CompleteDriverHoursDto,
    actor: ResolvedActor,
  ): Promise<DriverHoursResponseDto> {
    await this.assertCanManageDrivers(actor);
    const limits = await this.getLimit();
    const tenant = getCurrentTenant();
    let driverId: string | null = null;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT h.driver_id::text AS driver_id, h.duty_start_at, h.duty_end_at, h.cumulative_weekly_minutes ' +
          'FROM trn_driver_hours_logs h ' +
          'JOIN hr_employees e ON e.id = h.driver_id ' +
          'WHERE h.id = $1::uuid AND e.school_id = $2::uuid FOR UPDATE OF h',
        hoursId,
        tenant.schoolId,
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
      // incoming driving_minutes. Joined through hr_employees so the
      // school predicate defends the SUM.
      const sumRows = (await tx.$queryRawUnsafe(
        'SELECT COALESCE(SUM(h.driving_minutes), 0)::int AS s ' +
          'FROM trn_driver_hours_logs h ' +
          'JOIN hr_employees e ON e.id = h.driver_id ' +
          'WHERE h.driver_id = $1::uuid AND e.school_id = $2::uuid AND h.duty_end_at IS NOT NULL ' +
          'AND h.duty_end_at >= $3::timestamptz AND h.duty_end_at < $4::timestamptz ' +
          'AND h.id <> $5::uuid',
        driverId,
        tenant.schoolId,
        weekStart.toISOString(),
        weekEnd.toISOString(),
        hoursId,
      )) as Array<{ s: number }>;
      const priorCumulative = sumRows[0]!.s;
      const newCumulative = priorCumulative + input.drivingMinutes;

      const thresholdMinutes = Math.round(
        (limits.weeklyDrivingLimitMinutes * limits.approachingLimitThresholdPct) / 100,
      );
      const crossedApproaching =
        priorCumulative < thresholdMinutes && newCumulative >= thresholdMinutes;

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

      // REVIEW-P2C11 BLOCKING 3 — durable outbox emit inside the same tx.
      if (crossedApproaching) {
        await this.outbox.enqueueInTx(tx as unknown as OutboxTxClient, {
          topic: 'trn.driver.hours_approaching_limit',
          key: driverId,
          sourceModule: 'transport',
          eventId: deterministicDriverHoursApproachingEventId(hoursId),
          payload: {
            hoursLogId: hoursId,
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
    });

    // School-defensive reload — join carries the predicate.
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_HOURS_BASE + 'WHERE h.id = $1::uuid AND e.school_id = $2::uuid LIMIT 1',
        hoursId,
        tenant.schoolId,
      );
    })) as HoursRow[];
    if (rows.length === 0) throw new NotFoundException('Driver hours row not found after update');
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
