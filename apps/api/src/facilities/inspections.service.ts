import {
  BadRequestException,
  ConflictException,
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
  assertCanManage,
  assertEmployeeInCurrentTenant,
  assertWorkOrderInCurrentTenant,
} from './buildings.service';
import {
  AdjustSupplyDto,
  CreateInspectionDto,
  CreateInspectionTypeDto,
  CreateSupplyDto,
  CreateViolationDto,
  CreateZoneAssignmentDto,
  CreateZoneDto,
  InspectionOutcome,
  InspectionResponseDto,
  InspectionTypeResponseDto,
  ResolveViolationDto,
  SupplyResponseDto,
  UpdateZoneAssignmentDto,
  ViolationResponseDto,
  ViolationSeverity,
  ZoneAssignmentResponseDto,
  ZoneResponseDto,
  ZoneShift,
} from './dto/facilities.dto';

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (e.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('23505');
}

@Injectable()
export class InspectionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async listTypes(): Promise<InspectionTypeResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, name, authority, frequency_months, is_mandatory, failure_escalation_days ' +
          'FROM fac_inspection_types WHERE school_id = $1::uuid ORDER BY name',
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      name: string;
      authority: string;
      frequency_months: number;
      is_mandatory: boolean;
      failure_escalation_days: number | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      name: r.name,
      authority: r.authority,
      frequencyMonths: r.frequency_months,
      isMandatory: r.is_mandatory,
      failureEscalationDays: r.failure_escalation_days,
    }));
  }

  async createType(
    input: CreateInspectionTypeDto,
    actor: ResolvedActor,
  ): Promise<InspectionTypeResponseDto> {
    await assertCanManage(actor, this.permCheck);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fac_inspection_types (id, school_id, name, authority, frequency_months, is_mandatory, failure_escalation_days) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)',
          id,
          tenant.schoolId,
          input.name,
          input.authority,
          input.frequencyMonths,
          input.isMandatory ?? true,
          input.failureEscalationDays ?? null,
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('An inspection type with this name already exists');
      }
      throw err;
    }
    const list = await this.listTypes();
    return list.find((t) => t.id === id)!;
  }

  async list(args: { buildingId?: string }): Promise<InspectionResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['i.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.buildingId) {
      where.push('i.building_id = $' + (params.length + 1) + '::uuid');
      params.push(args.buildingId);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        INSP_SELECT +
          'WHERE ' +
          where.join(' AND ') +
          ' ORDER BY i.scheduled_date DESC NULLS LAST, i.created_at DESC LIMIT 200',
        ...params,
      );
    })) as InspRow[];
    return rows.map(inspRowToDto);
  }

  async getById(id: string): Promise<InspectionResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(INSP_SELECT + 'WHERE i.id = $1::uuid LIMIT 1', id);
    })) as InspRow[];
    if (rows.length === 0) throw new NotFoundException('Inspection not found');
    return inspRowToDto(rows[0]!);
  }

  async create(input: CreateInspectionDto, actor: ResolvedActor): Promise<InspectionResponseDto> {
    await assertCanManage(actor, this.permCheck);
    if (!actor.personId) {
      throw new ForbiddenException('Inspection creation requires an authenticated person');
    }
    if (input.outcome !== 'PENDING' && !input.conductedDate) {
      throw new BadRequestException(
        'conductedDate is required when outcome is non-PENDING (PASSED / PASSED_WITH_CONDITIONS / FAILED)',
      );
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO fac_inspections (id, school_id, inspection_type_id, building_id, scheduled_date, conducted_date, inspector_name, inspector_agency, outcome, certificate_s3_key, next_due_date, notes, created_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::date, $7, $8, $9, $10, $11::date, $12, $13::uuid)',
        id,
        tenant.schoolId,
        input.inspectionTypeId,
        input.buildingId,
        input.scheduledDate ?? null,
        input.conductedDate ?? null,
        input.inspectorName ?? null,
        input.inspectorAgency ?? null,
        input.outcome,
        input.certificateS3Key ?? null,
        input.nextDueDate ?? null,
        input.notes ?? null,
        actor.personId,
      );
    });
    if (input.outcome === 'FAILED' || input.outcome === 'PASSED_WITH_CONDITIONS') {
      await this.kafka.emit({
        topic: 'fac.inspection.failed',
        key: id,
        sourceModule: 'facilities',
        payload: {
          inspectionId: id,
          sourceRefId: id,
          inspectionTypeId: input.inspectionTypeId,
          buildingId: input.buildingId,
          outcome: input.outcome,
          conductedDate: input.conductedDate ?? null,
        },
      });
    }
    return this.getById(id);
  }
}

@Injectable()
export class ViolationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async listForInspection(inspectionId: string): Promise<ViolationResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        VIOL_SELECT + 'WHERE v.inspection_id = $1::uuid ORDER BY v.due_date',
        inspectionId,
      );
    })) as ViolRow[];
    return rows.map(violRowToDto);
  }

  async listActive(args: { severity?: ViolationSeverity }): Promise<ViolationResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['i.school_id = $1::uuid', 'v.resolved_at IS NULL'];
    const params: unknown[] = [tenant.schoolId];
    if (args.severity) {
      where.push('v.severity = $' + (params.length + 1));
      params.push(args.severity);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        VIOL_SELECT +
          'JOIN fac_inspections i ON i.id = v.inspection_id ' +
          'WHERE ' +
          where.join(' AND ') +
          ' ORDER BY v.due_date ASC LIMIT 200',
        ...params,
      );
    })) as ViolRow[];
    return rows.map(violRowToDto);
  }

  async create(
    inspectionId: string,
    input: CreateViolationDto,
    actor: ResolvedActor,
  ): Promise<ViolationResponseDto> {
    await assertCanManage(actor, this.permCheck);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO fac_inspection_violations (id, inspection_id, description, severity, due_date) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5::date)',
        id,
        inspectionId,
        input.description,
        input.severity,
        input.dueDate,
      );
    });
    return (await this.listForInspection(inspectionId)).find((v) => v.id === id)!;
  }

  async resolve(
    id: string,
    input: ResolveViolationDto,
    actor: ResolvedActor,
  ): Promise<ViolationResponseDto> {
    await assertCanManage(actor, this.permCheck);
    if (!actor.personId) {
      throw new ForbiddenException('Resolution requires an authenticated person');
    }
    // REVIEW-CYCLE21 BLOCKING 3 + MAJOR 6 — validate linkedWorkOrderId
    // belongs to the same school. The DB FK only checks existence;
    // assertWorkOrderInCurrentTenant adds the same-school check via
    // school_id match.
    if (input.linkedWorkOrderId) {
      await assertWorkOrderInCurrentTenant(this.tenantPrisma, input.linkedWorkOrderId);
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = (await tx.$queryRawUnsafe(
        'SELECT id, resolved_at, inspection_id::text AS inspection_id, due_date FROM fac_inspection_violations WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; resolved_at: Date | null; inspection_id: string; due_date: Date }>;
      if (locked.length === 0) throw new NotFoundException('Violation not found');
      if (locked[0]!.resolved_at !== null) {
        throw new BadRequestException('Violation is already resolved');
      }
      await tx.$executeRawUnsafe(
        'UPDATE fac_inspection_violations SET resolved_at = now(), resolved_by = $1::uuid, resolution_notes = $2, linked_work_order_id = $3::uuid, updated_at = now() WHERE id = $4::uuid',
        actor.personId,
        input.resolutionNotes,
        input.linkedWorkOrderId ?? null,
        id,
      );
    });
    const insp = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT inspection_id::text AS inspection_id FROM fac_inspection_violations WHERE id = $1::uuid',
        id,
      );
    })) as Array<{ inspection_id: string }>;
    return (await this.listForInspection(insp[0]!.inspection_id)).find((v) => v.id === id)!;
  }

  // Worker / cron helper: emits fac.inspection_violation.overdue for any
  // unresolved violation past its due_date. Idempotent — the Step 7 cron
  // wires this every day; emits do not retry per-event so a missed cycle
  // simply re-emits the next day.
  async emitOverdue(): Promise<{ emitted: number }> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT v.id::text AS id, v.severity, v.due_date FROM fac_inspection_violations v ' +
          'JOIN fac_inspections i ON i.id = v.inspection_id WHERE i.school_id = $1::uuid AND v.resolved_at IS NULL AND v.due_date < CURRENT_DATE',
        tenant.schoolId,
      );
    })) as Array<{ id: string; severity: string; due_date: Date }>;
    for (const r of rows) {
      await this.kafka.emit({
        topic: 'fac.inspection_violation.overdue',
        key: r.id,
        sourceModule: 'facilities',
        payload: {
          violationId: r.id,
          sourceRefId: r.id,
          severity: r.severity,
          dueDate: r.due_date.toISOString().slice(0, 10),
        },
      });
    }
    return { emitted: rows.length };
  }
}

@Injectable()
export class ZoneService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async list(): Promise<ZoneResponseDto[]> {
    const tenant = getCurrentTenant();
    const zoneRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, name, description, color FROM fac_zones WHERE school_id = $1::uuid ORDER BY name',
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      name: string;
      description: string | null;
      color: string | null;
    }>;
    const out: ZoneResponseDto[] = [];
    for (const z of zoneRows) {
      const assignments = await this.listAssignments(z.id);
      out.push({
        id: z.id,
        schoolId: z.school_id,
        name: z.name,
        description: z.description,
        color: z.color,
        assignments,
      });
    }
    return out;
  }

  async listAssignments(zoneId: string): Promise<ZoneAssignmentResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT za.id::text AS id, za.zone_id::text AS zone_id, za.employee_id::text AS employee_id, ' +
          "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip JOIN hr_employees e ON e.person_id = ip.id WHERE e.id = za.employee_id) AS employee_name, " +
          'za.effective_from, za.effective_to, za.shift, za.notes ' +
          'FROM fac_zone_assignments za WHERE za.zone_id = $1::uuid ORDER BY za.effective_from DESC',
        zoneId,
      );
    })) as Array<{
      id: string;
      zone_id: string;
      employee_id: string;
      employee_name: string | null;
      effective_from: Date;
      effective_to: Date | null;
      shift: string;
      notes: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      zoneId: r.zone_id,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      effectiveFrom: r.effective_from.toISOString().slice(0, 10),
      effectiveTo: r.effective_to ? r.effective_to.toISOString().slice(0, 10) : null,
      shift: r.shift as ZoneShift,
      notes: r.notes,
    }));
  }

  async create(input: CreateZoneDto, actor: ResolvedActor): Promise<ZoneResponseDto> {
    await assertCanManage(actor, this.permCheck);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fac_zones (id, school_id, name, description, color) VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
          id,
          tenant.schoolId,
          input.name,
          input.description ?? null,
          input.color ?? null,
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('A zone with this name already exists for this school');
      }
      throw err;
    }
    const list = await this.list();
    return list.find((z) => z.id === id)!;
  }

  async createAssignment(
    zoneId: string,
    input: CreateZoneAssignmentDto,
    actor: ResolvedActor,
  ): Promise<ZoneAssignmentResponseDto> {
    await assertCanManage(actor, this.permCheck);
    if (!actor.personId) {
      throw new ForbiddenException('Zone assignment requires an authenticated person');
    }
    if (input.effectiveTo && new Date(input.effectiveTo) < new Date(input.effectiveFrom)) {
      throw new BadRequestException('effectiveTo must be on or after effectiveFrom');
    }
    // REVIEW-CYCLE21 BLOCKING 3 — validate employeeId belongs to the
    // calling tenant before insert. Schema soft FK is permissive by
    // design (cross-cycle audit trail) so the service is the gate.
    await assertEmployeeInCurrentTenant(this.tenantPrisma, input.employeeId);
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fac_zone_assignments (id, zone_id, employee_id, effective_from, effective_to, shift, notes, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::date, $6, $7, $8::uuid)',
          id,
          zoneId,
          input.employeeId,
          input.effectiveFrom,
          input.effectiveTo ?? null,
          input.shift,
          input.notes ?? null,
          actor.personId,
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'An assignment for this (zone, employee, effective_from) already exists',
        );
      }
      throw err;
    }
    const list = await this.listAssignments(zoneId);
    return list.find((a) => a.id === id)!;
  }

  async patchAssignment(
    id: string,
    input: UpdateZoneAssignmentDto,
    actor: ResolvedActor,
  ): Promise<ZoneAssignmentResponseDto> {
    await assertCanManage(actor, this.permCheck);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.effectiveTo !== undefined) {
      sets.push('effective_to = $' + (params.length + 1) + '::date');
      params.push(input.effectiveTo);
    }
    if (input.shift !== undefined) {
      sets.push('shift = $' + (params.length + 1));
      params.push(input.shift);
    }
    if (sets.length === 0) {
      throw new BadRequestException('Nothing to update');
    }
    sets.push('updated_at = now()');
    params.push(id);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE fac_zone_assignments SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          params.length +
          '::uuid',
        ...params,
      );
    });
    const zoneRow = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT zone_id::text AS zone_id FROM fac_zone_assignments WHERE id = $1::uuid',
        id,
      );
    })) as Array<{ zone_id: string }>;
    if (zoneRow.length === 0) throw new NotFoundException('Assignment not found');
    return (await this.listAssignments(zoneRow[0]!.zone_id)).find((a) => a.id === id)!;
  }
}

@Injectable()
export class SupplyService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async listForBuilding(buildingId: string): Promise<SupplyResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, building_id::text AS building_id, item_name, unit, current_quantity, reorder_threshold, preferred_supplier, last_restocked_at ' +
          'FROM fac_supply_inventory WHERE building_id = $1::uuid ORDER BY item_name',
        buildingId,
      );
    })) as Array<{
      id: string;
      building_id: string;
      item_name: string;
      unit: string;
      current_quantity: number;
      reorder_threshold: number | null;
      preferred_supplier: string | null;
      last_restocked_at: Date | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      buildingId: r.building_id,
      itemName: r.item_name,
      unit: r.unit,
      currentQuantity: Number(r.current_quantity),
      reorderThreshold: r.reorder_threshold !== null ? Number(r.reorder_threshold) : null,
      preferredSupplier: r.preferred_supplier,
      lastRestockedAt: r.last_restocked_at ? r.last_restocked_at.toISOString() : null,
      belowThreshold:
        r.reorder_threshold !== null && Number(r.current_quantity) < Number(r.reorder_threshold),
    }));
  }

  async create(input: CreateSupplyDto, actor: ResolvedActor): Promise<SupplyResponseDto> {
    await assertCanManage(actor, this.permCheck);
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fac_supply_inventory (id, building_id, item_name, unit, current_quantity, reorder_threshold, preferred_supplier) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)',
          id,
          input.buildingId,
          input.itemName,
          input.unit,
          input.currentQuantity ?? 0,
          input.reorderThreshold ?? null,
          input.preferredSupplier ?? null,
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('A supply item with this name already exists in this building');
      }
      throw err;
    }
    return (await this.listForBuilding(input.buildingId)).find((s) => s.id === id)!;
  }

  async adjust(
    id: string,
    input: AdjustSupplyDto,
    actor: ResolvedActor,
  ): Promise<SupplyResponseDto> {
    await assertCanManage(actor, this.permCheck);
    let crossedBelow = false;
    let buildingId = '';
    let itemName = '';
    let threshold: number | null = null;
    let newQty = 0;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const before = (await tx.$queryRawUnsafe(
        'SELECT id, building_id::text AS building_id, item_name, current_quantity, reorder_threshold FROM fac_supply_inventory WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{
        id: string;
        building_id: string;
        item_name: string;
        current_quantity: number;
        reorder_threshold: number | null;
      }>;
      if (before.length === 0) throw new NotFoundException('Supply item not found');
      const b = before[0]!;
      buildingId = b.building_id;
      itemName = b.item_name;
      const beforeQty = Number(b.current_quantity);
      const beforeThr = b.reorder_threshold !== null ? Number(b.reorder_threshold) : null;
      threshold = input.reorderThreshold !== undefined ? input.reorderThreshold : beforeThr;
      newQty = input.currentQuantity;

      const sets: string[] = ['current_quantity = $1', 'updated_at = now()'];
      const params: unknown[] = [newQty];
      if (input.reorderThreshold !== undefined) {
        sets.push('reorder_threshold = $' + (params.length + 1));
        params.push(input.reorderThreshold);
      }
      if (newQty > beforeQty) {
        sets.push('last_restocked_at = now()');
      }
      params.push(id);
      await tx.$executeRawUnsafe(
        'UPDATE fac_supply_inventory SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          params.length +
          '::uuid',
        ...params,
      );
      const wasBelow = beforeThr !== null && beforeQty < beforeThr;
      const isBelow = threshold !== null && newQty < threshold;
      crossedBelow = !wasBelow && isBelow;
    });
    if (crossedBelow) {
      await this.kafka.emit({
        topic: 'fac.supply.reorder_needed',
        key: id,
        sourceModule: 'facilities',
        payload: {
          supplyId: id,
          sourceRefId: id,
          buildingId,
          itemName,
          currentQuantity: newQty,
          reorderThreshold: threshold,
        },
      });
    }
    return (await this.listForBuilding(buildingId)).find((s) => s.id === id)!;
  }
}

interface InspRow {
  id: string;
  school_id: string;
  inspection_type_id: string;
  inspection_type_name: string;
  authority: string;
  building_id: string;
  building_name: string;
  scheduled_date: Date | null;
  conducted_date: Date | null;
  inspector_name: string | null;
  inspector_agency: string | null;
  outcome: string;
  certificate_s3_key: string | null;
  next_due_date: Date | null;
  notes: string | null;
}

const INSP_SELECT =
  'SELECT i.id::text AS id, i.school_id::text AS school_id, ' +
  'i.inspection_type_id::text AS inspection_type_id, t.name AS inspection_type_name, t.authority, ' +
  'i.building_id::text AS building_id, b.name AS building_name, ' +
  'i.scheduled_date, i.conducted_date, i.inspector_name, i.inspector_agency, i.outcome, ' +
  'i.certificate_s3_key, i.next_due_date, i.notes ' +
  'FROM fac_inspections i ' +
  'JOIN fac_inspection_types t ON t.id = i.inspection_type_id ' +
  'JOIN fac_buildings b ON b.id = i.building_id ';

function inspRowToDto(r: InspRow): InspectionResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    inspectionTypeId: r.inspection_type_id,
    inspectionTypeName: r.inspection_type_name,
    authority: r.authority,
    buildingId: r.building_id,
    buildingName: r.building_name,
    scheduledDate: r.scheduled_date ? r.scheduled_date.toISOString().slice(0, 10) : null,
    conductedDate: r.conducted_date ? r.conducted_date.toISOString().slice(0, 10) : null,
    inspectorName: r.inspector_name,
    inspectorAgency: r.inspector_agency,
    outcome: r.outcome as InspectionOutcome,
    certificateS3Key: r.certificate_s3_key,
    nextDueDate: r.next_due_date ? r.next_due_date.toISOString().slice(0, 10) : null,
    notes: r.notes,
  };
}

interface ViolRow {
  id: string;
  inspection_id: string;
  description: string;
  severity: string;
  due_date: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolved_by_name: string | null;
  resolution_notes: string | null;
  linked_work_order_id: string | null;
}

const VIOL_SELECT =
  'SELECT v.id::text AS id, v.inspection_id::text AS inspection_id, v.description, v.severity, ' +
  'v.due_date, v.resolved_at, v.resolved_by::text AS resolved_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip WHERE ip.id = v.resolved_by) AS resolved_by_name, " +
  'v.resolution_notes, v.linked_work_order_id::text AS linked_work_order_id ' +
  'FROM fac_inspection_violations v ';

function violRowToDto(r: ViolRow): ViolationResponseDto {
  return {
    id: r.id,
    inspectionId: r.inspection_id,
    description: r.description,
    severity: r.severity as ViolationSeverity,
    dueDate: r.due_date.toISOString().slice(0, 10),
    resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
    resolvedBy: r.resolved_by,
    resolvedByName: r.resolved_by_name,
    resolutionNotes: r.resolution_notes,
    linkedWorkOrderId: r.linked_work_order_id,
  };
}
