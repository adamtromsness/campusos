import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  CreateInspectionDto,
  InspectionItemResponseDto,
  InspectionItemStatus,
  InspectionResponseDto,
  InspectionStatus,
} from './dto/transport.dto';

@Injectable()
export class InspectionService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Resolve the calling staff member's hr_employees.id; only employees
   * can submit pre-trip inspections (the schema's driver_id NOT NULL
   * makes this a hard requirement). Admins without hr_employees rows
   * (e.g. the synthetic admin@) are refused — the synthetic Platform
   * Admin doesn't drive.
   */
  private assertEmployeeActor(actor: ResolvedActor): string {
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Pre-trip inspections must be submitted by an active employee. The synthetic Platform Admin cannot submit inspections.',
      );
    }
    return actor.employeeId;
  }

  async listForVehicle(vehicleId: string): Promise<InspectionResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT i.id::text AS id, i.vehicle_id::text AS vehicle_id, i.driver_id::text AS driver_id, ' +
          "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
          '  JOIN hr_employees he ON he.person_id = ip.id WHERE he.id = i.driver_id) AS driver_name, ' +
          'i.inspection_date, i.overall_status, i.notes, i.completed_at ' +
          'FROM trn_pre_trip_inspections i ' +
          'WHERE i.vehicle_id = $1::uuid ' +
          'ORDER BY i.inspection_date DESC LIMIT 60',
        vehicleId,
      );
    })) as Array<{
      id: string;
      vehicle_id: string;
      driver_id: string;
      driver_name: string | null;
      inspection_date: Date;
      overall_status: string;
      notes: string | null;
      completed_at: Date;
    }>;
    return rows.map((r) => ({
      id: r.id,
      vehicleId: r.vehicle_id,
      driverId: r.driver_id,
      driverName: r.driver_name,
      inspectionDate: r.inspection_date.toISOString().slice(0, 10),
      overallStatus: r.overall_status as InspectionStatus,
      notes: r.notes,
      completedAt: r.completed_at.toISOString(),
    }));
  }

  async getById(inspectionId: string): Promise<InspectionResponseDto> {
    const headRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT i.id::text AS id, i.vehicle_id::text AS vehicle_id, i.driver_id::text AS driver_id, ' +
          "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
          '  JOIN hr_employees he ON he.person_id = ip.id WHERE he.id = i.driver_id) AS driver_name, ' +
          'i.inspection_date, i.overall_status, i.notes, i.completed_at ' +
          'FROM trn_pre_trip_inspections i WHERE i.id = $1::uuid LIMIT 1',
        inspectionId,
      );
    })) as Array<{
      id: string;
      vehicle_id: string;
      driver_id: string;
      driver_name: string | null;
      inspection_date: Date;
      overall_status: string;
      notes: string | null;
      completed_at: Date;
    }>;
    if (headRows.length === 0) throw new NotFoundException('Inspection not found');
    const r = headRows[0]!;

    const itemRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, inspection_id::text AS inspection_id, item_name, status, notes ' +
          'FROM trn_pre_trip_inspection_items WHERE inspection_id = $1::uuid ORDER BY item_name',
        inspectionId,
      );
    })) as Array<{
      id: string;
      inspection_id: string;
      item_name: string;
      status: string;
      notes: string | null;
    }>;
    const items: InspectionItemResponseDto[] = itemRows.map((it) => ({
      id: it.id,
      inspectionId: it.inspection_id,
      itemName: it.item_name,
      status: it.status as InspectionItemStatus,
      notes: it.notes,
    }));
    return {
      id: r.id,
      vehicleId: r.vehicle_id,
      driverId: r.driver_id,
      driverName: r.driver_name,
      inspectionDate: r.inspection_date.toISOString().slice(0, 10),
      overallStatus: r.overall_status as InspectionStatus,
      notes: r.notes,
      completedAt: r.completed_at.toISOString(),
      items,
    };
  }

  async create(
    vehicleId: string,
    input: CreateInspectionDto,
    actor: ResolvedActor,
  ): Promise<InspectionResponseDto> {
    const driverEmployeeId = this.assertEmployeeActor(actor);
    if (!input.items || input.items.length === 0) {
      throw new BadRequestException('Inspection must include at least one checklist item');
    }

    // Compute overall_status: any FAIL → FAIL; any CONDITIONAL note in
    // notes column → CONDITIONAL is admin override territory; default
    // to PASS when every item is PASS or NOT_APPLICABLE.
    const hasFail = input.items.some((it) => it.status === 'FAIL');
    const overall: InspectionStatus = hasFail ? 'FAIL' : 'PASS';

    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'INSERT INTO trn_pre_trip_inspections (id, vehicle_id, driver_id, inspection_date, overall_status, notes, completed_at) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6, now())',
          id,
          vehicleId,
          driverEmployeeId,
          input.inspectionDate,
          overall,
          input.notes ?? null,
        );
        for (const it of input.items) {
          await tx.$executeRawUnsafe(
            'INSERT INTO trn_pre_trip_inspection_items (id, inspection_id, item_name, status, notes) ' +
              'VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
            generateId(),
            id,
            it.itemName,
            it.status,
            it.notes ?? null,
          );
        }
      });
    } catch (err: unknown) {
      const e = err as { code?: string; meta?: { code?: string }; message?: string };
      if (
        e.code === '23505' ||
        e.meta?.code === '23505' ||
        (typeof e.message === 'string' && e.message.includes('23505'))
      ) {
        throw new BadRequestException('An inspection already exists for this vehicle on this date');
      }
      throw err;
    }

    return this.getById(id);
  }

  /**
   * Used by RunLogService.start to refuse a run when today's inspection
   * is missing or FAIL. The keystone safety gate.
   */
  async assertVehicleInspectedAndPassing(vehicleId: string, runDate: string): Promise<void> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT overall_status FROM trn_pre_trip_inspections WHERE vehicle_id = $1::uuid AND inspection_date = $2::date LIMIT 1',
        vehicleId,
        runDate,
      );
    })) as Array<{ overall_status: string }>;
    if (rows.length === 0) {
      throw new BadRequestException(
        'No pre-trip inspection on file for this vehicle and date. Complete the daily inspection before starting a run.',
      );
    }
    if (rows[0]!.overall_status === 'FAIL') {
      throw new BadRequestException(
        'Pre-trip inspection FAILED. Resolve the failing items + record a new inspection before starting a run.',
      );
    }
  }
}
