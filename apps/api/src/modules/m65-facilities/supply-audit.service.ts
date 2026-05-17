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
import { assertCanManage } from './buildings.service';
import {
  CompleteStocktakeResponseDto,
  CreateStocktakeDto,
  CreateSupplyTransactionDto,
  RecordStocktakeItemDto,
  StocktakeItemResponseDto,
  StocktakeResponseDto,
  StocktakeStatus,
  SupplyTransactionResponseDto,
  SupplyTransactionType,
} from './dto/facilities.dto';

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (e.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('23505');
}

/**
 * SupplyAuditService — P2-18a Step 2.
 *
 * Three surfaces:
 *
 *   1. Append-only supply transaction log
 *      (fac_supply_transactions). Every RECEIPT / USAGE / ADJUSTMENT /
 *      TRANSFER / WRITE_OFF applies the signed quantity_delta to
 *      fac_supply_inventory.current_quantity atomically inside one
 *      tenant tx so the rolling balance and the audit log stay
 *      consistent. The schema fac_supply_qty_chk (>= 0) catches any
 *      USAGE / TRANSFER / WRITE_OFF that would push the inventory
 *      negative and rolls back.
 *
 *   2. Stocktake lifecycle (IN_PROGRESS -> COMPLETED). createStocktake
 *      opens the audit header in IN_PROGRESS. recordItem upserts one
 *      fac_supply_stocktake_items row per inventory line.
 *
 *   3. completeStocktake — THE KEYSTONE. Inside one tenant tx the
 *      service flips status to COMPLETED, walks every stocktake_item,
 *      and for each row where actual_quantity differs from
 *      expected_quantity creates an ADJUSTMENT fac_supply_transactions
 *      row with the signed delta AND updates
 *      fac_supply_inventory.current_quantity to the actual figure. The
 *      reference_id on the adjustment points back at the stocktake so
 *      the audit log threads cleanly. Returns the adjustment count for
 *      the UI toast.
 */
@Injectable()
export class SupplyAuditService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  // ── Transactions ──

  async listTransactions(args: {
    inventoryId?: string;
    buildingId?: string;
    transactionType?: SupplyTransactionType;
    fromDate?: string;
    toDate?: string;
  }): Promise<SupplyTransactionResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['b.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.inventoryId) {
      where.push('t.inventory_id = $' + (params.length + 1) + '::uuid');
      params.push(args.inventoryId);
    }
    if (args.buildingId) {
      where.push('t.building_id = $' + (params.length + 1) + '::uuid');
      params.push(args.buildingId);
    }
    if (args.transactionType) {
      where.push('t.transaction_type = $' + (params.length + 1));
      params.push(args.transactionType);
    }
    if (args.fromDate) {
      where.push('t.transaction_at >= $' + (params.length + 1) + '::timestamptz');
      params.push(args.fromDate);
    }
    if (args.toDate) {
      where.push('t.transaction_at <= $' + (params.length + 1) + '::timestamptz');
      params.push(args.toDate);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        TX_SELECT + 'WHERE ' + where.join(' AND ') + ' ORDER BY t.transaction_at DESC LIMIT 200',
        ...params,
      );
    })) as TxRow[];
    return rows.map(txRowToDto);
  }

  async createTransaction(
    input: CreateSupplyTransactionDto,
    actor: ResolvedActor,
  ): Promise<SupplyTransactionResponseDto> {
    await assertCanManage(actor, this.permCheck);
    if (!actor.personId) {
      throw new ForbiddenException('Supply transaction recording requires an authenticated person');
    }
    if (input.quantityDelta === 0) {
      throw new BadRequestException('quantityDelta cannot be 0');
    }

    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock + verify inventory belongs to the building belongs to this
      // school. Apply the signed delta to inventory + write the audit
      // row in the same tx.
      const inv = (await tx.$queryRawUnsafe(
        'SELECT i.id::text AS id, i.current_quantity::float AS current_quantity ' +
          'FROM fac_supply_inventory i ' +
          'JOIN fac_buildings b ON b.id = i.building_id ' +
          'WHERE i.id = $1::uuid AND b.school_id = $2::uuid AND i.building_id = $3::uuid ' +
          'FOR UPDATE OF i',
        input.inventoryId,
        getCurrentTenant().schoolId,
        input.buildingId,
      )) as Array<{ id: string; current_quantity: number }>;
      if (inv.length === 0) {
        throw new BadRequestException(
          'inventoryId does not match an inventory row in this building',
        );
      }

      await tx.$executeRawUnsafe(
        'UPDATE fac_supply_inventory SET current_quantity = current_quantity + $1, updated_at = now() ' +
          'WHERE id = $2::uuid',
        input.quantityDelta,
        input.inventoryId,
      );

      await tx.$executeRawUnsafe(
        'INSERT INTO fac_supply_transactions ' +
          '(id, building_id, inventory_id, transaction_type, quantity_delta, performed_by, reference_id, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7::uuid, $8)',
        id,
        input.buildingId,
        input.inventoryId,
        input.transactionType,
        input.quantityDelta,
        actor.personId,
        input.referenceId ?? null,
        input.notes ?? null,
      );
    });

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(TX_SELECT + 'WHERE t.id = $1::uuid LIMIT 1', id);
    })) as TxRow[];
    if (rows.length === 0) throw new NotFoundException('Transaction not found after insert');
    return txRowToDto(rows[0]!);
  }

  // ── Stocktakes ──

  async listStocktakes(args: {
    buildingId?: string;
    status?: StocktakeStatus;
  }): Promise<StocktakeResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['s.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.buildingId) {
      where.push('s.building_id = $' + (params.length + 1) + '::uuid');
      params.push(args.buildingId);
    }
    if (args.status) {
      where.push('s.status = $' + (params.length + 1));
      params.push(args.status);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        STOCKTAKE_SELECT +
          'WHERE ' +
          where.join(' AND ') +
          ' ORDER BY s.stocktake_date DESC LIMIT 100',
        ...params,
      );
    })) as StocktakeRow[];
    const out: StocktakeResponseDto[] = [];
    for (const r of rows) {
      const items = await this.listItems(r.id);
      out.push(stocktakeRowToDto(r, items));
    }
    return out;
  }

  async getStocktakeById(id: string): Promise<StocktakeResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(STOCKTAKE_SELECT + 'WHERE s.id = $1::uuid LIMIT 1', id);
    })) as StocktakeRow[];
    if (rows.length === 0) throw new NotFoundException('Stocktake not found');
    const items = await this.listItems(id);
    return stocktakeRowToDto(rows[0]!, items);
  }

  async createStocktake(
    input: CreateStocktakeDto,
    actor: ResolvedActor,
  ): Promise<StocktakeResponseDto> {
    await assertCanManage(actor, this.permCheck);
    if (!actor.personId) {
      throw new ForbiddenException('Stocktake creation requires an authenticated person');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      // Validate the building belongs to this school.
      const bldg = (await client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM fac_buildings WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        input.buildingId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      if (bldg.length === 0) {
        throw new BadRequestException('buildingId does not match a building in this school');
      }
      await client.$executeRawUnsafe(
        'INSERT INTO fac_supply_stocktakes (id, school_id, building_id, conducted_by, stocktake_date, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6)',
        id,
        tenant.schoolId,
        input.buildingId,
        actor.personId,
        input.stocktakeDate ?? todayIso(),
        input.notes ?? null,
      );
    });
    return this.getStocktakeById(id);
  }

  async recordItem(
    stocktakeId: string,
    input: RecordStocktakeItemDto,
    actor: ResolvedActor,
  ): Promise<StocktakeItemResponseDto> {
    await assertCanManage(actor, this.permCheck);
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        // Validate parent stocktake exists + is IN_PROGRESS.
        const stk = (await client.$queryRawUnsafe(
          'SELECT status FROM fac_supply_stocktakes WHERE id = $1::uuid LIMIT 1',
          stocktakeId,
        )) as Array<{ status: string }>;
        if (stk.length === 0) throw new NotFoundException('Stocktake not found');
        if (stk[0]!.status !== 'IN_PROGRESS') {
          throw new BadRequestException(
            'Cannot record items on a stocktake in status ' + stk[0]!.status,
          );
        }

        // UPSERT — recording the same inventory twice updates the actual.
        await client.$executeRawUnsafe(
          'INSERT INTO fac_supply_stocktake_items (id, stocktake_id, inventory_id, expected_quantity, actual_quantity, discrepancy_notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6) ' +
            'ON CONFLICT (stocktake_id, inventory_id) DO UPDATE SET ' +
            'expected_quantity = EXCLUDED.expected_quantity, ' +
            'actual_quantity = EXCLUDED.actual_quantity, ' +
            'discrepancy_notes = EXCLUDED.discrepancy_notes, updated_at = now()',
          id,
          stocktakeId,
          input.inventoryId,
          input.expectedQuantity,
          input.actualQuantity,
          input.discrepancyNotes ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'A stocktake item for this inventory already exists on this stocktake',
        );
      }
      throw err;
    }

    const items = await this.listItems(stocktakeId);
    const found = items.find((it) => it.inventoryId === input.inventoryId);
    if (!found) throw new NotFoundException('Stocktake item not found after upsert');
    return found;
  }

  /**
   * THE ADJUSTMENT KEYSTONE — flip stocktake to COMPLETED inside one
   * tenant tx that also creates an ADJUSTMENT fac_supply_transactions
   * row for every item where actual_quantity differs from
   * expected_quantity AND updates fac_supply_inventory.current_quantity
   * to the actual figure. The reference_id on the adjustment points at
   * the stocktake so the supply transaction log threads back cleanly.
   * Re-running the endpoint on an already-COMPLETED stocktake is
   * refused with 400 so a duplicate completion cannot re-apply
   * adjustments.
   */
  async completeStocktake(
    stocktakeId: string,
    actor: ResolvedActor,
  ): Promise<CompleteStocktakeResponseDto> {
    await assertCanManage(actor, this.permCheck);
    if (!actor.personId) {
      throw new ForbiddenException('Stocktake completion requires an authenticated person');
    }
    let adjustmentsCreated = 0;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock stocktake row + verify status.
      const stkRows = (await tx.$queryRawUnsafe(
        'SELECT id, status, building_id::text AS building_id FROM fac_supply_stocktakes WHERE id = $1::uuid FOR UPDATE',
        stocktakeId,
      )) as Array<{ id: string; status: string; building_id: string }>;
      if (stkRows.length === 0) throw new NotFoundException('Stocktake not found');
      const stk = stkRows[0]!;
      if (stk.status !== 'IN_PROGRESS') {
        throw new BadRequestException(
          'Only IN_PROGRESS stocktakes can be completed — current status is ' + stk.status,
        );
      }

      // Walk every stocktake_item where actual differs from expected.
      const items = (await tx.$queryRawUnsafe(
        'SELECT inventory_id::text AS inventory_id, expected_quantity::float AS expected_quantity, actual_quantity::float AS actual_quantity ' +
          'FROM fac_supply_stocktake_items WHERE stocktake_id = $1::uuid AND expected_quantity <> actual_quantity',
        stocktakeId,
      )) as Array<{ inventory_id: string; expected_quantity: number; actual_quantity: number }>;

      for (const it of items) {
        const delta = it.actual_quantity - it.expected_quantity;
        await tx.$executeRawUnsafe(
          'UPDATE fac_supply_inventory SET current_quantity = $1, updated_at = now() WHERE id = $2::uuid',
          it.actual_quantity,
          it.inventory_id,
        );
        await tx.$executeRawUnsafe(
          'INSERT INTO fac_supply_transactions ' +
            '(id, building_id, inventory_id, transaction_type, quantity_delta, performed_by, reference_id, notes) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, 'ADJUSTMENT', $4, $5::uuid, $6::uuid, $7)",
          generateId(),
          stk.building_id,
          it.inventory_id,
          delta,
          actor.personId,
          stocktakeId,
          'Stocktake adjustment ' + stocktakeId.slice(0, 8) + ' delta ' + delta,
        );
        adjustmentsCreated += 1;
      }

      await tx.$executeRawUnsafe(
        "UPDATE fac_supply_stocktakes SET status = 'COMPLETED', completed_at = now(), updated_at = now() WHERE id = $1::uuid",
        stocktakeId,
      );
    });

    const stocktake = await this.getStocktakeById(stocktakeId);
    return { stocktake, adjustmentsCreated };
  }

  private async listItems(stocktakeId: string): Promise<StocktakeItemResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT it.id::text AS id, it.stocktake_id::text AS stocktake_id, ' +
          'it.inventory_id::text AS inventory_id, ' +
          'it.expected_quantity::float AS expected_quantity, ' +
          'it.actual_quantity::float AS actual_quantity, it.discrepancy_notes, ' +
          '(SELECT inv.item_name FROM fac_supply_inventory inv WHERE inv.id = it.inventory_id) AS item_name ' +
          'FROM fac_supply_stocktake_items it WHERE it.stocktake_id = $1::uuid ORDER BY it.created_at',
        stocktakeId,
      );
    })) as Array<{
      id: string;
      stocktake_id: string;
      inventory_id: string;
      expected_quantity: number;
      actual_quantity: number;
      discrepancy_notes: string | null;
      item_name: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      stocktakeId: r.stocktake_id,
      inventoryId: r.inventory_id,
      itemName: r.item_name,
      expectedQuantity: r.expected_quantity,
      actualQuantity: r.actual_quantity,
      discrepancy: r.actual_quantity - r.expected_quantity,
      discrepancyNotes: r.discrepancy_notes,
    }));
  }
}

const TX_SELECT =
  'SELECT t.id::text AS id, t.building_id::text AS building_id, t.inventory_id::text AS inventory_id, ' +
  '(SELECT inv.item_name FROM fac_supply_inventory inv WHERE inv.id = t.inventory_id) AS item_name, ' +
  't.transaction_type, t.quantity_delta::float AS quantity_delta, t.performed_by::text AS performed_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip WHERE ip.id = t.performed_by) AS performed_by_name, " +
  't.transaction_at, t.reference_id::text AS reference_id, t.notes ' +
  'FROM fac_supply_transactions t ' +
  'JOIN fac_buildings b ON b.id = t.building_id ';

interface TxRow {
  id: string;
  building_id: string;
  inventory_id: string;
  item_name: string | null;
  transaction_type: string;
  quantity_delta: number;
  performed_by: string;
  performed_by_name: string | null;
  transaction_at: Date;
  reference_id: string | null;
  notes: string | null;
}

function txRowToDto(r: TxRow): SupplyTransactionResponseDto {
  return {
    id: r.id,
    buildingId: r.building_id,
    inventoryId: r.inventory_id,
    itemName: r.item_name,
    transactionType: r.transaction_type as SupplyTransactionType,
    quantityDelta: r.quantity_delta,
    performedBy: r.performed_by,
    performedByName: r.performed_by_name,
    transactionAt: r.transaction_at.toISOString(),
    referenceId: r.reference_id,
    notes: r.notes,
  };
}

const STOCKTAKE_SELECT =
  'SELECT s.id::text AS id, s.school_id::text AS school_id, s.building_id::text AS building_id, ' +
  '(SELECT b.name FROM fac_buildings b WHERE b.id = s.building_id) AS building_name, ' +
  's.conducted_by::text AS conducted_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip WHERE ip.id = s.conducted_by) AS conducted_by_name, " +
  's.stocktake_date::text AS stocktake_date, s.status, s.completed_at, s.notes ' +
  'FROM fac_supply_stocktakes s ';

interface StocktakeRow {
  id: string;
  school_id: string;
  building_id: string;
  building_name: string | null;
  conducted_by: string;
  conducted_by_name: string | null;
  stocktake_date: string;
  status: string;
  completed_at: Date | null;
  notes: string | null;
}

function stocktakeRowToDto(
  r: StocktakeRow,
  items: StocktakeItemResponseDto[],
): StocktakeResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    buildingId: r.building_id,
    buildingName: r.building_name,
    conductedBy: r.conducted_by,
    conductedByName: r.conducted_by_name,
    stocktakeDate: r.stocktake_date,
    status: r.status as StocktakeStatus,
    completedAt: r.completed_at ? r.completed_at.toISOString() : null,
    notes: r.notes,
    items,
  };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
