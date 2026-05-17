import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { isUniqueViolation } from './assets.service';
import type {
  ApproveSelectionDto,
  CreateDeviceOptionDto,
  CreateDeviceSelectionDto,
  CreateInfrastructureItemDto,
  CreateMdmAlertDto,
  CreateMdmSyncDto,
  CreateProcurementOrderDto,
  DeviceOptionDto,
  DeviceSelectionDto,
  InfrastructureItemDto,
  MarkDeliveredDto,
  MdmAlertDto,
  MdmSyncDto,
  ProcurementOrderDto,
  ResolveMdmAlertDto,
  UpdateDeviceOptionDto,
  UpdateInfrastructureItemDto,
  UpdateProcurementOrderDto,
} from './dto/it.dto';

async function assertItStaff(
  actor: ResolvedActor,
  permCheck: PermissionCheckService,
  code: string,
): Promise<void> {
  if (actor.isSchoolAdmin) return;
  if (actor.personType !== 'STAFF') {
    throw new ForbiddenException('Only IT staff or school admins can manage ' + code);
  }
  const tenant = getCurrentTenant();
  const ok = await permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [code]);
  if (!ok) {
    throw new ForbiddenException('Only IT staff or school admins can manage ' + code);
  }
}

@Injectable()
export class MdmService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async listSyncs(filters: { assetId?: string } = {}): Promise<MdmSyncDto[]> {
    const params: unknown[] = [];
    let where = '';
    if (filters.assetId) {
      params.push(filters.assetId);
      where = ' WHERE s.asset_id = $1::uuid';
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT s.id::text AS id, s.asset_id::text AS asset_id, a.asset_tag, ' +
          's.mdm_provider, s.sync_at::text AS sync_at, s.device_name, s.os_version, ' +
          's.last_check_in::text AS last_check_in, s.is_compliant, s.compliance_details ' +
          'FROM tech_mdm_sync_logs s JOIN tech_assets a ON a.id = s.asset_id' +
          where +
          ' ORDER BY s.sync_at DESC LIMIT 200',
        ...params,
      );
    })) as Array<{
      id: string;
      asset_id: string;
      asset_tag: string;
      mdm_provider: string;
      sync_at: string;
      device_name: string | null;
      os_version: string | null;
      last_check_in: string | null;
      is_compliant: boolean;
      compliance_details: Record<string, unknown> | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      assetId: r.asset_id,
      assetTag: r.asset_tag,
      mdmProvider: r.mdm_provider as MdmSyncDto['mdmProvider'],
      syncAt: r.sync_at,
      deviceName: r.device_name,
      osVersion: r.os_version,
      lastCheckIn: r.last_check_in,
      isCompliant: r.is_compliant,
      complianceDetails: r.compliance_details,
    }));
  }

  async createSync(input: CreateMdmSyncDto, actor: ResolvedActor): Promise<MdmSyncDto> {
    await assertItStaff(actor, this.permCheck, 'it-006:write');
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO tech_mdm_sync_logs (id, asset_id, mdm_provider, device_name, os_version, last_check_in, is_compliant, compliance_details) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::timestamptz, $7, $8::jsonb)',
        id,
        input.assetId,
        input.mdmProvider,
        input.deviceName ?? null,
        input.osVersion ?? null,
        input.lastCheckIn ?? null,
        input.isCompliant ?? true,
        input.complianceDetails ? JSON.stringify(input.complianceDetails) : null,
      );
    });
    const all = await this.listSyncs({ assetId: input.assetId });
    const found = all.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Sync record not found after create');
    return found;
  }

  async listAlerts(filters: { unresolved?: boolean } = {}): Promise<MdmAlertDto[]> {
    const tenant = getCurrentTenant();
    const params: unknown[] = [tenant.schoolId];
    let where = ' WHERE a.school_id = $1::uuid';
    if (filters.unresolved !== false) {
      where += ' AND m.is_resolved = false';
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT m.id::text AS id, m.asset_id::text AS asset_id, a.asset_tag, m.alert_type, ' +
          'm.alert_detail, m.first_detected_at::text AS first_detected_at, ' +
          'm.last_detected_at::text AS last_detected_at, m.is_resolved, ' +
          'm.resolved_at::text AS resolved_at, m.resolved_by::text AS resolved_by, m.resolution_notes ' +
          'FROM tech_mdm_alerts m ' +
          'JOIN tech_assets a ON a.id = m.asset_id' +
          where +
          ' ORDER BY m.last_detected_at DESC',
        ...params,
      );
    })) as Array<{
      id: string;
      asset_id: string;
      asset_tag: string;
      alert_type: string;
      alert_detail: string | null;
      first_detected_at: string;
      last_detected_at: string;
      is_resolved: boolean;
      resolved_at: string | null;
      resolved_by: string | null;
      resolution_notes: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      assetId: r.asset_id,
      assetTag: r.asset_tag,
      alertType: r.alert_type as MdmAlertDto['alertType'],
      alertDetail: r.alert_detail,
      firstDetectedAt: r.first_detected_at,
      lastDetectedAt: r.last_detected_at,
      isResolved: r.is_resolved,
      resolvedAt: r.resolved_at,
      resolvedBy: r.resolved_by,
      resolutionNotes: r.resolution_notes,
    }));
  }

  async createAlert(input: CreateMdmAlertDto, actor: ResolvedActor): Promise<MdmAlertDto> {
    await assertItStaff(actor, this.permCheck, 'it-006:write');
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO tech_mdm_alerts (id, asset_id, alert_type, alert_detail) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4)',
        id,
        input.assetId,
        input.alertType,
        input.alertDetail ?? null,
      );
    });
    const all = await this.listAlerts({ unresolved: true });
    const found = all.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Alert not found after create');
    return found;
  }

  // Locked-row resolve: atomically stamps resolved_at +
  // resolved_by per the multi-column resolved_chk lockstep.
  async resolveAlert(
    id: string,
    input: ResolveMdmAlertDto,
    actor: ResolvedActor,
  ): Promise<MdmAlertDto> {
    await assertItStaff(actor, this.permCheck, 'it-006:write');
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT is_resolved FROM tech_mdm_alerts WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ is_resolved: boolean }>;
      if (lockRows.length === 0) throw new NotFoundException('Alert not found');
      if (lockRows[0]!.is_resolved) {
        throw new ConflictException('Alert is already resolved');
      }
      await tx.$executeRawUnsafe(
        'UPDATE tech_mdm_alerts SET is_resolved = true, resolved_at = now(), resolved_by = $1::uuid, resolution_notes = $2 WHERE id = $3::uuid',
        actor.accountId,
        input.resolutionNotes ?? null,
        id,
      );
    });
    const all = await this.listAlerts({ unresolved: false });
    const found = all.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Alert not found after resolve');
    return found;
  }
}

@Injectable()
export class InfrastructureService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async list(filters: { itemType?: string } = {}): Promise<InfrastructureItemDto[]> {
    const tenant = getCurrentTenant();
    const params: unknown[] = [tenant.schoolId];
    let where = ' WHERE school_id = $1::uuid';
    if (filters.itemType) {
      params.push(filters.itemType);
      where += ' AND item_type = $2';
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, item_name, item_type, location, ' +
          'ip_address, mac_address, make, model, serial_number, ' +
          'purchase_date::text AS purchase_date, warranty_expiry::text AS warranty_expiry, ' +
          'status, notes ' +
          'FROM tech_infrastructure_items' +
          where +
          ' ORDER BY item_type, item_name',
        ...params,
      );
    })) as Array<{
      id: string;
      school_id: string;
      item_name: string;
      item_type: string;
      location: string | null;
      ip_address: string | null;
      mac_address: string | null;
      make: string | null;
      model: string | null;
      serial_number: string | null;
      purchase_date: string | null;
      warranty_expiry: string | null;
      status: string;
      notes: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      itemName: r.item_name,
      itemType: r.item_type as InfrastructureItemDto['itemType'],
      location: r.location,
      ipAddress: r.ip_address,
      macAddress: r.mac_address,
      make: r.make,
      model: r.model,
      serialNumber: r.serial_number,
      purchaseDate: r.purchase_date,
      warrantyExpiry: r.warranty_expiry,
      status: r.status,
      notes: r.notes,
    }));
  }

  async getById(id: string): Promise<InfrastructureItemDto> {
    const all = await this.list();
    const found = all.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Infrastructure item not found');
    return found;
  }

  async create(
    input: CreateInfrastructureItemDto,
    actor: ResolvedActor,
  ): Promise<InfrastructureItemDto> {
    await assertItStaff(actor, this.permCheck, 'it-006:write');
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO tech_infrastructure_items (id, school_id, item_name, item_type, location, ip_address, mac_address, make, model, serial_number, purchase_date, warranty_expiry, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12::date, $13)',
          id,
          tenant.schoolId,
          input.itemName,
          input.itemType,
          input.location ?? null,
          input.ipAddress ?? null,
          input.macAddress ?? null,
          input.make ?? null,
          input.model ?? null,
          input.serialNumber ?? null,
          input.purchaseDate ?? null,
          input.warrantyExpiry ?? null,
          input.notes ?? null,
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'Infrastructure item with this serial number already exists for this school',
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  async patch(
    id: string,
    input: UpdateInfrastructureItemDto,
    actor: ResolvedActor,
  ): Promise<InfrastructureItemDto> {
    await assertItStaff(actor, this.permCheck, 'it-006:write');
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.itemName !== undefined) {
      sets.push('item_name = $' + (params.length + 1));
      params.push(input.itemName);
    }
    if (input.location !== undefined) {
      sets.push('location = $' + (params.length + 1));
      params.push(input.location);
    }
    if (input.ipAddress !== undefined) {
      sets.push('ip_address = $' + (params.length + 1));
      params.push(input.ipAddress);
    }
    if (input.macAddress !== undefined) {
      sets.push('mac_address = $' + (params.length + 1));
      params.push(input.macAddress);
    }
    if (input.status !== undefined) {
      sets.push('status = $' + (params.length + 1));
      params.push(input.status);
    }
    if (input.notes !== undefined) {
      sets.push('notes = $' + (params.length + 1));
      params.push(input.notes);
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(id);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE tech_infrastructure_items SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
    }
    return this.getById(id);
  }
}

@Injectable()
export class ProcurementService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async list(filters: { status?: string } = {}): Promise<ProcurementOrderDto[]> {
    const tenant = getCurrentTenant();
    const params: unknown[] = [tenant.schoolId];
    let where = ' WHERE p.school_id = $1::uuid';
    if (filters.status) {
      params.push(filters.status);
      where += ' AND p.status = $2';
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT p.id::text AS id, p.school_id::text AS school_id, p.order_title, ' +
          'p.vendor_id::text AS vendor_id, v.vendor_name, p.purchase_order_number, ' +
          "p.ordered_by::text AS ordered_by, ip.first_name || ' ' || ip.last_name AS ordered_by_name, " +
          'p.order_date::text AS order_date, p.expected_delivery_date::text AS expected_delivery_date, ' +
          'p.delivered_at::text AS delivered_at, p.total_cost::text AS total_cost, p.status, p.notes ' +
          'FROM tech_procurement_orders p ' +
          'LEFT JOIN tkt_vendors v ON v.id = p.vendor_id ' +
          'LEFT JOIN hr_employees e ON e.id = p.ordered_by ' +
          'LEFT JOIN platform.iam_person ip ON ip.id = e.person_id' +
          where +
          ' ORDER BY p.order_date DESC NULLS LAST',
        ...params,
      );
    })) as Array<{
      id: string;
      school_id: string;
      order_title: string;
      vendor_id: string | null;
      vendor_name: string | null;
      purchase_order_number: string | null;
      ordered_by: string | null;
      ordered_by_name: string | null;
      order_date: string | null;
      expected_delivery_date: string | null;
      delivered_at: string | null;
      total_cost: string | null;
      status: string;
      notes: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      orderTitle: r.order_title,
      vendorId: r.vendor_id,
      vendorName: r.vendor_name,
      purchaseOrderNumber: r.purchase_order_number,
      orderedBy: r.ordered_by,
      orderedByName: r.ordered_by_name,
      orderDate: r.order_date,
      expectedDeliveryDate: r.expected_delivery_date,
      deliveredAt: r.delivered_at,
      totalCost: r.total_cost === null ? null : Number(r.total_cost),
      status: r.status as ProcurementOrderDto['status'],
      notes: r.notes,
    }));
  }

  async getById(id: string): Promise<ProcurementOrderDto> {
    const all = await this.list();
    const found = all.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Procurement order not found');
    return found;
  }

  async create(
    input: CreateProcurementOrderDto,
    actor: ResolvedActor,
  ): Promise<ProcurementOrderDto> {
    await assertItStaff(actor, this.permCheck, 'it-002:write');
    const tenant = getCurrentTenant();
    if (!actor.employeeId) {
      throw new BadRequestException(
        'Procurement orders require an hr_employees record for the actor',
      );
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO tech_procurement_orders (id, school_id, order_title, vendor_id, purchase_order_number, ordered_by, order_date, expected_delivery_date, total_cost, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6::uuid, $7::date, $8::date, $9, $10)',
        id,
        tenant.schoolId,
        input.orderTitle,
        input.vendorId ?? null,
        input.purchaseOrderNumber ?? null,
        actor.employeeId,
        input.orderDate ?? null,
        input.expectedDeliveryDate ?? null,
        input.totalCost ?? null,
        input.notes ?? null,
      );
    });
    return this.getById(id);
  }

  async patch(
    id: string,
    input: UpdateProcurementOrderDto,
    actor: ResolvedActor,
  ): Promise<ProcurementOrderDto> {
    await assertItStaff(actor, this.permCheck, 'it-002:write');
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.orderTitle !== undefined) {
      sets.push('order_title = $' + (params.length + 1));
      params.push(input.orderTitle);
    }
    if (input.status !== undefined) {
      sets.push('status = $' + (params.length + 1));
      params.push(input.status);
    }
    if (input.expectedDeliveryDate !== undefined) {
      sets.push('expected_delivery_date = $' + (params.length + 1) + '::date');
      params.push(input.expectedDeliveryDate);
    }
    if (input.totalCost !== undefined) {
      sets.push('total_cost = $' + (params.length + 1));
      params.push(input.totalCost);
    }
    if (input.notes !== undefined) {
      sets.push('notes = $' + (params.length + 1));
      params.push(input.notes);
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(id);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE tech_procurement_orders SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
    }
    return this.getById(id);
  }

  // Locked-row delivery: atomically stamps delivered_at +
  // status='DELIVERED' per the multi-column delivered_chk
  // lockstep. Refuses if order is not in ORDERED.
  async markDelivered(
    id: string,
    input: MarkDeliveredDto,
    actor: ResolvedActor,
  ): Promise<ProcurementOrderDto> {
    await assertItStaff(actor, this.permCheck, 'it-002:write');
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT status FROM tech_procurement_orders WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ status: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Procurement order not found');
      if (lockRows[0]!.status !== 'ORDERED') {
        throw new ConflictException(
          'Order is in status ' + lockRows[0]!.status + ' — only ORDERED can be marked DELIVERED',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE tech_procurement_orders SET status = 'DELIVERED', delivered_at = COALESCE($1::timestamptz, now()), notes = COALESCE($2, notes), updated_at = now() WHERE id = $3::uuid",
        input.deliveredAt ?? null,
        input.notes ?? null,
        id,
      );
    });
    return this.getById(id);
  }
}

@Injectable()
export class DeviceSelectionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async listOptions(includeInactive = false): Promise<DeviceOptionDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, option_name, device_type, ' +
          'operating_system, specifications, COALESCE(software_available, ARRAY[]::text[]) AS software_available, ' +
          'cost_difference::text AS cost_difference, is_active ' +
          'FROM tech_device_options WHERE school_id = $1::uuid' +
          (includeInactive ? '' : ' AND is_active = true') +
          ' ORDER BY option_name',
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      option_name: string;
      device_type: string;
      operating_system: string | null;
      specifications: string | null;
      software_available: string[];
      cost_difference: string | null;
      is_active: boolean;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      optionName: r.option_name,
      deviceType: r.device_type as DeviceOptionDto['deviceType'],
      operatingSystem: r.operating_system,
      specifications: r.specifications,
      softwareAvailable: r.software_available,
      costDifference: r.cost_difference === null ? null : Number(r.cost_difference),
      isActive: r.is_active,
    }));
  }

  async createOption(input: CreateDeviceOptionDto, actor: ResolvedActor): Promise<DeviceOptionDto> {
    await assertItStaff(actor, this.permCheck, 'it-003:write');
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO tech_device_options (id, school_id, option_name, device_type, operating_system, specifications, software_available, cost_difference) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::text[], $8)',
          id,
          tenant.schoolId,
          input.optionName,
          input.deviceType,
          input.operatingSystem ?? null,
          input.specifications ?? null,
          input.softwareAvailable ?? [],
          input.costDifference ?? 0,
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'A device option with this name already exists for this school',
        );
      }
      throw err;
    }
    const all = await this.listOptions(true);
    const found = all.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Device option not found after create');
    return found;
  }

  async patchOption(
    id: string,
    input: UpdateDeviceOptionDto,
    actor: ResolvedActor,
  ): Promise<DeviceOptionDto> {
    await assertItStaff(actor, this.permCheck, 'it-003:write');
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.optionName !== undefined) {
      sets.push('option_name = $' + (params.length + 1));
      params.push(input.optionName);
    }
    if (input.operatingSystem !== undefined) {
      sets.push('operating_system = $' + (params.length + 1));
      params.push(input.operatingSystem);
    }
    if (input.specifications !== undefined) {
      sets.push('specifications = $' + (params.length + 1));
      params.push(input.specifications);
    }
    if (input.softwareAvailable !== undefined) {
      sets.push('software_available = $' + (params.length + 1) + '::text[]');
      params.push(input.softwareAvailable);
    }
    if (input.costDifference !== undefined) {
      sets.push('cost_difference = $' + (params.length + 1));
      params.push(input.costDifference);
    }
    if (input.isActive !== undefined) {
      sets.push('is_active = $' + (params.length + 1));
      params.push(input.isActive);
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(id);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE tech_device_options SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
    }
    const all = await this.listOptions(true);
    const found = all.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Device option not found after update');
    return found;
  }

  async listSelections(
    filters: {
      status?: string;
      personId?: string;
    } = {},
    actor?: ResolvedActor,
  ): Promise<DeviceSelectionDto[]> {
    const params: unknown[] = [];
    const wheres: string[] = [];
    if (filters.status) {
      params.push(filters.status);
      wheres.push('s.status = $' + params.length);
    }
    if (filters.personId) {
      params.push(filters.personId);
      wheres.push('s.person_id = $' + params.length + '::uuid');
    }
    // REVIEW-CYCLE22 BLOCKING 1 — actor-aware row scope.
    //   IT admin (school admin OR holds it-006:read — the IT admin
    //     signal that distinguishes IT staff from generic teachers):
    //     every selection in the tenant
    //   STUDENT: only s.person_id = actor.personId
    //   GUARDIAN: only selections for children linked via
    //     sis_student_guardians + sis_guardians on the actor
    //   TEACHER + non-IT-admin staff + everyone else: empty list
    //     (the device-selection workflow is between the
    //     student/parent and IT staff)
    //
    // The internal helpers downstream (createSelection /
    // approveSelection / rejectSelection) call listSelections({
    // personId }) WITHOUT an actor — they bypass the row scope on
    // purpose because they have already validated row access via
    // their own checks. The caller-supplied actor is only honoured
    // when actually present.
    if (actor) {
      const tenant = getCurrentTenant();
      const isItAdmin =
        actor.isSchoolAdmin ||
        (await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
          'it-006:read',
        ]));
      if (!isItAdmin) {
        if (actor.personType === 'STUDENT') {
          params.push(actor.personId);
          wheres.push('s.person_id = $' + params.length + '::uuid');
        } else if (actor.personType === 'GUARDIAN') {
          params.push(actor.personId);
          wheres.push(
            's.person_id IN (SELECT ps.person_id FROM platform.platform_students ps ' +
              'JOIN sis_students st ON st.platform_student_id = ps.id ' +
              'JOIN sis_student_guardians sg ON sg.student_id = st.id ' +
              'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
              'WHERE g.person_id = $' +
              params.length +
              '::uuid)',
          );
        } else {
          // Teacher (or any other non-IT-admin actor) gets empty
          wheres.push('FALSE');
        }
      }
    }
    const where = wheres.length === 0 ? '' : ' WHERE ' + wheres.join(' AND ');
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT s.id::text AS id, s.person_id::text AS person_id, ' +
          "ip.first_name || ' ' || ip.last_name AS person_name, " +
          's.option_id::text AS option_id, o.option_name, ' +
          's.selection_context, s.selected_at::text AS selected_at, s.status, ' +
          's.approved_by::text AS approved_by, ' +
          "ip2.first_name || ' ' || ip2.last_name AS approved_by_name, " +
          's.approved_at::text AS approved_at, ' +
          's.asset_id::text AS asset_id, a.asset_tag, s.notes ' +
          'FROM tech_device_selections s ' +
          'JOIN tech_device_options o ON o.id = s.option_id ' +
          'JOIN platform.iam_person ip ON ip.id = s.person_id ' +
          'LEFT JOIN platform.platform_users pu ON pu.id = s.approved_by ' +
          'LEFT JOIN platform.iam_person ip2 ON ip2.id = pu.person_id ' +
          'LEFT JOIN tech_assets a ON a.id = s.asset_id' +
          where +
          ' ORDER BY s.selected_at DESC',
        ...params,
      );
    })) as Array<{
      id: string;
      person_id: string;
      person_name: string;
      option_id: string;
      option_name: string;
      selection_context: string;
      selected_at: string;
      status: string;
      approved_by: string | null;
      approved_by_name: string | null;
      approved_at: string | null;
      asset_id: string | null;
      asset_tag: string | null;
      notes: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      personId: r.person_id,
      personName: r.person_name,
      optionId: r.option_id,
      optionName: r.option_name,
      selectionContext: r.selection_context as DeviceSelectionDto['selectionContext'],
      selectedAt: r.selected_at,
      status: r.status as DeviceSelectionDto['status'],
      approvedBy: r.approved_by,
      approvedByName: r.approved_by_name,
      approvedAt: r.approved_at,
      assetId: r.asset_id,
      assetTag: r.asset_tag,
      notes: r.notes,
    }));
  }

  // Selecting a device:
  // - Students / parents can submit a selection for the
  //   referenced person if they are that person OR (for parents)
  //   the student's guardian. This implements the "parent-active"
  //   onboarding path that ADR-066 describes.
  // - IT staff / school admins can submit a selection on behalf
  //   of any person.
  // - The seed places an existing PENDING/SELECTED row for the
  //   demo. New selections start at status='SELECTED' for self-
  //   service and 'PENDING' if filed on behalf of an unverified
  //   parent path; for the Cycle 22 demo we land everything as
  //   SELECTED for simplicity.
  async createSelection(
    input: CreateDeviceSelectionDto,
    actor: ResolvedActor,
  ): Promise<DeviceSelectionDto> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      // Student selecting for self
      if (actor.personType === 'STUDENT' && actor.personId !== input.personId) {
        throw new ForbiddenException('Students can only select a device for themselves');
      }
      // Guardian selecting for own child: confirm the child is
      // linked via sis_student_guardians + sis_guardians on the
      // calling actor's person_id.
      if (actor.personType === 'GUARDIAN') {
        const ok = (await this.tenantPrisma.executeInTenantContext(async (client) => {
          return client.$queryRawUnsafe(
            'SELECT 1 AS ok FROM sis_student_guardians sg ' +
              'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
              'JOIN sis_students st ON st.id = sg.student_id ' +
              'JOIN platform.platform_students ps ON ps.id = st.platform_student_id ' +
              'WHERE g.person_id = $1::uuid AND ps.person_id = $2::uuid LIMIT 1',
            actor.personId,
            input.personId,
          );
        })) as Array<{ ok: number }>;
        if (ok.length === 0) {
          throw new ForbiddenException('Guardians can only select a device for their own children');
        }
      }
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO tech_device_selections (id, person_id, option_id, selection_context, status, asset_id, notes) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'SELECTED', $5::uuid, $6)",
        id,
        input.personId,
        input.optionId,
        input.selectionContext,
        input.assetId ?? null,
        input.notes ?? null,
      );
    });
    const all = await this.listSelections({ personId: input.personId });
    const found = all.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Selection not found after create');
    return found;
  }

  // IT-staff approval — locks the row, flips status to APPROVED
  // (or PROVISIONED if an asset is supplied), stamps approved_by
  // + approved_at per the multi-column approved_chk lockstep.
  async approveSelection(
    id: string,
    input: ApproveSelectionDto,
    actor: ResolvedActor,
  ): Promise<DeviceSelectionDto> {
    await assertItStaff(actor, this.permCheck, 'it-003:write');
    let personId: string | null = null;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT status, person_id::text AS person_id FROM tech_device_selections WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ status: string; person_id: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Selection not found');
      const cur = lockRows[0]!.status;
      personId = lockRows[0]!.person_id;
      if (cur !== 'PENDING' && cur !== 'SELECTED') {
        throw new ConflictException(
          'Selection is in status ' + cur + ' — only PENDING or SELECTED can be approved',
        );
      }
      const newStatus = input.assetId ? 'PROVISIONED' : 'APPROVED';
      await tx.$executeRawUnsafe(
        'UPDATE tech_device_selections SET status = $1, asset_id = COALESCE($2::uuid, asset_id), approved_by = $3::uuid, approved_at = now(), notes = COALESCE($4, notes), updated_at = now() WHERE id = $5::uuid',
        newStatus,
        input.assetId ?? null,
        actor.accountId,
        input.notes ?? null,
        id,
      );
    });
    if (!personId) throw new NotFoundException('Selection lookup failed');
    const all = await this.listSelections({ personId });
    const found = all.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Selection not found after approve');
    return found;
  }

  async rejectSelection(id: string, actor: ResolvedActor): Promise<DeviceSelectionDto> {
    await assertItStaff(actor, this.permCheck, 'it-003:write');
    let personId: string | null = null;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT status, person_id::text AS person_id FROM tech_device_selections WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ status: string; person_id: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Selection not found');
      personId = lockRows[0]!.person_id;
      if (lockRows[0]!.status === 'PROVISIONED' || lockRows[0]!.status === 'REJECTED') {
        throw new ConflictException(
          'Selection in status ' + lockRows[0]!.status + ' cannot be rejected',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE tech_device_selections SET status = 'REJECTED', approved_by = $1::uuid, approved_at = now(), updated_at = now() WHERE id = $2::uuid",
        actor.accountId,
        id,
      );
    });
    if (!personId) throw new NotFoundException('Selection lookup failed');
    const all = await this.listSelections({ personId });
    const found = all.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Selection not found after reject');
    return found;
  }
}
