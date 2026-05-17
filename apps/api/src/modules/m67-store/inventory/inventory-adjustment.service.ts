import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import { assertStoreAdmin, assertStoreReader } from '../orders/access-advanced';
import type {
  CreateInventoryAdjustmentDto,
  InventoryAdjustmentDto,
  InventoryAdjustmentType,
} from '../orders/dto/commerce-store.dto';

interface AdjustmentRow {
  id: string;
  school_id: string;
  product_id: string;
  inventory_id: string;
  adjustment_type: string;
  quantity_delta: number;
  reason: string;
  adjusted_by: string;
  notes: string | null;
  created_at: string;
}

/**
 * P2-29b — InventoryAdjustmentService.
 *
 * Audit-logged stock movements outside the normal sales pipeline.
 * The Cycle 28 str_product_inventory row carries the authoritative
 * quantity_on_hand; this service is the only path that mutates it
 * outside the order pipeline so the audit chain is complete.
 *
 * Every adjustment runs inside a single tenant tx with
 * SELECT … FOR UPDATE on the str_product_inventory row so
 * concurrent admins serialise on the inventory row. The schema-side
 * quantity_on_hand >= 0 CHECK from Cycle 28 is the belt-and-braces
 * that catches a negative-delta adjust that would underflow.
 */
@Injectable()
export class InventoryAdjustmentService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private toDto(row: AdjustmentRow): InventoryAdjustmentDto {
    return {
      id: row.id,
      schoolId: row.school_id,
      productId: row.product_id,
      inventoryId: row.inventory_id,
      adjustmentType: row.adjustment_type as InventoryAdjustmentType,
      quantityDelta: Number(row.quantity_delta),
      reason: row.reason,
      adjustedBy: row.adjusted_by,
      notes: row.notes,
      createdAt: row.created_at,
    };
  }

  async listForProduct(
    actor: ResolvedActor,
    productId: string,
    limit?: number,
  ): Promise<InventoryAdjustmentDto[]> {
    await assertStoreReader(actor, this.permCheck, 'Inventory adjustment list');
    const tenant = getCurrentTenant();
    const cap = limit && limit > 0 && limit <= 500 ? limit : 100;
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT a.id::text AS id, a.school_id::text AS school_id,
                a.product_id::text AS product_id,
                a.inventory_id::text AS inventory_id,
                a.adjustment_type, a.quantity_delta, a.reason,
                a.adjusted_by::text AS adjusted_by, a.notes,
                a.created_at::text AS created_at
           FROM str_inventory_adjustments a
           JOIN str_products p ON p.id = a.product_id
           JOIN str_stores s ON s.id = p.store_id
          WHERE a.school_id = $1::uuid
            AND a.product_id = $2::uuid
            AND s.school_id = $1::uuid
          ORDER BY a.created_at DESC
          LIMIT $3::int`,
        tenant.schoolId,
        productId,
        cap,
      )) as AdjustmentRow[];
      return rows.map((r) => this.toDto(r));
    });
  }

  async adjust(
    actor: ResolvedActor,
    input: CreateInventoryAdjustmentDto,
  ): Promise<InventoryAdjustmentDto> {
    await assertStoreAdmin(actor, this.permCheck, 'Inventory adjustment');
    const tenant = getCurrentTenant();
    if (!actor.employeeId) {
      throw new BadRequestException('Caller does not have an employee record in this school');
    }
    if (input.quantityDelta === 0) {
      throw new BadRequestException('quantityDelta must be non-zero');
    }
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock the inventory row to serialise concurrent adjustments.
      // Verify the (product, inventory, store) triplet lives in this
      // school so a leaked id from another tenant cannot be adjusted.
      const invRows = (await tx.$queryRawUnsafe(
        `SELECT i.id::text AS id, i.product_id::text AS product_id,
                i.quantity_on_hand
           FROM str_product_inventory i
           JOIN str_products p ON p.id = i.product_id
           JOIN str_stores s ON s.id = p.store_id
          WHERE i.id = $1::uuid
            AND i.product_id = $2::uuid
            AND s.school_id = $3::uuid
          FOR UPDATE OF i`,
        input.inventoryId,
        input.productId,
        tenant.schoolId,
      )) as Array<{ id: string; product_id: string; quantity_on_hand: number }>;
      if (invRows.length === 0) {
        throw new NotFoundException(
          'Inventory row not found for this (productId, inventoryId) pair in the current school',
        );
      }
      const inv = invRows[0]!;
      const newQuantity = Number(inv.quantity_on_hand) + input.quantityDelta;
      if (newQuantity < 0) {
        throw new BadRequestException(
          `Adjustment would drive quantity_on_hand to ${newQuantity}, but the schema requires >= 0. Current quantity is ${inv.quantity_on_hand}.`,
        );
      }

      // Apply the inventory delta atomically with the audit log
      // insert. quantity_reserved is left alone — RECOUNT may
      // change on_hand without touching the reservation contract.
      //
      // REVIEW-P2C29 Round 1 MAJOR 2 fix — carry the school predicate
      // into the UPDATE itself via str_products + str_stores. The
      // SELECT … FOR UPDATE above already proved ownership; this is
      // the consistent mutation-statement-school-scope pattern.
      await tx.$executeRawUnsafe(
        `UPDATE str_product_inventory i
            SET quantity_on_hand = $1::int,
                updated_at = now()
           FROM str_products p
           JOIN str_stores s ON s.id = p.store_id
          WHERE p.id = i.product_id
            AND s.school_id = $2::uuid
            AND i.id = $3::uuid`,
        newQuantity,
        tenant.schoolId,
        input.inventoryId,
      );

      const id = generateId();
      const rows = (await tx.$queryRawUnsafe(
        `INSERT INTO str_inventory_adjustments
           (id, school_id, product_id, inventory_id, adjustment_type,
            quantity_delta, reason, adjusted_by, notes)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
                 $6::int, $7, $8::uuid, $9)
         RETURNING id::text AS id, school_id::text AS school_id,
                   product_id::text AS product_id,
                   inventory_id::text AS inventory_id,
                   adjustment_type, quantity_delta, reason,
                   adjusted_by::text AS adjusted_by, notes,
                   created_at::text AS created_at`,
        id,
        tenant.schoolId,
        input.productId,
        input.inventoryId,
        input.adjustmentType,
        input.quantityDelta,
        input.reason,
        actor.employeeId,
        input.notes ?? null,
      )) as AdjustmentRow[];
      return this.toDto(rows[0]!);
    });
  }
}
