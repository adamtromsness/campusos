import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import { PermissionCheckService } from '@modules/m00-platform';
import type { ResolvedActor } from '@modules/m00-platform';
import {
  CreateRepairCategoryDto,
  CreateRepairDto,
  RepairCategoryResponseDto,
  RepairPerformedByType,
  RepairResponseDto,
  RepairStatus,
  UpdateRepairCategoryDto,
  UpdateRepairDto,
} from './dto/fleet-maintenance.dto';

interface RepairRow {
  id: string;
  vehicle_id: string;
  category_id: string | null;
  category_name: string | null;
  is_safety_critical: boolean | null;
  repair_date: Date;
  mileage_at_repair: number;
  problem_description: string;
  work_performed: string;
  parts_used: Record<string, unknown> | null;
  labour_hours: string | null;
  total_cost: string;
  performed_by_type: string;
  vendor_account_id: string | null;
  warranty_claim: boolean;
  invoice_s3_key: string | null;
  status: string;
  scheduled_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

// REVIEW-P2C11 ROUND 1 BLOCKING 1 — every repair read joins through
// trn_vehicles so a school predicate can be added at the WHERE level.
// REVIEW-P2C11 ROUND 1 BLOCKING 6 — see assertCanManageFleet below.
const SELECT_REPAIR_BASE =
  'SELECT r.id::text AS id, r.vehicle_id::text AS vehicle_id, ' +
  'r.category_id::text AS category_id, c.name AS category_name, c.is_safety_critical AS is_safety_critical, ' +
  'r.repair_date, r.mileage_at_repair, r.problem_description, r.work_performed, r.parts_used, ' +
  'r.labour_hours::text AS labour_hours, r.total_cost::text AS total_cost, ' +
  'r.performed_by_type, r.vendor_account_id::text AS vendor_account_id, r.warranty_claim, ' +
  'r.invoice_s3_key, r.status, r.scheduled_at, r.started_at, r.completed_at, r.notes, ' +
  'r.created_at, r.updated_at ' +
  'FROM trn_vehicle_repairs r ' +
  'JOIN trn_vehicles v ON v.id = r.vehicle_id ' +
  'LEFT JOIN trn_repair_categories c ON c.id = r.category_id ';

function rowToDto(r: RepairRow): RepairResponseDto {
  return {
    id: r.id,
    vehicleId: r.vehicle_id,
    categoryId: r.category_id,
    categoryName: r.category_name,
    isSafetyCritical: r.is_safety_critical ?? false,
    repairDate: r.repair_date.toISOString().slice(0, 10),
    mileageAtRepair: r.mileage_at_repair,
    problemDescription: r.problem_description,
    workPerformed: r.work_performed,
    partsUsed: r.parts_used,
    labourHours: r.labour_hours === null ? null : Number(r.labour_hours),
    totalCost: Number(r.total_cost),
    performedByType: r.performed_by_type as RepairPerformedByType,
    vendorAccountId: r.vendor_account_id,
    warrantyClaim: r.warranty_claim,
    invoiceS3Key: r.invoice_s3_key,
    status: r.status as RepairStatus,
    scheduledAt: r.scheduled_at ? r.scheduled_at.toISOString() : null,
    startedAt: r.started_at ? r.started_at.toISOString() : null,
    completedAt: r.completed_at ? r.completed_at.toISOString() : null,
    notes: r.notes,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

@Injectable()
export class RepairService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  /**
   * REVIEW-P2C11 ROUND 1 BLOCKING 6 — replace `personType === 'STAFF'`
   * with an explicit TRN-002:write check via the tenant-scoped
   * PermissionCheckService. Mirrors the P2-10a / P2-10b FSM scope
   * pattern. A future Transportation Coordinator role split will hold
   * TRN-002:write alone; until then the IAM seed grants generic Staff
   * the perm.
   */
  private async assertCanManageFleet(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'trn-002:write',
      'trn-002:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Only school admins or transportation staff with trn-002:write can manage repairs',
      );
    }
  }

  // ── Categories ──
  async listCategories(includeInactive = false): Promise<RepairCategoryResponseDto[]> {
    const tenant = getCurrentTenant();
    const where = includeInactive
      ? 'WHERE school_id = $1::uuid'
      : 'WHERE school_id = $1::uuid AND is_active = true';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, name, is_safety_critical, is_active ' +
          'FROM trn_repair_categories ' +
          where +
          ' ORDER BY name ASC',
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      name: string;
      is_safety_critical: boolean;
      is_active: boolean;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      name: r.name,
      isSafetyCritical: r.is_safety_critical,
      isActive: r.is_active,
    }));
  }

  async createCategory(
    input: CreateRepairCategoryDto,
    actor: ResolvedActor,
  ): Promise<RepairCategoryResponseDto> {
    await this.assertCanManageFleet(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO trn_repair_categories (id, school_id, name, is_safety_critical) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4)',
          id,
          tenant.schoolId,
          input.name,
          input.isSafetyCritical ?? false,
        );
      });
    } catch (err: unknown) {
      const e = err as { code?: string; meta?: { code?: string }; message?: string };
      if (
        e.code === '23505' ||
        e.meta?.code === '23505' ||
        (typeof e.message === 'string' && e.message.includes('23505'))
      ) {
        throw new BadRequestException('A repair category with this name already exists');
      }
      throw err;
    }
    return {
      id,
      schoolId: tenant.schoolId,
      name: input.name,
      isSafetyCritical: input.isSafetyCritical ?? false,
      isActive: true,
    };
  }

  async patchCategory(
    categoryId: string,
    input: UpdateRepairCategoryDto,
    actor: ResolvedActor,
  ): Promise<RepairCategoryResponseDto> {
    await this.assertCanManageFleet(actor);
    const tenant = getCurrentTenant();
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) {
      sets.push('name = $' + (params.length + 1));
      params.push(input.name);
    }
    if (input.isSafetyCritical !== undefined) {
      sets.push('is_safety_critical = $' + (params.length + 1));
      params.push(input.isSafetyCritical);
    }
    if (input.isActive !== undefined) {
      sets.push('is_active = $' + (params.length + 1));
      params.push(input.isActive);
    }
    if (sets.length === 0) {
      const rows = await this.listCategories(true);
      const found = rows.find((r) => r.id === categoryId);
      if (!found) throw new NotFoundException('Repair category not found');
      return found;
    }
    sets.push('updated_at = now()');
    params.push(tenant.schoolId);
    params.push(categoryId);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE trn_repair_categories SET ' +
          sets.join(', ') +
          ' WHERE school_id = $' +
          (params.length - 1) +
          '::uuid AND id = $' +
          params.length +
          '::uuid',
        ...params,
      );
    });
    const rows = await this.listCategories(true);
    const found = rows.find((r) => r.id === categoryId);
    if (!found) throw new NotFoundException('Repair category not found after update');
    return found;
  }

  // ── Repairs ──
  // REVIEW-P2C11 ROUND 1 BLOCKING 1 — every read carries the tenant
  // school predicate at the JOIN level.
  async listForVehicle(vehicleId: string): Promise<RepairResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_REPAIR_BASE +
          'WHERE r.vehicle_id = $1::uuid AND v.school_id = $2::uuid ' +
          'ORDER BY r.repair_date DESC, r.created_at DESC LIMIT 500',
        vehicleId,
        tenant.schoolId,
      );
    })) as RepairRow[];
    return rows.map(rowToDto);
  }

  async getById(repairId: string): Promise<RepairResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_REPAIR_BASE + 'WHERE r.id = $1::uuid AND v.school_id = $2::uuid LIMIT 1',
        repairId,
        tenant.schoolId,
      );
    })) as RepairRow[];
    if (rows.length === 0) throw new NotFoundException('Repair not found');
    return rowToDto(rows[0]!);
  }

  async listOutstandingSafetyCritical(): Promise<RepairResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_REPAIR_BASE +
          "WHERE v.school_id = $1::uuid AND c.is_safety_critical = true AND r.status IN ('SCHEDULED','IN_PROGRESS') " +
          'ORDER BY r.repair_date ASC LIMIT 200',
        tenant.schoolId,
      );
    })) as RepairRow[];
    return rows.map(rowToDto);
  }

  /**
   * Log a repair. Safety-critical repairs that are not COMPLETED at log
   * time flip trn_vehicles.status to MAINTENANCE inside the same tenant
   * transaction so the vehicle is blocked from dispatch until the
   * repair completes.
   *
   * REVIEW-P2C11 ROUND 1 BLOCKING 1 — vehicle lock + safety-critical
   * UPDATE both carry the school predicate. A School A actor cannot
   * mutate a School B vehicle by guessing the UUID.
   */
  async create(
    vehicleId: string,
    input: CreateRepairDto,
    actor: ResolvedActor,
  ): Promise<RepairResponseDto> {
    await this.assertCanManageFleet(actor);
    const id = generateId();
    const status: RepairStatus = input.status ?? 'COMPLETED';
    const performedByType = input.performedByType;

    if (performedByType === 'INTERNAL' && input.vendorAccountId) {
      throw new BadRequestException(
        'vendorAccountId may only be set when performedByType is EXTERNAL_VENDOR',
      );
    }

    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Verify vehicle exists in tenant — REVIEW-P2C11 BLOCKING 1
      const vRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, status FROM trn_vehicles WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        vehicleId,
        tenant.schoolId,
      )) as Array<{ id: string; status: string }>;
      if (vRows.length === 0) {
        throw new NotFoundException('Vehicle not found');
      }

      // Verify category belongs to tenant when supplied + resolve safety flag
      let isSafetyCritical = false;
      if (input.categoryId) {
        const cRows = (await tx.$queryRawUnsafe(
          'SELECT is_safety_critical FROM trn_repair_categories WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
          input.categoryId,
          tenant.schoolId,
        )) as Array<{ is_safety_critical: boolean }>;
        if (cRows.length === 0) {
          throw new BadRequestException('categoryId does not match a category in this school');
        }
        isSafetyCritical = cRows[0]!.is_safety_critical;
      }

      const scheduledAt = status === 'SCHEDULED' ? new Date().toISOString() : null;
      const startedAt = status === 'IN_PROGRESS' ? new Date().toISOString() : null;
      const completedAt = status === 'COMPLETED' ? new Date().toISOString() : null;

      await tx.$executeRawUnsafe(
        'INSERT INTO trn_vehicle_repairs ' +
          '(id, vehicle_id, category_id, repair_date, mileage_at_repair, problem_description, work_performed, ' +
          'parts_used, labour_hours, total_cost, performed_by_type, vendor_account_id, warranty_claim, ' +
          'invoice_s3_key, status, scheduled_at, started_at, completed_at, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::uuid, $13, $14, $15, $16::timestamptz, $17::timestamptz, $18::timestamptz, $19)',
        id,
        vehicleId,
        input.categoryId ?? null,
        input.repairDate,
        input.mileageAtRepair,
        input.problemDescription,
        input.workPerformed,
        input.partsUsed ? JSON.stringify(input.partsUsed) : null,
        input.labourHours ?? null,
        input.totalCost,
        performedByType,
        input.vendorAccountId ?? null,
        input.warrantyClaim ?? false,
        input.invoiceS3Key ?? null,
        status,
        scheduledAt,
        startedAt,
        completedAt,
        input.notes ?? null,
      );

      // Safety-critical, non-COMPLETED repair → flip vehicle to MAINTENANCE.
      // REVIEW-P2C11 BLOCKING 1 — UPDATE includes school predicate.
      if (isSafetyCritical && status !== 'COMPLETED' && status !== 'CANCELLED') {
        await tx.$executeRawUnsafe(
          "UPDATE trn_vehicles SET status = 'MAINTENANCE', updated_at = now() WHERE id = $1::uuid AND school_id = $2::uuid AND status = 'ACTIVE'",
          vehicleId,
          tenant.schoolId,
        );
      }
    });

    return this.getById(id);
  }

  /**
   * Patch a repair. When a safety-critical repair transitions to
   * COMPLETED and no other open safety-critical repair remains on the
   * vehicle, flip the vehicle back to ACTIVE.
   *
   * REVIEW-P2C11 ROUND 1 BLOCKING 1 — repair lock + UPDATE carry the
   * school predicate via JOIN to trn_vehicles. Vehicle release UPDATE
   * also predicates on school_id.
   */
  async patch(
    repairId: string,
    input: UpdateRepairDto,
    actor: ResolvedActor,
  ): Promise<RepairResponseDto> {
    await this.assertCanManageFleet(actor);
    const tenant = getCurrentTenant();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT r.id::text AS id, r.vehicle_id::text AS vehicle_id, r.category_id::text AS category_id, ' +
          'r.status, COALESCE(c.is_safety_critical, false) AS is_safety_critical ' +
          'FROM trn_vehicle_repairs r ' +
          'JOIN trn_vehicles v ON v.id = r.vehicle_id ' +
          'LEFT JOIN trn_repair_categories c ON c.id = r.category_id ' +
          'WHERE r.id = $1::uuid AND v.school_id = $2::uuid FOR UPDATE OF r',
        repairId,
        tenant.schoolId,
      )) as Array<{
        id: string;
        vehicle_id: string;
        category_id: string | null;
        status: string;
        is_safety_critical: boolean;
      }>;
      if (rows.length === 0) throw new NotFoundException('Repair not found');
      const prior = rows[0]!;

      const sets: string[] = [];
      const params: unknown[] = [];
      const newStatus = input.status ?? (prior.status as RepairStatus);

      if (input.status !== undefined) {
        sets.push('status = $' + (params.length + 1));
        params.push(input.status);
        // Lifecycle stamps
        if (input.status === 'IN_PROGRESS' && prior.status !== 'IN_PROGRESS') {
          sets.push('started_at = now()');
        }
        if (input.status === 'COMPLETED' && prior.status !== 'COMPLETED') {
          sets.push('completed_at = now()');
        }
        if (input.status !== 'COMPLETED' && prior.status === 'COMPLETED') {
          sets.push('completed_at = NULL');
        }
      }
      if (input.workPerformed !== undefined) {
        sets.push('work_performed = $' + (params.length + 1));
        params.push(input.workPerformed);
      }
      if (input.totalCost !== undefined) {
        sets.push('total_cost = $' + (params.length + 1));
        params.push(input.totalCost);
      }
      if (input.labourHours !== undefined) {
        sets.push('labour_hours = $' + (params.length + 1));
        params.push(input.labourHours);
      }
      if (input.warrantyClaim !== undefined) {
        sets.push('warranty_claim = $' + (params.length + 1));
        params.push(input.warrantyClaim);
      }
      if (input.partsUsed !== undefined) {
        sets.push('parts_used = $' + (params.length + 1) + '::jsonb');
        params.push(JSON.stringify(input.partsUsed));
      }
      if (input.notes !== undefined) {
        sets.push('notes = $' + (params.length + 1));
        params.push(input.notes);
      }
      if (sets.length === 0) return;
      sets.push('updated_at = now()');
      params.push(repairId);
      // The repair lock above already proved the school predicate; the
      // UPDATE is by repair ID. The next SELECT inside getById re-asserts
      // the school predicate so a leaked id cannot return data.
      await tx.$executeRawUnsafe(
        'UPDATE trn_vehicle_repairs SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          params.length +
          '::uuid',
        ...params,
      );

      // Release the vehicle if this was the last open safety-critical repair.
      // REVIEW-P2C11 BLOCKING 1 — vehicle release UPDATE carries school predicate.
      if (prior.is_safety_critical && newStatus === 'COMPLETED' && prior.status !== 'COMPLETED') {
        const remRows = (await tx.$queryRawUnsafe(
          'SELECT COUNT(*)::int AS c FROM trn_vehicle_repairs r ' +
            'JOIN trn_repair_categories c ON c.id = r.category_id ' +
            "WHERE r.vehicle_id = $1::uuid AND c.is_safety_critical = true AND r.status IN ('SCHEDULED','IN_PROGRESS') AND r.id <> $2::uuid",
          prior.vehicle_id,
          repairId,
        )) as Array<{ c: number }>;
        if (remRows[0]!.c === 0) {
          await tx.$executeRawUnsafe(
            "UPDATE trn_vehicles SET status = 'ACTIVE', updated_at = now() WHERE id = $1::uuid AND school_id = $2::uuid AND status = 'MAINTENANCE'",
            prior.vehicle_id,
            tenant.schoolId,
          );
        }
      }
    });

    return this.getById(repairId);
  }
}
