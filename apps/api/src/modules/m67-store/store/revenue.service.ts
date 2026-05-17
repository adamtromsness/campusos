import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import type {
  CreateExternalCustomerDto,
  CreateShippingOptionDto,
  ExternalCustomerDto,
  MaterialiseRevenueDto,
  RevenueRowDto,
  ShippingOptionDto,
  UpdateShippingOptionDto,
} from './dto/store.dto';

@Injectable()
export class ExternalCustomerService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private toDto(r: {
    id: string;
    school_id: string;
    name: string;
    email: string;
    phone: string | null;
    shipping_address: string | null;
    notes: string | null;
    created_at: string;
  }): ExternalCustomerDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      shippingAddress: r.shipping_address,
      notes: r.notes,
      createdAt: r.created_at,
    };
  }

  async create(input: CreateExternalCustomerDto): Promise<ExternalCustomerDto> {
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `INSERT INTO str_external_customers (id, school_id, name, email, phone, shipping_address, notes) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)`,
        id,
        tenant.schoolId,
        input.name,
        input.email,
        input.phone ?? null,
        input.shippingAddress ?? null,
        input.notes ?? null,
      );
    });
    return this.getById(id);
  }

  async getById(id: string): Promise<ExternalCustomerDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, name, email, phone, shipping_address, notes, created_at::text AS created_at FROM str_external_customers WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as Array<Parameters<typeof this.toDto>[0]>;
    if (rows.length === 0) throw new NotFoundException('External customer not found');
    return this.toDto(rows[0]!);
  }

  async list(actor: ResolvedActor): Promise<ExternalCustomerDto[]> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only store managers or admins may list external customers');
    }
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, name, email, phone, shipping_address, notes, created_at::text AS created_at FROM str_external_customers WHERE school_id = $1::uuid ORDER BY created_at DESC LIMIT 200`,
        tenant.schoolId,
      );
    })) as Array<Parameters<typeof this.toDto>[0]>;
    return rows.map((r) => this.toDto(r));
  }
}

@Injectable()
export class ShippingService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private isStoreManager(actor: ResolvedActor): boolean {
    return actor.isSchoolAdmin || actor.personType === 'STAFF';
  }

  private toDto(r: {
    id: string;
    store_id: string;
    method_name: string;
    estimated_days: number | null;
    flat_rate: string | number;
    is_active: boolean;
  }): ShippingOptionDto {
    return {
      id: r.id,
      storeId: r.store_id,
      methodName: r.method_name,
      estimatedDays: r.estimated_days === null ? null : Number(r.estimated_days),
      flatRate: Number(r.flat_rate),
      isActive: r.is_active,
    };
  }

  async listForStore(storeId: string, includeInactive = false): Promise<ShippingOptionDto[]> {
    const where = ['store_id = $1::uuid'];
    if (!includeInactive) where.push('is_active = true');
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, store_id::text AS store_id, method_name, estimated_days, flat_rate, is_active FROM str_shipping_options WHERE ${where.join(' AND ')} ORDER BY flat_rate`,
        storeId,
      );
    })) as Array<Parameters<typeof this.toDto>[0]>;
    return rows.map((r) => this.toDto(r));
  }

  async create(actor: ResolvedActor, input: CreateShippingOptionDto): Promise<ShippingOptionDto> {
    if (!this.isStoreManager(actor)) {
      throw new ForbiddenException('Only store managers or admins may add shipping options');
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `INSERT INTO str_shipping_options (id, store_id, method_name, estimated_days, flat_rate) VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
        id,
        input.storeId,
        input.methodName,
        input.estimatedDays ?? null,
        input.flatRate,
      );
    });
    return this.getById(id);
  }

  async patch(
    actor: ResolvedActor,
    id: string,
    input: UpdateShippingOptionDto,
  ): Promise<ShippingOptionDto> {
    if (!this.isStoreManager(actor)) {
      throw new ForbiddenException('Only store managers or admins may edit shipping options');
    }
    const fields: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (input.methodName !== undefined) {
      fields.push(`method_name = $${i++}`);
      params.push(input.methodName);
    }
    if (input.estimatedDays !== undefined) {
      fields.push(`estimated_days = $${i++}`);
      params.push(input.estimatedDays);
    }
    if (input.flatRate !== undefined) {
      fields.push(`flat_rate = $${i++}`);
      params.push(input.flatRate);
    }
    if (input.isActive !== undefined) {
      fields.push(`is_active = $${i++}`);
      params.push(input.isActive);
    }
    if (fields.length > 0) {
      params.push(id);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `UPDATE str_shipping_options SET ${fields.join(', ')}, updated_at = now() WHERE id = $${i}::uuid`,
          ...params,
        );
      });
    }
    return this.getById(id);
  }

  private async getById(id: string): Promise<ShippingOptionDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, store_id::text AS store_id, method_name, estimated_days, flat_rate, is_active FROM str_shipping_options WHERE id = $1::uuid LIMIT 1`,
        id,
      );
    })) as Array<Parameters<typeof this.toDto>[0]>;
    if (rows.length === 0) throw new NotFoundException('Shipping option not found');
    return this.toDto(rows[0]!);
  }
}

@Injectable()
export class RevenueService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private toDto(r: {
    id: string;
    store_id: string;
    store_name: string | null;
    period_start: string;
    period_end: string;
    total_orders: number;
    total_revenue: string | number;
    total_cost: string | number;
    gross_margin: string | number;
    computed_at: string;
  }): RevenueRowDto {
    return {
      id: r.id,
      storeId: r.store_id,
      storeName: r.store_name,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      totalOrders: Number(r.total_orders),
      totalRevenue: Number(r.total_revenue),
      totalCost: Number(r.total_cost),
      grossMargin: Number(r.gross_margin),
      computedAt: r.computed_at,
    };
  }

  async list(actor: ResolvedActor, storeId?: string): Promise<RevenueRowDto[]> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only store managers or admins may view revenue summaries');
    }
    const tenant = getCurrentTenant();
    const where = [
      'EXISTS (SELECT 1 FROM str_stores s WHERE s.id = r.store_id AND s.school_id = $1::uuid)',
    ];
    const params: unknown[] = [tenant.schoolId];
    let i = 2;
    if (storeId) {
      where.push(`r.store_id = $${i++}::uuid`);
      params.push(storeId);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT r.id::text AS id, r.store_id::text AS store_id, (SELECT name FROM str_stores WHERE id = r.store_id) AS store_name, r.period_start::text AS period_start, r.period_end::text AS period_end, r.total_orders, r.total_revenue, r.total_cost, r.gross_margin, r.computed_at::text AS computed_at FROM str_store_revenue r WHERE ${where.join(' AND ')} ORDER BY r.period_start DESC, r.store_id`,
        ...params,
      );
    })) as Array<Parameters<typeof this.toDto>[0]>;
    return rows.map((r) => this.toDto(r));
  }

  /**
   * StoreRevenueWorker.materialiseForPeriod — aggregates COMPLETED
   * orders in [period_start, period_end] for the store, sums revenue
   * from order totals + cost from product costs × line quantities,
   * computes gross margin, and UPSERTs into str_store_revenue keyed
   * on (store_id, period_start, period_end). Idempotent — re-runs
   * for the same period replace the existing row.
   */
  async materialise(actor: ResolvedActor, input: MaterialiseRevenueDto): Promise<RevenueRowDto> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException(
        'Only store managers or admins may materialise revenue summaries',
      );
    }
    const tenant = getCurrentTenant();
    if (input.periodEnd < input.periodStart) {
      throw new BadRequestException('periodEnd must be >= periodStart');
    }
    // Verify store belongs to school
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT 1 FROM str_stores WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        input.storeId,
        tenant.schoolId,
      )) as Array<unknown>;
      if (rows.length === 0) {
        throw new BadRequestException('storeId does not match a store in this school');
      }
    });
    // Aggregate completed orders in the window
    const aggRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT
           count(*)::int AS total_orders,
           COALESCE(SUM(o.total), 0)::numeric AS total_revenue,
           COALESCE(SUM(line_costs.line_cost), 0)::numeric AS total_cost
         FROM str_orders o
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(ol.quantity * COALESCE(p.cost, 0)), 0) AS line_cost
           FROM str_order_lines ol
           JOIN str_products p ON p.id = ol.product_id
           WHERE ol.order_id = o.id
         ) line_costs ON true
         WHERE o.store_id = $1::uuid
           AND o.status = 'COMPLETED'
           AND o.order_date >= $2::date
           AND o.order_date <= $3::date`,
        input.storeId,
        input.periodStart,
        input.periodEnd,
      );
    })) as Array<{
      total_orders: number;
      total_revenue: string | number;
      total_cost: string | number;
    }>;
    const agg = aggRows[0]!;
    const totalRevenue = Number(agg.total_revenue);
    const totalCost = Number(agg.total_cost);
    const grossMargin = Number((totalRevenue - totalCost).toFixed(2));
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `INSERT INTO str_store_revenue (id, store_id, period_start, period_end, total_orders, total_revenue, total_cost, gross_margin)
         VALUES ($1::uuid, $2::uuid, $3::date, $4::date, $5, $6, $7, $8)
         ON CONFLICT (store_id, period_start, period_end) DO UPDATE SET
           total_orders = EXCLUDED.total_orders,
           total_revenue = EXCLUDED.total_revenue,
           total_cost = EXCLUDED.total_cost,
           gross_margin = EXCLUDED.gross_margin,
           computed_at = now()`,
        id,
        input.storeId,
        input.periodStart,
        input.periodEnd,
        Number(agg.total_orders),
        totalRevenue,
        totalCost,
        grossMargin,
      );
    });
    // Re-read to get the row (handles the UPSERT case where id is the existing row's id, not our generated one)
    const final = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT r.id::text AS id, r.store_id::text AS store_id, (SELECT name FROM str_stores WHERE id = r.store_id) AS store_name, r.period_start::text AS period_start, r.period_end::text AS period_end, r.total_orders, r.total_revenue, r.total_cost, r.gross_margin, r.computed_at::text AS computed_at FROM str_store_revenue r WHERE r.store_id = $1::uuid AND r.period_start = $2::date AND r.period_end = $3::date LIMIT 1`,
        input.storeId,
        input.periodStart,
        input.periodEnd,
      );
    })) as Array<Parameters<typeof this.toDto>[0]>;
    return this.toDto(final[0]!);
  }
}
