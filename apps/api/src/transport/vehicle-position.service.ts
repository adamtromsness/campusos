import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  IngestVehiclePositionDto,
  VehiclePositionResponseDto,
  VehiclePositionSource,
} from './dto/gps-fleet.dto';

interface PositionRow {
  id: string;
  vehicle_id: string;
  latitude: string;
  longitude: string;
  speed_kmh: string | null;
  heading: string | null;
  recorded_at: Date;
  source: string;
}

const SELECT_POSITION_BASE =
  'SELECT id::text AS id, vehicle_id::text AS vehicle_id, ' +
  'latitude::text AS latitude, longitude::text AS longitude, ' +
  'speed_kmh::text AS speed_kmh, heading::text AS heading, ' +
  'recorded_at, source ' +
  'FROM trn_vehicle_positions ';

function rowToDto(r: PositionRow): VehiclePositionResponseDto {
  return {
    id: r.id,
    vehicleId: r.vehicle_id,
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    speedKmh: r.speed_kmh === null ? null : Number(r.speed_kmh),
    heading: r.heading === null ? null : Number(r.heading),
    recordedAt: r.recorded_at.toISOString(),
    source: r.source as VehiclePositionSource,
  };
}

/**
 * VehiclePositionService — high-frequency GPS telemetry surface.
 *
 * trn_vehicle_positions is RANGE-partitioned by recorded_at DAILY.
 * Insert volume runs from 10 to 30 seconds per vehicle. No UPDATE,
 * no DELETE — telemetry is an immutable record. The Step 6 partition-
 * maintenance worker creates forward partitions and retires cold ones.
 *
 * The ingest endpoint runs the geofence boundary check after the
 * INSERT commits (GeofenceService.checkAndEmitEvents) so a position
 * update fans out trn.geofence.entered / trn.geofence.exited events
 * to the consumer pipeline.
 */
@Injectable()
export class VehiclePositionService {
  private readonly logger = new Logger(VehiclePositionService.name);

  // Late-bound to break the circular GeofenceService dependency.
  private geofenceCheckCallback:
    | ((
        vehicleId: string,
        latitude: number,
        longitude: number,
        speedKmh: number | null,
      ) => Promise<void>)
    | null = null;

  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  setGeofenceCheckCallback(
    cb: (
      vehicleId: string,
      latitude: number,
      longitude: number,
      speedKmh: number | null,
    ) => Promise<void>,
  ): void {
    this.geofenceCheckCallback = cb;
  }

  private assertCanIngest(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STAFF') return;
    throw new ForbiddenException(
      'Only school admins or transportation staff can ingest vehicle positions',
    );
  }

  private async assertVehicleInCurrentSchool(vehicleId: string): Promise<void> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM trn_vehicles WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        vehicleId,
        tenant.schoolId,
      );
    })) as Array<{ ok: number }>;
    if (rows.length === 0) {
      throw new BadRequestException('vehicleId does not match a vehicle in this school');
    }
  }

  /**
   * Ingest a single GPS position. INSERT is immutable — the row lands
   * in the daily partition matching recorded_at. Triggers the geofence
   * boundary check + ETA recompute (async, outside the INSERT path).
   */
  async ingest(
    vehicleId: string,
    input: IngestVehiclePositionDto,
    actor: ResolvedActor,
  ): Promise<VehiclePositionResponseDto> {
    this.assertCanIngest(actor);
    await this.assertVehicleInCurrentSchool(vehicleId);

    const id = generateId();
    const recordedAt = input.recordedAt ? new Date(input.recordedAt) : new Date();
    const source = input.source ?? 'GPS';

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO trn_vehicle_positions (id, vehicle_id, latitude, longitude, speed_kmh, heading, recorded_at, source) ' +
          'VALUES ($1::uuid, $2::uuid, $3::numeric, $4::numeric, $5::numeric, $6::numeric, $7::timestamptz, $8)',
        id,
        vehicleId,
        input.latitude,
        input.longitude,
        input.speedKmh ?? null,
        input.heading ?? null,
        recordedAt.toISOString(),
        source,
      );
    });

    // Fire-and-log geofence boundary check after the position commits.
    // Errors are logged but never block the position ingest.
    if (this.geofenceCheckCallback) {
      try {
        await this.geofenceCheckCallback(
          vehicleId,
          input.latitude,
          input.longitude,
          input.speedKmh ?? null,
        );
      } catch (err) {
        this.logger.warn(
          'Geofence boundary check failed for vehicle ' + vehicleId + ': ' + String(err),
        );
      }
    }

    return {
      id,
      vehicleId,
      latitude: input.latitude,
      longitude: input.longitude,
      speedKmh: input.speedKmh ?? null,
      heading: input.heading ?? null,
      recordedAt: recordedAt.toISOString(),
      source,
    };
  }

  async getLatest(vehicleId: string): Promise<VehiclePositionResponseDto | null> {
    await this.assertVehicleInCurrentSchool(vehicleId);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_POSITION_BASE + 'WHERE vehicle_id = $1::uuid ORDER BY recorded_at DESC LIMIT 1',
        vehicleId,
      );
    })) as PositionRow[];
    if (rows.length === 0) return null;
    return rowToDto(rows[0]!);
  }

  async listHistory(
    vehicleId: string,
    args: { fromDate?: string; toDate?: string; limit?: number },
  ): Promise<VehiclePositionResponseDto[]> {
    await this.assertVehicleInCurrentSchool(vehicleId);
    const where: string[] = ['vehicle_id = $1::uuid'];
    const params: unknown[] = [vehicleId];
    if (args.fromDate) {
      params.push(args.fromDate);
      where.push('recorded_at >= $' + params.length + '::timestamptz');
    }
    if (args.toDate) {
      params.push(args.toDate);
      where.push('recorded_at < $' + params.length + '::timestamptz');
    }
    const limit = Math.min(Math.max(args.limit ?? 200, 1), 5000);
    params.push(limit);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_POSITION_BASE +
          'WHERE ' +
          where.join(' AND ') +
          ' ORDER BY recorded_at DESC LIMIT $' +
          params.length,
        ...params,
      );
    })) as PositionRow[];
    return rows.map(rowToDto);
  }
}
