import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { OutboxService, OutboxTxClient } from '../kafka/outbox.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { assertFsmAdminScope } from './fsm-scope';

/**
 * REVIEW-P2-10a ROUND 1 BLOCKING 3 — deterministic event id for
 * `fds.inventory.low`. A retry / redelivery on the same low-stock
 * transaction produces the exact same Kafka event_id so any
 * downstream consumer (Procurement requisition auto-create, Cycle
 * 14 notifications) catches the dup cleanly. Same v5-shaped UUID
 * pattern as P2-4a deterministicPayrollEventId + P2-6
 * deterministicCreditNoteEventId.
 */
export function deterministicInventoryLowEventId(transactionId: string): string {
  const hash = createHash('sha256')
    .update(transactionId + ':fds.inventory.low:v1')
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  );
}
import {
  CreateInventoryGroupDto,
  CreateInventoryItemDto,
  InventoryGroupResponseDto,
  InventoryItemResponseDto,
  InventoryLevelResponseDto,
  InventoryTransactionResponseDto,
  ReceiveInventoryDto,
  StocktakeInventoryDto,
  UpdateInventoryGroupDto,
  UpdateInventoryItemDto,
  UsageInventoryDto,
  WasteInventoryDto,
} from './dto/food-service-advanced.dto';
import { isUniqueViolation } from './food-service.errors';

/**
 * InventoryService — groups, items, levels, and the 4 stock-movement
 * actions that write IMMUTABLE fds_inventory_transactions rows:
 * RECEIPT, USAGE, WASTE, STOCKTAKE. ADJUSTMENT + TRANSFER_IN +
 * TRANSFER_OUT are written by TransferService.
 *
 * IMPORTANT — fds_inventory_transactions is IMMUTABLE. There is no
 * update or delete method on this service for transaction rows.
 * Corrections land as a fresh ADJUSTMENT or STOCKTAKE row.
 *
 * Every stock action runs inside a single locked tenant tx that:
 *   1. SELECT … FOR UPDATE on the fds_inventory_levels row
 *      (creating it on first touch via UPSERT)
 *   2. Apply the signed quantity_delta to quantity_on_hand
 *   3. INSERT the immutable transaction row
 *
 * After commit, when the new quantity crosses below the parent
 * item's reorder_threshold (and the previous value was above), the
 * service emits `fds.inventory.low` via the canonical ADR-057
 * envelope so the Procurement consumer can auto-create a
 * requisition.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  /**
   * REVIEW-P2-10a ROUND 1 BLOCKING 4 — every mutation path now gates
   * on FDS-006:write (Food Service Administration) instead of the
   * broad `personType === 'STAFF'` check. A generic teacher/office
   * Staff persona without FDS-006 can no longer mutate inventory,
   * stocktake, or transfer.
   */
  private async assertCanManage(actor: ResolvedActor): Promise<void> {
    await assertFsmAdminScope(this.permCheck, actor, 'manage inventory');
  }

  // ─── Groups ─────────────────────────────────────────────────────────

  async listGroups(args: { includeInactive?: boolean }): Promise<InventoryGroupResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (!args.includeInactive) where.push('is_active = true');
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, name, group_type, location, is_active, managed_by::text AS managed_by ' +
          'FROM fds_inventory_groups WHERE ' +
          where.join(' AND ') +
          ' ORDER BY name',
        ...params,
      );
    })) as InventoryGroupRow[];
    return rows.map(groupRowToDto);
  }

  async createGroup(
    input: CreateInventoryGroupDto,
    actor: ResolvedActor,
  ): Promise<InventoryGroupResponseDto> {
    await this.assertCanManage(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fds_inventory_groups (id, school_id, name, group_type, location, managed_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid)',
          id,
          tenant.schoolId,
          input.name,
          input.groupType,
          input.location ?? null,
          input.managedBy ?? null,
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'An inventory group with this name already exists for this school',
        );
      }
      throw err;
    }
    const groups = await this.listGroups({ includeInactive: true });
    return groups.find((g) => g.id === id)!;
  }

  async patchGroup(
    id: string,
    input: UpdateInventoryGroupDto,
    actor: ResolvedActor,
  ): Promise<InventoryGroupResponseDto> {
    await this.assertCanManage(actor);
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown): void => {
      sets.push(col + ' = $' + (params.length + 1));
      params.push(val);
    };
    if (input.name !== undefined) push('name', input.name);
    if (input.groupType !== undefined) push('group_type', input.groupType);
    if (input.location !== undefined) push('location', input.location);
    if (input.managedBy !== undefined) {
      sets.push('managed_by = $' + (params.length + 1) + '::uuid');
      params.push(input.managedBy);
    }
    if (input.isActive !== undefined) push('is_active', input.isActive);
    if (sets.length === 0) {
      const groups = await this.listGroups({ includeInactive: true });
      const found = groups.find((g) => g.id === id);
      if (!found) throw new NotFoundException('Inventory group not found');
      return found;
    }
    sets.push('updated_at = now()');
    params.push(id);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const result = await client.$executeRawUnsafe(
        'UPDATE fds_inventory_groups SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          params.length +
          '::uuid',
        ...params,
      );
      if (result === 0) throw new NotFoundException('Inventory group not found');
    });
    const groups = await this.listGroups({ includeInactive: true });
    return groups.find((g) => g.id === id)!;
  }

  // ─── Items ──────────────────────────────────────────────────────────

  async listItems(args: { category?: string }): Promise<InventoryItemResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.category) {
      where.push('category = $' + (params.length + 1));
      params.push(args.category);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, name, unit, category, allergen_codes, ' +
          'reorder_threshold, preferred_vendor_id::text AS preferred_vendor_id, unit_cost ' +
          'FROM fds_inventory_items WHERE ' +
          where.join(' AND ') +
          ' ORDER BY category, name',
        ...params,
      );
    })) as InventoryItemRow[];
    return rows.map(itemRowToDto);
  }

  async createItem(
    input: CreateInventoryItemDto,
    actor: ResolvedActor,
  ): Promise<InventoryItemResponseDto> {
    await this.assertCanManage(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fds_inventory_items (id, school_id, name, unit, category, allergen_codes, reorder_threshold, preferred_vendor_id, unit_cost) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::text[], $7, $8::uuid, $9)',
          id,
          tenant.schoolId,
          input.name,
          input.unit,
          input.category,
          input.allergenCodes ?? [],
          input.reorderThreshold ?? null,
          input.preferredVendorId ?? null,
          input.unitCost ?? null,
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'An inventory item with this name already exists for this school',
        );
      }
      throw err;
    }
    const items = await this.listItems({});
    return items.find((i) => i.id === id)!;
  }

  async patchItem(
    id: string,
    input: UpdateInventoryItemDto,
    actor: ResolvedActor,
  ): Promise<InventoryItemResponseDto> {
    await this.assertCanManage(actor);
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown): void => {
      sets.push(col + ' = $' + (params.length + 1));
      params.push(val);
    };
    if (input.name !== undefined) push('name', input.name);
    if (input.unit !== undefined) push('unit', input.unit);
    if (input.category !== undefined) push('category', input.category);
    if (input.allergenCodes !== undefined) {
      sets.push('allergen_codes = $' + (params.length + 1) + '::text[]');
      params.push(input.allergenCodes);
    }
    if (input.reorderThreshold !== undefined) push('reorder_threshold', input.reorderThreshold);
    if (input.preferredVendorId !== undefined) {
      sets.push('preferred_vendor_id = $' + (params.length + 1) + '::uuid');
      params.push(input.preferredVendorId);
    }
    if (input.unitCost !== undefined) push('unit_cost', input.unitCost);
    if (sets.length === 0) {
      const items = await this.listItems({});
      const found = items.find((i) => i.id === id);
      if (!found) throw new NotFoundException('Inventory item not found');
      return found;
    }
    sets.push('updated_at = now()');
    params.push(id);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const result = await client.$executeRawUnsafe(
        'UPDATE fds_inventory_items SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          params.length +
          '::uuid',
        ...params,
      );
      if (result === 0) throw new NotFoundException('Inventory item not found');
    });
    const items = await this.listItems({});
    return items.find((i) => i.id === id)!;
  }

  // ─── Levels ─────────────────────────────────────────────────────────

  async listLevels(groupId: string): Promise<InventoryLevelResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      // Outer join from items so the FSM sees rows for items that
      // have never had stock in this group (quantity_on_hand=0
      // when missing).
      return client.$queryRawUnsafe(
        'SELECT COALESCE(l.id::text, NULL) AS id, g.id::text AS group_id, i.id::text AS item_id, i.name AS item_name, ' +
          'i.unit AS unit, i.category AS category, COALESCE(l.quantity_on_hand, 0) AS quantity_on_hand, ' +
          'i.reorder_threshold AS reorder_threshold, l.last_counted_at AS last_counted_at ' +
          'FROM fds_inventory_items i ' +
          'CROSS JOIN fds_inventory_groups g ' +
          'LEFT JOIN fds_inventory_levels l ON l.group_id = g.id AND l.item_id = i.id ' +
          'WHERE g.id = $1::uuid AND g.school_id = $2::uuid AND i.school_id = $2::uuid ' +
          'ORDER BY i.category, i.name',
        groupId,
        tenant.schoolId,
      );
    })) as InventoryLevelRow[];
    return rows.map(levelRowToDto);
  }

  // ─── Stock movements (write IMMUTABLE transactions) ────────────────

  async receive(
    input: ReceiveInventoryDto,
    actor: ResolvedActor,
  ): Promise<InventoryTransactionResponseDto> {
    await this.assertCanManage(actor);
    return this.movement('RECEIPT', input.groupId, input.itemId, input.quantity, actor, {
      notes: input.notes,
    });
  }

  async usage(
    input: UsageInventoryDto,
    actor: ResolvedActor,
  ): Promise<InventoryTransactionResponseDto> {
    await this.assertCanManage(actor);
    return this.movement('USAGE', input.groupId, input.itemId, -input.quantity, actor, {
      notes: input.notes,
      relatedSessionId: input.relatedSessionId,
    });
  }

  async waste(
    input: WasteInventoryDto,
    actor: ResolvedActor,
  ): Promise<InventoryTransactionResponseDto> {
    await this.assertCanManage(actor);
    return this.movement('WASTE', input.groupId, input.itemId, -input.quantity, actor, {
      notes: input.notes,
    });
  }

  /**
   * Stocktake reconciles to an absolute count. Computes the delta
   * vs the current level and writes a STOCKTAKE transaction with
   * the signed delta in quantity_delta. The level UPDATE sets the
   * absolute count + stamps last_counted_at.
   */
  async stocktake(
    input: StocktakeInventoryDto,
    actor: ResolvedActor,
  ): Promise<InventoryTransactionResponseDto> {
    await this.assertCanManage(actor);
    const tenant = getCurrentTenant();
    let txnDto: InventoryTransactionResponseDto | null = null;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      let crossedBelow = false;
      let reorderThreshold: number | null = null;
      let priorQty = 0;
      let newQty = 0;
      let itemNameForEvent = '';

      // REVIEW-P2-10a ROUND 1 BLOCKING 2 — existing-level lock JOINs
      // both fds_inventory_groups + fds_inventory_items and requires
      // both rows' school_id = $tenant.schoolId. A School A actor
      // providing a (groupId, itemId) pair that exists in School B
      // can no longer lock and update the foreign-school level row.
      const locked = (await tx.$queryRawUnsafe(
        'SELECT l.id::text AS id, l.quantity_on_hand AS quantity_on_hand, i.reorder_threshold AS reorder_threshold, i.name AS item_name, i.school_id::text AS school_id ' +
          'FROM fds_inventory_levels l ' +
          'JOIN fds_inventory_groups g ON g.id = l.group_id ' +
          'JOIN fds_inventory_items i ON i.id = l.item_id ' +
          'WHERE l.group_id = $1::uuid AND l.item_id = $2::uuid ' +
          'AND g.school_id = $3::uuid AND i.school_id = $3::uuid FOR UPDATE OF l',
        input.groupId,
        input.itemId,
        tenant.schoolId,
      )) as Array<{
        id: string;
        quantity_on_hand: number;
        reorder_threshold: number | null;
        item_name: string;
        school_id: string;
      }>;
      let levelId: string;
      if (locked.length === 0) {
        // Verify the item + group belong to this tenant before creating.
        const item = (await tx.$queryRawUnsafe(
          'SELECT i.name, i.reorder_threshold ' +
            'FROM fds_inventory_items i ' +
            'JOIN fds_inventory_groups g ON g.school_id = i.school_id ' +
            'WHERE i.id = $1::uuid AND g.id = $2::uuid AND i.school_id = $3::uuid',
          input.itemId,
          input.groupId,
          tenant.schoolId,
        )) as Array<{ name: string; reorder_threshold: number | null }>;
        if (item.length === 0)
          throw new NotFoundException('Inventory item or group not found for this school');
        levelId = generateId();
        await tx.$executeRawUnsafe(
          'INSERT INTO fds_inventory_levels (id, group_id, item_id, quantity_on_hand) VALUES ($1::uuid, $2::uuid, $3::uuid, 0)',
          levelId,
          input.groupId,
          input.itemId,
        );
        priorQty = 0;
        reorderThreshold =
          item[0]!.reorder_threshold === null ? null : numFromDecimal(item[0]!.reorder_threshold);
        itemNameForEvent = item[0]!.name;
      } else {
        levelId = locked[0]!.id;
        priorQty = numFromDecimal(locked[0]!.quantity_on_hand);
        reorderThreshold =
          locked[0]!.reorder_threshold === null
            ? null
            : numFromDecimal(locked[0]!.reorder_threshold);
        itemNameForEvent = locked[0]!.item_name;
      }

      const counted = numFromDecimal(input.countedQuantity);
      const delta = Math.round((counted - priorQty) * 1000) / 1000;
      newQty = counted;
      await tx.$executeRawUnsafe(
        'UPDATE fds_inventory_levels SET quantity_on_hand = $1, last_counted_at = now(), updated_at = now() WHERE id = $2::uuid',
        counted,
        levelId,
      );

      const txnId = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO fds_inventory_transactions (id, school_id, group_id, item_id, transaction_type, quantity_delta, performed_by, transaction_at, notes) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'STOCKTAKE', $5, $6::uuid, now(), $7)",
        txnId,
        tenant.schoolId,
        input.groupId,
        input.itemId,
        delta,
        actor.accountId,
        input.notes ?? null,
      );
      txnDto = await this.loadTransactionInTx(tx, txnId);

      crossedBelow =
        reorderThreshold !== null && priorQty > reorderThreshold && newQty <= reorderThreshold;

      // REVIEW-P2-10a ROUND 1 BLOCKING 3 — durable outbox emit
      // INSIDE the tx that bumped the level + wrote the immutable
      // transaction. If the broker is down the outbox row commits
      // with the parent tx and the OutboxPublisherWorker publishes
      // when the broker comes back. Deterministic event_id keys on
      // the transaction id so retries dedup cleanly downstream.
      if (crossedBelow) {
        await this.outbox.enqueueInTx(tx as unknown as OutboxTxClient, {
          topic: 'fds.inventory.low',
          key: input.itemId,
          sourceModule: 'food-service',
          eventId: deterministicInventoryLowEventId(txnId),
          payload: {
            schoolId: tenant.schoolId,
            groupId: input.groupId,
            itemId: input.itemId,
            itemName: itemNameForEvent,
            previousQuantity: priorQty,
            newQuantity: newQty,
            reorderThreshold: reorderThreshold!,
            transactionId: txnId,
          },
        });
      }
    });

    // REVIEW-P2-10a ROUND 1 BLOCKING 3 — emit is enqueued in the
    // tx above via OutboxService.enqueueInTx, not via a post-tx
    // best-effort call.
    if (!txnDto) {
      throw new Error('Stocktake transaction failed to materialise');
    }
    return txnDto;
  }

  // ─── Internal: shared movement primitive ──────────────────────────

  /**
   * Locks the level row, applies a signed quantity_delta, inserts
   * the immutable transaction, and (if the new quantity crosses
   * downward through reorder_threshold) emits fds.inventory.low.
   */
  private async movement(
    type: 'RECEIPT' | 'USAGE' | 'WASTE',
    groupId: string,
    itemId: string,
    signedQuantityDelta: number,
    actor: ResolvedActor,
    opts: { notes?: string; relatedSessionId?: string } = {},
  ): Promise<InventoryTransactionResponseDto> {
    if (Math.abs(signedQuantityDelta) < 0.000001) {
      throw new BadRequestException('quantity must be > 0');
    }
    const tenant = getCurrentTenant();
    let txnDto: InventoryTransactionResponseDto | null = null;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      let crossedBelow = false;
      let reorderThreshold: number | null = null;
      let priorQty = 0;
      let newQty = 0;
      let itemNameForEvent = '';

      // REVIEW-P2-10a ROUND 1 BLOCKING 2 — existing-level lock JOINs
      // both fds_inventory_groups + fds_inventory_items and requires
      // both rows' school_id = $tenant.schoolId. Mirror of the
      // stocktake fix.
      const locked = (await tx.$queryRawUnsafe(
        'SELECT l.id::text AS id, l.quantity_on_hand AS quantity_on_hand, i.reorder_threshold AS reorder_threshold, i.name AS item_name, i.school_id::text AS school_id ' +
          'FROM fds_inventory_levels l ' +
          'JOIN fds_inventory_groups g ON g.id = l.group_id ' +
          'JOIN fds_inventory_items i ON i.id = l.item_id ' +
          'WHERE l.group_id = $1::uuid AND l.item_id = $2::uuid ' +
          'AND g.school_id = $3::uuid AND i.school_id = $3::uuid FOR UPDATE OF l',
        groupId,
        itemId,
        tenant.schoolId,
      )) as Array<{
        id: string;
        quantity_on_hand: number;
        reorder_threshold: number | null;
        item_name: string;
        school_id: string;
      }>;
      let levelId: string;
      if (locked.length === 0) {
        const item = (await tx.$queryRawUnsafe(
          'SELECT i.name, i.reorder_threshold, i.school_id::text AS school_id ' +
            'FROM fds_inventory_items i JOIN fds_inventory_groups g ON g.school_id = i.school_id ' +
            'WHERE i.id = $1::uuid AND g.id = $2::uuid AND i.school_id = $3::uuid',
          itemId,
          groupId,
          tenant.schoolId,
        )) as Array<{ name: string; reorder_threshold: number | null; school_id: string }>;
        if (item.length === 0) {
          throw new NotFoundException('Inventory item or group not found for this school');
        }
        levelId = generateId();
        await tx.$executeRawUnsafe(
          'INSERT INTO fds_inventory_levels (id, group_id, item_id, quantity_on_hand) VALUES ($1::uuid, $2::uuid, $3::uuid, 0)',
          levelId,
          groupId,
          itemId,
        );
        priorQty = 0;
        reorderThreshold =
          item[0]!.reorder_threshold === null ? null : numFromDecimal(item[0]!.reorder_threshold);
        itemNameForEvent = item[0]!.name;
      } else {
        levelId = locked[0]!.id;
        priorQty = numFromDecimal(locked[0]!.quantity_on_hand);
        reorderThreshold =
          locked[0]!.reorder_threshold === null
            ? null
            : numFromDecimal(locked[0]!.reorder_threshold);
        itemNameForEvent = locked[0]!.item_name;
      }

      newQty = Math.round((priorQty + signedQuantityDelta) * 1000) / 1000;
      if (newQty < 0) {
        throw new BadRequestException(
          'Cannot draw down below 0. Current on-hand is ' +
            priorQty.toString() +
            ' and the requested draw is ' +
            Math.abs(signedQuantityDelta).toString() +
            '.',
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE fds_inventory_levels SET quantity_on_hand = $1, updated_at = now() WHERE id = $2::uuid',
        newQty,
        levelId,
      );

      const txnId = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO fds_inventory_transactions (id, school_id, group_id, item_id, transaction_type, quantity_delta, performed_by, transaction_at, related_session_id, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::uuid, now(), $8::uuid, $9)',
        txnId,
        tenant.schoolId,
        groupId,
        itemId,
        type,
        signedQuantityDelta,
        actor.accountId,
        opts.relatedSessionId ?? null,
        opts.notes ?? null,
      );
      txnDto = await this.loadTransactionInTx(tx, txnId);

      crossedBelow =
        reorderThreshold !== null && priorQty > reorderThreshold && newQty <= reorderThreshold;

      // REVIEW-P2-10a ROUND 1 BLOCKING 3 — durable outbox emit INSIDE
      // the same tx that bumped the level + wrote the immutable
      // transaction. Deterministic event_id keys on the transaction
      // id so retries dedup cleanly downstream.
      if (crossedBelow) {
        await this.outbox.enqueueInTx(tx as unknown as OutboxTxClient, {
          topic: 'fds.inventory.low',
          key: itemId,
          sourceModule: 'food-service',
          eventId: deterministicInventoryLowEventId(txnId),
          payload: {
            schoolId: tenant.schoolId,
            groupId,
            itemId,
            itemName: itemNameForEvent,
            previousQuantity: priorQty,
            newQuantity: newQty,
            reorderThreshold: reorderThreshold!,
            transactionId: txnId,
          },
        });
      }
    });

    if (!txnDto) {
      throw new Error('Inventory transaction failed to materialise');
    }
    return txnDto;
  }

  private async loadTransactionInTx(
    tx: { $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown> },
    id: string,
  ): Promise<InventoryTransactionResponseDto> {
    const rows = (await tx.$queryRawUnsafe(
      'SELECT id::text AS id, group_id::text AS group_id, item_id::text AS item_id, transaction_type, quantity_delta, performed_by::text AS performed_by, transaction_at, transfer_reference_id::text AS transfer_reference_id, related_session_id::text AS related_session_id, notes ' +
        'FROM fds_inventory_transactions WHERE id = $1::uuid LIMIT 1',
      id,
    )) as Array<{
      id: string;
      group_id: string;
      item_id: string;
      transaction_type: string;
      quantity_delta: number;
      performed_by: string;
      transaction_at: Date;
      transfer_reference_id: string | null;
      related_session_id: string | null;
      notes: string | null;
    }>;
    if (rows.length === 0) throw new Error('Transaction row not visible after insert');
    const r = rows[0]!;
    return {
      id: r.id,
      groupId: r.group_id,
      itemId: r.item_id,
      transactionType: r.transaction_type as InventoryTransactionResponseDto['transactionType'],
      quantityDelta: numFromDecimal(r.quantity_delta),
      performedBy: r.performed_by,
      transactionAt: r.transaction_at.toISOString(),
      transferReferenceId: r.transfer_reference_id,
      relatedSessionId: r.related_session_id,
      notes: r.notes,
    };
  }

  // REVIEW-P2-10a ROUND 1 BLOCKING 3 — the legacy `emitInventoryLow`
  // helper that used best-effort `KafkaProducerService.emit` after the
  // tenant tx committed has been removed. `fds.inventory.low` is now
  // enqueued via `OutboxService.enqueueInTx` INSIDE the same tx that
  // updated the level row + wrote the immutable transaction, so a
  // broker outage no longer drops the notification request after the
  // stock state has been committed.

  /**
   * List transactions for an item or group with pagination cursor.
   * Read-only — IMMUTABLE log per the schema contract.
   */
  async listTransactions(args: {
    groupId?: string;
    itemId?: string;
    limit?: number;
  }): Promise<InventoryTransactionResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.groupId) {
      where.push('group_id = $' + (params.length + 1) + '::uuid');
      params.push(args.groupId);
    }
    if (args.itemId) {
      where.push('item_id = $' + (params.length + 1) + '::uuid');
      params.push(args.itemId);
    }
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, group_id::text AS group_id, item_id::text AS item_id, transaction_type, quantity_delta, performed_by::text AS performed_by, transaction_at, transfer_reference_id::text AS transfer_reference_id, related_session_id::text AS related_session_id, notes ' +
          'FROM fds_inventory_transactions WHERE ' +
          where.join(' AND ') +
          ' ORDER BY transaction_at DESC LIMIT ' +
          limit.toString(),
        ...params,
      );
    })) as Array<{
      id: string;
      group_id: string;
      item_id: string;
      transaction_type: string;
      quantity_delta: number;
      performed_by: string;
      transaction_at: Date;
      transfer_reference_id: string | null;
      related_session_id: string | null;
      notes: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      groupId: r.group_id,
      itemId: r.item_id,
      transactionType: r.transaction_type as InventoryTransactionResponseDto['transactionType'],
      quantityDelta: numFromDecimal(r.quantity_delta),
      performedBy: r.performed_by,
      transactionAt: r.transaction_at.toISOString(),
      transferReferenceId: r.transfer_reference_id,
      relatedSessionId: r.related_session_id,
      notes: r.notes,
    }));
  }
}

// ─── row → DTO helpers ──────────────────────────────────────────────────

interface InventoryGroupRow {
  id: string;
  school_id: string;
  name: string;
  group_type: string;
  location: string | null;
  is_active: boolean;
  managed_by: string | null;
}

interface InventoryItemRow {
  id: string;
  school_id: string;
  name: string;
  unit: string;
  category: string;
  allergen_codes: string[];
  reorder_threshold: number | null;
  preferred_vendor_id: string | null;
  unit_cost: number | null;
}

interface InventoryLevelRow {
  id: string | null;
  group_id: string;
  item_id: string;
  item_name: string;
  unit: string;
  category: string;
  quantity_on_hand: number;
  reorder_threshold: number | null;
  last_counted_at: Date | null;
}

function groupRowToDto(r: InventoryGroupRow): InventoryGroupResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    groupType: r.group_type as InventoryGroupResponseDto['groupType'],
    location: r.location,
    isActive: r.is_active,
    managedBy: r.managed_by,
  };
}

function itemRowToDto(r: InventoryItemRow): InventoryItemResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    unit: r.unit,
    category: r.category as InventoryItemResponseDto['category'],
    allergenCodes: r.allergen_codes ?? [],
    reorderThreshold: r.reorder_threshold === null ? null : numFromDecimal(r.reorder_threshold),
    preferredVendorId: r.preferred_vendor_id,
    unitCost: r.unit_cost === null ? null : numFromDecimal(r.unit_cost),
  };
}

function levelRowToDto(r: InventoryLevelRow): InventoryLevelResponseDto {
  const onHand = numFromDecimal(r.quantity_on_hand);
  const threshold = r.reorder_threshold === null ? null : numFromDecimal(r.reorder_threshold);
  return {
    id: r.id ?? '',
    groupId: r.group_id,
    itemId: r.item_id,
    itemName: r.item_name,
    unit: r.unit,
    category: r.category as InventoryLevelResponseDto['category'],
    quantityOnHand: onHand,
    reorderThreshold: threshold,
    belowReorderThreshold: threshold !== null && onHand <= threshold,
    lastCountedAt: r.last_counted_at ? r.last_counted_at.toISOString() : null,
  };
}

function numFromDecimal(v: number | string): number {
  if (typeof v === 'number') return v;
  return Number(v);
}
