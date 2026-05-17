import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import { createHash } from 'crypto';
import { OutboxService, OutboxTxClient } from '@shared/kafka';
import { PermissionCheckService } from '@modules/m00-platform';
import type { ResolvedActor } from '@modules/m00-platform';
import { VehiclePositionService } from './vehicle-position.service';
import {
  CreateGeofenceDto,
  GeofenceBoundary,
  GeofenceEventResponseDto,
  GeofenceResponseDto,
  GeofenceType,
  UpdateGeofenceDto,
} from './dto/gps-fleet.dto';

interface GeofenceRow {
  id: string;
  school_id: string;
  name: string;
  geofence_type: string;
  boundary: GeofenceBoundary;
  speed_limit_kmh: number | null;
  is_active: boolean;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}

interface GeofenceEventRow {
  id: string;
  geofence_id: string;
  geofence_name: string | null;
  vehicle_id: string;
  vehicle_registration: string | null;
  event_type: string;
  recorded_at: Date;
  speed_at_event: string | null;
  latitude: string | null;
  longitude: string | null;
}

const SELECT_GEOFENCE_BASE =
  'SELECT id::text AS id, school_id::text AS school_id, name, geofence_type, ' +
  'boundary, speed_limit_kmh, is_active, description, created_at, updated_at ' +
  'FROM trn_geofences ';

const SELECT_EVENT_BASE =
  'SELECT e.id::text AS id, e.geofence_id::text AS geofence_id, g.name AS geofence_name, ' +
  'e.vehicle_id::text AS vehicle_id, v.registration AS vehicle_registration, ' +
  'e.event_type, e.recorded_at, e.speed_at_event::text AS speed_at_event, ' +
  'e.latitude::text AS latitude, e.longitude::text AS longitude ' +
  'FROM trn_geofence_events e ' +
  'LEFT JOIN trn_geofences g ON g.id = e.geofence_id ' +
  'LEFT JOIN trn_vehicles v ON v.id = e.vehicle_id ';

function geofenceRowToDto(r: GeofenceRow): GeofenceResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    geofenceType: r.geofence_type as GeofenceType,
    boundary: r.boundary,
    speedLimitKmh: r.speed_limit_kmh,
    isActive: r.is_active,
    description: r.description,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function eventRowToDto(r: GeofenceEventRow): GeofenceEventResponseDto {
  return {
    id: r.id,
    geofenceId: r.geofence_id,
    geofenceName: r.geofence_name,
    vehicleId: r.vehicle_id,
    vehicleRegistration: r.vehicle_registration,
    eventType: r.event_type as 'ENTER' | 'EXIT',
    recordedAt: r.recorded_at.toISOString(),
    speedAtEvent: r.speed_at_event === null ? null : Number(r.speed_at_event),
    latitude: r.latitude === null ? null : Number(r.latitude),
    longitude: r.longitude === null ? null : Number(r.longitude),
  };
}

// Haversine distance in metres between two lat/lng points
export function haversineMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dphi = ((lat2 - lat1) * Math.PI) / 180;
  const dlambda = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dphi / 2) * Math.sin(dphi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlambda / 2) * Math.sin(dlambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Ray-casting point-in-polygon. coordinates is an array of [lat, lng] pairs.
export function pointInPolygon(lat: number, lng: number, coordinates: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = coordinates.length - 1; i < coordinates.length; j = i++) {
    const xi = coordinates[i]![0]!;
    const yi = coordinates[i]![1]!;
    const xj = coordinates[j]![0]!;
    const yj = coordinates[j]![1]!;
    const intersect = yi > lng !== yj > lng && lat < ((xj - xi) * (lng - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function isPointInBoundary(lat: number, lng: number, boundary: GeofenceBoundary): boolean {
  if (boundary.type === 'circle' && boundary.center && boundary.radius_metres !== undefined) {
    const distance = haversineMetres(lat, lng, boundary.center.lat, boundary.center.lng);
    return distance <= boundary.radius_metres;
  }
  if (boundary.type === 'polygon' && Array.isArray(boundary.coordinates)) {
    return pointInPolygon(lat, lng, boundary.coordinates);
  }
  return false;
}

/**
 * REVIEW-P2C11 ROUND 1 BLOCKING 3 — deterministic event id for
 * trn.geofence.entered + trn.geofence.exited. Keys on the geofence
 * event row id so a redelivered outbox row carries the same envelope.
 */
export function deterministicGeofenceEventEventId(
  geofenceEventId: string,
  eventType: 'ENTER' | 'EXIT',
): string {
  const topic = eventType === 'ENTER' ? 'trn.geofence.entered' : 'trn.geofence.exited';
  const hash = createHash('sha256')
    .update(geofenceEventId + ':' + topic + ':v1')
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

/**
 * GeofenceService — per-school zone definitions plus the GeofenceWorker
 * boundary check fired after every position update.
 *
 * The Step 6 GeofenceWorker pattern lives in this service rather than a
 * separate process because the position-ingest path runs in the same
 * tenant context and the inbound vehicle id is already validated. The
 * worker walks every active geofence for the school, runs
 * isPointInBoundary, and on a transition since the last position event
 * INSERTs a trn_geofence_events row + emits trn.geofence.entered or
 * trn.geofence.exited.
 */
@Injectable()
export class GeofenceService implements OnModuleInit {
  private readonly logger = new Logger(GeofenceService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxService,
    private readonly positions: VehiclePositionService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  onModuleInit(): void {
    // Wire the position service to call us back after each ingest.
    this.positions.setGeofenceCheckCallback(async (vehicleId, latitude, longitude, speedKmh) => {
      await this.checkAndEmitEvents(vehicleId, latitude, longitude, speedKmh);
    });
  }

  /**
   * REVIEW-P2C11 ROUND 1 BLOCKING 6 — replace `personType === 'STAFF'`
   * with explicit TRN-002:write check.
   */
  private async assertCanManage(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'trn-002:write',
      'trn-002:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Only school admins or transportation staff with trn-002:write can manage geofences',
      );
    }
  }

  // ── Geofence CRUD ──

  async list(args: { includeInactive?: boolean }): Promise<GeofenceResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (!args.includeInactive) {
      where.push('is_active = true');
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_GEOFENCE_BASE +
          'WHERE ' +
          where.join(' AND ') +
          ' ORDER BY geofence_type ASC, name ASC',
        ...params,
      );
    })) as GeofenceRow[];
    return rows.map(geofenceRowToDto);
  }

  async getById(id: string): Promise<GeofenceResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_GEOFENCE_BASE + 'WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      );
    })) as GeofenceRow[];
    if (rows.length === 0) throw new NotFoundException('Geofence not found');
    return geofenceRowToDto(rows[0]!);
  }

  private validateBoundary(boundary: GeofenceBoundary): void {
    if (!boundary || typeof boundary !== 'object') {
      throw new BadRequestException('boundary must be a JSON object');
    }
    if (boundary.type === 'circle') {
      if (
        !boundary.center ||
        typeof boundary.center.lat !== 'number' ||
        typeof boundary.center.lng !== 'number'
      ) {
        throw new BadRequestException('circle boundary requires center.lat and center.lng');
      }
      if (typeof boundary.radius_metres !== 'number' || boundary.radius_metres <= 0) {
        throw new BadRequestException('circle boundary requires positive radius_metres');
      }
    } else if (boundary.type === 'polygon') {
      if (!Array.isArray(boundary.coordinates) || boundary.coordinates.length < 3) {
        throw new BadRequestException(
          'polygon boundary requires a coordinates array of at least 3 points',
        );
      }
      for (const pair of boundary.coordinates) {
        if (
          !Array.isArray(pair) ||
          pair.length < 2 ||
          typeof pair[0] !== 'number' ||
          typeof pair[1] !== 'number'
        ) {
          throw new BadRequestException('polygon coordinates must be an array of [lat, lng] pairs');
        }
      }
    } else {
      throw new BadRequestException("boundary.type must be 'circle' or 'polygon'");
    }
  }

  async create(input: CreateGeofenceDto, actor: ResolvedActor): Promise<GeofenceResponseDto> {
    await this.assertCanManage(actor);
    this.validateBoundary(input.boundary);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO trn_geofences (id, school_id, name, geofence_type, boundary, speed_limit_kmh, is_active, description, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7, $8, $9::uuid)',
          id,
          tenant.schoolId,
          input.name,
          input.geofenceType,
          JSON.stringify(input.boundary),
          input.speedLimitKmh ?? null,
          input.isActive ?? true,
          input.description ?? null,
          actor.accountId,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'A geofence named "' + input.name + '" already exists in this school',
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  async update(
    id: string,
    input: UpdateGeofenceDto,
    actor: ResolvedActor,
  ): Promise<GeofenceResponseDto> {
    await this.assertCanManage(actor);
    if (input.boundary) this.validateBoundary(input.boundary);
    const tenant = getCurrentTenant();

    const updates: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) {
      params.push(input.name);
      updates.push('name = $' + params.length);
    }
    if (input.boundary !== undefined) {
      params.push(JSON.stringify(input.boundary));
      updates.push('boundary = $' + params.length + '::jsonb');
    }
    if (input.speedLimitKmh !== undefined) {
      params.push(input.speedLimitKmh);
      updates.push('speed_limit_kmh = $' + params.length);
    }
    if (input.description !== undefined) {
      params.push(input.description);
      updates.push('description = $' + params.length);
    }
    if (input.isActive !== undefined) {
      params.push(input.isActive);
      updates.push('is_active = $' + params.length);
    }
    if (updates.length === 0) {
      return this.getById(id);
    }
    updates.push('updated_at = now()');

    params.push(tenant.schoolId);
    params.push(id);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const result = await client.$executeRawUnsafe(
        'UPDATE trn_geofences SET ' +
          updates.join(', ') +
          ' WHERE school_id = $' +
          (params.length - 1) +
          '::uuid AND id = $' +
          params.length +
          '::uuid',
        ...params,
      );
      if (result === 0) throw new NotFoundException('Geofence not found');
    });
    return this.getById(id);
  }

  // ── GeofenceWorker — boundary check ──

  /**
   * Called after every position INSERT. Walks active geofences in
   * the calling tenant, runs isPointInBoundary, and on a transition
   * (the vehicle wasn't inside on the prior position but is now, or
   * vice versa) INSERTs a trn_geofence_events row + emits
   * trn.geofence.entered or trn.geofence.exited.
   *
   * Last-known boundary state is derived from the most recent
   * trn_geofence_events row per (vehicle, geofence) pair — if the
   * last event was ENTER the vehicle is currently inside, if EXIT
   * it is outside, if there is no prior event the vehicle is
   * assumed to be outside.
   */
  async checkAndEmitEvents(
    vehicleId: string,
    latitude: number,
    longitude: number,
    speedKmh: number | null,
  ): Promise<void> {
    const tenant = getCurrentTenant();

    const geofences = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_GEOFENCE_BASE + 'WHERE school_id = $1::uuid AND is_active = true',
        tenant.schoolId,
      );
    })) as GeofenceRow[];

    for (const gf of geofences) {
      let nowInside = false;
      try {
        nowInside = isPointInBoundary(latitude, longitude, gf.boundary);
      } catch (err) {
        this.logger.warn('Invalid boundary for geofence ' + gf.id + ': ' + String(err));
        continue;
      }

      // Resolve prior state — the latest event per (vehicle, geofence)
      const lastEventRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT event_type FROM trn_geofence_events ' +
            'WHERE vehicle_id = $1::uuid AND geofence_id = $2::uuid ' +
            'ORDER BY recorded_at DESC LIMIT 1',
          vehicleId,
          gf.id,
        );
      })) as Array<{ event_type: string }>;
      const wasInside = lastEventRows.length > 0 && lastEventRows[0]!.event_type === 'ENTER';

      // No transition — skip
      if (nowInside === wasInside) continue;

      const eventType: 'ENTER' | 'EXIT' = nowInside ? 'ENTER' : 'EXIT';
      const eventId = generateId();
      const recordedAt = new Date();

      // REVIEW-P2C11 ROUND 1 BLOCKING 3 — geofence event INSERT and
      // the trn.geofence.entered / trn.geofence.exited outbox emit
      // commit inside one tenant tx. Deterministic event_id keyed on
      // the geofence event row so a redelivered outbox row dedups
      // cleanly downstream. A Kafka outage no longer drops the
      // parent-notification fan-out signal.
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'INSERT INTO trn_geofence_events (id, geofence_id, vehicle_id, event_type, recorded_at, speed_at_event, latitude, longitude) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $6::numeric, $7::numeric, $8::numeric)',
          eventId,
          gf.id,
          vehicleId,
          eventType,
          recordedAt.toISOString(),
          speedKmh,
          latitude,
          longitude,
        );
        await this.outbox.enqueueInTx(tx as unknown as OutboxTxClient, {
          topic: eventType === 'ENTER' ? 'trn.geofence.entered' : 'trn.geofence.exited',
          key: vehicleId,
          sourceModule: 'transport',
          eventId: deterministicGeofenceEventEventId(eventId, eventType),
          payload: {
            eventId,
            geofenceId: gf.id,
            geofenceName: gf.name,
            geofenceType: gf.geofence_type,
            schoolId: tenant.schoolId,
            vehicleId,
            eventType,
            speedKmh,
            speedLimitKmh: gf.speed_limit_kmh,
            latitude,
            longitude,
            recordedAt: recordedAt.toISOString(),
          },
        });
      });
    }
  }

  async listEvents(args: {
    geofenceId?: string;
    vehicleId?: string;
    fromDate?: string;
    toDate?: string;
    limit?: number;
  }): Promise<GeofenceEventResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['g.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.geofenceId) {
      params.push(args.geofenceId);
      where.push('e.geofence_id = $' + params.length + '::uuid');
    }
    if (args.vehicleId) {
      params.push(args.vehicleId);
      where.push('e.vehicle_id = $' + params.length + '::uuid');
    }
    if (args.fromDate) {
      params.push(args.fromDate);
      where.push('e.recorded_at >= $' + params.length + '::timestamptz');
    }
    if (args.toDate) {
      params.push(args.toDate);
      where.push('e.recorded_at < $' + params.length + '::timestamptz');
    }
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
    params.push(limit);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_EVENT_BASE +
          'WHERE ' +
          where.join(' AND ') +
          ' ORDER BY e.recorded_at DESC LIMIT $' +
          params.length,
        ...params,
      );
    })) as GeofenceEventRow[];
    return rows.map(eventRowToDto);
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const anyErr = err as { code?: string; meta?: { code?: string }; message?: string };
  if (anyErr.code === 'P2010' || anyErr.meta?.code === '23505') return true;
  if (typeof anyErr.message === 'string' && anyErr.message.includes('23505')) return true;
  return false;
}
