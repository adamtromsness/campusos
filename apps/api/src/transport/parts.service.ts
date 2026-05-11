import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
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

@Injectable()
export class PartsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  private assertCanManage(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STAFF') return;
    throw new ForbiddenException(
      'Only school admins or transportation staff can manage parts inventory',
    );
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
    this.assertCanManage(actor);
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
    this.assertCanManage(actor);
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
   * is restricted to the consume endpoint and gated separately. After
   * the update, if the new on-hand quantity is at or below
   * min_stock_level AND a threshold crossing happened (prior was above,
   * now at or below), we emit trn.parts.low so the TC dashboard can
   * raise the alert.
   */
  async restock(
    partId: string,
    input: RestockPartDto,
    actor: ResolvedActor,
  ): Promise<PartResponseDto> {
    this.assertCanManage(actor);
    const tenant = getCurrentTenant();
    let crossedBelow = false;
    let priorQty = 0;
    let newQty = 0;
    let newMin = 0;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT quantity_on_hand, min_stock_level FROM trn_parts_inventory WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        partId,
      )) as Array<{ quantity_on_hand: number; min_stock_level: number }>;
      if (rows.length === 0) throw new NotFoundException('Part not found');
      priorQty = rows[0]!.quantity_on_hand;
      newMin = rows[0]!.min_stock_level;
      newQty = priorQty + input.quantityDelta;
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
        crossedBelow = true;
      }
    });

    if (crossedBelow) {
      const dto = await this.getById(partId);
      await this.kafka.emit({
        topic: 'trn.parts.low',
        key: partId,
        sourceModule: 'transport',
        payload: {
          partId,
          schoolId: tenant.schoolId,
          partName: dto.partName,
          partNumber: dto.partNumber,
          quantityOnHand: dto.quantityOnHand,
          minStockLevel: dto.minStockLevel,
          actorAccountId: actor.accountId,
          crossedAt: new Date().toISOString(),
        },
      });
    }

    return this.getById(partId);
  }
}
