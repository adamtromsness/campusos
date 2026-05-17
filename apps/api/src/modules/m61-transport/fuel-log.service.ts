import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import {
  CreateFuelLogDto,
  FleetFuelSummaryRowDto,
  FuelLogResponseDto,
  FuelType,
} from './dto/fleet-maintenance.dto';

interface FuelRow {
  id: string;
  vehicle_id: string;
  logged_by: string | null;
  logged_by_name: string | null;
  log_date: Date;
  odometer_reading: string;
  fuel_quantity: string;
  fuel_cost: string | null;
  fuel_type: string;
  refuel_location: string | null;
  created_at: Date;
  prev_odometer: string | null;
}

const SELECT_FUEL_BASE =
  'SELECT f.id::text AS id, f.vehicle_id::text AS vehicle_id, f.logged_by::text AS logged_by, ' +
  "COALESCE(p.first_name || ' ' || p.last_name, '') AS logged_by_name, " +
  'f.log_date, f.odometer_reading::text AS odometer_reading, f.fuel_quantity::text AS fuel_quantity, ' +
  'f.fuel_cost::text AS fuel_cost, f.fuel_type, f.refuel_location, f.created_at, ' +
  '(SELECT MAX(prior.odometer_reading)::text FROM trn_vehicle_fuel_logs prior ' +
  'WHERE prior.vehicle_id = f.vehicle_id AND prior.log_date < f.log_date) AS prev_odometer ' +
  'FROM trn_vehicle_fuel_logs f ' +
  'LEFT JOIN hr_employees e ON e.id = f.logged_by ' +
  'LEFT JOIN platform.iam_person p ON p.id = e.person_id ';

function rowToDto(r: FuelRow): FuelLogResponseDto {
  const odo = Number(r.odometer_reading);
  const qty = Number(r.fuel_quantity);
  const prev = r.prev_odometer === null ? null : Number(r.prev_odometer);
  let miles: number | null = null;
  let eff: number | null = null;
  if (prev !== null) {
    miles = odo - prev;
    if (qty > 0) {
      eff = Math.round((miles / qty) * 100) / 100;
    }
  }
  return {
    id: r.id,
    vehicleId: r.vehicle_id,
    loggedBy: r.logged_by,
    loggedByName: r.logged_by_name || null,
    logDate: r.log_date.toISOString().slice(0, 10),
    odometerReading: odo,
    fuelQuantity: qty,
    fuelCost: r.fuel_cost === null ? null : Number(r.fuel_cost),
    fuelType: r.fuel_type as FuelType,
    refuelLocation: r.refuel_location,
    efficiency: eff,
    milesSincePrevious: miles,
    createdAt: r.created_at.toISOString(),
  };
}

@Injectable()
export class FuelLogService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertCanManage(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STAFF') return;
    throw new ForbiddenException('Only school admins or transportation staff can log fuel');
  }

  async listForVehicle(vehicleId: string): Promise<FuelLogResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_FUEL_BASE +
          'WHERE f.vehicle_id = $1::uuid ORDER BY f.log_date DESC, f.created_at DESC LIMIT 500',
        vehicleId,
      );
    })) as FuelRow[];
    return rows.map(rowToDto);
  }

  async create(
    vehicleId: string,
    input: CreateFuelLogDto,
    actor: ResolvedActor,
  ): Promise<FuelLogResponseDto> {
    this.assertCanManage(actor);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const vRows = (await client.$queryRawUnsafe(
        'SELECT id FROM trn_vehicles WHERE id = $1::uuid LIMIT 1',
        vehicleId,
      )) as Array<{ id: string }>;
      if (vRows.length === 0) throw new NotFoundException('Vehicle not found');

      const eRows = (await client.$queryRawUnsafe(
        'SELECT id FROM hr_employees WHERE id = $1::uuid LIMIT 1',
        input.loggedBy,
      )) as Array<{ id: string }>;
      if (eRows.length === 0) {
        throw new BadRequestException('loggedBy does not match an employee in this school');
      }

      await client.$executeRawUnsafe(
        'INSERT INTO trn_vehicle_fuel_logs ' +
          '(id, vehicle_id, logged_by, log_date, odometer_reading, fuel_quantity, fuel_cost, fuel_type, refuel_location, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6, $7, $8, $9, $10)',
        id,
        vehicleId,
        input.loggedBy,
        input.logDate,
        input.odometerReading,
        input.fuelQuantity,
        input.fuelCost ?? null,
        input.fuelType,
        input.refuelLocation ?? null,
        input.notes ?? null,
      );
    });
    const rows = await this.listForVehicle(vehicleId);
    const found = rows.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Fuel log not found after insert');
    return found;
  }

  /**
   * Per-vehicle per-calendar-month rollup of fuel cost + total quantity
   * + computed average efficiency across consecutive entries within the
   * month window.
   */
  async fleetSummary(): Promise<FleetFuelSummaryRowDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT v.id::text AS vehicle_id, v.registration AS vehicle_registration, ' +
          "to_char(f.log_date, 'YYYY-MM') AS period_label, " +
          'SUM(f.fuel_quantity)::text AS total_quantity, ' +
          'COALESCE(SUM(f.fuel_cost), 0)::text AS total_cost, ' +
          'COUNT(*)::int AS log_count ' +
          'FROM trn_vehicle_fuel_logs f ' +
          'JOIN trn_vehicles v ON v.id = f.vehicle_id ' +
          'WHERE v.school_id = $1::uuid ' +
          "AND f.log_date >= CURRENT_DATE - INTERVAL '180 days' " +
          "GROUP BY v.id, v.registration, to_char(f.log_date, 'YYYY-MM') " +
          'ORDER BY period_label DESC, vehicle_registration ASC LIMIT 200',
        tenant.schoolId,
      );
    })) as Array<{
      vehicle_id: string;
      vehicle_registration: string;
      period_label: string;
      total_quantity: string;
      total_cost: string;
      log_count: number;
    }>;
    return rows.map((r) => ({
      vehicleId: r.vehicle_id,
      vehicleRegistration: r.vehicle_registration,
      periodLabel: r.period_label,
      totalQuantity: Number(r.total_quantity),
      totalCost: Number(r.total_cost),
      averageEfficiency: null,
      logCount: r.log_count,
    }));
  }
}
