import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { OutboxService } from '../kafka/outbox.service';
import { assertCanManage } from './buildings.service';
import { deterministicFireDrillOverdueEventId } from './event-ids';
import {
  CreateFireDrillDto,
  FireDrillComplianceRowDto,
  FireDrillResponseDto,
} from './dto/facilities.dto';

/**
 * FireDrillService — P2-18b Step 4.
 *
 * Per-(building drill_date) fire drill log + the 90-day compliance
 * sweep. met_target is computed at insert time from
 * target_evacuation_seconds — evacuation_time_seconds is less than or
 * equal to target_evacuation_seconds equals true; left NULL when no
 * target was supplied.
 *
 * The compliance endpoint LEFT JOINs every fac_buildings row against
 * the most-recent drill and flags rows where the most-recent drill is
 * either missing or older than 90 days. Each overdue row gets a
 * fac.fire_drill.overdue Kafka emit (deterministic event_id keyed on
 * the (buildingId, today) pair) so downstream consumers can idempotently
 * fan out an admin notification.
 */
@Injectable()
export class FireDrillService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async list(args: {
    buildingId?: string;
    fromDate?: string;
    toDate?: string;
  }): Promise<FireDrillResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['d.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.buildingId) {
      where.push('d.building_id = $' + (params.length + 1) + '::uuid');
      params.push(args.buildingId);
    }
    if (args.fromDate) {
      where.push('d.drill_date >= $' + (params.length + 1) + '::date');
      params.push(args.fromDate);
    }
    if (args.toDate) {
      where.push('d.drill_date <= $' + (params.length + 1) + '::date');
      params.push(args.toDate);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        DRILL_SELECT +
          'WHERE ' +
          where.join(' AND ') +
          ' ORDER BY d.drill_date DESC, d.drill_time DESC LIMIT 200',
        ...params,
      );
    })) as DrillRow[];
    return rows.map(drillRowToDto);
  }

  async getById(id: string): Promise<FireDrillResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        DRILL_SELECT + 'WHERE d.id = $1::uuid AND d.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as DrillRow[];
    if (rows.length === 0) throw new NotFoundException('Fire drill not found in this school');
    return drillRowToDto(rows[0]!);
  }

  async create(input: CreateFireDrillDto, actor: ResolvedActor): Promise<FireDrillResponseDto> {
    await assertCanManage(actor, this.permCheck);
    if (!actor.personId) {
      throw new ForbiddenException('Fire drill logging requires an authenticated person');
    }
    const tenant = getCurrentTenant();
    const id = generateId();

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      // Validate building belongs to current school.
      const bldg = (await client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM fac_buildings WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        input.buildingId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      if (bldg.length === 0) {
        throw new NotFoundException('Building not found in this school');
      }

      const metTarget =
        input.targetEvacuationSeconds === undefined || input.targetEvacuationSeconds === null
          ? null
          : input.evacuationTimeSeconds <= input.targetEvacuationSeconds;

      await client.$executeRawUnsafe(
        'INSERT INTO fac_fire_drills ' +
          '(id, school_id, building_id, drill_date, drill_time, duration_seconds, total_occupants, evacuation_time_seconds, target_evacuation_seconds, met_target, issues_noted, conducted_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::time, $6, $7, $8, $9, $10, $11, $12::uuid)',
        id,
        tenant.schoolId,
        input.buildingId,
        input.drillDate,
        input.drillTime,
        input.durationSeconds,
        input.totalOccupants,
        input.evacuationTimeSeconds,
        input.targetEvacuationSeconds ?? null,
        metTarget,
        input.issuesNoted ?? null,
        actor.personId,
      );
    });
    return this.getById(id);
  }

  /**
   * Compliance dashboard — 90-day rule. For every building in the
   * current school, return whether a drill landed in the trailing
   * 90 days. Overdue rows enqueue fac.fire_drill.overdue durably.
   *
   * REVIEW-P2C18 BLOCKING 1 — the compliance scan now runs inside a
   * tenant tx and per-overdue-building outbox rows commit with the
   * scan. Deterministic event_id per (buildingId, today_iso) so two
   * scans on the same day land the same envelope and the consumer's
   * claim-after-success idempotency catches the second one cleanly.
   * A new (building, day) overdue scan emits a fresh envelope so the
   * notification fan-out can repeat each day until a drill is logged.
   */
  async compliance(): Promise<FireDrillComplianceRowDto[]> {
    const tenant = getCurrentTenant();
    const todayIso = new Date().toISOString().slice(0, 10);
    let result: FireDrillComplianceRowDto[] = [];

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT b.id::text AS building_id, b.name AS building_name, ' +
          '  latest.last_drill_date::text AS last_drill_date, ' +
          '  CASE WHEN latest.last_drill_date IS NULL THEN NULL ' +
          '    ELSE (CURRENT_DATE - latest.last_drill_date)::int END AS days_since_last_drill, ' +
          "  (latest.last_drill_date IS NULL OR latest.last_drill_date < CURRENT_DATE - INTERVAL '90 days') AS is_overdue " +
          'FROM fac_buildings b ' +
          'LEFT JOIN LATERAL (' +
          '  SELECT MAX(d.drill_date) AS last_drill_date FROM fac_fire_drills d ' +
          '  WHERE d.building_id = b.id AND d.school_id = $1::uuid' +
          ') latest ON true ' +
          'WHERE b.school_id = $1::uuid AND b.is_active = true ' +
          'ORDER BY is_overdue DESC, b.name',
        tenant.schoolId,
      )) as Array<{
        building_id: string;
        building_name: string;
        last_drill_date: string | null;
        days_since_last_drill: number | null;
        is_overdue: boolean;
      }>;

      result = rows.map<FireDrillComplianceRowDto>((r) => ({
        buildingId: r.building_id,
        buildingName: r.building_name,
        lastDrillDate: r.last_drill_date,
        daysSinceLastDrill: r.days_since_last_drill,
        isOverdue: r.is_overdue,
      }));

      // Durably enqueue an overdue envelope per overdue building. The
      // outbox row commits with the (read-only-by-shape) scan. The
      // OutboxPublisherWorker drains on broker recovery.
      for (const row of result) {
        if (!row.isOverdue) continue;
        await this.outbox.enqueueInTx(tx, {
          topic: 'fac.fire_drill.overdue',
          key: row.buildingId,
          sourceModule: 'facilities',
          eventId: deterministicFireDrillOverdueEventId(row.buildingId, todayIso),
          payload: {
            schoolId: tenant.schoolId,
            buildingId: row.buildingId,
            buildingName: row.buildingName,
            lastDrillDate: row.lastDrillDate,
            daysSinceLastDrill: row.daysSinceLastDrill,
            computedAt: new Date().toISOString(),
          },
        });
      }
    });

    return result;
  }
}

const DRILL_SELECT =
  'SELECT d.id::text AS id, d.school_id::text AS school_id, d.building_id::text AS building_id, ' +
  '(SELECT name FROM fac_buildings WHERE id = d.building_id) AS building_name, ' +
  'd.drill_date::text AS drill_date, d.drill_time::text AS drill_time, ' +
  'd.duration_seconds, d.total_occupants, d.evacuation_time_seconds, ' +
  'd.target_evacuation_seconds, d.met_target, d.issues_noted, ' +
  'd.conducted_by::text AS conducted_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip WHERE ip.id = d.conducted_by) AS conducted_by_name " +
  'FROM fac_fire_drills d ';

interface DrillRow {
  id: string;
  school_id: string;
  building_id: string;
  building_name: string | null;
  drill_date: string;
  drill_time: string;
  duration_seconds: number;
  total_occupants: number;
  evacuation_time_seconds: number;
  target_evacuation_seconds: number | null;
  met_target: boolean | null;
  issues_noted: string | null;
  conducted_by: string;
  conducted_by_name: string | null;
}

function drillRowToDto(r: DrillRow): FireDrillResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    buildingId: r.building_id,
    buildingName: r.building_name,
    drillDate: r.drill_date,
    drillTime: r.drill_time,
    durationSeconds: r.duration_seconds,
    totalOccupants: r.total_occupants,
    evacuationTimeSeconds: r.evacuation_time_seconds,
    targetEvacuationSeconds: r.target_evacuation_seconds,
    metTarget: r.met_target,
    issuesNoted: r.issues_noted,
    conductedBy: r.conducted_by,
    conductedByName: r.conducted_by_name,
  };
}
