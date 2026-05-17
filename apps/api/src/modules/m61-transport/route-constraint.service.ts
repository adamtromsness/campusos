import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  CreateRouteConstraintDto,
  RouteConstraintResponseDto,
  UpdateRouteConstraintDto,
} from './dto/route-generation.dto';

interface ConstraintRow {
  id: string;
  school_id: string;
  constraint_name: string;
  max_ride_time_minutes: number;
  max_route_mileage: string | null;
  max_students_per_vehicle: number | null;
  required_arrival_buffer_minutes: number;
  max_stops_per_route: number | null;
  walkable_radius_metres: number;
  is_active: boolean;
  notes: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT_BASE =
  'SELECT id::text AS id, school_id::text AS school_id, constraint_name, ' +
  'max_ride_time_minutes, max_route_mileage::text AS max_route_mileage, ' +
  'max_students_per_vehicle, required_arrival_buffer_minutes, max_stops_per_route, ' +
  'walkable_radius_metres, is_active, notes, created_by::text AS created_by, ' +
  'created_at, updated_at FROM trn_route_constraints ';

function rowToDto(r: ConstraintRow): RouteConstraintResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    constraintName: r.constraint_name,
    maxRideTimeMinutes: r.max_ride_time_minutes,
    maxRouteMileage: r.max_route_mileage === null ? null : Number(r.max_route_mileage),
    maxStudentsPerVehicle: r.max_students_per_vehicle,
    requiredArrivalBufferMinutes: r.required_arrival_buffer_minutes,
    maxStopsPerRoute: r.max_stops_per_route,
    walkableRadiusMetres: r.walkable_radius_metres,
    isActive: r.is_active,
    notes: r.notes,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string } | null;
  if (!e) return false;
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('23505');
}

/**
 * RouteConstraintService — per-school constraint profile catalogue.
 *
 * Constraint profiles drive the Step 4 RouteGenerationWorker. UNIQUE
 * (school_id, constraint_name) lets a TC ship multiple named profiles
 * (e.g. "2026 Standard" vs "2026 Snow Day") and pick at generation
 * time. is_active=false soft-deactivates a profile without deleting
 * historical generation runs that reference it.
 */
@Injectable()
export class RouteConstraintService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertCanManage(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STAFF') return;
    throw new ForbiddenException(
      'Only school admins or transportation staff can manage route constraints',
    );
  }

  async list(args: { includeInactive?: boolean }): Promise<RouteConstraintResponseDto[]> {
    const tenant = getCurrentTenant();
    const where = args.includeInactive
      ? 'WHERE school_id = $1::uuid'
      : 'WHERE school_id = $1::uuid AND is_active = true';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_BASE + where + ' ORDER BY constraint_name ASC LIMIT 200',
        tenant.schoolId,
      );
    })) as ConstraintRow[];
    return rows.map(rowToDto);
  }

  async getById(constraintId: string): Promise<RouteConstraintResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_BASE + 'WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        constraintId,
      );
    })) as ConstraintRow[];
    if (rows.length === 0) throw new NotFoundException('Route constraint not found');
    return rowToDto(rows[0]!);
  }

  async create(
    input: CreateRouteConstraintDto,
    actor: ResolvedActor,
  ): Promise<RouteConstraintResponseDto> {
    this.assertCanManage(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO trn_route_constraints (id, school_id, constraint_name, max_ride_time_minutes, max_route_mileage, max_students_per_vehicle, required_arrival_buffer_minutes, max_stops_per_route, walkable_radius_metres, notes, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3, COALESCE($4, 45), $5, $6, COALESCE($7, 10), $8, COALESCE($9, 400), $10, $11::uuid)',
          id,
          tenant.schoolId,
          input.constraintName,
          input.maxRideTimeMinutes ?? null,
          input.maxRouteMileage ?? null,
          input.maxStudentsPerVehicle ?? null,
          input.requiredArrivalBufferMinutes ?? null,
          input.maxStopsPerRoute ?? null,
          input.walkableRadiusMetres ?? null,
          input.notes ?? null,
          actor.accountId,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'A constraint profile with that name already exists for this school',
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  async patch(
    constraintId: string,
    input: UpdateRouteConstraintDto,
    actor: ResolvedActor,
  ): Promise<RouteConstraintResponseDto> {
    this.assertCanManage(actor);
    const tenant = getCurrentTenant();

    const sets: string[] = [];
    const params: unknown[] = [];
    function add(col: string, cast: string, val: unknown): void {
      params.push(val);
      sets.push(col + ' = $' + params.length + cast);
    }
    if (input.constraintName !== undefined) add('constraint_name', '', input.constraintName);
    if (input.maxRideTimeMinutes !== undefined)
      add('max_ride_time_minutes', '::int', input.maxRideTimeMinutes);
    if (input.maxRouteMileage !== undefined)
      add('max_route_mileage', '::numeric', input.maxRouteMileage);
    if (input.maxStudentsPerVehicle !== undefined)
      add('max_students_per_vehicle', '::int', input.maxStudentsPerVehicle);
    if (input.requiredArrivalBufferMinutes !== undefined)
      add('required_arrival_buffer_minutes', '::int', input.requiredArrivalBufferMinutes);
    if (input.maxStopsPerRoute !== undefined)
      add('max_stops_per_route', '::int', input.maxStopsPerRoute);
    if (input.walkableRadiusMetres !== undefined)
      add('walkable_radius_metres', '::int', input.walkableRadiusMetres);
    if (input.isActive !== undefined) add('is_active', '::boolean', input.isActive);
    if (input.notes !== undefined) add('notes', '', input.notes);

    if (sets.length === 0) {
      return this.getById(constraintId);
    }
    sets.push('updated_at = now()');
    params.push(tenant.schoolId);
    params.push(constraintId);

    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE trn_route_constraints SET ' +
            sets.join(', ') +
            ' WHERE school_id = $' +
            (params.length - 1) +
            '::uuid AND id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'A constraint profile with that name already exists for this school',
        );
      }
      throw err;
    }
    return this.getById(constraintId);
  }
}
