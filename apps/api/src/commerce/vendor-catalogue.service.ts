import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { assertProcurementAdmin, assertProcurementReader, isUniqueViolation } from './access';
import type {
  CatalogueItemDto,
  CreateCatalogueItemDto,
  CreateVendorCatalogueDto,
  UpdateCatalogueItemDto,
  UpdateVendorCatalogueDto,
  VendorCatalogueDetailDto,
  VendorCatalogueDto,
} from './dto/commerce.dto';

interface CatalogueRow {
  id: string;
  vendor_id: string;
  school_id: string;
  catalogue_name: string;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  id: string;
  catalogue_id: string;
  item_code: string;
  description: string;
  unit: string | null;
  negotiated_price: string | number;
  category: string | null;
  min_order_qty: number;
  lead_time_days: number | null;
  is_active: boolean;
}

@Injectable()
export class VendorCatalogueService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private toDto(row: CatalogueRow): VendorCatalogueDto {
    return {
      id: row.id,
      vendorId: row.vendor_id,
      schoolId: row.school_id,
      catalogueName: row.catalogue_name,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      isActive: row.is_active,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private itemToDto(row: ItemRow): CatalogueItemDto {
    return {
      id: row.id,
      catalogueId: row.catalogue_id,
      itemCode: row.item_code,
      description: row.description,
      unit: row.unit,
      negotiatedPrice: Number(row.negotiated_price),
      category: row.category,
      minOrderQty: Number(row.min_order_qty),
      leadTimeDays: row.lead_time_days === null ? null : Number(row.lead_time_days),
      isActive: row.is_active,
    };
  }

  async list(actor: ResolvedActor, vendorId?: string): Promise<VendorCatalogueDto[]> {
    await assertProcurementReader(actor, this.permCheck, 'Vendor catalogue list');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const args: unknown[] = [tenant.schoolId];
      let where = '';
      if (vendorId) {
        args.push(vendorId);
        where = ' AND vendor_id = $2::uuid';
      }
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, vendor_id::text AS vendor_id, school_id::text AS school_id,
                catalogue_name,
                effective_from::text AS effective_from,
                effective_to::text AS effective_to,
                is_active, notes,
                created_at::text AS created_at, updated_at::text AS updated_at
           FROM prc_vendor_catalogues
          WHERE school_id = $1::uuid${where}
          ORDER BY effective_from DESC, catalogue_name`,
        ...args,
      )) as CatalogueRow[];
      return rows.map((r) => this.toDto(r));
    });
  }

  async getById(actor: ResolvedActor, id: string): Promise<VendorCatalogueDetailDto> {
    await assertProcurementReader(actor, this.permCheck, 'Vendor catalogue read');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, vendor_id::text AS vendor_id, school_id::text AS school_id,
                catalogue_name,
                effective_from::text AS effective_from,
                effective_to::text AS effective_to,
                is_active, notes,
                created_at::text AS created_at, updated_at::text AS updated_at
           FROM prc_vendor_catalogues
          WHERE school_id = $1::uuid AND id = $2::uuid`,
        tenant.schoolId,
        id,
      )) as CatalogueRow[];
      if (rows.length === 0) throw new NotFoundException('Vendor catalogue not found');
      const items = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, catalogue_id::text AS catalogue_id, item_code, description,
                unit, negotiated_price, category, min_order_qty, lead_time_days, is_active
           FROM prc_catalogue_items
          WHERE catalogue_id = $1::uuid
          ORDER BY item_code`,
        id,
      )) as ItemRow[];
      return { ...this.toDto(rows[0]!), items: items.map((i) => this.itemToDto(i)) };
    });
  }

  async create(actor: ResolvedActor, input: CreateVendorCatalogueDto): Promise<VendorCatalogueDto> {
    await assertProcurementAdmin(actor, this.permCheck, 'Create vendor catalogue');
    const tenant = getCurrentTenant();
    if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
      throw new BadRequestException('effectiveTo must be on or after effectiveFrom');
    }
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Verify vendor exists in this tenant (fin_suppliers is tenant-scoped per Cycle 26)
      const vendor = (await tx.$queryRawUnsafe(
        `SELECT 1 AS ok FROM fin_suppliers WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        input.vendorId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      if (vendor.length === 0) {
        throw new BadRequestException('vendorId does not match a supplier in this school');
      }
      const id = generateId();
      try {
        const rows = (await tx.$queryRawUnsafe(
          `INSERT INTO prc_vendor_catalogues
             (id, vendor_id, school_id, catalogue_name, effective_from, effective_to, notes)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6::date, $7)
           RETURNING id::text AS id, vendor_id::text AS vendor_id, school_id::text AS school_id,
                     catalogue_name,
                     effective_from::text AS effective_from,
                     effective_to::text AS effective_to,
                     is_active, notes,
                     created_at::text AS created_at, updated_at::text AS updated_at`,
          id,
          input.vendorId,
          tenant.schoolId,
          input.catalogueName,
          input.effectiveFrom,
          input.effectiveTo ?? null,
          input.notes ?? null,
        )) as CatalogueRow[];
        return this.toDto(rows[0]!);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            `A catalogue named "${input.catalogueName}" already exists for this vendor`,
          );
        }
        throw err;
      }
    });
  }

  async patch(
    actor: ResolvedActor,
    id: string,
    input: UpdateVendorCatalogueDto,
  ): Promise<VendorCatalogueDto> {
    await assertProcurementAdmin(actor, this.permCheck, 'Update vendor catalogue');
    const tenant = getCurrentTenant();
    if (
      input.effectiveTo !== undefined &&
      input.effectiveFrom !== undefined &&
      input.effectiveTo !== null &&
      input.effectiveTo < input.effectiveFrom
    ) {
      throw new BadRequestException('effectiveTo must be on or after effectiveFrom');
    }
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const existing = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id FROM prc_vendor_catalogues
          WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
        tenant.schoolId,
        id,
      )) as Array<{ id: string }>;
      if (existing.length === 0) throw new NotFoundException('Vendor catalogue not found');

      const sets: string[] = [];
      const args: unknown[] = [];
      let p = 1;
      if (input.catalogueName !== undefined) {
        sets.push(`catalogue_name = $${p}`);
        args.push(input.catalogueName);
        p++;
      }
      if (input.effectiveFrom !== undefined) {
        sets.push(`effective_from = $${p}::date`);
        args.push(input.effectiveFrom);
        p++;
      }
      if (input.effectiveTo !== undefined) {
        sets.push(`effective_to = $${p}::date`);
        args.push(input.effectiveTo);
        p++;
      }
      if (input.isActive !== undefined) {
        sets.push(`is_active = $${p}`);
        args.push(input.isActive);
        p++;
      }
      if (input.notes !== undefined) {
        sets.push(`notes = $${p}`);
        args.push(input.notes);
        p++;
      }
      if (sets.length === 0) {
        return this.getById(actor, id).then((d) => ({ ...d }));
      }
      sets.push(`updated_at = now()`);
      args.push(tenant.schoolId, id);
      try {
        const rows = (await tx.$queryRawUnsafe(
          `UPDATE prc_vendor_catalogues
              SET ${sets.join(', ')}
            WHERE school_id = $${p}::uuid AND id = $${p + 1}::uuid
            RETURNING id::text AS id, vendor_id::text AS vendor_id, school_id::text AS school_id,
                      catalogue_name,
                      effective_from::text AS effective_from,
                      effective_to::text AS effective_to,
                      is_active, notes,
                      created_at::text AS created_at, updated_at::text AS updated_at`,
          ...args,
        )) as CatalogueRow[];
        return this.toDto(rows[0]!);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            `A catalogue named "${input.catalogueName}" already exists for this vendor`,
          );
        }
        throw err;
      }
    });
  }

  async addItem(
    actor: ResolvedActor,
    catalogueId: string,
    input: CreateCatalogueItemDto,
  ): Promise<CatalogueItemDto> {
    await assertProcurementAdmin(actor, this.permCheck, 'Add catalogue item');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const existing = (await tx.$queryRawUnsafe(
        `SELECT id FROM prc_vendor_catalogues
          WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1`,
        tenant.schoolId,
        catalogueId,
      )) as Array<{ id: string }>;
      if (existing.length === 0) throw new NotFoundException('Vendor catalogue not found');
      const id = generateId();
      try {
        const rows = (await tx.$queryRawUnsafe(
          `INSERT INTO prc_catalogue_items
             (id, catalogue_id, item_code, description, unit, negotiated_price, category,
              min_order_qty, lead_time_days)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::numeric, $7, $8, $9)
           RETURNING id::text AS id, catalogue_id::text AS catalogue_id, item_code, description,
                     unit, negotiated_price, category, min_order_qty, lead_time_days, is_active`,
          id,
          catalogueId,
          input.itemCode,
          input.description,
          input.unit ?? null,
          input.negotiatedPrice,
          input.category ?? null,
          input.minOrderQty ?? 1,
          input.leadTimeDays ?? null,
        )) as ItemRow[];
        return this.itemToDto(rows[0]!);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            `Item code "${input.itemCode}" already exists in this catalogue`,
          );
        }
        throw err;
      }
    });
  }

  async patchItem(
    actor: ResolvedActor,
    itemId: string,
    input: UpdateCatalogueItemDto,
  ): Promise<CatalogueItemDto> {
    await assertProcurementAdmin(actor, this.permCheck, 'Update catalogue item');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Verify item belongs to a catalogue owned by current school.
      const existing = (await tx.$queryRawUnsafe(
        `SELECT i.id::text AS id FROM prc_catalogue_items i
            JOIN prc_vendor_catalogues c ON c.id = i.catalogue_id AND c.school_id = $1::uuid
           WHERE i.id = $2::uuid
           FOR UPDATE OF i`,
        tenant.schoolId,
        itemId,
      )) as Array<{ id: string }>;
      if (existing.length === 0) throw new NotFoundException('Catalogue item not found');

      const sets: string[] = [];
      const args: unknown[] = [];
      let p = 1;
      if (input.description !== undefined) {
        sets.push(`description = $${p}`);
        args.push(input.description);
        p++;
      }
      if (input.unit !== undefined) {
        sets.push(`unit = $${p}`);
        args.push(input.unit);
        p++;
      }
      if (input.negotiatedPrice !== undefined) {
        sets.push(`negotiated_price = $${p}::numeric`);
        args.push(input.negotiatedPrice);
        p++;
      }
      if (input.category !== undefined) {
        sets.push(`category = $${p}`);
        args.push(input.category);
        p++;
      }
      if (input.minOrderQty !== undefined) {
        sets.push(`min_order_qty = $${p}`);
        args.push(input.minOrderQty);
        p++;
      }
      if (input.leadTimeDays !== undefined) {
        sets.push(`lead_time_days = $${p}`);
        args.push(input.leadTimeDays);
        p++;
      }
      if (input.isActive !== undefined) {
        sets.push(`is_active = $${p}`);
        args.push(input.isActive);
        p++;
      }
      if (sets.length === 0) {
        const rows = (await tx.$queryRawUnsafe(
          `SELECT id::text AS id, catalogue_id::text AS catalogue_id, item_code, description,
                  unit, negotiated_price, category, min_order_qty, lead_time_days, is_active
             FROM prc_catalogue_items WHERE id = $1::uuid`,
          itemId,
        )) as ItemRow[];
        return this.itemToDto(rows[0]!);
      }
      sets.push(`updated_at = now()`);
      args.push(itemId);
      const rows = (await tx.$queryRawUnsafe(
        `UPDATE prc_catalogue_items
            SET ${sets.join(', ')}
          WHERE id = $${p}::uuid
          RETURNING id::text AS id, catalogue_id::text AS catalogue_id, item_code, description,
                    unit, negotiated_price, category, min_order_qty, lead_time_days, is_active`,
        ...args,
      )) as ItemRow[];
      return this.itemToDto(rows[0]!);
    });
  }
}
