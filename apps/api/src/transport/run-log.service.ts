import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { InspectionService } from './inspection.service';
import {
  CompleteRunLogDto,
  CreateRunLogDto,
  RunLogResponseDto,
  RunStatus,
} from './dto/transport.dto';

@Injectable()
export class RunLogService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly inspections: InspectionService,
  ) {}

  async start(input: CreateRunLogDto, actor: ResolvedActor): Promise<RunLogResponseDto> {
    if (!actor.employeeId) {
      throw new ForbiddenException('Only an active employee (driver) can start a route run.');
    }
    // Resolve the assigned vehicle from the route
    const routeRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT vehicle_id::text AS vehicle_id, status FROM trn_routes WHERE id = $1::uuid LIMIT 1',
        input.routeId,
      );
    })) as Array<{ vehicle_id: string | null; status: string }>;
    if (routeRows.length === 0) throw new NotFoundException('Route not found');
    if (routeRows[0]!.status !== 'ACTIVE') {
      throw new BadRequestException('Route is not ACTIVE; cannot start a run');
    }
    const vehicleId = routeRows[0]!.vehicle_id;
    if (!vehicleId) {
      throw new BadRequestException('Route has no assigned vehicle');
    }

    // Pre-trip safety gate
    await this.inspections.assertVehicleInspectedAndPassing(vehicleId, input.runDate);

    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO trn_route_run_logs (id, route_id, vehicle_id, driver_id, run_date, departure_time, odometer_start, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, now(), $6, 'IN_PROGRESS')",
        id,
        input.routeId,
        vehicleId,
        actor.employeeId,
        input.runDate,
        input.odometerStart ?? null,
      );
    });
    return this.getById(id);
  }

  async complete(
    runId: string,
    input: CompleteRunLogDto,
    actor: ResolvedActor,
  ): Promise<RunLogResponseDto> {
    if (!actor.employeeId && !actor.isSchoolAdmin) {
      throw new ForbiddenException('Only the driver or a school admin can complete a route run.');
    }

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = (await tx.$queryRawUnsafe(
        'SELECT id, driver_id::text AS driver_id, status FROM trn_route_run_logs WHERE id = $1::uuid FOR UPDATE',
        runId,
      )) as Array<{ id: string; driver_id: string; status: string }>;
      if (locked.length === 0) throw new NotFoundException('Run not found');
      const row = locked[0]!;
      if (row.status !== 'IN_PROGRESS') {
        throw new BadRequestException(
          'Run is in status ' + row.status + '; only IN_PROGRESS runs can be completed',
        );
      }
      if (!actor.isSchoolAdmin && row.driver_id !== actor.employeeId) {
        throw new ForbiddenException('Only the originating driver can complete this run');
      }
      const status: RunStatus = input.status ?? 'COMPLETED';
      await tx.$executeRawUnsafe(
        'UPDATE trn_route_run_logs SET status = $1, arrival_time = now(), odometer_end = $2, notes = $3, updated_at = now() WHERE id = $4::uuid',
        status,
        input.odometerEnd ?? null,
        input.notes ?? null,
        runId,
      );
      // Recompute students_boarded
      await tx.$executeRawUnsafe(
        'UPDATE trn_route_run_logs SET students_boarded = (' +
          "SELECT COUNT(*)::int FROM trn_ridership_records r WHERE r.route_id = trn_route_run_logs.route_id AND r.scanned_at::date = trn_route_run_logs.run_date AND r.scan_direction = 'BOARDING'" +
          ') WHERE id = $1::uuid',
        runId,
      );
    });
    return this.getById(runId);
  }

  async getById(runId: string): Promise<RunLogResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, route_id::text AS route_id, vehicle_id::text AS vehicle_id, ' +
          'driver_id::text AS driver_id, run_date, departure_time, arrival_time, ' +
          'odometer_start, odometer_end, students_boarded, status ' +
          'FROM trn_route_run_logs WHERE id = $1::uuid LIMIT 1',
        runId,
      );
    })) as Array<{
      id: string;
      route_id: string;
      vehicle_id: string;
      driver_id: string;
      run_date: Date;
      departure_time: Date | null;
      arrival_time: Date | null;
      odometer_start: number | null;
      odometer_end: number | null;
      students_boarded: number;
      status: string;
    }>;
    if (rows.length === 0) throw new NotFoundException('Run not found');
    const r = rows[0]!;
    return {
      id: r.id,
      routeId: r.route_id,
      vehicleId: r.vehicle_id,
      driverId: r.driver_id,
      runDate: r.run_date.toISOString().slice(0, 10),
      departureTime: r.departure_time ? r.departure_time.toISOString() : null,
      arrivalTime: r.arrival_time ? r.arrival_time.toISOString() : null,
      odometerStart: r.odometer_start,
      odometerEnd: r.odometer_end,
      studentsBoarded: r.students_boarded,
      status: r.status as RunStatus,
    };
  }
}
