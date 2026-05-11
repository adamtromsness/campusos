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
import { ETAConfidence, VehicleETAResponseDto } from './dto/gps-fleet.dto';

interface EtaRow {
  id: string;
  vehicle_id: string;
  vehicle_registration: string | null;
  stop_id: string;
  stop_name: string | null;
  eta: Date;
  computed_at: Date;
  confidence: string;
  distance_metres: string | null;
}

const SELECT_ETA_BASE =
  'SELECT e.id::text AS id, e.vehicle_id::text AS vehicle_id, ' +
  'v.registration AS vehicle_registration, e.stop_id::text AS stop_id, ' +
  's.name AS stop_name, e.eta, e.computed_at, e.confidence, ' +
  'e.distance_metres::text AS distance_metres ' +
  'FROM trn_vehicle_eta e ' +
  'LEFT JOIN trn_vehicles v ON v.id = e.vehicle_id ' +
  'LEFT JOIN trn_stops s ON s.id = e.stop_id ';

function rowToDto(r: EtaRow): VehicleETAResponseDto {
  const minutesUntil = Math.max(0, Math.round((r.eta.getTime() - Date.now()) / 60000));
  return {
    id: r.id,
    vehicleId: r.vehicle_id,
    vehicleRegistration: r.vehicle_registration,
    stopId: r.stop_id,
    stopName: r.stop_name,
    eta: r.eta.toISOString(),
    computedAt: r.computed_at.toISOString(),
    confidence: r.confidence as ETAConfidence,
    distanceMetres: r.distance_metres === null ? null : Number(r.distance_metres),
    minutesUntilEta: minutesUntil,
  };
}

/**
 * ETAService — ETA read paths + upsert from the position pipeline.
 *
 * The Step 6 GeofenceWorker or the future Transport Dispatch extracted
 * service computes ETAs from the latest vehicle position + the
 * route geometry + the historical speed. Until the extracted service
 * deploys, ETAs land via the upsert path called by the dispatch
 * integration. The upsert keys on (vehicle, stop) so the freshest
 * snapshot wins.
 */
@Injectable()
export class ETAService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async listForRoute(routeId: string): Promise<VehicleETAResponseDto[]> {
    const tenant = getCurrentTenant();
    // Verify route belongs to this school
    const routeRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM trn_routes WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        routeId,
        tenant.schoolId,
      );
    })) as Array<{ ok: number }>;
    if (routeRows.length === 0) {
      throw new NotFoundException('Route not found');
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_ETA_BASE + 'WHERE s.route_id = $1::uuid ORDER BY s.sequence_order ASC',
        routeId,
      );
    })) as EtaRow[];
    return rows.map(rowToDto);
  }

  async getForStop(stopId: string): Promise<VehicleETAResponseDto[]> {
    const tenant = getCurrentTenant();
    const stopRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM trn_stops s JOIN trn_routes r ON r.id = s.route_id ' +
          'WHERE s.id = $1::uuid AND r.school_id = $2::uuid LIMIT 1',
        stopId,
        tenant.schoolId,
      );
    })) as Array<{ ok: number }>;
    if (stopRows.length === 0) {
      throw new NotFoundException('Stop not found');
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_ETA_BASE + 'WHERE e.stop_id = $1::uuid ORDER BY e.computed_at DESC',
        stopId,
      );
    })) as EtaRow[];
    return rows.map(rowToDto);
  }

  /**
   * Upsert an ETA snapshot. Called by the dispatch integration or by
   * the Step 6 ETA recompute worker. UNIQUE(vehicle, stop) means the
   * upsert overwrites the prior snapshot.
   */
  async upsert(
    vehicleId: string,
    stopId: string,
    args: {
      eta: string;
      confidence?: ETAConfidence;
      distanceMetres?: number;
    },
    actor: ResolvedActor,
  ): Promise<VehicleETAResponseDto> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only school admins or transportation staff can write ETAs');
    }
    const tenant = getCurrentTenant();
    // Verify both vehicle and stop belong to this school
    const checks = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT ' +
          '(SELECT 1 FROM trn_vehicles WHERE id = $1::uuid AND school_id = $3::uuid LIMIT 1) AS v_ok, ' +
          '(SELECT 1 FROM trn_stops s JOIN trn_routes r ON r.id = s.route_id ' +
          'WHERE s.id = $2::uuid AND r.school_id = $3::uuid LIMIT 1) AS s_ok',
        vehicleId,
        stopId,
        tenant.schoolId,
      );
    })) as Array<{ v_ok: number | null; s_ok: number | null }>;
    if (!checks[0]?.v_ok) {
      throw new BadRequestException('vehicleId does not match a vehicle in this school');
    }
    if (!checks[0]?.s_ok) {
      throw new BadRequestException('stopId does not match a stop in this school');
    }

    const confidence = args.confidence ?? 'HIGH';
    const newId = generateId();

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO trn_vehicle_eta (id, vehicle_id, stop_id, eta, computed_at, confidence, distance_metres) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, now(), $5, $6::numeric) ' +
          'ON CONFLICT (vehicle_id, stop_id) DO UPDATE SET ' +
          'eta = EXCLUDED.eta, computed_at = now(), confidence = EXCLUDED.confidence, ' +
          'distance_metres = EXCLUDED.distance_metres, updated_at = now()',
        newId,
        vehicleId,
        stopId,
        args.eta,
        confidence,
        args.distanceMetres ?? null,
      );
    });

    // REVIEW-P2C11 ROUND 1 MAJOR 2 — final reload joins through
    // trn_vehicles so the school predicate carries through. The vehicle
    // + stop both validated above, but the reload is defence in depth
    // against a leaked id from another school.
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_ETA_BASE +
          'JOIN trn_vehicles vv ON vv.id = e.vehicle_id ' +
          'WHERE e.vehicle_id = $1::uuid AND e.stop_id = $2::uuid AND vv.school_id = $3::uuid LIMIT 1',
        vehicleId,
        stopId,
        tenant.schoolId,
      );
    })) as EtaRow[];
    if (rows.length === 0) throw new NotFoundException('ETA not found after upsert');
    return rowToDto(rows[0]!);
  }
}
