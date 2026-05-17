import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  ComponentResponseDto,
  ComponentStatus,
  ComponentType,
  CreateComponentDto,
  UpdateComponentDto,
} from './dto/fleet-maintenance.dto';

interface ComponentRow {
  id: string;
  vehicle_id: string;
  component_type: string;
  description: string | null;
  installed_date: Date;
  installed_mileage: number;
  expected_life_miles: number | null;
  expected_life_months: number | null;
  warranty_provider: string | null;
  warranty_expiry_date: Date | null;
  status: string;
  replaced_at: Date | null;
  replaced_by_component_id: string | null;
  notes: string | null;
}

const SELECT_COMPONENT_BASE =
  'SELECT id::text AS id, vehicle_id::text AS vehicle_id, component_type, description, ' +
  'installed_date, installed_mileage, expected_life_miles, expected_life_months, ' +
  'warranty_provider, warranty_expiry_date, status, replaced_at, ' +
  'replaced_by_component_id::text AS replaced_by_component_id, notes ' +
  'FROM trn_vehicle_components ';

/** Approaching-end-of-life threshold: 90% of expected life by months. */
const APPROACHING_THRESHOLD_PCT = 0.9;

function rowToDto(r: ComponentRow): ComponentResponseDto {
  const now = new Date();
  const installed = r.installed_date;
  const ageDays = Math.floor((now.getTime() - installed.getTime()) / (1000 * 60 * 60 * 24));
  let monthsRemaining: number | null = null;
  let approaching = false;
  if (r.expected_life_months !== null && r.status === 'ACTIVE') {
    const expiresAt = new Date(installed);
    expiresAt.setMonth(expiresAt.getMonth() + r.expected_life_months);
    monthsRemaining = Math.floor(
      (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24 * 30),
    );
    const ageMonths = Math.floor(ageDays / 30);
    if (ageMonths >= r.expected_life_months * APPROACHING_THRESHOLD_PCT) {
      approaching = true;
    }
  }
  return {
    id: r.id,
    vehicleId: r.vehicle_id,
    componentType: r.component_type as ComponentType,
    description: r.description,
    installedDate: r.installed_date.toISOString().slice(0, 10),
    installedMileage: r.installed_mileage,
    expectedLifeMiles: r.expected_life_miles,
    expectedLifeMonths: r.expected_life_months,
    warrantyProvider: r.warranty_provider,
    warrantyExpiryDate: r.warranty_expiry_date
      ? r.warranty_expiry_date.toISOString().slice(0, 10)
      : null,
    status: r.status as ComponentStatus,
    replacedAt: r.replaced_at ? r.replaced_at.toISOString() : null,
    replacedByComponentId: r.replaced_by_component_id,
    notes: r.notes,
    ageDays,
    monthsRemaining,
    approachingEndOfLife: approaching,
  };
}

@Injectable()
export class ComponentService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertCanManage(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STAFF') return;
    throw new ForbiddenException(
      'Only school admins or transportation staff can manage vehicle components',
    );
  }

  async listForVehicle(
    vehicleId: string,
    args: { status?: ComponentStatus } = {},
  ): Promise<ComponentResponseDto[]> {
    const where: string[] = ['vehicle_id = $1::uuid'];
    const params: unknown[] = [vehicleId];
    if (args.status) {
      where.push('status = $' + (params.length + 1));
      params.push(args.status);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_COMPONENT_BASE +
          'WHERE ' +
          where.join(' AND ') +
          ' ORDER BY installed_date DESC LIMIT 500',
        ...params,
      );
    })) as ComponentRow[];
    return rows.map(rowToDto);
  }

  async getById(componentId: string): Promise<ComponentResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_COMPONENT_BASE + 'WHERE id = $1::uuid LIMIT 1',
        componentId,
      );
    })) as ComponentRow[];
    if (rows.length === 0) throw new NotFoundException('Component not found');
    return rowToDto(rows[0]!);
  }

  async listApproachingEndOfLife(): Promise<ComponentResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_COMPONENT_BASE.replace(
          'FROM trn_vehicle_components',
          'FROM trn_vehicle_components c',
        )
          .replace(
            'id::text AS id, vehicle_id::text AS vehicle_id',
            'c.id::text AS id, c.vehicle_id::text AS vehicle_id',
          )
          .replace('component_type, description', 'c.component_type, c.description')
          .replace('installed_date, installed_mileage', 'c.installed_date, c.installed_mileage')
          .replace(
            'expected_life_miles, expected_life_months',
            'c.expected_life_miles, c.expected_life_months',
          )
          .replace(
            'warranty_provider, warranty_expiry_date, status',
            'c.warranty_provider, c.warranty_expiry_date, c.status',
          )
          .replace(
            'replaced_at, replaced_by_component_id::text AS replaced_by_component_id, notes',
            'c.replaced_at, c.replaced_by_component_id::text AS replaced_by_component_id, c.notes',
          ) +
          'JOIN trn_vehicles v ON v.id = c.vehicle_id ' +
          "WHERE v.school_id = $1::uuid AND c.status = 'ACTIVE' " +
          'AND c.expected_life_months IS NOT NULL ' +
          'AND (CURRENT_DATE - c.installed_date) >= (c.expected_life_months * 30 * 0.9) ' +
          'ORDER BY c.installed_date ASC LIMIT 200',
        tenant.schoolId,
      );
    })) as ComponentRow[];
    return rows.map(rowToDto);
  }

  async create(
    vehicleId: string,
    input: CreateComponentDto,
    actor: ResolvedActor,
  ): Promise<ComponentResponseDto> {
    this.assertCanManage(actor);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const vRows = (await client.$queryRawUnsafe(
        'SELECT id FROM trn_vehicles WHERE id = $1::uuid LIMIT 1',
        vehicleId,
      )) as Array<{ id: string }>;
      if (vRows.length === 0) throw new NotFoundException('Vehicle not found');

      await client.$executeRawUnsafe(
        'INSERT INTO trn_vehicle_components ' +
          '(id, vehicle_id, component_type, description, installed_date, installed_mileage, ' +
          'expected_life_miles, expected_life_months, warranty_provider, warranty_expiry_date, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, $6, $7, $8, $9, $10::date, 'ACTIVE')",
        id,
        vehicleId,
        input.componentType,
        input.description ?? null,
        input.installedDate,
        input.installedMileage,
        input.expectedLifeMiles ?? null,
        input.expectedLifeMonths ?? null,
        input.warrantyProvider ?? null,
        input.warrantyExpiryDate ?? null,
      );
    });
    return this.getById(id);
  }

  /**
   * Replace or mark-failed a component. Sets replaced_at and (for
   * REPLACED) the replaced_by_component_id chaining. The schema-side
   * multi-column replaced_chk pins replaced_at to NOT NULL on REPLACED
   * or FAILED.
   */
  async patch(
    componentId: string,
    input: UpdateComponentDto,
    actor: ResolvedActor,
  ): Promise<ComponentResponseDto> {
    this.assertCanManage(actor);

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT status FROM trn_vehicle_components WHERE id = $1::uuid FOR UPDATE',
        componentId,
      )) as Array<{ status: string }>;
      if (rows.length === 0) throw new NotFoundException('Component not found');
      const prior = rows[0]!.status;

      const sets: string[] = [];
      const params: unknown[] = [];
      if (input.status !== undefined) {
        sets.push('status = $' + (params.length + 1));
        params.push(input.status);
        if (input.status !== 'ACTIVE' && prior === 'ACTIVE') {
          sets.push('replaced_at = now()');
        }
        if (input.status === 'ACTIVE' && prior !== 'ACTIVE') {
          sets.push('replaced_at = NULL');
          sets.push('replaced_by_component_id = NULL');
        }
      }
      if (input.description !== undefined) {
        sets.push('description = $' + (params.length + 1));
        params.push(input.description);
      }
      if (input.notes !== undefined) {
        sets.push('notes = $' + (params.length + 1));
        params.push(input.notes);
      }
      if (input.replacedByComponentId !== undefined) {
        sets.push('replaced_by_component_id = $' + (params.length + 1) + '::uuid');
        params.push(input.replacedByComponentId);
      }
      if (sets.length === 0) return;
      sets.push('updated_at = now()');
      params.push(componentId);
      await tx.$executeRawUnsafe(
        'UPDATE trn_vehicle_components SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          params.length +
          '::uuid',
        ...params,
      );
    });

    return this.getById(componentId);
  }
}
