import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import { OutboxService, OutboxTxClient } from '@shared/kafka';
import { PermissionCheckService } from '@modules/m00-platform';
import type { ResolvedActor } from '@modules/m00-platform';
import {
  CreatePartDto,
  PartResponseDto,
  RestockPartDto,
  UpdatePartDto,
} from './dto/fleet-maintenance.dto';

interface PartRow {
  id: string;
  school_id: string;
  part_name: string;
  part_number: string | null;
  quantity_on_hand: number;
  min_stock_level: number;
  unit_cost: string | null;
  supplier: string | null;
  last_restocked_at: Date | null;
}

const SELECT_PART_BASE =
  'SELECT id::text AS id, school_id::text AS school_id, part_name, part_number, ' +
  'quantity_on_hand, min_stock_level, unit_cost::text AS unit_cost, supplier, last_restocked_at ' +
  'FROM trn_parts_inventory ';

function rowToDto(r: PartRow): PartResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    partName: r.part_name,
    partNumber: r.part_number,
    quantityOnHand: r.quantity_on_hand,
    minStockLevel: r.min_stock_level,
    unitCost: r.unit_cost === null ? null : Number(r.unit_cost),
    supplier: r.supplier,
    lastRestockedAt: r.last_restocked_at ? r.last_restocked_at.toISOString().slice(0, 10) : null,
    belowThreshold: r.quantity_on_hand <= r.min_stock_level,
  };
}

/**
 * REVIEW-P2C11 ROUND 1 BLOCKING 3 — deterministic event id for the
 * trn.parts.low outbox row. Keys on partId + an opaque crossedAt token
 * (the timestamp the threshold crossing landed) so retries from the
 * outbox publisher dedup cleanly downstream. Same shape as
 * deterministicCreditNoteEventId / deterministicInventoryLowEventId.
 */
export function deterministicPartsLowEventId(partId: string, crossedAt: string): string {
  const hash = createHash('sha256')
    .update(partId + ':' + crossedAt + ':trn.parts.low:v1')
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

@Injectable()
export class PartsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  // REVIEW-P2C11 ROUND 1 BLOCKING 6 — explicit TRN-002:write check.
  private async assertCanManageFleet(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'trn-002:write',
      'trn-002:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Only school admins or transportation staff with trn-002:write can manage parts inventory',
      );
    }
  }

  async list(args: { lowStockOnly?: boolean }): Promise<PartResponseDto[]> {
    const tenant = getCurrentTenant();
    const where = args.lowStockOnly
      ? 'WHERE school_id = $1::uuid AND quantity_on_hand <= min_stock_level'
      : 'WHERE school_id = $1::uuid';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_PART_BASE + where + ' ORDER BY part_name ASC LIMIT 500',
        tenant.schoolId,
      );
    })) as PartRow[];
    return rows.map(rowToDto);
  }

  async getById(partId: string): Promise<PartResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_PART_BASE + 'WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        partId,
      );
    })) as PartRow[];
    if (rows.length === 0) throw new NotFoundException('Part not found');
    return rowToDto(rows[0]!);
  }

  async create(input: CreatePartDto, actor: ResolvedActor): Promise<PartResponseDto> {
    await this.assertCanManageFleet(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    const qty = input.quantityOnHand ?? 0;
    const min = input.minStockLevel ?? 0;
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO trn_parts_inventory (id, school_id, part_name, part_number, quantity_on_hand, min_stock_level, unit_cost, supplier) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)',
          id,
          tenant.schoolId,
          input.partName,
          input.partNumber ?? null,
          qty,
          min,
          input.unitCost ?? null,
          input.supplier ?? null,
        );
      });
    } catch (err: unknown) {
      const e = err as { code?: string; meta?: { code?: string }; message?: string };
      if (
        e.code === '23505' ||
        e.meta?.code === '23505' ||
        (typeof e.message === 'string' && e.message.includes('23505'))
      ) {
        throw new BadRequestException('A part with this name already exists for this school');
      }
      throw err;
    }
    return this.getById(id);
  }

  async patch(
    partId: string,
    input: UpdatePartDto,
    actor: ResolvedActor,
  ): Promise<PartResponseDto> {
    await this.assertCanManageFleet(actor);
    const tenant = getCurrentTenant();
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.partName !== undefined) {
      sets.push('part_name = $' + (params.length + 1));
      params.push(input.partName);
    }
    if (input.partNumber !== undefined) {
      sets.push('part_number = $' + (params.length + 1));
      params.push(input.partNumber);
    }
    if (input.minStockLevel !== undefined) {
      sets.push('min_stock_level = $' + (params.length + 1));
      params.push(input.minStockLevel);
    }
    if (input.unitCost !== undefined) {
      sets.push('unit_cost = $' + (params.length + 1));
      params.push(input.unitCost);
    }
    if (input.supplier !== undefined) {
      sets.push('supplier = $' + (params.length + 1));
      params.push(input.supplier);
    }
    if (sets.length === 0) return this.getById(partId);
    sets.push('updated_at = now()');
    params.push(tenant.schoolId);
    params.push(partId);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE trn_parts_inventory SET ' +
          sets.join(', ') +
          ' WHERE school_id = $' +
          (params.length - 1) +
          '::uuid AND id = $' +
          params.length +
          '::uuid',
        ...params,
      );
    });
    return this.getById(partId);
  }

  /**
   * Restock or consume parts. Positive `quantityDelta` adds stock; the
   * caller may use the consume path by passing a negative delta — that
   * is restricted to the consume endpoint and gated separately.
   *
   * REVIEW-P2C11 ROUND 1 BLOCKING 3 — the trn.parts.low emit now goes
   * through OutboxService.enqueueInTx inside the same transaction as
   * the quantity UPDATE. Deterministic event_id keyed on
   * (partId + crossedAt). The OutboxPublisherWorker handles the actual
   * Kafka publish + retry; a Kafka outage no longer drops the alert.
   */
  async restock(
    partId: string,
    input: RestockPartDto,
    actor: ResolvedActor,
  ): Promise<PartResponseDto> {
    await this.assertCanManageFleet(actor);
    const tenant = getCurrentTenant();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT quantity_on_hand, min_stock_level, part_name, part_number FROM trn_parts_inventory WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        partId,
      )) as Array<{
        quantity_on_hand: number;
        min_stock_level: number;
        part_name: string;
        part_number: string | null;
      }>;
      if (rows.length === 0) throw new NotFoundException('Part not found');
      const priorQty = rows[0]!.quantity_on_hand;
      const newMin = rows[0]!.min_stock_level;
      const newQty = priorQty + input.quantityDelta;
      if (newQty < 0) {
        throw new BadRequestException('Restock would drive quantity below zero');
      }
      const sets: string[] = ['quantity_on_hand = $1'];
      const params: unknown[] = [newQty];
      if (input.unitCost !== undefined) {
        sets.push('unit_cost = $' + (params.length + 1));
        params.push(input.unitCost);
      }
      if (input.supplier !== undefined) {
        sets.push('supplier = $' + (params.length + 1));
        params.push(input.supplier);
      }
      if (input.quantityDelta > 0) {
        sets.push('last_restocked_at = CURRENT_DATE');
      }
      sets.push('updated_at = now()');
      params.push(tenant.schoolId);
      params.push(partId);
      await tx.$executeRawUnsafe(
        'UPDATE trn_parts_inventory SET ' +
          sets.join(', ') +
          ' WHERE school_id = $' +
          (params.length - 1) +
          '::uuid AND id = $' +
          params.length +
          '::uuid',
        ...params,
      );

      // Threshold crossing: prior strictly above, now at or below.
      if (priorQty > newMin && newQty <= newMin) {
        const crossedAt = new Date().toISOString();
        await this.outbox.enqueueInTx(tx as unknown as OutboxTxClient, {
          topic: 'trn.parts.low',
          key: partId,
          sourceModule: 'transport',
          eventId: deterministicPartsLowEventId(partId, crossedAt),
          payload: {
            partId,
            schoolId: tenant.schoolId,
            partName: rows[0]!.part_name,
            partNumber: rows[0]!.part_number,
            quantityOnHand: newQty,
            minStockLevel: newMin,
            actorAccountId: actor.accountId,
            crossedAt,
          },
        });
      }
    });

    return this.getById(partId);
  }
}
