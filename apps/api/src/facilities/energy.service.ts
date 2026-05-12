import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { assertCanManage } from './buildings.service';
import {
  CreateEnergyReadingDto,
  CreateEnergyTargetDto,
  CreateUtilityMeterDto,
  EnergyReadingResponseDto,
  EnergySummaryRowDto,
  EnergyTargetPeriod,
  EnergyTargetResponseDto,
  EnergyTrendPointDto,
  EnergyTrendResponseDto,
  UpdateUtilityMeterDto,
  UtilityMeterResponseDto,
  UtilityType,
} from './dto/facilities.dto';

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (e.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('23505');
}

/**
 * EnergyService — P2-18b Step 4.
 *
 * Utility meters + readings + targets + per-meter trend + school-wide
 * actual-vs-target summary.
 *
 * KEYSTONE — recordReading auto-computes consumption inside the same
 * tenant tx as the INSERT by reading the most-recent earlier reading on
 * the same meter under a row lock on the meter. The computation is
 * (current.reading_value minus prior.reading_value); the first reading
 * per meter lands with NULL consumption. The UNIQUE(meter_id,
 * reading_date) constraint catches duplicate-day inserts before the
 * compute runs.
 */
@Injectable()
export class EnergyService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  // ── Meters ──

  async listMeters(args: {
    utilityType?: UtilityType;
    buildingId?: string;
    includeInactive?: boolean;
  }): Promise<UtilityMeterResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['m.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.utilityType) {
      where.push('m.utility_type = $' + (params.length + 1));
      params.push(args.utilityType);
    }
    if (args.buildingId) {
      where.push('m.building_id = $' + (params.length + 1) + '::uuid');
      params.push(args.buildingId);
    }
    if (!args.includeInactive) {
      where.push('m.is_active = true');
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        METER_SELECT + 'WHERE ' + where.join(' AND ') + ' ORDER BY m.utility_type, m.meter_name',
        ...params,
      );
    })) as MeterRow[];
    return rows.map(meterRowToDto);
  }

  async getMeter(id: string): Promise<UtilityMeterResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        METER_SELECT + 'WHERE m.id = $1::uuid AND m.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as MeterRow[];
    if (rows.length === 0) throw new NotFoundException('Utility meter not found in this school');
    return meterRowToDto(rows[0]!);
  }

  async createMeter(
    input: CreateUtilityMeterDto,
    actor: ResolvedActor,
  ): Promise<UtilityMeterResponseDto> {
    await assertCanManage(actor, this.permCheck);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        const bldg = (await client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM fac_buildings WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
          input.buildingId,
          tenant.schoolId,
        )) as Array<{ ok: number }>;
        if (bldg.length === 0) {
          throw new BadRequestException('buildingId does not match a building in this school');
        }
        await client.$executeRawUnsafe(
          'INSERT INTO fac_utility_meters ' +
            '(id, school_id, building_id, meter_name, utility_type, meter_reference, unit) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)',
          id,
          tenant.schoolId,
          input.buildingId,
          input.meterName,
          input.utilityType,
          input.meterReference ?? null,
          input.unit,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'A utility meter named "' + input.meterName + '" already exists in this school.',
        );
      }
      throw err;
    }
    return this.getMeter(id);
  }

  async patchMeter(
    id: string,
    input: UpdateUtilityMeterDto,
    actor: ResolvedActor,
  ): Promise<UtilityMeterResponseDto> {
    await assertCanManage(actor, this.permCheck);
    const tenant = getCurrentTenant();
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.meterName !== undefined) {
      sets.push('meter_name = $' + (params.length + 1));
      params.push(input.meterName);
    }
    if (input.meterReference !== undefined) {
      sets.push('meter_reference = $' + (params.length + 1));
      params.push(input.meterReference);
    }
    if (input.unit !== undefined) {
      sets.push('unit = $' + (params.length + 1));
      params.push(input.unit);
    }
    if (input.isActive !== undefined) {
      sets.push('is_active = $' + (params.length + 1));
      params.push(input.isActive);
    }
    if (sets.length === 0) return this.getMeter(id);
    sets.push('updated_at = now()');
    params.push(id, tenant.schoolId);
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE fac_utility_meters SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            (params.length - 1) +
            '::uuid AND school_id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('Another meter already uses that name.');
      }
      throw err;
    }
    return this.getMeter(id);
  }

  // ── Readings ──

  /**
   * KEYSTONE — record a reading and auto-compute consumption inside one
   * tenant tx. Locks the parent meter row FOR UPDATE so concurrent
   * readings on the same meter serialise on the meter (otherwise two
   * inserts could both compute against the same prior). The
   * UNIQUE(meter_id, reading_date) constraint catches duplicate-day
   * inserts before the compute runs.
   */
  async recordReading(
    input: CreateEnergyReadingDto,
    actor: ResolvedActor,
  ): Promise<EnergyReadingResponseDto> {
    await assertCanManage(actor, this.permCheck);
    if (!actor.personId) {
      throw new ForbiddenException('Energy reading entry requires an authenticated person');
    }
    const tenant = getCurrentTenant();
    const id = generateId();

    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        // Lock the parent meter row so concurrent inserts serialise.
        const meters = (await tx.$queryRawUnsafe(
          'SELECT id FROM fac_utility_meters WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
          input.meterId,
          tenant.schoolId,
        )) as Array<{ id: string }>;
        if (meters.length === 0) {
          throw new NotFoundException('Utility meter not found in this school');
        }

        // Look up the most-recent earlier reading to compute consumption.
        const prior = (await tx.$queryRawUnsafe(
          'SELECT reading_value::float AS reading_value FROM fac_energy_readings ' +
            'WHERE meter_id = $1::uuid AND reading_date < $2::date ' +
            'ORDER BY reading_date DESC LIMIT 1',
          input.meterId,
          input.readingDate,
        )) as Array<{ reading_value: number }>;

        const consumption =
          prior.length === 0 ? null : input.readingValue - prior[0]!.reading_value;
        if (consumption !== null && consumption < 0) {
          throw new BadRequestException(
            'Reading value (' +
              input.readingValue +
              ') is lower than the prior reading (' +
              prior[0]!.reading_value +
              '). Energy meters only count up — check the entered value.',
          );
        }

        await tx.$executeRawUnsafe(
          'INSERT INTO fac_energy_readings ' +
            '(id, meter_id, reading_date, reading_value, consumption, cost_estimate, recorded_by, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6, $7::uuid, $8)',
          id,
          input.meterId,
          input.readingDate,
          input.readingValue,
          consumption,
          input.costEstimate ?? null,
          actor.personId,
          input.notes ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'A reading already exists for this meter on ' + input.readingDate + '.',
        );
      }
      throw err;
    }
    return this.getReading(id);
  }

  async getReading(id: string): Promise<EnergyReadingResponseDto> {
    // REVIEW-P2C18 BLOCKING 6 — school-scope the reading fetch via
    // fac_utility_meters.school_id. A School A energy reader with a
    // School B reading UUID now collapses to 404 don't-leak-existence
    // rather than reading the foreign-school row.
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        READING_SELECT +
          'JOIN fac_utility_meters m ON m.id = r.meter_id ' +
          'WHERE r.id = $1::uuid AND m.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as ReadingRow[];
    if (rows.length === 0) throw new NotFoundException('Energy reading not found');
    return readingRowToDto(rows[0]!);
  }

  /**
   * Per-meter trend — readings ordered oldest-first for charting.
   * Optional from/to date filters for windowed views.
   */
  async trend(
    meterId: string,
    args: { fromDate?: string; toDate?: string },
  ): Promise<EnergyTrendResponseDto> {
    const tenant = getCurrentTenant();
    const meters = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT m.id::text AS id, m.meter_name, m.utility_type, m.unit ' +
          'FROM fac_utility_meters m WHERE m.id = $1::uuid AND m.school_id = $2::uuid LIMIT 1',
        meterId,
        tenant.schoolId,
      );
    })) as Array<{ id: string; meter_name: string; utility_type: string; unit: string }>;
    if (meters.length === 0) throw new NotFoundException('Utility meter not found in this school');
    const meter = meters[0]!;

    const where: string[] = ['r.meter_id = $1::uuid'];
    const params: unknown[] = [meterId];
    if (args.fromDate) {
      where.push('r.reading_date >= $' + (params.length + 1) + '::date');
      params.push(args.fromDate);
    }
    if (args.toDate) {
      where.push('r.reading_date <= $' + (params.length + 1) + '::date');
      params.push(args.toDate);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT r.reading_date::text AS reading_date, r.reading_value::float AS reading_value, ' +
          'r.consumption::float AS consumption, r.cost_estimate::float AS cost_estimate ' +
          'FROM fac_energy_readings r WHERE ' +
          where.join(' AND ') +
          ' ORDER BY r.reading_date',
        ...params,
      );
    })) as Array<{
      reading_date: string;
      reading_value: number;
      consumption: number | null;
      cost_estimate: number | null;
    }>;

    const points: EnergyTrendPointDto[] = rows.map((r) => ({
      readingDate: r.reading_date,
      readingValue: r.reading_value,
      consumption: r.consumption,
      costEstimate: r.cost_estimate,
    }));
    const totalConsumption = points.reduce((acc, p) => acc + (p.consumption ?? 0), 0);
    const totalCost = points.reduce((acc, p) => acc + (p.costEstimate ?? 0), 0);
    return {
      meterId: meter.id,
      meterName: meter.meter_name,
      utilityType: meter.utility_type as UtilityType,
      unit: meter.unit,
      points,
      totalConsumption: Number(totalConsumption.toFixed(2)),
      totalCost: Number(totalCost.toFixed(2)),
    };
  }

  // ── Targets ──

  async listTargets(): Promise<EnergyTargetResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, utility_type, target_period, ' +
          'target_value::float AS target_value, academic_year, notes ' +
          'FROM fac_energy_targets WHERE school_id = $1::uuid ' +
          'ORDER BY utility_type, target_period',
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      utility_type: string;
      target_period: string;
      target_value: number;
      academic_year: string | null;
      notes: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      utilityType: r.utility_type as UtilityType,
      targetPeriod: r.target_period as EnergyTargetPeriod,
      targetValue: r.target_value,
      academicYear: r.academic_year,
      notes: r.notes,
    }));
  }

  async createTarget(
    input: CreateEnergyTargetDto,
    actor: ResolvedActor,
  ): Promise<EnergyTargetResponseDto> {
    await assertCanManage(actor, this.permCheck);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fac_energy_targets ' +
            '(id, school_id, utility_type, target_period, target_value, academic_year, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)',
          id,
          tenant.schoolId,
          input.utilityType,
          input.targetPeriod,
          input.targetValue,
          input.academicYear ?? null,
          input.notes ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'A target already exists for this utility / period / academic year combination.',
        );
      }
      throw err;
    }
    const all = await this.listTargets();
    const found = all.find((t) => t.id === id);
    if (!found) throw new NotFoundException('Energy target not found after insert');
    return found;
  }

  /**
   * School-wide actual-vs-target summary. Aggregates the trailing
   * 30 days of consumption per utility_type and compares against any
   * MONTHLY target on file (most-specific match wins — preferring the
   * row with a populated academic_year if one exists).
   */
  async summary(): Promise<EnergySummaryRowDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'WITH actuals AS (' +
          '  SELECT m.utility_type, m.unit, ' +
          '    COALESCE(SUM(r.consumption), 0)::float AS total ' +
          '  FROM fac_utility_meters m ' +
          '  LEFT JOIN fac_energy_readings r ON r.meter_id = m.id ' +
          "    AND r.reading_date >= CURRENT_DATE - INTERVAL '30 days' " +
          '  WHERE m.school_id = $1::uuid AND m.is_active = true ' +
          '  GROUP BY m.utility_type, m.unit' +
          ') ' +
          'SELECT a.utility_type, a.unit, a.total AS actual, ' +
          '  (SELECT t.target_value::float FROM fac_energy_targets t ' +
          "    WHERE t.school_id = $1::uuid AND t.utility_type = a.utility_type AND t.target_period = 'MONTHLY' " +
          '    ORDER BY t.academic_year DESC NULLS LAST LIMIT 1) AS target ' +
          'FROM actuals a ORDER BY a.utility_type',
        tenant.schoolId,
      );
    })) as Array<{
      utility_type: string;
      unit: string;
      actual: number;
      target: number | null;
    }>;
    return rows.map((r) => {
      const variancePercent =
        r.target === null || r.target === 0
          ? null
          : Number((((r.actual - r.target) / r.target) * 100).toFixed(2));
      return {
        utilityType: r.utility_type as UtilityType,
        actualConsumption: Number(r.actual.toFixed(2)),
        targetValue: r.target,
        variancePercent,
        unit: r.unit,
      };
    });
  }
}

const METER_SELECT =
  'SELECT m.id::text AS id, m.school_id::text AS school_id, m.building_id::text AS building_id, ' +
  '(SELECT name FROM fac_buildings WHERE id = m.building_id) AS building_name, ' +
  'm.meter_name, m.utility_type, m.meter_reference, m.unit, m.is_active ' +
  'FROM fac_utility_meters m ';

interface MeterRow {
  id: string;
  school_id: string;
  building_id: string;
  building_name: string | null;
  meter_name: string;
  utility_type: string;
  meter_reference: string | null;
  unit: string;
  is_active: boolean;
}

function meterRowToDto(r: MeterRow): UtilityMeterResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    buildingId: r.building_id,
    buildingName: r.building_name,
    meterName: r.meter_name,
    utilityType: r.utility_type as UtilityType,
    meterReference: r.meter_reference,
    unit: r.unit,
    isActive: r.is_active,
  };
}

const READING_SELECT =
  'SELECT r.id::text AS id, r.meter_id::text AS meter_id, ' +
  '(SELECT meter_name FROM fac_utility_meters WHERE id = r.meter_id) AS meter_name, ' +
  '(SELECT utility_type FROM fac_utility_meters WHERE id = r.meter_id) AS utility_type, ' +
  '(SELECT unit FROM fac_utility_meters WHERE id = r.meter_id) AS unit, ' +
  'r.reading_date::text AS reading_date, r.reading_value::float AS reading_value, ' +
  'r.consumption::float AS consumption, r.cost_estimate::float AS cost_estimate, ' +
  'r.recorded_by::text AS recorded_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip WHERE ip.id = r.recorded_by) AS recorded_by_name, " +
  'r.notes FROM fac_energy_readings r ';

interface ReadingRow {
  id: string;
  meter_id: string;
  meter_name: string | null;
  utility_type: string | null;
  unit: string | null;
  reading_date: string;
  reading_value: number;
  consumption: number | null;
  cost_estimate: number | null;
  recorded_by: string;
  recorded_by_name: string | null;
  notes: string | null;
}

function readingRowToDto(r: ReadingRow): EnergyReadingResponseDto {
  return {
    id: r.id,
    meterId: r.meter_id,
    meterName: r.meter_name,
    utilityType: r.utility_type as UtilityType | null,
    unit: r.unit,
    readingDate: r.reading_date,
    readingValue: r.reading_value,
    consumption: r.consumption,
    costEstimate: r.cost_estimate,
    recordedBy: r.recorded_by,
    recordedByName: r.recorded_by_name,
    notes: r.notes,
  };
}
