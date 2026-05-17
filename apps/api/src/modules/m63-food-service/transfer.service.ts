import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import { PermissionCheckService } from '@modules/m00-platform';
import type { ResolvedActor } from '@modules/m00-platform';
import { assertFsmAdminScope } from './fsm-scope';
import {
  CreateTransferRequestDto,
  TransferDecisionDto,
  TransferRequestResponseDto,
  TransferStatus,
} from './dto/food-service-advanced.dto';

/**
 * TransferService — inter-group inventory transfer workflow.
 *
 * Lifecycle:
 *   PENDING --approve--> APPROVED --complete--> COMPLETED
 *           --reject--> REJECTED
 *           --cancel--> CANCELLED
 *   APPROVED --cancel--> CANCELLED
 *
 * On COMPLETED the service writes paired TRANSFER_OUT + TRANSFER_IN
 * fds_inventory_transactions rows with a single shared
 * transfer_reference_id (a fresh UUID) and stamps that same UUID
 * on the request row. Both rows + the request flip + both level
 * UPDATEs happen inside one locked tenant tx so the audit is
 * atomic. The reviewed_chk schema invariant guarantees the row
 * shape on the wire.
 */
@Injectable()
export class TransferService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  /**
   * REVIEW-P2-10a ROUND 1 BLOCKING 4 — every transfer mutation gates
   * on FDS-006:write (Food Service Administration) instead of the
   * broad `personType === 'STAFF'` check.
   */
  private async assertCanManage(actor: ResolvedActor): Promise<void> {
    await assertFsmAdminScope(this.permCheck, actor, 'manage inventory transfers');
  }

  async list(args: { status?: TransferStatus }): Promise<TransferRequestResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.status) {
      where.push('status = $' + (params.length + 1));
      params.push(args.status);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        TRANSFER_SELECT_SQL + ' WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC',
        ...params,
      );
    })) as TransferRow[];
    return rows.map(transferRowToDto);
  }

  async getById(id: string): Promise<TransferRequestResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        TRANSFER_SELECT_SQL + ' WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as TransferRow[];
    if (rows.length === 0) throw new NotFoundException('Transfer request not found');
    return transferRowToDto(rows[0]!);
  }

  async create(
    input: CreateTransferRequestDto,
    actor: ResolvedActor,
  ): Promise<TransferRequestResponseDto> {
    await this.assertCanManage(actor);
    if (input.fromGroupId === input.toGroupId) {
      throw new BadRequestException('fromGroupId and toGroupId must be different');
    }
    if (input.quantity <= 0) {
      throw new BadRequestException('quantity must be > 0');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      // Verify both groups + item exist in this tenant.
      const groups = (await client.$queryRawUnsafe(
        'SELECT id::text AS id FROM fds_inventory_groups WHERE school_id = $1::uuid AND id = ANY($2::uuid[])',
        tenant.schoolId,
        [input.fromGroupId, input.toGroupId],
      )) as Array<{ id: string }>;
      if (groups.length !== 2) {
        throw new BadRequestException(
          'fromGroupId and toGroupId must reference inventory groups in this school',
        );
      }
      const items = (await client.$queryRawUnsafe(
        'SELECT id::text AS id FROM fds_inventory_items WHERE id = $1::uuid AND school_id = $2::uuid',
        input.itemId,
        tenant.schoolId,
      )) as Array<{ id: string }>;
      if (items.length === 0) {
        throw new BadRequestException('itemId must reference an inventory item in this school');
      }
      await client.$executeRawUnsafe(
        'INSERT INTO fds_inventory_transfer_requests (id, school_id, from_group_id, to_group_id, item_id, quantity, reason, status, requested_by) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, 'PENDING', $8::uuid)",
        id,
        tenant.schoolId,
        input.fromGroupId,
        input.toGroupId,
        input.itemId,
        input.quantity,
        input.reason ?? null,
        actor.accountId,
      );
    });
    return this.getById(id);
  }

  /**
   * Approve or reject a PENDING transfer request. Locks the row,
   * verifies status=PENDING, then flips. The reviewed_chk schema
   * invariant guarantees reviewed_at + reviewed_by are stamped
   * together.
   */
  async decide(
    id: string,
    input: TransferDecisionDto,
    actor: ResolvedActor,
  ): Promise<TransferRequestResponseDto> {
    await this.assertCanManage(actor);
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = (await tx.$queryRawUnsafe(
        'SELECT status FROM fds_inventory_transfer_requests WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        id,
        tenant.schoolId,
      )) as Array<{ status: string }>;
      if (locked.length === 0) throw new NotFoundException('Transfer request not found');
      if (locked[0]!.status !== 'PENDING') {
        throw new BadRequestException(
          'Transfer is in status ' +
            locked[0]!.status +
            '; only PENDING requests can be approved or rejected',
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE fds_inventory_transfer_requests SET status = $1, reviewed_by = $2::uuid, reviewed_at = now(), reason = COALESCE($3, reason), updated_at = now() WHERE id = $4::uuid',
        input.status,
        actor.accountId,
        input.reason ?? null,
        id,
      );
    });
    return this.getById(id);
  }

  /**
   * Complete an APPROVED transfer. The keystone — writes paired
   * TRANSFER_OUT + TRANSFER_IN rows with shared transfer_reference_id,
   * applies signed deltas to both level rows, and flips request to
   * COMPLETED + stamps completed_at + transfer_reference_id. All
   * inside one locked tenant tx.
   */
  async complete(id: string, actor: ResolvedActor): Promise<TransferRequestResponseDto> {
    await this.assertCanManage(actor);
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = (await tx.$queryRawUnsafe(
        'SELECT status, from_group_id::text AS from_group_id, to_group_id::text AS to_group_id, item_id::text AS item_id, quantity ' +
          'FROM fds_inventory_transfer_requests WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        id,
        tenant.schoolId,
      )) as Array<{
        status: string;
        from_group_id: string;
        to_group_id: string;
        item_id: string;
        quantity: number;
      }>;
      if (locked.length === 0) throw new NotFoundException('Transfer request not found');
      if (locked[0]!.status !== 'APPROVED') {
        throw new BadRequestException(
          'Transfer is in status ' +
            locked[0]!.status +
            '; only APPROVED requests can be completed',
        );
      }
      const req = locked[0]!;
      const qty = numFromDecimal(req.quantity);
      const transferRef = generateId();

      // Lock both level rows in deterministic (from, to) order so two
      // concurrent completions on overlapping items cannot deadlock.
      const fromLevel = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, quantity_on_hand FROM fds_inventory_levels WHERE group_id = $1::uuid AND item_id = $2::uuid FOR UPDATE',
        req.from_group_id,
        req.item_id,
      )) as Array<{ id: string; quantity_on_hand: number }>;
      if (fromLevel.length === 0) {
        throw new BadRequestException(
          'Source group has no stock record for this item; cannot transfer.',
        );
      }
      const priorFrom = numFromDecimal(fromLevel[0]!.quantity_on_hand);
      if (priorFrom < qty) {
        throw new BadRequestException(
          'Source group has insufficient stock: ' +
            priorFrom.toString() +
            ' on hand, ' +
            qty.toString() +
            ' requested.',
        );
      }
      const newFrom = Math.round((priorFrom - qty) * 1000) / 1000;
      await tx.$executeRawUnsafe(
        'UPDATE fds_inventory_levels SET quantity_on_hand = $1, updated_at = now() WHERE id = $2::uuid',
        newFrom,
        fromLevel[0]!.id,
      );

      // Upsert the destination level row.
      const toLevel = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, quantity_on_hand FROM fds_inventory_levels WHERE group_id = $1::uuid AND item_id = $2::uuid FOR UPDATE',
        req.to_group_id,
        req.item_id,
      )) as Array<{ id: string; quantity_on_hand: number }>;
      let priorTo = 0;
      if (toLevel.length === 0) {
        await tx.$executeRawUnsafe(
          'INSERT INTO fds_inventory_levels (id, group_id, item_id, quantity_on_hand) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)',
          generateId(),
          req.to_group_id,
          req.item_id,
          qty,
        );
      } else {
        priorTo = numFromDecimal(toLevel[0]!.quantity_on_hand);
        const newTo = Math.round((priorTo + qty) * 1000) / 1000;
        await tx.$executeRawUnsafe(
          'UPDATE fds_inventory_levels SET quantity_on_hand = $1, updated_at = now() WHERE id = $2::uuid',
          newTo,
          toLevel[0]!.id,
        );
      }

      // Paired transactions, same transfer_reference_id.
      const txOutId = generateId();
      const txInId = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO fds_inventory_transactions (id, school_id, group_id, item_id, transaction_type, quantity_delta, performed_by, transaction_at, transfer_reference_id, notes) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'TRANSFER_OUT', $5, $6::uuid, now(), $7::uuid, $8)",
        txOutId,
        tenant.schoolId,
        req.from_group_id,
        req.item_id,
        -qty,
        actor.accountId,
        transferRef,
        'Transfer request ' + id,
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO fds_inventory_transactions (id, school_id, group_id, item_id, transaction_type, quantity_delta, performed_by, transaction_at, transfer_reference_id, notes) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'TRANSFER_IN', $5, $6::uuid, now(), $7::uuid, $8)",
        txInId,
        tenant.schoolId,
        req.to_group_id,
        req.item_id,
        qty,
        actor.accountId,
        transferRef,
        'Transfer request ' + id,
      );

      await tx.$executeRawUnsafe(
        "UPDATE fds_inventory_transfer_requests SET status = 'COMPLETED', completed_at = now(), transfer_reference_id = $1::uuid, updated_at = now() WHERE id = $2::uuid",
        transferRef,
        id,
      );
    });
    return this.getById(id);
  }

  async cancel(id: string, actor: ResolvedActor): Promise<TransferRequestResponseDto> {
    await this.assertCanManage(actor);
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = (await tx.$queryRawUnsafe(
        'SELECT status FROM fds_inventory_transfer_requests WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        id,
        tenant.schoolId,
      )) as Array<{ status: string }>;
      if (locked.length === 0) throw new NotFoundException('Transfer request not found');
      if (!['PENDING', 'APPROVED'].includes(locked[0]!.status)) {
        throw new BadRequestException(
          'Transfer is in status ' +
            locked[0]!.status +
            '; only PENDING or APPROVED requests can be cancelled',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE fds_inventory_transfer_requests SET status = 'CANCELLED', updated_at = now() WHERE id = $1::uuid",
        id,
      );
    });
    return this.getById(id);
  }
}

const TRANSFER_SELECT_SQL =
  'SELECT id::text AS id, school_id::text AS school_id, from_group_id::text AS from_group_id, to_group_id::text AS to_group_id, ' +
  'item_id::text AS item_id, quantity, reason, status, requested_by::text AS requested_by, ' +
  'reviewed_by::text AS reviewed_by, reviewed_at, completed_at, transfer_reference_id::text AS transfer_reference_id, created_at ' +
  'FROM fds_inventory_transfer_requests';

interface TransferRow {
  id: string;
  school_id: string;
  from_group_id: string;
  to_group_id: string;
  item_id: string;
  quantity: number;
  reason: string | null;
  status: string;
  requested_by: string;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  completed_at: Date | null;
  transfer_reference_id: string | null;
  created_at: Date;
}

function transferRowToDto(r: TransferRow): TransferRequestResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    fromGroupId: r.from_group_id,
    toGroupId: r.to_group_id,
    itemId: r.item_id,
    quantity: numFromDecimal(r.quantity),
    reason: r.reason,
    status: r.status as TransferStatus,
    requestedBy: r.requested_by,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at ? r.reviewed_at.toISOString() : null,
    completedAt: r.completed_at ? r.completed_at.toISOString() : null,
    transferReferenceId: r.transfer_reference_id,
  };
}

function numFromDecimal(v: number | string): number {
  if (typeof v === 'number') return v;
  return Number(v);
}
