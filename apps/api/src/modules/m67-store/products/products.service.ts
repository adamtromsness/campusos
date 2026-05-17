import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import type { PrismaClient } from '@prisma/client';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import { KafkaProducerService } from '@shared/kafka/kafka-producer.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import type {
  AdjustInventoryDto,
  CreateProductDto,
  CreateStoreDto,
  InventoryRowDto,
  LocationType,
  ProductDto,
  StoreDto,
  StoreType,
  UpdateProductDto,
  UpdateStoreDto,
} from '../orders/dto/store.dto';

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e?.code === 'P2002') return true;
  if (e?.code === 'P2010' && e?.meta?.code === '23505') return true;
  if (typeof e?.message === 'string' && e.message.includes('23505')) return true;
  return false;
}

interface StoreRow {
  id: string;
  school_id: string;
  store_type: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface ProductRow {
  id: string;
  store_id: string;
  name: string;
  description: string | null;
  sku: string | null;
  category: string | null;
  price: string | number;
  cost: string | number | null;
  image_s3_keys: string[];
  is_active: boolean;
  backorder_allowed: boolean;
  preferred_supplier_id: string | null;
  created_at: string;
  updated_at: string;
}

interface InventoryRow {
  id: string;
  product_id: string;
  location_type: string;
  location_id: string;
  quantity_on_hand: number;
  quantity_reserved: number;
  reorder_point: number;
  reorder_quantity: number;
}

@Injectable()
export class StoreService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private isStoreManager(actor: ResolvedActor): boolean {
    return actor.isSchoolAdmin || actor.personType === 'STAFF';
  }

  private toDto(r: StoreRow): StoreDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      storeType: r.store_type as StoreType,
      name: r.name,
      description: r.description,
      isActive: r.is_active,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async list(includeInactive = false): Promise<StoreDto[]> {
    const tenant = getCurrentTenant();
    const where = ['school_id = $1::uuid'];
    if (!includeInactive) where.push('is_active = true');
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, store_type, name, description, is_active, created_at::text AS created_at, updated_at::text AS updated_at FROM str_stores WHERE ${where.join(' AND ')} ORDER BY store_type, name`,
        tenant.schoolId,
      );
    })) as StoreRow[];
    return rows.map((r) => this.toDto(r));
  }

  async getById(id: string): Promise<StoreDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, store_type, name, description, is_active, created_at::text AS created_at, updated_at::text AS updated_at FROM str_stores WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as StoreRow[];
    if (rows.length === 0) throw new NotFoundException('Store not found');
    return this.toDto(rows[0]!);
  }

  async create(actor: ResolvedActor, input: CreateStoreDto): Promise<StoreDto> {
    if (!this.isStoreManager(actor)) {
      throw new ForbiddenException('Only store managers or admins may create stores');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `INSERT INTO str_stores (id, school_id, store_type, name, description) VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
          id,
          tenant.schoolId,
          input.storeType,
          input.name,
          input.description ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          `This school already has a ${input.storeType} store. Each school can have at most one store per type.`,
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  async patch(actor: ResolvedActor, id: string, input: UpdateStoreDto): Promise<StoreDto> {
    if (!this.isStoreManager(actor)) {
      throw new ForbiddenException('Only store managers or admins may edit stores');
    }
    const fields: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (input.name !== undefined) {
      fields.push(`name = $${i++}`);
      params.push(input.name);
    }
    if (input.description !== undefined) {
      fields.push(`description = $${i++}`);
      params.push(input.description);
    }
    if (input.isActive !== undefined) {
      fields.push(`is_active = $${i++}`);
      params.push(input.isActive);
    }
    if (fields.length > 0) {
      const tenant = getCurrentTenant();
      params.push(id);
      params.push(tenant.schoolId);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `UPDATE str_stores SET ${fields.join(', ')}, updated_at = now() WHERE id = $${i++}::uuid AND school_id = $${i}::uuid`,
          ...params,
        );
      });
    }
    return this.getById(id);
  }

  /** Used by ProductService to validate ownership. */
  async assertExists(storeId: string): Promise<{ schoolId: string; storeType: StoreType }> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT school_id::text AS school_id, store_type FROM str_stores WHERE id = $1::uuid AND school_id = $2::uuid AND is_active = true LIMIT 1`,
        storeId,
        tenant.schoolId,
      );
    })) as Array<{ school_id: string; store_type: string }>;
    if (rows.length === 0) {
      throw new BadRequestException('storeId does not match an active store in this school');
    }
    return { schoolId: rows[0]!.school_id, storeType: rows[0]!.store_type as StoreType };
  }
}

@Injectable()
export class ProductService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly stores: StoreService,
  ) {}

  private isStoreManager(actor: ResolvedActor): boolean {
    return actor.isSchoolAdmin || actor.personType === 'STAFF';
  }

  private async loadInventory(productIds: string[]): Promise<Map<string, InventoryRowDto[]>> {
    if (productIds.length === 0) return new Map();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, product_id::text AS product_id, location_type, location_id::text AS location_id, quantity_on_hand, quantity_reserved, reorder_point, reorder_quantity FROM str_product_inventory WHERE product_id = ANY($1::uuid[]) ORDER BY product_id`,
        productIds,
      );
    })) as InventoryRow[];
    const out = new Map<string, InventoryRowDto[]>();
    for (const r of rows) {
      const dto: InventoryRowDto = {
        id: r.id,
        productId: r.product_id,
        locationType: r.location_type as LocationType,
        locationId: r.location_id,
        quantityOnHand: Number(r.quantity_on_hand),
        quantityReserved: Number(r.quantity_reserved),
        reorderPoint: Number(r.reorder_point),
        reorderQuantity: Number(r.reorder_quantity),
      };
      const list = out.get(r.product_id) ?? [];
      list.push(dto);
      out.set(r.product_id, list);
    }
    return out;
  }

  private toDto(r: ProductRow, inventory: InventoryRowDto[]): ProductDto {
    const totalOnHand = inventory.reduce((s, i) => s + i.quantityOnHand, 0);
    const totalReserved = inventory.reduce((s, i) => s + i.quantityReserved, 0);
    return {
      id: r.id,
      storeId: r.store_id,
      name: r.name,
      description: r.description,
      sku: r.sku,
      category: r.category,
      price: Number(r.price),
      cost: r.cost === null ? null : Number(r.cost),
      imageS3Keys: r.image_s3_keys ?? [],
      isActive: r.is_active,
      backorderAllowed: r.backorder_allowed,
      preferredSupplierId: r.preferred_supplier_id,
      inventory,
      totalOnHand,
      totalReserved,
      totalAvailable: Math.max(totalOnHand - totalReserved, 0),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async listForStore(
    storeId: string,
    args: { category?: string; includeInactive?: boolean } = {},
  ): Promise<ProductDto[]> {
    await this.stores.assertExists(storeId);
    const where = ['p.store_id = $1::uuid'];
    const params: unknown[] = [storeId];
    let i = 2;
    if (!args.includeInactive) {
      where.push('p.is_active = true');
    }
    if (args.category) {
      where.push(`p.category = $${i++}`);
      params.push(args.category);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT p.id::text AS id, p.store_id::text AS store_id, p.name, p.description, p.sku, p.category, p.price, p.cost, p.image_s3_keys, p.is_active, p.backorder_allowed, p.preferred_supplier_id::text AS preferred_supplier_id, p.created_at::text AS created_at, p.updated_at::text AS updated_at FROM str_products p WHERE ${where.join(' AND ')} ORDER BY COALESCE(p.category, ''), p.name`,
        ...params,
      );
    })) as ProductRow[];
    const inv = await this.loadInventory(rows.map((r) => r.id));
    return rows.map((r) => this.toDto(r, inv.get(r.id) ?? []));
  }

  async getById(id: string): Promise<ProductDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT p.id::text AS id, p.store_id::text AS store_id, p.name, p.description, p.sku, p.category, p.price, p.cost, p.image_s3_keys, p.is_active, p.backorder_allowed, p.preferred_supplier_id::text AS preferred_supplier_id, p.created_at::text AS created_at, p.updated_at::text AS updated_at FROM str_products p JOIN str_stores s ON s.id = p.store_id WHERE p.id = $1::uuid LIMIT 1`,
        id,
      );
    })) as ProductRow[];
    if (rows.length === 0) throw new NotFoundException('Product not found');
    const inv = await this.loadInventory([id]);
    return this.toDto(rows[0]!, inv.get(id) ?? []);
  }

  async create(actor: ResolvedActor, input: CreateProductDto): Promise<ProductDto> {
    if (!this.isStoreManager(actor)) {
      throw new ForbiddenException('Only store managers or admins may create products');
    }
    await this.stores.assertExists(input.storeId);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `INSERT INTO str_products (id, store_id, name, description, sku, category, price, cost, image_s3_keys, backorder_allowed, preferred_supplier_id) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11::uuid)`,
        id,
        input.storeId,
        input.name,
        input.description ?? null,
        input.sku ?? null,
        input.category ?? null,
        input.price,
        input.cost ?? null,
        input.imageS3Keys ?? [],
        input.backorderAllowed ?? false,
        input.preferredSupplierId ?? null,
      );
    });
    return this.getById(id);
  }

  async patch(actor: ResolvedActor, id: string, input: UpdateProductDto): Promise<ProductDto> {
    if (!this.isStoreManager(actor)) {
      throw new ForbiddenException('Only store managers or admins may edit products');
    }
    const fields: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    const set = (col: string, value: unknown, cast?: string) => {
      fields.push(`${col} = $${i++}${cast ? `::${cast}` : ''}`);
      params.push(value);
    };
    if (input.name !== undefined) set('name', input.name);
    if (input.description !== undefined) set('description', input.description);
    if (input.sku !== undefined) set('sku', input.sku);
    if (input.category !== undefined) set('category', input.category);
    if (input.price !== undefined) set('price', input.price);
    if (input.cost !== undefined) set('cost', input.cost);
    if (input.imageS3Keys !== undefined) set('image_s3_keys', input.imageS3Keys, 'text[]');
    if (input.isActive !== undefined) set('is_active', input.isActive);
    if (input.backorderAllowed !== undefined) set('backorder_allowed', input.backorderAllowed);
    if (input.preferredSupplierId !== undefined)
      set('preferred_supplier_id', input.preferredSupplierId, 'uuid');
    if (fields.length > 0) {
      params.push(id);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `UPDATE str_products SET ${fields.join(', ')}, updated_at = now() WHERE id = $${i}::uuid`,
          ...params,
        );
      });
    }
    return this.getById(id);
  }

  /** Used by OrderService.create to read price + backorder + active state under FOR UPDATE. */
  async loadForOrderInTx(
    tx: PrismaClient,
    productId: string,
  ): Promise<{
    id: string;
    storeId: string;
    price: number;
    cost: number | null;
    isActive: boolean;
    backorderAllowed: boolean;
  }> {
    const rows = (await tx.$queryRawUnsafe(
      `SELECT id::text AS id, store_id::text AS store_id, price, cost, is_active, backorder_allowed FROM str_products WHERE id = $1::uuid LIMIT 1`,
      productId,
    )) as Array<{
      id: string;
      store_id: string;
      price: string | number;
      cost: string | number | null;
      is_active: boolean;
      backorder_allowed: boolean;
    }>;
    if (rows.length === 0) {
      throw new BadRequestException(
        `productId ${productId} does not match a product in this store`,
      );
    }
    const r = rows[0]!;
    return {
      id: r.id,
      storeId: r.store_id,
      price: Number(r.price),
      cost: r.cost === null ? null : Number(r.cost),
      isActive: r.is_active,
      backorderAllowed: r.backorder_allowed,
    };
  }
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  private isStoreManager(actor: ResolvedActor): boolean {
    return actor.isSchoolAdmin || actor.personType === 'STAFF';
  }

  /**
   * Admin inventory dashboard: every product (active + inactive) with
   * stock, reservation, reorder thresholds, and an `at_or_below_reorder`
   * flag. Joins to str_products + str_stores so the page can render
   * product name + SKU + store name without a second round-trip.
   */
  async dashboard(): Promise<
    Array<{
      productId: string;
      productName: string;
      sku: string | null;
      storeName: string;
      storeType: StoreType;
      locationType: LocationType;
      locationId: string;
      quantityOnHand: number;
      quantityReserved: number;
      reorderPoint: number;
      reorderQuantity: number;
      atOrBelowReorder: boolean;
    }>
  > {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT i.product_id::text AS product_id, p.name AS product_name, p.sku, s.name AS store_name, s.store_type, i.location_type, i.location_id::text AS location_id, i.quantity_on_hand, i.quantity_reserved, i.reorder_point, i.reorder_quantity FROM str_product_inventory i JOIN str_products p ON p.id = i.product_id JOIN str_stores s ON s.id = p.store_id WHERE s.school_id = $1::uuid ORDER BY (i.quantity_on_hand <= i.reorder_point AND i.reorder_point > 0) DESC, p.name`,
        tenant.schoolId,
      );
    })) as Array<{
      product_id: string;
      product_name: string;
      sku: string | null;
      store_name: string;
      store_type: string;
      location_type: string;
      location_id: string;
      quantity_on_hand: number;
      quantity_reserved: number;
      reorder_point: number;
      reorder_quantity: number;
    }>;
    return rows.map((r) => ({
      productId: r.product_id,
      productName: r.product_name,
      sku: r.sku,
      storeName: r.store_name,
      storeType: r.store_type as StoreType,
      locationType: r.location_type as LocationType,
      locationId: r.location_id,
      quantityOnHand: Number(r.quantity_on_hand),
      quantityReserved: Number(r.quantity_reserved),
      reorderPoint: Number(r.reorder_point),
      reorderQuantity: Number(r.reorder_quantity),
      atOrBelowReorder:
        Number(r.quantity_on_hand) <= Number(r.reorder_point) && Number(r.reorder_point) > 0,
    }));
  }

  /**
   * Adjust an inventory row. Locked-row tx: read prior quantity_on_hand
   * + reorder_point under FOR UPDATE, apply the new quantity, fire
   * `str.inventory.reorder_needed` AFTER the tx commits ONLY when the
   * stock crosses from above-reorder-point to at-or-below. Subsequent
   * adjustments that leave stock below the threshold do NOT re-fire
   * the emit (delta-based deduplication).
   */
  async adjust(
    actor: ResolvedActor,
    inventoryId: string,
    input: AdjustInventoryDto,
  ): Promise<void> {
    if (!this.isStoreManager(actor)) {
      throw new ForbiddenException('Only store managers or admins may adjust inventory');
    }
    const tenant = getCurrentTenant();
    type ReorderContext = {
      productId: string;
      productName: string;
      sku: string | null;
      currentStock: number;
      reorderPoint: number;
      reorderQuantity: number;
      preferredSupplierId: string | null;
    };
    let crossed = false;
    let context: ReorderContext | null = null;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT i.id, i.product_id::text AS product_id, i.quantity_on_hand AS prior_on_hand, i.reorder_point AS prior_reorder, p.name AS product_name, p.sku, p.preferred_supplier_id::text AS preferred_supplier_id, p.store_id, s.school_id::text AS school_id FROM str_product_inventory i JOIN str_products p ON p.id = i.product_id JOIN str_stores s ON s.id = p.store_id WHERE i.id = $1::uuid FOR UPDATE OF i`,
        inventoryId,
      )) as Array<{
        id: string;
        product_id: string;
        prior_on_hand: number;
        prior_reorder: number;
        product_name: string;
        sku: string | null;
        preferred_supplier_id: string | null;
        school_id: string;
      }>;
      if (rows.length === 0) throw new NotFoundException('Inventory row not found');
      const r = rows[0]!;
      if (r.school_id !== tenant.schoolId) {
        throw new NotFoundException('Inventory row not found');
      }
      const newOnHand = input.quantityOnHand;
      const newReorder = input.reorderPoint ?? Number(r.prior_reorder);
      const newReorderQty = input.reorderQuantity ?? null;
      const wasAbove = Number(r.prior_on_hand) > Number(r.prior_reorder);
      const nowAtOrBelow = newOnHand <= newReorder && newReorder > 0;
      crossed = wasAbove && nowAtOrBelow;
      const fields = [`quantity_on_hand = $1`, `reorder_point = $2`];
      const params: unknown[] = [newOnHand, newReorder];
      if (newReorderQty !== null) {
        fields.push(`reorder_quantity = $3`);
        params.push(newReorderQty);
      }
      params.push(inventoryId);
      await tx.$executeRawUnsafe(
        `UPDATE str_product_inventory SET ${fields.join(', ')}, updated_at = now() WHERE id = $${params.length}::uuid`,
        ...params,
      );
      if (crossed) {
        context = {
          productId: r.product_id,
          productName: r.product_name,
          sku: r.sku,
          currentStock: newOnHand,
          reorderPoint: newReorder,
          reorderQuantity: input.reorderQuantity ?? Number(r.prior_reorder),
          preferredSupplierId: r.preferred_supplier_id,
        };
      }
    });
    if (crossed && context !== null) {
      const ctx = context as ReorderContext;
      await this.kafka.emit({
        topic: 'str.inventory.reorder_needed',
        key: ctx.productId,
        sourceModule: 'store',
        payload: {
          productId: ctx.productId,
          schoolId: tenant.schoolId,
          productName: ctx.productName,
          sku: ctx.sku,
          currentStock: ctx.currentStock,
          reorderPoint: ctx.reorderPoint,
          reorderQuantity: ctx.reorderQuantity,
          preferredSupplierId: ctx.preferredSupplierId,
          sourceRefId: ctx.productId,
        },
      });
    }
  }
}
