import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { FleetStatusRowDto } from './dto/gps-fleet.dto';

interface FleetStatusRow {
  id: string;
  vehicle_id: string;
  school_id: string;
  vehicle_registration: string;
  vehicle_status: string;
  days_until_insurance_expiry: number | null;
  days_until_registration_expiry: number | null;
  days_until_mot_expiry: number | null;
  days_until_licence_expiry: number | null;
  maintenance_overdue: boolean;
  last_incident_date: Date | null;
  total_incidents_this_year: number;
  current_route_assignment: string | null;
  current_route_id: string | null;
  last_position_at: Date | null;
  fuel_efficiency_last_month: string | null;
  open_safety_critical_repair_count: number;
  materialised_at: Date;
}

function rowToDto(r: FleetStatusRow): FleetStatusRowDto {
  return {
    id: r.id,
    vehicleId: r.vehicle_id,
    schoolId: r.school_id,
    vehicleRegistration: r.vehicle_registration,
    vehicleStatus: r.vehicle_status,
    daysUntilInsuranceExpiry: r.days_until_insurance_expiry,
    daysUntilRegistrationExpiry: r.days_until_registration_expiry,
    daysUntilMotExpiry: r.days_until_mot_expiry,
    daysUntilLicenceExpiry: r.days_until_licence_expiry,
    maintenanceOverdue: r.maintenance_overdue,
    lastIncidentDate: r.last_incident_date ? r.last_incident_date.toISOString().slice(0, 10) : null,
    totalIncidentsThisYear: r.total_incidents_this_year,
    currentRouteAssignment: r.current_route_assignment,
    currentRouteId: r.current_route_id,
    lastPositionAt: r.last_position_at ? r.last_position_at.toISOString() : null,
    fuelEfficiencyLastMonth:
      r.fuel_efficiency_last_month === null ? null : Number(r.fuel_efficiency_last_month),
    openSafetyCriticalRepairCount: r.open_safety_critical_repair_count,
    materialisedAt: r.materialised_at.toISOString(),
  };
}

const SELECT_FLEET_BASE =
  'SELECT id::text AS id, vehicle_id::text AS vehicle_id, school_id::text AS school_id, ' +
  'vehicle_registration, vehicle_status, days_until_insurance_expiry, ' +
  'days_until_registration_expiry, days_until_mot_expiry, days_until_licence_expiry, ' +
  'maintenance_overdue, last_incident_date, total_incidents_this_year, ' +
  'current_route_assignment, current_route_id::text AS current_route_id, ' +
  'last_position_at, fuel_efficiency_last_month::text AS fuel_efficiency_last_month, ' +
  'open_safety_critical_repair_count, materialised_at ' +
  'FROM rpt_fleet_status ';

/**
 * FleetStatusService — read-only TC dashboard + FleetStatusWorker
 * materialiser.
 *
 * The Step 6 FleetStatusWorker runs nightly per ADR-018: walks every
 * vehicle in the school, reads from trn_vehicle_documents (insurance
 * registration MOT licence expiry dates), trn_vehicle_repairs (open
 * safety-critical count), trn_vehicle_fuel_logs (last-month avg
 * efficiency), trn_vehicle_positions (latest position timestamp),
 * trn_routes (current route assignment), and overwrites the
 * rpt_fleet_status row inside one tenant tx per vehicle. UNIQUE on
 * vehicle_id means the upsert overwrites the prior snapshot.
 *
 * The worker is exposed as an admin-only POST so a TC can force a
 * recompute outside the nightly schedule (e.g. after a vehicle
 * document expiry update). The actual cron schedule lives in ops.
 */
@Injectable()
export class FleetStatusService {
  private readonly logger = new Logger(FleetStatusService.name);

  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(args: {
    maintenanceOverdue?: boolean;
    expiringWithinDays?: number;
  }): Promise<FleetStatusRowDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.maintenanceOverdue !== undefined) {
      params.push(args.maintenanceOverdue);
      where.push('maintenance_overdue = $' + params.length);
    }
    if (args.expiringWithinDays !== undefined && args.expiringWithinDays > 0) {
      params.push(args.expiringWithinDays);
      where.push(
        '(days_until_insurance_expiry IS NOT NULL AND days_until_insurance_expiry <= $' +
          params.length +
          ' OR days_until_registration_expiry IS NOT NULL AND days_until_registration_expiry <= $' +
          params.length +
          ' OR days_until_mot_expiry IS NOT NULL AND days_until_mot_expiry <= $' +
          params.length +
          ' OR days_until_licence_expiry IS NOT NULL AND days_until_licence_expiry <= $' +
          params.length +
          ')',
      );
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_FLEET_BASE +
          'WHERE ' +
          where.join(' AND ') +
          ' ORDER BY maintenance_overdue DESC, vehicle_registration ASC',
        ...params,
      );
    })) as FleetStatusRow[];
    return rows.map(rowToDto);
  }

  async getForVehicle(vehicleId: string): Promise<FleetStatusRowDto | null> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_FLEET_BASE + 'WHERE school_id = $1::uuid AND vehicle_id = $2::uuid LIMIT 1',
        tenant.schoolId,
        vehicleId,
      );
    })) as FleetStatusRow[];
    if (rows.length === 0) return null;
    return rowToDto(rows[0]!);
  }

  /**
   * Materialise (UPSERT) the rpt_fleet_status row for a single
   * vehicle. The full nightly run loops this across every vehicle.
   * Admin or transport-staff only.
   */
  async materialiseForVehicle(vehicleId: string, actor: ResolvedActor): Promise<FleetStatusRowDto> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException(
        'Only school admins or transportation staff can trigger fleet status materialisation',
      );
    }
    const tenant = getCurrentTenant();

    // Verify the vehicle belongs to this school + load core fields
    const vehicleRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, registration, status FROM trn_vehicles WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        vehicleId,
        tenant.schoolId,
      );
    })) as Array<{ id: string; registration: string; status: string }>;
    if (vehicleRows.length === 0) {
      throw new NotFoundException('Vehicle not found');
    }
    const vehicle = vehicleRows[0]!;

    // Resolve days-until-expiry across document categories. Cycle 19
    // trn_vehicle_documents stores document_type + expiry_date.
    const docRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT document_type, expiry_date FROM trn_vehicle_documents ' +
          'WHERE vehicle_id = $1::uuid AND expiry_date IS NOT NULL ' +
          'ORDER BY expiry_date ASC',
        vehicleId,
      );
    })) as Array<{ document_type: string; expiry_date: Date }>;

    function daysUntil(type: string): number | null {
      const match = docRows.find((d) => d.document_type === type);
      if (!match) return null;
      const ms = match.expiry_date.getTime() - Date.now();
      return Math.floor(ms / (24 * 60 * 60 * 1000));
    }
    const daysInsurance = daysUntil('INSURANCE');
    const daysRegistration = daysUntil('REGISTRATION');
    const daysMot = daysUntil('MOT');
    // Licence expiry from driver credentials — pick the driver assigned to a
    // route this vehicle is on, otherwise leave null.
    const licenceRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT MIN(c.expiry_date) AS earliest FROM trn_routes r ' +
          "JOIN trn_driver_credentials c ON c.driver_id = r.driver_id AND c.credential_type = 'CDL' AND c.status = 'VALID' " +
          'WHERE r.vehicle_id = $1::uuid',
        vehicleId,
      );
    })) as Array<{ earliest: Date | null }>;
    const daysLicence =
      licenceRows[0]?.earliest === null || licenceRows[0]?.earliest === undefined
        ? null
        : Math.floor((licenceRows[0]!.earliest!.getTime() - Date.now()) / (24 * 60 * 60 * 1000));

    // Open safety-critical repair count
    const repairRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS n FROM trn_vehicle_repairs r ' +
          'LEFT JOIN trn_repair_categories c ON c.id = r.category_id ' +
          "WHERE r.vehicle_id = $1::uuid AND r.status IN ('SCHEDULED', 'IN_PROGRESS') " +
          'AND c.is_safety_critical = true',
        vehicleId,
      );
    })) as Array<{ n: number }>;
    const openSafetyCritical = repairRows[0]?.n ?? 0;
    const maintenanceOverdue = openSafetyCritical > 0 || vehicle.status === 'MAINTENANCE';

    // Last position
    const lastPosRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT MAX(recorded_at) AS last_at FROM trn_vehicle_positions WHERE vehicle_id = $1::uuid',
        vehicleId,
      );
    })) as Array<{ last_at: Date | null }>;
    const lastPositionAt = lastPosRows[0]?.last_at ?? null;

    // Current route assignment
    const routeRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        "SELECT id::text AS id, name FROM trn_routes WHERE vehicle_id = $1::uuid AND status = 'ACTIVE' ORDER BY name ASC LIMIT 1",
        vehicleId,
      );
    })) as Array<{ id: string; name: string }>;
    const currentRoute = routeRows[0];

    // Fuel efficiency last 30 days
    const fuelRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT SUM(fuel_quantity)::text AS total_fuel, ' +
          'MAX(odometer_reading)::text AS max_odo, MIN(odometer_reading)::text AS min_odo, ' +
          'COUNT(*)::int AS n ' +
          "FROM trn_vehicle_fuel_logs WHERE vehicle_id = $1::uuid AND log_date >= (CURRENT_DATE - INTERVAL '30 days')",
        vehicleId,
      );
    })) as Array<{
      total_fuel: string | null;
      max_odo: string | null;
      min_odo: string | null;
      n: number;
    }>;
    let fuelEfficiency: number | null = null;
    if (
      fuelRows.length > 0 &&
      fuelRows[0]!.n > 1 &&
      fuelRows[0]!.total_fuel &&
      fuelRows[0]!.max_odo &&
      fuelRows[0]!.min_odo
    ) {
      const totalFuel = Number(fuelRows[0]!.total_fuel);
      const range = Number(fuelRows[0]!.max_odo) - Number(fuelRows[0]!.min_odo);
      if (totalFuel > 0 && range > 0) {
        fuelEfficiency = Number((range / totalFuel).toFixed(2));
      }
    }

    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO rpt_fleet_status (id, vehicle_id, school_id, vehicle_registration, vehicle_status, ' +
          'days_until_insurance_expiry, days_until_registration_expiry, days_until_mot_expiry, days_until_licence_expiry, ' +
          'maintenance_overdue, current_route_assignment, current_route_id, last_position_at, ' +
          'fuel_efficiency_last_month, open_safety_critical_repair_count, materialised_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12::uuid, $13::timestamptz, $14::numeric, $15, now()) ' +
          'ON CONFLICT (vehicle_id) DO UPDATE SET ' +
          'vehicle_registration = EXCLUDED.vehicle_registration, ' +
          'vehicle_status = EXCLUDED.vehicle_status, ' +
          'days_until_insurance_expiry = EXCLUDED.days_until_insurance_expiry, ' +
          'days_until_registration_expiry = EXCLUDED.days_until_registration_expiry, ' +
          'days_until_mot_expiry = EXCLUDED.days_until_mot_expiry, ' +
          'days_until_licence_expiry = EXCLUDED.days_until_licence_expiry, ' +
          'maintenance_overdue = EXCLUDED.maintenance_overdue, ' +
          'current_route_assignment = EXCLUDED.current_route_assignment, ' +
          'current_route_id = EXCLUDED.current_route_id, ' +
          'last_position_at = EXCLUDED.last_position_at, ' +
          'fuel_efficiency_last_month = EXCLUDED.fuel_efficiency_last_month, ' +
          'open_safety_critical_repair_count = EXCLUDED.open_safety_critical_repair_count, ' +
          'materialised_at = now()',
        id,
        vehicleId,
        tenant.schoolId,
        vehicle.registration,
        vehicle.status,
        daysInsurance,
        daysRegistration,
        daysMot,
        daysLicence,
        maintenanceOverdue,
        currentRoute?.name ?? null,
        currentRoute?.id ?? null,
        lastPositionAt ? lastPositionAt.toISOString() : null,
        fuelEfficiency,
        openSafetyCritical,
      );
    });

    return (await this.getForVehicle(vehicleId))!;
  }

  /**
   * Run the nightly materialisation across every vehicle in the
   * calling tenant. Admin-only. Returns the count of rows updated.
   */
  async materialiseAll(actor: ResolvedActor): Promise<{ updated: number }> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can trigger a fleet-wide materialisation');
    }
    const tenant = getCurrentTenant();
    const vehicleRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id FROM trn_vehicles WHERE school_id = $1::uuid',
        tenant.schoolId,
      );
    })) as Array<{ id: string }>;
    let updated = 0;
    for (const v of vehicleRows) {
      try {
        await this.materialiseForVehicle(v.id, actor);
        updated += 1;
      } catch (err) {
        this.logger.warn('FleetStatusWorker failed for vehicle ' + v.id + ': ' + String(err));
      }
    }
    return { updated };
  }
}
