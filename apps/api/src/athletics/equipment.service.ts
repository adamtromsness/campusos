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
import { PermissionCheckService } from '../iam/permission-check.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import {
  CheckoutEquipmentDto,
  CreateEquipmentDto,
  CreateMaintenanceDto,
  EquipmentCheckoutResponseDto,
  EquipmentCondition,
  EquipmentItemType,
  EquipmentResponseDto,
  MaintenanceResponseDto,
  MaintenanceType,
  ReturnCondition,
  ReturnEquipmentDto,
  UpdateEquipmentDto,
} from './dto/athletics-advanced.dto';

interface EquipmentRow {
  id: string;
  school_id: string;
  programme_id: string;
  programme_name: string | null;
  item_type: string;
  item_name: string;
  quantity: number;
  condition: string;
  purchase_date: string | null;
  unit_cost: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_EQUIPMENT =
  'SELECT e.id::text AS id, e.school_id::text AS school_id, e.programme_id::text AS programme_id, ' +
  'p.sport_name AS programme_name, e.item_type, e.item_name, e.quantity, e.condition, ' +
  "TO_CHAR(e.purchase_date, 'YYYY-MM-DD') AS purchase_date, e.unit_cost::text AS unit_cost, " +
  'TO_CHAR(e.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(e.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM ath_equipment e LEFT JOIN ath_programmes p ON p.id = e.programme_id ';

interface CheckoutRow {
  id: string;
  equipment_id: string;
  equipment_name: string | null;
  assigned_to_person_id: string;
  assigned_to_name: string | null;
  item_identifier: string | null;
  checked_out_at: string;
  expected_return_date: string | null;
  returned_at: string | null;
  condition_at_return: string | null;
  damage_notes: string | null;
  replacement_charge: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_CHECKOUT =
  'SELECT c.id::text AS id, c.equipment_id::text AS equipment_id, e.item_name AS equipment_name, ' +
  'c.assigned_to_person_id::text AS assigned_to_person_id, ' +
  "(p.first_name || ' ' || p.last_name) AS assigned_to_name, " +
  "c.item_identifier, TO_CHAR(c.checked_out_at, 'YYYY-MM-DD') AS checked_out_at, " +
  "TO_CHAR(c.expected_return_date, 'YYYY-MM-DD') AS expected_return_date, " +
  "TO_CHAR(c.returned_at, 'YYYY-MM-DD') AS returned_at, " +
  'c.condition_at_return, c.damage_notes, c.replacement_charge::text AS replacement_charge, ' +
  'TO_CHAR(c.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(c.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM ath_equipment_checkouts c ' +
  'LEFT JOIN ath_equipment e ON e.id = c.equipment_id ' +
  'LEFT JOIN platform.iam_person p ON p.id = c.assigned_to_person_id ';

interface MaintenanceRow {
  id: string;
  equipment_id: string;
  maintenance_type: string;
  performed_at: string;
  performed_by: string | null;
  cost: string | null;
  notes: string | null;
  next_maintenance_date: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_MAINTENANCE =
  'SELECT id::text AS id, equipment_id::text AS equipment_id, maintenance_type, ' +
  "TO_CHAR(performed_at, 'YYYY-MM-DD') AS performed_at, performed_by, cost::text AS cost, notes, " +
  "TO_CHAR(next_maintenance_date, 'YYYY-MM-DD') AS next_maintenance_date, " +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM ath_equipment_maintenance ';

function rowToEquipmentDto(r: EquipmentRow): EquipmentResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    programmeId: r.programme_id,
    programmeName: r.programme_name,
    itemType: r.item_type as EquipmentItemType,
    itemName: r.item_name,
    quantity: r.quantity,
    condition: r.condition as EquipmentCondition,
    purchaseDate: r.purchase_date,
    unitCost: r.unit_cost === null ? null : Number(r.unit_cost),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToCheckoutDto(r: CheckoutRow): EquipmentCheckoutResponseDto {
  const today = new Date().toISOString().slice(0, 10);
  const isOverdue =
    r.returned_at === null && r.expected_return_date !== null && r.expected_return_date < today;
  return {
    id: r.id,
    equipmentId: r.equipment_id,
    equipmentName: r.equipment_name,
    assignedToPersonId: r.assigned_to_person_id,
    assignedToName: r.assigned_to_name,
    itemIdentifier: r.item_identifier,
    checkedOutAt: r.checked_out_at,
    expectedReturnDate: r.expected_return_date,
    returnedAt: r.returned_at,
    conditionAtReturn: r.condition_at_return as ReturnCondition | null,
    damageNotes: r.damage_notes,
    replacementCharge: r.replacement_charge === null ? null : Number(r.replacement_charge),
    isOverdue,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToMaintenanceDto(r: MaintenanceRow): MaintenanceResponseDto {
  return {
    id: r.id,
    equipmentId: r.equipment_id,
    maintenanceType: r.maintenance_type as MaintenanceType,
    performedAt: r.performed_at,
    performedBy: r.performed_by,
    cost: r.cost === null ? null : Number(r.cost),
    notes: r.notes,
    nextMaintenanceDate: r.next_maintenance_date,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class EquipmentService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * AD scope — admin OR holds ATH-004:write. Generic Staff covers the
   * AD persona today, the Wave 2 Phase 2 punch list narrows this to a
   * dedicated AD role before pilot.
   */
  async hasEquipmentScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'ath-004:write',
    ]);
  }

  // ── Equipment CRUD ──────────────────────────────────────────────

  async list(filters: {
    programmeId?: string;
    itemType?: EquipmentItemType;
    condition?: EquipmentCondition;
  }): Promise<EquipmentResponseDto[]> {
    const tenant = getCurrentTenant();
    const sql: string[] = [SELECT_EQUIPMENT, 'WHERE e.school_id = $1::uuid '];
    const params: unknown[] = [tenant.schoolId];
    if (filters.programmeId) {
      params.push(filters.programmeId);
      sql.push('AND e.programme_id = $' + params.length + '::uuid ');
    }
    if (filters.itemType) {
      params.push(filters.itemType);
      sql.push('AND e.item_type = $' + params.length + ' ');
    }
    if (filters.condition) {
      params.push(filters.condition);
      sql.push('AND e.condition = $' + params.length + ' ');
    }
    sql.push('ORDER BY e.item_type, e.item_name LIMIT 500');
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<EquipmentRow[]>(sql.join(''), ...params),
    );
    return rows.map(rowToEquipmentDto);
  }

  async getById(id: string): Promise<EquipmentResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<EquipmentRow[]>(
        SELECT_EQUIPMENT + 'WHERE e.id = $1::uuid AND e.school_id = $2::uuid',
        id,
        tenant.schoolId,
      ),
    );
    if (rows.length === 0) throw new NotFoundException('Equipment not found');
    return rowToEquipmentDto(rows[0]!);
  }

  async create(input: CreateEquipmentDto, actor: ResolvedActor): Promise<EquipmentResponseDto> {
    if (!(await this.hasEquipmentScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can create equipment');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      // Validate programme exists in this school
      const prog = await client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM ath_programmes WHERE id = $1::uuid AND school_id = $2::uuid',
        input.programmeId,
        tenant.schoolId,
      );
      if (prog.length === 0) {
        throw new BadRequestException('programmeId does not match a programme in this school');
      }
      await client.$executeRawUnsafe(
        'INSERT INTO ath_equipment (id, school_id, programme_id, item_type, item_name, quantity, condition, purchase_date, unit_cost) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::date, $9)',
        id,
        tenant.schoolId,
        input.programmeId,
        input.itemType,
        input.itemName,
        input.quantity ?? 0,
        input.condition ?? 'GOOD',
        input.purchaseDate ?? null,
        input.unitCost ?? null,
      );
    });
    return this.getById(id);
  }

  async patch(
    id: string,
    input: UpdateEquipmentDto,
    actor: ResolvedActor,
  ): Promise<EquipmentResponseDto> {
    if (!(await this.hasEquipmentScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can edit equipment');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.itemType !== undefined) {
      params.push(input.itemType);
      sets.push('item_type = $' + params.length);
    }
    if (input.itemName !== undefined) {
      params.push(input.itemName);
      sets.push('item_name = $' + params.length);
    }
    if (input.quantity !== undefined) {
      params.push(input.quantity);
      sets.push('quantity = $' + params.length);
    }
    if (input.condition !== undefined) {
      params.push(input.condition);
      sets.push('condition = $' + params.length);
    }
    if (input.purchaseDate !== undefined) {
      params.push(input.purchaseDate);
      sets.push('purchase_date = $' + params.length + '::date');
    }
    if (input.unitCost !== undefined) {
      params.push(input.unitCost);
      sets.push('unit_cost = $' + params.length);
    }
    if (sets.length === 0) return this.getById(id);
    sets.push('updated_at = now()');
    params.push(id);
    const tenant = getCurrentTenant();
    params.push(tenant.schoolId);
    const sql =
      'UPDATE ath_equipment SET ' +
      sets.join(', ') +
      ' WHERE id = $' +
      (params.length - 1) +
      '::uuid AND school_id = $' +
      params.length +
      '::uuid';
    const updated = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$executeRawUnsafe(sql, ...params),
    );
    if (updated === 0) throw new NotFoundException('Equipment not found');
    return this.getById(id);
  }

  // ── Checkout flow ───────────────────────────────────────────────

  async checkout(
    equipmentId: string,
    input: CheckoutEquipmentDto,
    actor: ResolvedActor,
  ): Promise<EquipmentCheckoutResponseDto> {
    if (!(await this.hasEquipmentScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can issue equipment checkouts');
    }
    // Validate equipment exists in this school
    await this.getById(equipmentId);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO ath_equipment_checkouts (id, equipment_id, assigned_to_person_id, item_identifier, checked_out_at, expected_return_date) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6::date)',
        id,
        equipmentId,
        input.assignedToPersonId,
        input.itemIdentifier ?? null,
        input.checkedOutAt ?? new Date().toISOString().slice(0, 10),
        input.expectedReturnDate ?? null,
      );
    });
    return this.getCheckoutById(id);
  }

  async returnCheckout(
    checkoutId: string,
    input: ReturnEquipmentDto,
    actor: ResolvedActor,
  ): Promise<EquipmentCheckoutResponseDto> {
    if (!(await this.hasEquipmentScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can record equipment returns');
    }
    const tenant = getCurrentTenant();
    let damaged = false;
    let kafkaPayload: Record<string, unknown> | null = null;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock checkout row + verify equipment is in this school
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT c.id::text AS id, c.returned_at, e.unit_cost::text AS unit_cost, e.school_id::text AS school_id, e.id::text AS equipment_id, c.assigned_to_person_id::text AS assigned_to_person_id ' +
          'FROM ath_equipment_checkouts c JOIN ath_equipment e ON e.id = c.equipment_id ' +
          'WHERE c.id = $1::uuid FOR UPDATE OF c',
        checkoutId,
      )) as Array<{
        id: string;
        returned_at: string | null;
        unit_cost: string | null;
        school_id: string;
        equipment_id: string;
        assigned_to_person_id: string;
      }>;
      if (lockRows.length === 0) throw new NotFoundException('Checkout not found');
      const row = lockRows[0]!;
      if (row.school_id !== tenant.schoolId) {
        throw new NotFoundException('Checkout not found');
      }
      if (row.returned_at !== null) {
        throw new BadRequestException('Checkout has already been returned');
      }

      // Default replacement_charge to equipment unit_cost when DAMAGED or LOST
      let charge: number | null = null;
      if (input.conditionAtReturn === 'DAMAGED' || input.conditionAtReturn === 'LOST') {
        damaged = true;
        if (input.replacementCharge !== undefined) {
          charge = input.replacementCharge;
        } else if (row.unit_cost !== null) {
          charge = Number(row.unit_cost);
        }
      } else if (input.replacementCharge !== undefined) {
        charge = input.replacementCharge;
      }

      await tx.$executeRawUnsafe(
        'UPDATE ath_equipment_checkouts SET returned_at = $1::date, condition_at_return = $2, damage_notes = $3, replacement_charge = $4, updated_at = now() ' +
          'WHERE id = $5::uuid',
        new Date().toISOString().slice(0, 10),
        input.conditionAtReturn,
        input.damageNotes ?? null,
        charge,
        checkoutId,
      );

      if (damaged && charge !== null) {
        kafkaPayload = {
          checkoutId,
          equipmentId: row.equipment_id,
          assignedToPersonId: row.assigned_to_person_id,
          conditionAtReturn: input.conditionAtReturn,
          replacementCharge: charge,
          damageNotes: input.damageNotes ?? null,
          schoolId: tenant.schoolId,
          sourceRefId: checkoutId,
        };
      }
    });

    if (kafkaPayload) {
      try {
        await this.kafka.emit({
          topic: 'ath.equipment.replacement_charge',
          key: checkoutId,
          payload: kafkaPayload,
          sourceModule: 'athletics',
        });
      } catch {
        // Best-effort emit per existing convention
      }
    }
    return this.getCheckoutById(checkoutId);
  }

  async getCheckoutById(id: string): Promise<EquipmentCheckoutResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<CheckoutRow[]>(
        SELECT_CHECKOUT + 'WHERE c.id = $1::uuid AND e.school_id = $2::uuid',
        id,
        tenant.schoolId,
      ),
    );
    if (rows.length === 0) throw new NotFoundException('Checkout not found');
    return rowToCheckoutDto(rows[0]!);
  }

  async listCheckouts(filters: {
    equipmentId?: string;
    assignedToPersonId?: string;
    activeOnly?: boolean;
  }): Promise<EquipmentCheckoutResponseDto[]> {
    const tenant = getCurrentTenant();
    const sql: string[] = [SELECT_CHECKOUT, 'WHERE e.school_id = $1::uuid '];
    const params: unknown[] = [tenant.schoolId];
    if (filters.equipmentId) {
      params.push(filters.equipmentId);
      sql.push('AND c.equipment_id = $' + params.length + '::uuid ');
    }
    if (filters.assignedToPersonId) {
      params.push(filters.assignedToPersonId);
      sql.push('AND c.assigned_to_person_id = $' + params.length + '::uuid ');
    }
    if (filters.activeOnly) {
      sql.push('AND c.returned_at IS NULL ');
    }
    sql.push('ORDER BY c.checked_out_at DESC LIMIT 500');
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<CheckoutRow[]>(sql.join(''), ...params),
    );
    return rows.map(rowToCheckoutDto);
  }

  async listOverdue(): Promise<EquipmentCheckoutResponseDto[]> {
    const tenant = getCurrentTenant();
    const today = new Date().toISOString().slice(0, 10);
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<CheckoutRow[]>(
        SELECT_CHECKOUT +
          'WHERE e.school_id = $1::uuid AND c.returned_at IS NULL AND c.expected_return_date IS NOT NULL AND c.expected_return_date < $2::date ' +
          'ORDER BY c.expected_return_date ASC LIMIT 200',
        tenant.schoolId,
        today,
      ),
    );
    return rows.map(rowToCheckoutDto);
  }

  // ── Maintenance ─────────────────────────────────────────────────

  async addMaintenance(
    equipmentId: string,
    input: CreateMaintenanceDto,
    actor: ResolvedActor,
  ): Promise<MaintenanceResponseDto> {
    if (!(await this.hasEquipmentScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can record equipment maintenance');
    }
    // Validate equipment exists
    await this.getById(equipmentId);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext((client) =>
      client.$executeRawUnsafe(
        'INSERT INTO ath_equipment_maintenance (id, equipment_id, maintenance_type, performed_at, performed_by, cost, notes, next_maintenance_date) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4::date, $5, $6, $7, $8::date)',
        id,
        equipmentId,
        input.maintenanceType,
        input.performedAt ?? new Date().toISOString().slice(0, 10),
        input.performedBy ?? null,
        input.cost ?? null,
        input.notes ?? null,
        input.nextMaintenanceDate ?? null,
      ),
    );
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<MaintenanceRow[]>(SELECT_MAINTENANCE + 'WHERE id = $1::uuid', id),
    );
    return rowToMaintenanceDto(rows[0]!);
  }

  async listMaintenance(equipmentId: string): Promise<MaintenanceResponseDto[]> {
    // Validate equipment exists in this school first
    await this.getById(equipmentId);
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<MaintenanceRow[]>(
        SELECT_MAINTENANCE + 'WHERE equipment_id = $1::uuid ORDER BY performed_at DESC LIMIT 200',
        equipmentId,
      ),
    );
    return rows.map(rowToMaintenanceDto);
  }
}
