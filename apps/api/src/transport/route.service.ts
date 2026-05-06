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
import { RouteChangeLogService } from './route-change-log.service';
import {
  CreateRouteDto,
  RouteDirection,
  RouteResponseDto,
  RouteStatus,
  StopResponseDto,
  UpdateRouteDto,
} from './dto/transport.dto';

interface RouteRow {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  direction: string;
  status: string;
  vehicle_id: string | null;
  vehicle_registration: string | null;
  driver_id: string | null;
  driver_name: string | null;
  academic_year_id: string | null;
  academic_year_name: string | null;
  stop_count: number;
  student_count: number;
  created_at: Date;
}

const SELECT_ROUTE_BASE =
  'SELECT r.id::text AS id, r.school_id::text AS school_id, r.name, r.description, ' +
  'r.direction, r.status, r.vehicle_id::text AS vehicle_id, ' +
  '(SELECT registration FROM trn_vehicles WHERE id = r.vehicle_id) AS vehicle_registration, ' +
  'r.driver_id::text AS driver_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
  '  JOIN hr_employees he ON he.person_id = ip.id WHERE he.id = r.driver_id) AS driver_name, ' +
  'r.academic_year_id::text AS academic_year_id, ' +
  '(SELECT name FROM sis_academic_years WHERE id = r.academic_year_id) AS academic_year_name, ' +
  '(SELECT COUNT(*)::int FROM trn_stops WHERE route_id = r.id) AS stop_count, ' +
  '(SELECT COUNT(*)::int FROM trn_student_assignments WHERE route_id = r.id) AS student_count, ' +
  'r.created_at ' +
  'FROM trn_routes r ';

function rowToDto(r: RouteRow): RouteResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    description: r.description,
    direction: r.direction as RouteDirection,
    status: r.status as RouteStatus,
    vehicleId: r.vehicle_id,
    vehicleRegistration: r.vehicle_registration,
    driverId: r.driver_id,
    driverName: r.driver_name,
    academicYearId: r.academic_year_id,
    academicYearName: r.academic_year_name,
    stopCount: r.stop_count,
    studentCount: r.student_count,
    createdAt: r.created_at.toISOString(),
  };
}

@Injectable()
export class RouteService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly changeLog: RouteChangeLogService,
  ) {}

  /**
   * Manager scope = school admin OR STAFF (covers the Transportation
   * Coordinator role; the seed grants TRN-001:write to Staff). Joins
   * the broader role-split work in the Wave 2 Phase 2 punch list — a
   * dedicated TC role should hold the TRN-* codes alone before pilot.
   */
  private assertCanManage(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STAFF') return;
    throw new ForbiddenException('Only school admins or transportation staff can manage routes');
  }

  async list(
    actor: ResolvedActor,
    args: { status?: RouteStatus; direction?: RouteDirection },
  ): Promise<RouteResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['r.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];

    if (args.status) {
      where.push('r.status = $' + (params.length + 1));
      params.push(args.status);
    } else if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      where.push("r.status = 'ACTIVE'");
    }
    if (args.direction) {
      where.push('r.direction = $' + (params.length + 1));
      params.push(args.direction);
    }

    const sql =
      SELECT_ROUTE_BASE +
      'WHERE ' +
      where.join(' AND ') +
      ' ORDER BY r.direction, r.name LIMIT 200';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql, ...params);
    })) as RouteRow[];
    return rows.map(rowToDto);
  }

  async getById(routeId: string, actor: ResolvedActor): Promise<RouteResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_ROUTE_BASE + 'WHERE r.id = $1::uuid LIMIT 1', routeId);
    })) as RouteRow[];
    if (rows.length === 0) throw new NotFoundException('Route not found');
    const dto = rowToDto(rows[0]!);
    if (dto.status !== 'ACTIVE' && !actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new NotFoundException('Route not found');
    }
    return dto;
  }

  async getStops(routeId: string): Promise<StopResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, route_id::text AS route_id, name, address, latitude, longitude, sequence_order, ' +
          "to_char(scheduled_time, 'HH24:MI:SS') AS scheduled_time, notes " +
          'FROM trn_stops WHERE route_id = $1::uuid ORDER BY sequence_order',
        routeId,
      );
    })) as Array<{
      id: string;
      route_id: string;
      name: string;
      address: string | null;
      latitude: number | null;
      longitude: number | null;
      sequence_order: number;
      scheduled_time: string | null;
      notes: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      routeId: r.route_id,
      name: r.name,
      address: r.address,
      latitude: r.latitude !== null ? Number(r.latitude) : null,
      longitude: r.longitude !== null ? Number(r.longitude) : null,
      sequenceOrder: r.sequence_order,
      scheduledTime: r.scheduled_time,
      notes: r.notes,
    }));
  }

  async create(input: CreateRouteDto, actor: ResolvedActor): Promise<RouteResponseDto> {
    this.assertCanManage(actor);
    if (input.vehicleId) await this.assertVehicleAssignable(input.vehicleId);
    if (input.driverId) await this.assertDriverAssignable(input.driverId);
    const tenant = getCurrentTenant();
    const id = generateId();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO trn_routes (id, school_id, name, description, direction, vehicle_id, driver_id, status, academic_year_id, created_by) ' +
            "VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::uuid, 'ACTIVE', $8::uuid, $9::uuid)",
          id,
          tenant.schoolId,
          input.name,
          input.description ?? null,
          input.direction,
          input.vehicleId ?? null,
          input.driverId ?? null,
          input.academicYearId ?? null,
          actor.accountId,
        );
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          throw new BadRequestException(
            'A route with this name and direction already exists for this academic year',
          );
        }
        throw err;
      }
      await this.changeLog.recordChange(tx, {
        routeId: id,
        changedBy: actor.accountId,
        changeType: 'ROUTE_ACTIVATED',
        newValue: {
          name: input.name,
          direction: input.direction,
          vehicleId: input.vehicleId ?? null,
          driverId: input.driverId ?? null,
        },
        reason: 'Route created',
      });
    });

    return this.getById(id, actor);
  }

  async patch(
    routeId: string,
    input: UpdateRouteDto,
    actor: ResolvedActor,
  ): Promise<RouteResponseDto> {
    this.assertCanManage(actor);
    if (input.vehicleId !== undefined && input.vehicleId !== null) {
      await this.assertVehicleAssignable(input.vehicleId);
    }
    if (input.driverId !== undefined && input.driverId !== null) {
      await this.assertDriverAssignable(input.driverId);
    }

    const before = await this.getById(routeId, actor);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) {
      sets.push('name = $' + (params.length + 1));
      params.push(input.name);
    }
    if (input.description !== undefined) {
      sets.push('description = $' + (params.length + 1));
      params.push(input.description);
    }
    if (input.status !== undefined) {
      sets.push('status = $' + (params.length + 1));
      params.push(input.status);
    }
    if (input.vehicleId !== undefined) {
      sets.push('vehicle_id = $' + (params.length + 1) + '::uuid');
      params.push(input.vehicleId);
    }
    if (input.driverId !== undefined) {
      sets.push('driver_id = $' + (params.length + 1) + '::uuid');
      params.push(input.driverId);
    }

    if (sets.length === 0) return before;
    sets.push('updated_at = now()');
    params.push(routeId);

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'UPDATE trn_routes SET ' + sets.join(', ') + ' WHERE id = $' + params.length + '::uuid',
        ...params,
      );

      // Log status transitions explicitly
      if (input.status !== undefined && input.status !== before.status) {
        const changeType = input.status === 'ACTIVE' ? 'ROUTE_ACTIVATED' : 'ROUTE_DEACTIVATED';
        await this.changeLog.recordChange(tx, {
          routeId,
          changedBy: actor.accountId,
          changeType,
          oldValue: { status: before.status },
          newValue: { status: input.status },
        });
      }
    });

    return this.getById(routeId, actor);
  }

  /**
   * Used by AssignmentService and StopService to verify the route exists
   * and the actor can read it (404 don't-leak-existence on inactive
   * routes for non-managers).
   */
  async assertCanReadRoute(routeId: string, actor: ResolvedActor): Promise<void> {
    await this.getById(routeId, actor);
  }

  /**
   * Used by mutation paths to verify the actor can manage routes for
   * this tenant. Returns void; throws ForbiddenException if not.
   */
  assertManagerScope(actor: ResolvedActor): void {
    this.assertCanManage(actor);
  }

  /**
   * REVIEW-CYCLE19 BLOCKING 5 — every route create/patch that
   * specifies a vehicleId must verify the vehicle exists in the
   * current tenant + status=ACTIVE. The schema doesn't enforce a
   * cross-table FK on trn_routes.vehicle_id (soft polymorphic-ish),
   * so the application layer is the gate.
   */
  private async assertVehicleAssignable(vehicleId: string): Promise<void> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT status FROM trn_vehicles WHERE id = $1::uuid LIMIT 1',
        vehicleId,
      );
    })) as Array<{ status: string }>;
    if (rows.length === 0) {
      throw new BadRequestException('vehicleId does not match a vehicle in this school');
    }
    if (rows[0]!.status !== 'ACTIVE') {
      throw new BadRequestException(
        'Vehicle is in status ' + rows[0]!.status + '; only ACTIVE vehicles can be assigned',
      );
    }
  }

  /**
   * REVIEW-CYCLE19 BLOCKING 5 — every route create/patch that
   * specifies a driverId must verify the driver exists in
   * hr_employees + carries VALID CDL + MEDICAL_CERTIFICATE
   * credentials. The Step 7 RunLogService.start re-checks at run
   * time too; the route-assignment gate catches misconfiguration
   * upstream.
   */
  private async assertDriverAssignable(driverId: string): Promise<void> {
    const empRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM hr_employees WHERE id = $1::uuid LIMIT 1',
        driverId,
      );
    })) as Array<{ ok: number }>;
    if (empRows.length === 0) {
      throw new BadRequestException('driverId does not match an employee in this school');
    }
    const credRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        "SELECT credential_type, status FROM trn_driver_credentials WHERE driver_id = $1::uuid AND credential_type IN ('CDL', 'MEDICAL_CERTIFICATE')",
        driverId,
      );
    })) as Array<{ credential_type: string; status: string }>;
    const byType = new Map(credRows.map((r) => [r.credential_type, r.status]));
    const cdl = byType.get('CDL');
    const med = byType.get('MEDICAL_CERTIFICATE');
    if (cdl !== 'VALID' || med !== 'VALID') {
      throw new BadRequestException(
        'Driver credentials are not VALID (CDL=' +
          (cdl ?? 'MISSING') +
          ', MEDICAL_CERTIFICATE=' +
          (med ?? 'MISSING') +
          '). Verify or refresh credentials before assigning to a route.',
      );
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (e.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('23505');
}
