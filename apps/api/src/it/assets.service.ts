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
import type {
  AssetCategoryDto,
  AssetDto,
  AssetDocumentDto,
  AssetStatus,
  AssignAssetDto,
  AssignmentDto,
  CreateAssetCategoryDto,
  CreateAssetDocumentDto,
  CreateAssetDto,
  CreateDamageReportDto,
  CreateRepairDto,
  DamageReportDto,
  RepairRecordDto,
  ReturnAssetDto,
  UpdateAssetCategoryDto,
  UpdateAssetDto,
  UpdateRepairDto,
} from './dto/it.dto';

/**
 * IT Administrator scope helper.
 *
 * IT-002:write is held by Teacher / Student / Staff per the
 * Cycle 22 IAM seed. The actual IT admin authority for management
 * (creating categories, retiring assets, assigning by-anyone) is
 * narrowed at the service layer via assertItAdminScope. School
 * admins bypass.
 */
export async function assertItAdminScope(
  actor: ResolvedActor,
  permCheck: PermissionCheckService,
): Promise<void> {
  if (actor.isSchoolAdmin) return;
  const tenant = getCurrentTenant();
  const ok = await permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
    'it-002:admin',
    'it-002:write',
  ]);
  if (!ok) {
    throw new ForbiddenException('Only IT staff or school admins can manage IT assets');
  }
  // Service-layer narrowing: only STAFF persona OR isSchoolAdmin
  // count as IT admins for management actions. Teachers + Students
  // hold IT-002:write so they can read their own assigned device
  // and submit damage reports — but they cannot manage the fleet.
  if (actor.personType !== 'STAFF') {
    throw new ForbiddenException('Only IT staff or school admins can manage IT assets');
  }
}

export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (e.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('23505');
}

@Injectable()
export class AssetCategoryService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async list(includeInactive = false): Promise<AssetCategoryDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT c.id::text AS id, c.school_id::text AS school_id, c.name, c.description, ' +
          'c.depreciation_years, c.maintenance_interval_months, c.is_active, ' +
          '(SELECT COUNT(*)::int FROM tech_assets a WHERE a.category_id = c.id) AS asset_count ' +
          'FROM tech_asset_categories c WHERE c.school_id = $1::uuid' +
          (includeInactive ? '' : ' AND c.is_active = true') +
          ' ORDER BY c.name',
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      name: string;
      description: string | null;
      depreciation_years: number | null;
      maintenance_interval_months: number | null;
      is_active: boolean;
      asset_count: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      name: r.name,
      description: r.description,
      depreciationYears: r.depreciation_years,
      maintenanceIntervalMonths: r.maintenance_interval_months,
      isActive: r.is_active,
      assetCount: r.asset_count,
    }));
  }

  async getById(id: string): Promise<AssetCategoryDto> {
    const all = await this.list(true);
    const found = all.find((c) => c.id === id);
    if (!found) throw new NotFoundException('Asset category not found');
    return found;
  }

  async create(input: CreateAssetCategoryDto, actor: ResolvedActor): Promise<AssetCategoryDto> {
    await assertItAdminScope(actor, this.permCheck);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO tech_asset_categories (id, school_id, name, description, depreciation_years, maintenance_interval_months) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)',
          id,
          tenant.schoolId,
          input.name,
          input.description ?? null,
          input.depreciationYears ?? null,
          input.maintenanceIntervalMonths ?? null,
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('A category with this name already exists for this school');
      }
      throw err;
    }
    return this.getById(id);
  }

  async patch(
    id: string,
    input: UpdateAssetCategoryDto,
    actor: ResolvedActor,
  ): Promise<AssetCategoryDto> {
    await assertItAdminScope(actor, this.permCheck);
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
    if (input.depreciationYears !== undefined) {
      sets.push('depreciation_years = $' + (params.length + 1));
      params.push(input.depreciationYears);
    }
    if (input.maintenanceIntervalMonths !== undefined) {
      sets.push('maintenance_interval_months = $' + (params.length + 1));
      params.push(input.maintenanceIntervalMonths);
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
          'UPDATE tech_asset_categories SET ' +
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
export class AssetService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  // Row-scope: admin/IT staff see everything. Other actors
  // (teachers, students, parents) see only assets currently
  // assigned to them via tech_asset_assignments.
  private async buildVisibility(
    actor: ResolvedActor,
  ): Promise<{ predicate: string; params: unknown[] }> {
    if (actor.isSchoolAdmin || actor.personType === 'STAFF') {
      return { predicate: '', params: [] };
    }
    const tenant = getCurrentTenant();
    return {
      predicate:
        ' AND EXISTS (SELECT 1 FROM tech_asset_assignments aa WHERE aa.asset_id = a.id AND aa.assigned_to_id = $2::uuid AND aa.returned_at IS NULL)',
      params: [tenant.schoolId, actor.accountId],
    };
  }

  async list(
    actor: ResolvedActor,
    filters: { status?: AssetStatus; categoryId?: string } = {},
  ): Promise<AssetDto[]> {
    const tenant = getCurrentTenant();
    const vis = await this.buildVisibility(actor);
    const params: unknown[] = vis.params.length > 0 ? [...vis.params] : [tenant.schoolId];
    let where = ' WHERE a.school_id = $1::uuid' + vis.predicate;
    if (filters.status) {
      params.push(filters.status);
      where += ' AND a.status = $' + params.length;
    }
    if (filters.categoryId) {
      params.push(filters.categoryId);
      where += ' AND a.category_id = $' + params.length + '::uuid';
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT a.id::text AS id, a.school_id::text AS school_id, a.category_id::text AS category_id, ' +
          'c.name AS category_name, a.asset_tag, a.serial_number, a.make, a.model, ' +
          'a.purchase_date::text AS purchase_date, a.purchase_cost::text AS purchase_cost, ' +
          'a.warranty_expiry::text AS warranty_expiry, a.status, a.notes, ' +
          '(SELECT aa.assigned_to_id::text FROM tech_asset_assignments aa WHERE aa.asset_id = a.id AND aa.returned_at IS NULL ORDER BY aa.assigned_at DESC LIMIT 1) AS current_assignee_id, ' +
          "(SELECT ip.first_name || ' ' || ip.last_name FROM tech_asset_assignments aa JOIN platform.platform_users pu ON pu.id = aa.assigned_to_id JOIN platform.iam_person ip ON ip.id = pu.person_id WHERE aa.asset_id = a.id AND aa.returned_at IS NULL ORDER BY aa.assigned_at DESC LIMIT 1) AS current_assignee_name " +
          'FROM tech_assets a JOIN tech_asset_categories c ON c.id = a.category_id' +
          where +
          ' ORDER BY a.asset_tag',
        ...params,
      );
    })) as Array<{
      id: string;
      school_id: string;
      category_id: string;
      category_name: string;
      asset_tag: string;
      serial_number: string | null;
      make: string | null;
      model: string | null;
      purchase_date: string | null;
      purchase_cost: string | null;
      warranty_expiry: string | null;
      status: AssetStatus;
      notes: string | null;
      current_assignee_id: string | null;
      current_assignee_name: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      categoryId: r.category_id,
      categoryName: r.category_name,
      assetTag: r.asset_tag,
      serialNumber: r.serial_number,
      make: r.make,
      model: r.model,
      purchaseDate: r.purchase_date,
      purchaseCost: r.purchase_cost === null ? null : Number(r.purchase_cost),
      warrantyExpiry: r.warranty_expiry,
      status: r.status,
      notes: r.notes,
      currentAssigneeId: r.current_assignee_id,
      currentAssigneeName: r.current_assignee_name,
    }));
  }

  async getById(id: string, actor: ResolvedActor): Promise<AssetDto> {
    const all = await this.list(actor);
    const found = all.find((a) => a.id === id);
    if (!found) throw new NotFoundException('Asset not found');
    return found;
  }

  async create(input: CreateAssetDto, actor: ResolvedActor): Promise<AssetDto> {
    await assertItAdminScope(actor, this.permCheck);
    const tenant = getCurrentTenant();
    // Validate category belongs to this school + is active.
    const catRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM tech_asset_categories WHERE id = $1::uuid AND school_id = $2::uuid AND is_active = true LIMIT 1',
        input.categoryId,
        tenant.schoolId,
      );
    })) as Array<{ ok: number }>;
    if (catRows.length === 0) {
      throw new BadRequestException('categoryId does not match an active category in this school');
    }
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO tech_assets (id, school_id, category_id, asset_tag, serial_number, make, model, purchase_date, purchase_cost, warranty_expiry, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::date, $9, $10::date, $11)',
          id,
          tenant.schoolId,
          input.categoryId,
          input.assetTag,
          input.serialNumber ?? null,
          input.make ?? null,
          input.model ?? null,
          input.purchaseDate ?? null,
          input.purchaseCost ?? null,
          input.warrantyExpiry ?? null,
          input.notes ?? null,
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'An asset with this tag or serial number already exists in this school',
        );
      }
      throw err;
    }
    return this.getById(id, actor);
  }

  async patch(id: string, input: UpdateAssetDto, actor: ResolvedActor): Promise<AssetDto> {
    await assertItAdminScope(actor, this.permCheck);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.categoryId !== undefined) {
      sets.push('category_id = $' + (params.length + 1) + '::uuid');
      params.push(input.categoryId);
    }
    if (input.assetTag !== undefined) {
      sets.push('asset_tag = $' + (params.length + 1));
      params.push(input.assetTag);
    }
    if (input.serialNumber !== undefined) {
      sets.push('serial_number = $' + (params.length + 1));
      params.push(input.serialNumber);
    }
    if (input.make !== undefined) {
      sets.push('make = $' + (params.length + 1));
      params.push(input.make);
    }
    if (input.model !== undefined) {
      sets.push('model = $' + (params.length + 1));
      params.push(input.model);
    }
    if (input.purchaseDate !== undefined) {
      sets.push('purchase_date = $' + (params.length + 1) + '::date');
      params.push(input.purchaseDate);
    }
    if (input.purchaseCost !== undefined) {
      sets.push('purchase_cost = $' + (params.length + 1));
      params.push(input.purchaseCost);
    }
    if (input.warrantyExpiry !== undefined) {
      sets.push('warranty_expiry = $' + (params.length + 1) + '::date');
      params.push(input.warrantyExpiry);
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
      try {
        await this.tenantPrisma.executeInTenantContext(async (client) => {
          await client.$executeRawUnsafe(
            'UPDATE tech_assets SET ' +
              sets.join(', ') +
              ' WHERE id = $' +
              params.length +
              '::uuid',
            ...params,
          );
        });
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          throw new ConflictException('Asset tag or serial number is already in use');
        }
        throw err;
      }
    }
    return this.getById(id, actor);
  }
}

@Injectable()
export class AssignmentService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async listForAsset(assetId: string): Promise<AssignmentDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT aa.id::text AS id, aa.asset_id::text AS asset_id, a.asset_tag, ' +
          "aa.assigned_to_id::text AS assignee_id, ip.first_name || ' ' || ip.last_name AS assignee_name, " +
          'aa.assigned_by::text AS assigned_by, aa.assigned_at::text AS assigned_at, ' +
          'aa.returned_at::text AS returned_at, aa.condition_at_assign, aa.condition_at_return, aa.notes ' +
          'FROM tech_asset_assignments aa ' +
          'JOIN tech_assets a ON a.id = aa.asset_id ' +
          'JOIN platform.platform_users pu ON pu.id = aa.assigned_to_id ' +
          'JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
          'WHERE aa.asset_id = $1::uuid ORDER BY aa.assigned_at DESC',
        assetId,
      );
    })) as Array<{
      id: string;
      asset_id: string;
      asset_tag: string;
      assignee_id: string;
      assignee_name: string;
      assigned_by: string;
      assigned_at: string;
      returned_at: string | null;
      condition_at_assign: string | null;
      condition_at_return: string | null;
      notes: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      assetId: r.asset_id,
      assetTag: r.asset_tag,
      assigneeId: r.assignee_id,
      assigneeName: r.assignee_name,
      assignedBy: r.assigned_by,
      assignedAt: r.assigned_at,
      returnedAt: r.returned_at,
      conditionAtAssign:
        r.condition_at_assign === null
          ? null
          : (r.condition_at_assign as AssignmentDto['conditionAtAssign']),
      conditionAtReturn:
        r.condition_at_return === null
          ? null
          : (r.condition_at_return as AssignmentDto['conditionAtReturn']),
      notes: r.notes,
    }));
  }

  async listForUser(actor: ResolvedActor): Promise<AssignmentDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT aa.id::text AS id, aa.asset_id::text AS asset_id, a.asset_tag, ' +
          "aa.assigned_to_id::text AS assignee_id, ip.first_name || ' ' || ip.last_name AS assignee_name, " +
          'aa.assigned_by::text AS assigned_by, aa.assigned_at::text AS assigned_at, ' +
          'aa.returned_at::text AS returned_at, aa.condition_at_assign, aa.condition_at_return, aa.notes ' +
          'FROM tech_asset_assignments aa ' +
          'JOIN tech_assets a ON a.id = aa.asset_id ' +
          'JOIN platform.platform_users pu ON pu.id = aa.assigned_to_id ' +
          'JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
          'WHERE aa.assigned_to_id = $1::uuid AND aa.returned_at IS NULL ' +
          'ORDER BY aa.assigned_at DESC',
        actor.accountId,
      );
    })) as Array<{
      id: string;
      asset_id: string;
      asset_tag: string;
      assignee_id: string;
      assignee_name: string;
      assigned_by: string;
      assigned_at: string;
      returned_at: string | null;
      condition_at_assign: string | null;
      condition_at_return: string | null;
      notes: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      assetId: r.asset_id,
      assetTag: r.asset_tag,
      assigneeId: r.assignee_id,
      assigneeName: r.assignee_name,
      assignedBy: r.assigned_by,
      assignedAt: r.assigned_at,
      returnedAt: r.returned_at,
      conditionAtAssign:
        r.condition_at_assign === null
          ? null
          : (r.condition_at_assign as AssignmentDto['conditionAtAssign']),
      conditionAtReturn:
        r.condition_at_return === null
          ? null
          : (r.condition_at_return as AssignmentDto['conditionAtReturn']),
      notes: r.notes,
    }));
  }

  // Locked-row lifecycle: assigning an asset locks it FOR UPDATE,
  // verifies status='AVAILABLE', creates the assignment row,
  // flips status to 'ASSIGNED' inside the same tx.
  async assignAsset(
    assetId: string,
    input: AssignAssetDto,
    actor: ResolvedActor,
  ): Promise<AssignmentDto> {
    await assertItAdminScope(actor, this.permCheck);
    // Validate assignee is a platform user
    const userRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM platform.platform_users pu WHERE pu.id = $1::uuid LIMIT 1',
        input.assigneeId,
      );
    })) as Array<{ ok: number }>;
    if (userRows.length === 0) {
      throw new BadRequestException('assigneeId does not match a platform user');
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT status FROM tech_assets WHERE id = $1::uuid FOR UPDATE',
        assetId,
      )) as Array<{ status: string }>;
      if (lockRows.length === 0) {
        throw new NotFoundException('Asset not found');
      }
      if (lockRows[0]!.status !== 'AVAILABLE') {
        throw new ConflictException(
          'Asset is in status ' +
            lockRows[0]!.status +
            ' and cannot be assigned. Return or repair it first.',
        );
      }
      await tx.$executeRawUnsafe(
        'INSERT INTO tech_asset_assignments (id, asset_id, assigned_to_id, assigned_by, assigned_at, condition_at_assign, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, now(), $5, $6)',
        id,
        assetId,
        input.assigneeId,
        actor.accountId,
        input.conditionAtAssign ?? null,
        input.notes ?? null,
      );
      await tx.$executeRawUnsafe(
        "UPDATE tech_assets SET status = 'ASSIGNED', updated_at = now() WHERE id = $1::uuid",
        assetId,
      );
    });
    const all = await this.listForAsset(assetId);
    const found = all.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Assignment not found after create');
    return found;
  }

  // Locked-row lifecycle: returning an assignment locks the
  // assignment row FOR UPDATE, verifies returned_at IS NULL,
  // stamps returned_at + condition_at_return atomically per the
  // multi-column returned_chk lockstep, then flips the parent
  // asset back to AVAILABLE.
  async returnAssignment(
    assignmentId: string,
    input: ReturnAssetDto,
    actor: ResolvedActor,
  ): Promise<AssignmentDto> {
    await assertItAdminScope(actor, this.permCheck);
    let assetId: string | null = null;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT asset_id::text AS asset_id, returned_at::text AS returned_at FROM tech_asset_assignments WHERE id = $1::uuid FOR UPDATE',
        assignmentId,
      )) as Array<{ asset_id: string; returned_at: string | null }>;
      if (lockRows.length === 0) {
        throw new NotFoundException('Assignment not found');
      }
      if (lockRows[0]!.returned_at !== null) {
        throw new ConflictException('Assignment has already been returned');
      }
      assetId = lockRows[0]!.asset_id;
      await tx.$executeRawUnsafe(
        'UPDATE tech_asset_assignments SET returned_at = now(), condition_at_return = $1, notes = COALESCE($2, notes) WHERE id = $3::uuid',
        input.conditionAtReturn ?? null,
        input.notes ?? null,
        assignmentId,
      );
      await tx.$executeRawUnsafe(
        "UPDATE tech_assets SET status = 'AVAILABLE', updated_at = now() WHERE id = $1::uuid",
        assetId,
      );
    });
    if (!assetId) throw new NotFoundException('Assignment lookup failed');
    const all = await this.listForAsset(assetId);
    const found = all.find((r) => r.id === assignmentId);
    if (!found) throw new NotFoundException('Assignment not found after return');
    return found;
  }
}

@Injectable()
export class AssetDocumentService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async listForAsset(assetId: string): Promise<AssetDocumentDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, asset_id::text AS asset_id, document_type, s3_key, file_name, ' +
          'uploaded_by::text AS uploaded_by, uploaded_at::text AS uploaded_at ' +
          'FROM tech_asset_documents WHERE asset_id = $1::uuid ORDER BY uploaded_at DESC',
        assetId,
      );
    })) as Array<{
      id: string;
      asset_id: string;
      document_type: string;
      s3_key: string;
      file_name: string;
      uploaded_by: string;
      uploaded_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      assetId: r.asset_id,
      documentType: r.document_type as AssetDocumentDto['documentType'],
      s3Key: r.s3_key,
      fileName: r.file_name,
      uploadedBy: r.uploaded_by,
      uploadedAt: r.uploaded_at,
    }));
  }

  async create(
    assetId: string,
    input: CreateAssetDocumentDto,
    actor: ResolvedActor,
  ): Promise<AssetDocumentDto> {
    await assertItAdminScope(actor, this.permCheck);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO tech_asset_documents (id, asset_id, document_type, s3_key, file_name, uploaded_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid)',
        id,
        assetId,
        input.documentType,
        input.s3Key,
        input.fileName,
        actor.accountId,
      );
    });
    const all = await this.listForAsset(assetId);
    const found = all.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Document not found after create');
    return found;
  }
}

@Injectable()
export class DamageReportService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(filters: { assetId?: string } = {}): Promise<DamageReportDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      const params: unknown[] = [];
      let where = '';
      if (filters.assetId) {
        params.push(filters.assetId);
        where = ' WHERE d.asset_id = $1::uuid';
      }
      return client.$queryRawUnsafe(
        'SELECT d.id::text AS id, d.asset_id::text AS asset_id, a.asset_tag, ' +
          "d.reported_by::text AS reported_by, ip.first_name || ' ' || ip.last_name AS reported_by_name, " +
          'd.description, d.severity, COALESCE(d.photo_s3_keys, ARRAY[]::text[]) AS photo_s3_keys, ' +
          'd.reported_at::text AS reported_at, d.repair_record_id::text AS repair_record_id ' +
          'FROM tech_damage_reports d ' +
          'JOIN tech_assets a ON a.id = d.asset_id ' +
          'JOIN platform.platform_users pu ON pu.id = d.reported_by ' +
          'JOIN platform.iam_person ip ON ip.id = pu.person_id' +
          where +
          ' ORDER BY d.reported_at DESC',
        ...params,
      );
    })) as Array<{
      id: string;
      asset_id: string;
      asset_tag: string;
      reported_by: string;
      reported_by_name: string;
      description: string;
      severity: string;
      photo_s3_keys: string[];
      reported_at: string;
      repair_record_id: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      assetId: r.asset_id,
      assetTag: r.asset_tag,
      reportedBy: r.reported_by,
      reportedByName: r.reported_by_name,
      description: r.description,
      severity: r.severity as DamageReportDto['severity'],
      photoS3Keys: r.photo_s3_keys,
      reportedAt: r.reported_at,
      repairRecordId: r.repair_record_id,
    }));
  }

  async create(input: CreateDamageReportDto, actor: ResolvedActor): Promise<DamageReportDto> {
    // Damage reporting is broader than IT admin — any user with
    // an active assignment for the asset OR IT staff/admin can
    // file. Validate that the actor is one or the other.
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      const ownership = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM tech_asset_assignments WHERE asset_id = $1::uuid AND assigned_to_id = $2::uuid AND returned_at IS NULL LIMIT 1',
          input.assetId,
          actor.accountId,
        );
      })) as Array<{ ok: number }>;
      if (ownership.length === 0) {
        throw new ForbiddenException(
          'Only IT staff or the current assignee can file a damage report for this asset',
        );
      }
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO tech_damage_reports (id, asset_id, reported_by, description, severity, photo_s3_keys) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::text[])',
        id,
        input.assetId,
        actor.accountId,
        input.description,
        input.severity,
        input.photoS3Keys ?? [],
      );
    });
    const all = await this.list({ assetId: input.assetId });
    const found = all.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Damage report not found after create');
    return found;
  }
}

@Injectable()
export class RepairRecordService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async list(filters: { assetId?: string } = {}): Promise<RepairRecordDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      const params: unknown[] = [];
      let where = '';
      if (filters.assetId) {
        params.push(filters.assetId);
        where = ' WHERE r.asset_id = $1::uuid';
      }
      return client.$queryRawUnsafe(
        'SELECT r.id::text AS id, r.asset_id::text AS asset_id, a.asset_tag, ' +
          'r.damage_report_id::text AS damage_report_id, r.vendor_id::text AS vendor_id, v.vendor_name, ' +
          'r.repair_type, r.sent_for_repair_at::text AS sent_for_repair_at, ' +
          'r.estimated_return_date::text AS estimated_return_date, r.returned_at::text AS returned_at, ' +
          'r.cost_estimate::text AS cost_estimate, r.final_cost::text AS final_cost, r.status, r.notes ' +
          'FROM tech_repair_records r ' +
          'JOIN tech_assets a ON a.id = r.asset_id ' +
          'LEFT JOIN tkt_vendors v ON v.id = r.vendor_id' +
          where +
          ' ORDER BY r.sent_for_repair_at DESC NULLS LAST',
        ...params,
      );
    })) as Array<{
      id: string;
      asset_id: string;
      asset_tag: string;
      damage_report_id: string | null;
      vendor_id: string | null;
      vendor_name: string | null;
      repair_type: string;
      sent_for_repair_at: string | null;
      estimated_return_date: string | null;
      returned_at: string | null;
      cost_estimate: string | null;
      final_cost: string | null;
      status: string;
      notes: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      assetId: r.asset_id,
      assetTag: r.asset_tag,
      damageReportId: r.damage_report_id,
      vendorId: r.vendor_id,
      vendorName: r.vendor_name,
      repairType: r.repair_type as RepairRecordDto['repairType'],
      sentForRepairAt: r.sent_for_repair_at,
      estimatedReturnDate: r.estimated_return_date,
      returnedAt: r.returned_at,
      costEstimate: r.cost_estimate === null ? null : Number(r.cost_estimate),
      finalCost: r.final_cost === null ? null : Number(r.final_cost),
      status: r.status as RepairRecordDto['status'],
      notes: r.notes,
    }));
  }

  // Creating a repair flips the asset to status='REPAIR' and
  // backfills the damage_report.repair_record_id link in the
  // same tx (if a damage report id is supplied).
  async create(input: CreateRepairDto, actor: ResolvedActor): Promise<RepairRecordDto> {
    await assertItAdminScope(actor, this.permCheck);
    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO tech_repair_records (id, asset_id, damage_report_id, vendor_id, repair_type, sent_for_repair_at, estimated_return_date, cost_estimate, status, created_by) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, now(), $6::date, $7, 'IN_REPAIR', $8::uuid)",
        id,
        input.assetId,
        input.damageReportId ?? null,
        input.vendorId ?? null,
        input.repairType,
        input.estimatedReturnDate ?? null,
        input.costEstimate ?? null,
        actor.accountId,
      );
      await tx.$executeRawUnsafe(
        "UPDATE tech_assets SET status = 'REPAIR', updated_at = now() WHERE id = $1::uuid",
        input.assetId,
      );
      if (input.damageReportId) {
        await tx.$executeRawUnsafe(
          'UPDATE tech_damage_reports SET repair_record_id = $1::uuid WHERE id = $2::uuid',
          id,
          input.damageReportId,
        );
      }
    });
    const all = await this.list({ assetId: input.assetId });
    const found = all.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Repair record not found after create');
    return found;
  }

  // Updating a repair to COMPLETED flips the asset back to
  // AVAILABLE; updating to UNREPAIRABLE flips it to LOST. Both
  // run inside the same tenant tx.
  async patch(id: string, input: UpdateRepairDto, actor: ResolvedActor): Promise<RepairRecordDto> {
    await assertItAdminScope(actor, this.permCheck);
    let assetId: string | null = null;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT asset_id::text AS asset_id, status FROM tech_repair_records WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ asset_id: string; status: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Repair record not found');
      assetId = lockRows[0]!.asset_id;
      const sets: string[] = [];
      const params: unknown[] = [];
      if (input.status !== undefined) {
        sets.push('status = $' + (params.length + 1));
        params.push(input.status);
      }
      if (input.estimatedReturnDate !== undefined) {
        sets.push('estimated_return_date = $' + (params.length + 1) + '::date');
        params.push(input.estimatedReturnDate);
      }
      if (input.returnedAt !== undefined) {
        sets.push('returned_at = $' + (params.length + 1) + '::timestamptz');
        params.push(input.returnedAt);
      }
      if (input.finalCost !== undefined) {
        sets.push('final_cost = $' + (params.length + 1));
        params.push(input.finalCost);
      }
      if (input.notes !== undefined) {
        sets.push('notes = $' + (params.length + 1));
        params.push(input.notes);
      }
      if (sets.length > 0) {
        params.push(id);
        await tx.$executeRawUnsafe(
          'UPDATE tech_repair_records SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      }
      // Asset status side effects
      if (input.status === 'COMPLETED') {
        await tx.$executeRawUnsafe(
          "UPDATE tech_assets SET status = 'AVAILABLE', updated_at = now() WHERE id = $1::uuid",
          assetId,
        );
        // Stamp returned_at if not supplied
        if (input.returnedAt === undefined) {
          await tx.$executeRawUnsafe(
            'UPDATE tech_repair_records SET returned_at = now() WHERE id = $1::uuid AND returned_at IS NULL',
            id,
          );
        }
      } else if (input.status === 'UNREPAIRABLE') {
        await tx.$executeRawUnsafe(
          "UPDATE tech_assets SET status = 'LOST', updated_at = now() WHERE id = $1::uuid",
          assetId,
        );
      }
    });
    if (!assetId) throw new NotFoundException('Repair record lookup failed');
    const all = await this.list({ assetId });
    const found = all.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Repair record not found after update');
    return found;
  }
}
