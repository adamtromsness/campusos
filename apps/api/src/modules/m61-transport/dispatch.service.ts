import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  CreateDispatchEventDto,
  DispatchEventResponseDto,
  DispatchEventType,
} from './dto/gps-fleet.dto';

interface DispatchEventRow {
  id: string;
  school_id: string;
  vehicle_id: string | null;
  vehicle_registration: string | null;
  route_id: string | null;
  route_name: string | null;
  driver_id: string | null;
  event_type: string;
  event_data: Record<string, unknown> | null;
  recorded_at: Date;
  recorded_by: string | null;
  notes: string | null;
  created_at: Date;
}

const SELECT_DISPATCH_BASE =
  'SELECT e.id::text AS id, e.school_id::text AS school_id, ' +
  'e.vehicle_id::text AS vehicle_id, v.registration AS vehicle_registration, ' +
  'e.route_id::text AS route_id, r.name AS route_name, ' +
  'e.driver_id::text AS driver_id, e.event_type, e.event_data, ' +
  'e.recorded_at, e.recorded_by::text AS recorded_by, e.notes, e.created_at ' +
  'FROM trn_dispatch_events e ' +
  'LEFT JOIN trn_vehicles v ON v.id = e.vehicle_id ' +
  'LEFT JOIN trn_routes r ON r.id = e.route_id ';

function rowToDto(r: DispatchEventRow): DispatchEventResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    vehicleId: r.vehicle_id,
    vehicleRegistration: r.vehicle_registration,
    routeId: r.route_id,
    routeName: r.route_name,
    driverId: r.driver_id,
    eventType: r.event_type as DispatchEventType,
    eventData: r.event_data,
    recordedAt: r.recorded_at.toISOString(),
    recordedBy: r.recorded_by,
    notes: r.notes,
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * DispatchService — TC-facing dispatch event log.
 *
 * The 8-value event_type CHECK covers route start and completion plus
 * delay and breakdown plus student no-show plus emergency stop plus
 * detour plus driver swap. event_data JSONB captures the free-shape
 * payload — minutes_delayed for DELAY_REPORTED, fault for
 * BREAKDOWN_REPORTED, etc.
 *
 * Events are append-only at the service layer — no UPDATE / no DELETE
 * methods exposed. The audit trail survives the parent vehicle or
 * route being retired (SET NULL on hard-delete preserves the row).
 */
@Injectable()
export class DispatchService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertCanLog(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STAFF') return;
    throw new ForbiddenException(
      'Only school admins or transportation staff can log dispatch events',
    );
  }

  async create(
    input: CreateDispatchEventDto,
    actor: ResolvedActor,
  ): Promise<DispatchEventResponseDto> {
    this.assertCanLog(actor);
    const tenant = getCurrentTenant();

    // Validate refs belong to this school
    if (input.vehicleId) {
      const v = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM trn_vehicles WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
          input.vehicleId,
          tenant.schoolId,
        );
      })) as Array<{ ok: number }>;
      if (v.length === 0) {
        throw new BadRequestException('vehicleId does not match a vehicle in this school');
      }
    }
    if (input.routeId) {
      const r = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM trn_routes WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
          input.routeId,
          tenant.schoolId,
        );
      })) as Array<{ ok: number }>;
      if (r.length === 0) {
        throw new BadRequestException('routeId does not match a route in this school');
      }
    }
    if (input.driverId) {
      const d = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM hr_employees WHERE id = $1::uuid LIMIT 1',
          input.driverId,
        );
      })) as Array<{ ok: number }>;
      if (d.length === 0) {
        throw new BadRequestException('driverId does not match an employee in this school');
      }
    }

    const id = generateId();
    const recordedAt = input.recordedAt ? new Date(input.recordedAt) : new Date();

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO trn_dispatch_events (id, school_id, vehicle_id, route_id, driver_id, event_type, event_data, recorded_at, recorded_by, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::jsonb, $8::timestamptz, $9::uuid, $10)',
        id,
        tenant.schoolId,
        input.vehicleId ?? null,
        input.routeId ?? null,
        input.driverId ?? null,
        input.eventType,
        JSON.stringify(input.eventData ?? {}),
        recordedAt.toISOString(),
        actor.accountId,
        input.notes ?? null,
      );
    });

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_DISPATCH_BASE + 'WHERE e.id = $1::uuid LIMIT 1', id);
    })) as DispatchEventRow[];
    return rowToDto(rows[0]!);
  }

  async list(args: {
    vehicleId?: string;
    routeId?: string;
    eventType?: DispatchEventType;
    fromDate?: string;
    toDate?: string;
    limit?: number;
  }): Promise<DispatchEventResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['e.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.vehicleId) {
      params.push(args.vehicleId);
      where.push('e.vehicle_id = $' + params.length + '::uuid');
    }
    if (args.routeId) {
      params.push(args.routeId);
      where.push('e.route_id = $' + params.length + '::uuid');
    }
    if (args.eventType) {
      params.push(args.eventType);
      where.push('e.event_type = $' + params.length);
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
        SELECT_DISPATCH_BASE +
          'WHERE ' +
          where.join(' AND ') +
          ' ORDER BY e.recorded_at DESC LIMIT $' +
          params.length,
        ...params,
      );
    })) as DispatchEventRow[];
    return rows.map(rowToDto);
  }
}
