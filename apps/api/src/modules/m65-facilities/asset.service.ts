import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import { assertCanManage } from './buildings.service';
import {
  AssetCategoryResponseDto,
  AssetDisposalResponseDto,
  AssetMaintenanceResponseDto,
  AssetResponseDto,
  AssetStatus,
  CreateAssetCategoryDto,
  CreateAssetDto,
  CreateAssetMaintenanceDto,
  DecommissionAssetDto,
  DisposeAssetDto,
  MaintenanceOverdueRowDto,
  ReplacementPlanningRowDto,
  ReplacementPriority,
  UpdateAssetCategoryDto,
  UpdateAssetDto,
} from './dto/facilities.dto';

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (e.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('23505');
}

/**
 * AssetService — P2-18b Step 4.
 *
 * Asset categories + assets + maintenance + decommission + disposal.
 *
 * Three keystones:
 *   1. Disposal requires DECOMMISSIONED status. The dispose path locks
 *      the parent fac_assets row with FOR UPDATE, validates
 *      status='DECOMMISSIONED', then INSERTs the fac_asset_disposals
 *      row inside the same tenant tx. CHECKs cannot encode the cross-
 *      row invariant so the service is the authoritative gate.
 *   2. Decommission stamps decommissioned_at + decommissioned_by
 *      atomically with the status flip so the schema-side decom_chk
 *      multi-column CHECK never fires mid-flight.
 *   3. Maintenance overdue dashboard surfaces assets whose most-recent
 *      maintenance record has next_maintenance_date strictly less than
 *      today.
 */
@Injectable()
export class AssetService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  // ── Categories ──

  async listCategories(includeInactive = false): Promise<AssetCategoryResponseDto[]> {
    const tenant = getCurrentTenant();
    const where = ['school_id = $1::uuid'];
    if (!includeInactive) where.push('is_active = true');
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, name, description, ' +
          'depreciation_years, maintenance_interval_months, is_active ' +
          'FROM fac_asset_categories WHERE ' +
          where.join(' AND ') +
          ' ORDER BY name',
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
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      name: r.name,
      description: r.description,
      depreciationYears: r.depreciation_years,
      maintenanceIntervalMonths: r.maintenance_interval_months,
      isActive: r.is_active,
    }));
  }

  async createCategory(
    input: CreateAssetCategoryDto,
    actor: ResolvedActor,
  ): Promise<AssetCategoryResponseDto> {
    await assertCanManage(actor, this.permCheck);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fac_asset_categories ' +
            '(id, school_id, name, description, depreciation_years, maintenance_interval_months) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)',
          id,
          tenant.schoolId,
          input.name,
          input.description ?? null,
          input.depreciationYears ?? null,
          input.maintenanceIntervalMonths ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'An asset category named "' + input.name + '" already exists in this school.',
        );
      }
      throw err;
    }
    const cats = await this.listCategories(true);
    const found = cats.find((c) => c.id === id);
    if (!found) throw new NotFoundException('Asset category not found after insert');
    return found;
  }

  async patchCategory(
    id: string,
    input: UpdateAssetCategoryDto,
    actor: ResolvedActor,
  ): Promise<AssetCategoryResponseDto> {
    await assertCanManage(actor, this.permCheck);
    const tenant = getCurrentTenant();
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
    if (sets.length === 0) {
      const cats = await this.listCategories(true);
      const found = cats.find((c) => c.id === id);
      if (!found) throw new NotFoundException('Asset category not found');
      return found;
    }
    sets.push('updated_at = now()');
    params.push(id, tenant.schoolId);
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE fac_asset_categories SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            (params.length - 1) +
            '::uuid AND school_id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('Another asset category already uses that name.');
      }
      throw err;
    }
    const cats = await this.listCategories(true);
    const found = cats.find((c) => c.id === id);
    if (!found) throw new NotFoundException('Asset category not found');
    return found;
  }

  // ── Assets ──

  async listAssets(args: {
    status?: AssetStatus;
    categoryId?: string;
    buildingId?: string;
  }): Promise<AssetResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['a.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.status) {
      where.push('a.status = $' + (params.length + 1));
      params.push(args.status);
    }
    if (args.categoryId) {
      where.push('a.category_id = $' + (params.length + 1) + '::uuid');
      params.push(args.categoryId);
    }
    if (args.buildingId) {
      where.push('a.building_id = $' + (params.length + 1) + '::uuid');
      params.push(args.buildingId);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        ASSET_SELECT + 'WHERE ' + where.join(' AND ') + ' ORDER BY a.name LIMIT 500',
        ...params,
      );
    })) as AssetRow[];
    return rows.map(assetRowToDto);
  }

  async getAsset(id: string): Promise<AssetResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        ASSET_SELECT + 'WHERE a.id = $1::uuid AND a.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as AssetRow[];
    if (rows.length === 0) throw new NotFoundException('Asset not found in this school');
    return assetRowToDto(rows[0]!);
  }

  async createAsset(input: CreateAssetDto, actor: ResolvedActor): Promise<AssetResponseDto> {
    await assertCanManage(actor, this.permCheck);
    const tenant = getCurrentTenant();
    const id = generateId();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Validate category + building belong to this school.
      const cat = (await tx.$queryRawUnsafe(
        'SELECT 1 AS ok FROM fac_asset_categories WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        input.categoryId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      if (cat.length === 0) {
        throw new BadRequestException('categoryId does not match an asset category in this school');
      }
      const bldg = (await tx.$queryRawUnsafe(
        'SELECT 1 AS ok FROM fac_buildings WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        input.buildingId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      if (bldg.length === 0) {
        throw new BadRequestException('buildingId does not match a building in this school');
      }
      if (input.spaceId) {
        // REVIEW-P2C18 BLOCKING 5 — validate the supplied spaceId
        // belongs to a building in the current school AND that the
        // building matches the asset's buildingId. fac_spaces has no
        // school_id column directly so we walk through fac_buildings.
        const sp = (await tx.$queryRawUnsafe(
          'SELECT 1 AS ok FROM fac_spaces s ' +
            'JOIN fac_buildings b ON b.id = s.building_id ' +
            'WHERE s.id = $1::uuid AND b.school_id = $2::uuid AND b.id = $3::uuid LIMIT 1',
          input.spaceId,
          tenant.schoolId,
          input.buildingId,
        )) as Array<{ ok: number }>;
        if (sp.length === 0) {
          throw new BadRequestException('spaceId does not match a space in this school + building');
        }
      }

      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO fac_assets ' +
            '(id, school_id, category_id, building_id, space_id, name, make, model, serial_number, install_date, warranty_expiry, expected_lifespan_years, replacement_cost_estimate, replacement_priority, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10::date, $11::date, $12, $13, $14, $15)',
          id,
          tenant.schoolId,
          input.categoryId,
          input.buildingId,
          input.spaceId ?? null,
          input.name,
          input.make ?? null,
          input.model ?? null,
          input.serialNumber ?? null,
          input.installDate ?? null,
          input.warrantyExpiry ?? null,
          input.expectedLifespanYears ?? null,
          input.replacementCostEstimate ?? null,
          input.replacementPriority ?? null,
          input.notes ?? null,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            'Another asset already uses that serial number in this school.',
          );
        }
        throw err;
      }
    });

    return this.getAsset(id);
  }

  async patchAsset(
    id: string,
    input: UpdateAssetDto,
    actor: ResolvedActor,
  ): Promise<AssetResponseDto> {
    await assertCanManage(actor, this.permCheck);
    const tenant = getCurrentTenant();

    // REVIEW-P2C18 BLOCKING 5 — when a new spaceId is supplied, validate
    // it belongs to a building in the current school AND that building
    // matches the asset's existing buildingId. Walks fac_spaces →
    // fac_buildings.school_id.
    if (input.spaceId !== undefined && input.spaceId !== null) {
      const existing = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT building_id::text AS building_id FROM fac_assets ' +
            'WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
          id,
          tenant.schoolId,
        );
      })) as Array<{ building_id: string }>;
      if (existing.length === 0) throw new NotFoundException('Asset not found in this school');
      const sp = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM fac_spaces s ' +
            'JOIN fac_buildings b ON b.id = s.building_id ' +
            'WHERE s.id = $1::uuid AND b.school_id = $2::uuid AND b.id = $3::uuid LIMIT 1',
          input.spaceId,
          tenant.schoolId,
          existing[0]!.building_id,
        );
      })) as Array<{ ok: number }>;
      if (sp.length === 0) {
        throw new BadRequestException(
          "spaceId does not match a space in this school + the asset's building",
        );
      }
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) {
      sets.push('name = $' + (params.length + 1));
      params.push(input.name);
    }
    if (input.make !== undefined) {
      sets.push('make = $' + (params.length + 1));
      params.push(input.make);
    }
    if (input.model !== undefined) {
      sets.push('model = $' + (params.length + 1));
      params.push(input.model);
    }
    if (input.serialNumber !== undefined) {
      sets.push('serial_number = $' + (params.length + 1));
      params.push(input.serialNumber);
    }
    if (input.installDate !== undefined) {
      sets.push('install_date = $' + (params.length + 1) + '::date');
      params.push(input.installDate);
    }
    if (input.warrantyExpiry !== undefined) {
      sets.push('warranty_expiry = $' + (params.length + 1) + '::date');
      params.push(input.warrantyExpiry);
    }
    if (input.expectedLifespanYears !== undefined) {
      sets.push('expected_lifespan_years = $' + (params.length + 1));
      params.push(input.expectedLifespanYears);
    }
    if (input.replacementCostEstimate !== undefined) {
      sets.push('replacement_cost_estimate = $' + (params.length + 1));
      params.push(input.replacementCostEstimate);
    }
    if (input.replacementPriority !== undefined) {
      sets.push('replacement_priority = $' + (params.length + 1));
      params.push(input.replacementPriority);
    }
    if (input.spaceId !== undefined) {
      sets.push('space_id = $' + (params.length + 1) + '::uuid');
      params.push(input.spaceId);
    }
    if (input.notes !== undefined) {
      sets.push('notes = $' + (params.length + 1));
      params.push(input.notes);
    }
    if (sets.length === 0) return this.getAsset(id);
    sets.push('updated_at = now()');
    params.push(id, tenant.schoolId);
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE fac_assets SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            (params.length - 1) +
            '::uuid AND school_id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('Another asset already uses that serial number.');
      }
      throw err;
    }
    return this.getAsset(id);
  }

  /**
   * Decommission an asset — flips status to DECOMMISSIONED and stamps
   * decommissioned_at + decommissioned_by atomically so the schema-side
   * decom_chk multi-column CHECK never fires mid-flight. Locks the row
   * with FOR UPDATE inside the tx so concurrent decommission attempts
   * serialise on the row.
   */
  async decommission(
    id: string,
    _input: DecommissionAssetDto,
    actor: ResolvedActor,
  ): Promise<AssetResponseDto> {
    await assertCanManage(actor, this.permCheck);
    if (!actor.personId) {
      throw new ForbiddenException('Decommission requires an authenticated person');
    }
    const tenant = getCurrentTenant();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT status FROM fac_assets WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        id,
        tenant.schoolId,
      )) as Array<{ status: string }>;
      if (rows.length === 0) throw new NotFoundException('Asset not found in this school');
      if (rows[0]!.status === 'DECOMMISSIONED') {
        throw new ConflictException('Asset is already DECOMMISSIONED.');
      }
      await tx.$executeRawUnsafe(
        "UPDATE fac_assets SET status = 'DECOMMISSIONED', decommissioned_at = now(), decommissioned_by = $1::uuid, updated_at = now() " +
          'WHERE id = $2::uuid AND school_id = $3::uuid',
        actor.personId,
        id,
        tenant.schoolId,
      );
    });
    return this.getAsset(id);
  }

  /**
   * KEYSTONE — Dispose of a DECOMMISSIONED asset. Locks the parent
   * fac_assets row FOR UPDATE inside the tenant tx, validates
   * status='DECOMMISSIONED', then INSERTs the fac_asset_disposals row.
   * The schema cannot encode the cross-row invariant directly so the
   * service layer is the authoritative gate.
   */
  async dispose(
    assetId: string,
    input: DisposeAssetDto,
    actor: ResolvedActor,
  ): Promise<AssetDisposalResponseDto> {
    await assertCanManage(actor, this.permCheck);
    if (!actor.personId) {
      throw new ForbiddenException('Disposal requires an authenticated person');
    }
    const tenant = getCurrentTenant();
    const disposalId = generateId();

    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        const rows = (await tx.$queryRawUnsafe(
          'SELECT status, school_id::text AS school_id FROM fac_assets ' +
            'WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
          assetId,
          tenant.schoolId,
        )) as Array<{ status: string; school_id: string }>;
        if (rows.length === 0) {
          throw new NotFoundException('Asset not found in this school');
        }
        if (rows[0]!.status !== 'DECOMMISSIONED') {
          throw new BadRequestException(
            'Asset must be DECOMMISSIONED before disposal. Current status: ' + rows[0]!.status,
          );
        }
        await tx.$executeRawUnsafe(
          'INSERT INTO fac_asset_disposals ' +
            '(id, school_id, asset_id, disposal_method, disposal_date, value_recovered, recipient_name, disposed_by, authorised_by, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6, $7, $8::uuid, $9::uuid, $10)',
          disposalId,
          tenant.schoolId,
          assetId,
          input.disposalMethod,
          input.disposalDate,
          input.valueRecovered ?? null,
          input.recipientName ?? null,
          actor.personId,
          input.authorisedById,
          input.notes ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('This asset has already been disposed.');
      }
      throw err;
    }

    return this.getDisposal(disposalId);
  }

  async getDisposal(id: string): Promise<AssetDisposalResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT d.id::text AS id, d.school_id::text AS school_id, d.asset_id::text AS asset_id, ' +
          '(SELECT name FROM fac_assets WHERE id = d.asset_id) AS asset_name, ' +
          'd.disposal_method, d.disposal_date::text AS disposal_date, ' +
          'd.value_recovered::float AS value_recovered, d.recipient_name, ' +
          'd.disposed_by::text AS disposed_by, ' +
          "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip WHERE ip.id = d.disposed_by) AS disposed_by_name, " +
          'd.authorised_by::text AS authorised_by, ' +
          "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip WHERE ip.id = d.authorised_by) AS authorised_by_name, " +
          'd.notes FROM fac_asset_disposals d ' +
          'WHERE d.id = $1::uuid AND d.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      asset_id: string;
      asset_name: string | null;
      disposal_method: string;
      disposal_date: string;
      value_recovered: number | null;
      recipient_name: string | null;
      disposed_by: string;
      disposed_by_name: string | null;
      authorised_by: string;
      authorised_by_name: string | null;
      notes: string | null;
    }>;
    if (rows.length === 0) throw new NotFoundException('Disposal not found');
    const r = rows[0]!;
    return {
      id: r.id,
      schoolId: r.school_id,
      assetId: r.asset_id,
      assetName: r.asset_name,
      disposalMethod: r.disposal_method as AssetDisposalResponseDto['disposalMethod'],
      disposalDate: r.disposal_date,
      valueRecovered: r.value_recovered,
      recipientName: r.recipient_name,
      disposedBy: r.disposed_by,
      disposedByName: r.disposed_by_name,
      authorisedBy: r.authorised_by,
      authorisedByName: r.authorised_by_name,
      notes: r.notes,
    };
  }

  // ── Maintenance ──

  async listMaintenance(assetId: string): Promise<AssetMaintenanceResponseDto[]> {
    await this.assertAssetInTenant(assetId);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT m.id::text AS id, m.asset_id::text AS asset_id, m.maintenance_type, ' +
          'm.performed_date::text AS performed_date, m.performed_by, m.cost::float AS cost, ' +
          'm.description, m.next_maintenance_date::text AS next_maintenance_date, ' +
          'm.created_by::text AS created_by, ' +
          "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip WHERE ip.id = m.created_by) AS created_by_name " +
          'FROM fac_asset_maintenance_records m WHERE m.asset_id = $1::uuid ORDER BY m.performed_date DESC',
        assetId,
      );
    })) as Array<{
      id: string;
      asset_id: string;
      maintenance_type: string;
      performed_date: string;
      performed_by: string;
      cost: number | null;
      description: string;
      next_maintenance_date: string | null;
      created_by: string;
      created_by_name: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      assetId: r.asset_id,
      maintenanceType: r.maintenance_type as AssetMaintenanceResponseDto['maintenanceType'],
      performedDate: r.performed_date,
      performedBy: r.performed_by,
      cost: r.cost,
      description: r.description,
      nextMaintenanceDate: r.next_maintenance_date,
      createdBy: r.created_by,
      createdByName: r.created_by_name,
    }));
  }

  async recordMaintenance(
    assetId: string,
    input: CreateAssetMaintenanceDto,
    actor: ResolvedActor,
  ): Promise<AssetMaintenanceResponseDto> {
    await assertCanManage(actor, this.permCheck);
    if (!actor.personId) {
      throw new ForbiddenException('Maintenance logging requires an authenticated person');
    }
    await this.assertAssetInTenant(assetId);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO fac_asset_maintenance_records ' +
          '(id, asset_id, maintenance_type, performed_date, performed_by, cost, description, next_maintenance_date, created_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4::date, $5, $6, $7, $8::date, $9::uuid)',
        id,
        assetId,
        input.maintenanceType,
        input.performedDate,
        input.performedBy,
        input.cost ?? null,
        input.description,
        input.nextMaintenanceDate ?? null,
        actor.personId,
      );
    });
    const all = await this.listMaintenance(assetId);
    const found = all.find((m) => m.id === id);
    if (!found) throw new NotFoundException('Maintenance record not found after insert');
    return found;
  }

  /**
   * Maintenance-overdue dashboard. Surfaces assets whose most-recent
   * fac_asset_maintenance_records.next_maintenance_date is strictly
   * less than CURRENT_DATE. Only ACTIVE and UNDER_MAINTENANCE assets
   * appear — DECOMMISSIONED is out of scope.
   */
  async maintenanceOverdue(): Promise<MaintenanceOverdueRowDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT a.id::text AS asset_id, a.name AS asset_name, ' +
          '(SELECT name FROM fac_asset_categories WHERE id = a.category_id) AS category_name, ' +
          '(SELECT name FROM fac_buildings WHERE id = a.building_id) AS building_name, ' +
          'latest.next_maintenance_date::text AS next_maintenance_date, ' +
          '(CURRENT_DATE - latest.next_maintenance_date)::int AS days_overdue ' +
          'FROM fac_assets a ' +
          'JOIN LATERAL (' +
          '  SELECT next_maintenance_date FROM fac_asset_maintenance_records m ' +
          '  WHERE m.asset_id = a.id AND m.next_maintenance_date IS NOT NULL ' +
          '  ORDER BY m.performed_date DESC LIMIT 1' +
          ') latest ON true ' +
          'WHERE a.school_id = $1::uuid ' +
          "  AND a.status IN ('ACTIVE', 'UNDER_MAINTENANCE') " +
          '  AND latest.next_maintenance_date < CURRENT_DATE ' +
          'ORDER BY days_overdue DESC LIMIT 200',
        tenant.schoolId,
      );
    })) as Array<{
      asset_id: string;
      asset_name: string;
      category_name: string | null;
      building_name: string | null;
      next_maintenance_date: string;
      days_overdue: number;
    }>;
    return rows.map((r) => ({
      assetId: r.asset_id,
      assetName: r.asset_name,
      categoryName: r.category_name,
      buildingName: r.building_name,
      nextMaintenanceDate: r.next_maintenance_date,
      daysOverdue: r.days_overdue,
    }));
  }

  /**
   * Replacement planning dashboard. Lists ACTIVE assets sorted by
   * projected end of life ascending, then replacement_priority — so
   * CRITICAL items nearing the end of their lifespan surface first.
   */
  async replacementPlanning(): Promise<ReplacementPlanningRowDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT a.id::text AS asset_id, a.name AS asset_name, ' +
          '(SELECT name FROM fac_asset_categories WHERE id = a.category_id) AS category_name, ' +
          'a.install_date::text AS install_date, a.expected_lifespan_years, ' +
          'CASE WHEN a.install_date IS NULL OR a.expected_lifespan_years IS NULL THEN NULL ' +
          "  ELSE (a.install_date + (a.expected_lifespan_years || ' years')::interval)::date::text END AS projected_end_of_life, " +
          'CASE WHEN a.install_date IS NULL OR a.expected_lifespan_years IS NULL THEN NULL ' +
          "  ELSE EXTRACT(YEAR FROM age((a.install_date + (a.expected_lifespan_years || ' years')::interval), CURRENT_DATE::timestamp))::int END AS years_remaining, " +
          'a.replacement_cost_estimate::float AS replacement_cost_estimate, ' +
          'a.replacement_priority ' +
          "FROM fac_assets a WHERE a.school_id = $1::uuid AND a.status = 'ACTIVE' " +
          'ORDER BY ' +
          "  CASE a.replacement_priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END, " +
          '  projected_end_of_life NULLS LAST',
        tenant.schoolId,
      );
    })) as Array<{
      asset_id: string;
      asset_name: string;
      category_name: string | null;
      install_date: string | null;
      expected_lifespan_years: number | null;
      projected_end_of_life: string | null;
      years_remaining: number | null;
      replacement_cost_estimate: number | null;
      replacement_priority: string | null;
    }>;
    return rows.map((r) => ({
      assetId: r.asset_id,
      assetName: r.asset_name,
      categoryName: r.category_name,
      installDate: r.install_date,
      expectedLifespanYears: r.expected_lifespan_years,
      projectedEndOfLife: r.projected_end_of_life,
      yearsRemaining: r.years_remaining,
      replacementCostEstimate: r.replacement_cost_estimate,
      replacementPriority: r.replacement_priority as ReplacementPriority | null,
    }));
  }

  private async assertAssetInTenant(assetId: string): Promise<void> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM fac_assets WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        assetId,
        tenant.schoolId,
      );
    })) as Array<{ ok: number }>;
    if (rows.length === 0) {
      throw new NotFoundException('Asset not found in this school');
    }
  }
}

const ASSET_SELECT =
  'SELECT a.id::text AS id, a.school_id::text AS school_id, a.category_id::text AS category_id, ' +
  '(SELECT name FROM fac_asset_categories WHERE id = a.category_id) AS category_name, ' +
  'a.building_id::text AS building_id, ' +
  '(SELECT name FROM fac_buildings WHERE id = a.building_id) AS building_name, ' +
  'a.space_id::text AS space_id, ' +
  '(SELECT name FROM fac_spaces WHERE id = a.space_id) AS space_name, ' +
  'a.name, a.make, a.model, a.serial_number, ' +
  'a.install_date::text AS install_date, a.warranty_expiry::text AS warranty_expiry, ' +
  'a.expected_lifespan_years, a.replacement_cost_estimate::float AS replacement_cost_estimate, ' +
  'a.replacement_priority, a.status, a.notes, ' +
  'a.decommissioned_at, a.decommissioned_by::text AS decommissioned_by ' +
  'FROM fac_assets a ';

interface AssetRow {
  id: string;
  school_id: string;
  category_id: string;
  category_name: string | null;
  building_id: string;
  building_name: string | null;
  space_id: string | null;
  space_name: string | null;
  name: string;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  install_date: string | null;
  warranty_expiry: string | null;
  expected_lifespan_years: number | null;
  replacement_cost_estimate: number | null;
  replacement_priority: string | null;
  status: string;
  notes: string | null;
  decommissioned_at: Date | null;
  decommissioned_by: string | null;
}

function assetRowToDto(r: AssetRow): AssetResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    categoryId: r.category_id,
    categoryName: r.category_name,
    buildingId: r.building_id,
    buildingName: r.building_name,
    spaceId: r.space_id,
    spaceName: r.space_name,
    name: r.name,
    make: r.make,
    model: r.model,
    serialNumber: r.serial_number,
    installDate: r.install_date,
    warrantyExpiry: r.warranty_expiry,
    expectedLifespanYears: r.expected_lifespan_years,
    replacementCostEstimate: r.replacement_cost_estimate,
    replacementPriority: r.replacement_priority as ReplacementPriority | null,
    status: r.status as AssetStatus,
    notes: r.notes,
    decommissionedAt: r.decommissioned_at ? r.decommissioned_at.toISOString() : null,
    decommissionedBy: r.decommissioned_by,
  };
}
