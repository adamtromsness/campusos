import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import { assertFinanceAdmin, assertFinanceReader, isUniqueViolation } from './access-advanced';
import { deterministicBudgetTransferApprovedEventId } from './event-ids-advanced';
import type {
  BudgetTransferDto,
  BudgetTransferStatus,
  CreateBudgetTransferDto,
  RejectBudgetTransferDto,
} from './dto/commerce-advanced.dto';

interface TransferRow {
  id: string;
  school_id: string;
  from_budget_id: string;
  to_budget_id: string;
  amount: string | number;
  reason: string;
  requested_by: string;
  approved_by: string | null;
  status: string;
  transferred_at: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * P2-29a — BudgetTransferService.
 *
 * Inter-department budget transfer request + approval. The KEYSTONE
 * is the `approve` path: from-decrement and to-increment run inside a
 * SINGLE executeInTenantTransaction with FOR UPDATE locks on BOTH
 * budget rows so concurrent approvals can never half-apply. The
 * CHECK(from_budget_id != to_budget_id) at the schema layer is the
 * belt-and-braces against same-budget self-transfers, but the service
 * also enforces that the calling actor cannot approve a non-PENDING
 * row and that both budgets belong to the current school.
 *
 * Emits `fin.budget_transfer.approved` via the durable outbox INSIDE
 * the same tx so downstream analytics consumers see the transfer
 * exactly once with deterministic event_id keyed on transferId.
 */
@Injectable()
export class BudgetTransferService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly outbox: OutboxService,
  ) {}

  private toDto(row: TransferRow): BudgetTransferDto {
    return {
      id: row.id,
      schoolId: row.school_id,
      fromBudgetId: row.from_budget_id,
      toBudgetId: row.to_budget_id,
      amount: Number(row.amount),
      reason: row.reason,
      requestedBy: row.requested_by,
      approvedBy: row.approved_by,
      status: row.status as BudgetTransferStatus,
      transferredAt: row.transferred_at,
      rejectionReason: row.rejection_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async list(actor: ResolvedActor, status?: BudgetTransferStatus): Promise<BudgetTransferDto[]> {
    await assertFinanceReader(actor, this.permCheck, 'Budget transfer list');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const args: unknown[] = [tenant.schoolId];
      let where = '';
      if (status) {
        args.push(status);
        where = ` AND status = $${args.length}`;
      }
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id,
                from_budget_id::text AS from_budget_id,
                to_budget_id::text AS to_budget_id,
                amount, reason,
                requested_by::text AS requested_by,
                approved_by::text AS approved_by, status,
                transferred_at::text AS transferred_at,
                rejection_reason,
                created_at::text AS created_at,
                updated_at::text AS updated_at
           FROM fin_budget_transfers
          WHERE school_id = $1::uuid${where}
          ORDER BY created_at DESC`,
        ...args,
      )) as TransferRow[];
      return rows.map((r) => this.toDto(r));
    });
  }

  async getById(actor: ResolvedActor, id: string): Promise<BudgetTransferDto> {
    await assertFinanceReader(actor, this.permCheck, 'Budget transfer read');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id,
                from_budget_id::text AS from_budget_id,
                to_budget_id::text AS to_budget_id,
                amount, reason,
                requested_by::text AS requested_by,
                approved_by::text AS approved_by, status,
                transferred_at::text AS transferred_at,
                rejection_reason,
                created_at::text AS created_at,
                updated_at::text AS updated_at
           FROM fin_budget_transfers
          WHERE school_id = $1::uuid AND id = $2::uuid`,
        tenant.schoolId,
        id,
      )) as TransferRow[];
      if (rows.length === 0) throw new NotFoundException('Budget transfer not found');
      return this.toDto(rows[0]!);
    });
  }

  async request(actor: ResolvedActor, input: CreateBudgetTransferDto): Promise<BudgetTransferDto> {
    await assertFinanceReader(actor, this.permCheck, 'Request budget transfer');
    const tenant = getCurrentTenant();
    if (!actor.employeeId) {
      throw new BadRequestException('Caller does not have an employee record in this school');
    }
    if (input.fromBudgetId === input.toBudgetId) {
      throw new BadRequestException('fromBudgetId and toBudgetId must be different');
    }
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Verify both budgets exist + belong to current school.
      const budgets = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id
           FROM fin_departmental_budgets
          WHERE school_id = $1::uuid AND id = ANY($2::uuid[])`,
        tenant.schoolId,
        [input.fromBudgetId, input.toBudgetId],
      )) as Array<{ id: string }>;
      if (budgets.length !== 2) {
        throw new BadRequestException(
          'fromBudgetId or toBudgetId does not match a budget in this school',
        );
      }
      const id = generateId();
      try {
        const rows = (await tx.$queryRawUnsafe(
          `INSERT INTO fin_budget_transfers
             (id, school_id, from_budget_id, to_budget_id, amount, reason, requested_by)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, $6, $7::uuid)
           RETURNING id::text AS id, school_id::text AS school_id,
                     from_budget_id::text AS from_budget_id,
                     to_budget_id::text AS to_budget_id,
                     amount, reason,
                     requested_by::text AS requested_by,
                     approved_by::text AS approved_by, status,
                     transferred_at::text AS transferred_at,
                     rejection_reason,
                     created_at::text AS created_at,
                     updated_at::text AS updated_at`,
          id,
          tenant.schoolId,
          input.fromBudgetId,
          input.toBudgetId,
          input.amount,
          input.reason,
          actor.employeeId,
        )) as TransferRow[];
        return this.toDto(rows[0]!);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException('Duplicate budget transfer request');
        }
        throw err;
      }
    });
  }

  /**
   * KEYSTONE — atomic budget transfer.
   *
   * Locks both budgets + the transfer row inside a single
   * tenant tx. Validates the from-budget has sufficient allocated
   * balance. Then in lockstep:
   *   1. DECREMENT from_budget.allocated_amount BY amount
   *   2. INCREMENT to_budget.allocated_amount BY amount
   *   3. flip transfer.status to APPROVED + stamp transferred_at + approved_by
   *   4. enqueue fin.budget_transfer.approved via the durable outbox
   *
   * On any step failure the entire tx rolls back so the budget rows
   * are NEVER half-applied.
   */
  async approve(actor: ResolvedActor, id: string): Promise<BudgetTransferDto> {
    await assertFinanceAdmin(actor, this.permCheck, 'Approve budget transfer');
    const tenant = getCurrentTenant();
    if (!actor.employeeId) {
      throw new BadRequestException('Caller does not have an employee record in this school');
    }
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock the transfer row with FOR UPDATE so concurrent admins serialise.
      const transferRows = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id, status,
                from_budget_id::text AS from_budget_id,
                to_budget_id::text AS to_budget_id,
                amount
           FROM fin_budget_transfers
          WHERE school_id = $1::uuid AND id = $2::uuid
          FOR UPDATE`,
        tenant.schoolId,
        id,
      )) as Array<{
        id: string;
        status: string;
        from_budget_id: string;
        to_budget_id: string;
        amount: string | number;
      }>;
      if (transferRows.length === 0) throw new NotFoundException('Budget transfer not found');
      const transfer = transferRows[0]!;
      if (transfer.status !== 'PENDING') {
        throw new BadRequestException(
          `Budget transfer is in status ${transfer.status} — only PENDING transfers can be approved`,
        );
      }
      const amount = Number(transfer.amount);

      // Lock BOTH budget rows in deterministic order (smallest id
      // first) to avoid deadlock between concurrent transfers that
      // touch the same pair of budgets.
      const ordered =
        transfer.from_budget_id < transfer.to_budget_id
          ? [transfer.from_budget_id, transfer.to_budget_id]
          : [transfer.to_budget_id, transfer.from_budget_id];
      const lockedBudgets = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id, allocated_amount
           FROM fin_departmental_budgets
          WHERE school_id = $1::uuid AND id = ANY($2::uuid[])
          ORDER BY id
          FOR UPDATE`,
        tenant.schoolId,
        ordered,
      )) as Array<{ id: string; allocated_amount: string | number }>;
      if (lockedBudgets.length !== 2) {
        throw new BadRequestException(
          'Source or destination budget no longer exists in this school',
        );
      }
      const fromBudget = lockedBudgets.find((b) => b.id === transfer.from_budget_id)!;
      const fromAllocated = Number(fromBudget.allocated_amount);
      if (fromAllocated < amount) {
        throw new BadRequestException(
          `Insufficient allocated balance in source budget (have ${fromAllocated.toFixed(2)}, need ${amount.toFixed(2)})`,
        );
      }

      // Atomic from-decrement.
      await tx.$executeRawUnsafe(
        `UPDATE fin_departmental_budgets
            SET allocated_amount = allocated_amount - $1::numeric,
                updated_at = now()
          WHERE school_id = $2::uuid AND id = $3::uuid`,
        amount,
        tenant.schoolId,
        transfer.from_budget_id,
      );

      // Atomic to-increment.
      await tx.$executeRawUnsafe(
        `UPDATE fin_departmental_budgets
            SET allocated_amount = allocated_amount + $1::numeric,
                updated_at = now()
          WHERE school_id = $2::uuid AND id = $3::uuid`,
        amount,
        tenant.schoolId,
        transfer.to_budget_id,
      );

      // Flip transfer status to APPROVED — schema-side approved_chk
      // lockstep requires both approved_by and transferred_at to be
      // set when status='APPROVED'.
      const updated = (await tx.$queryRawUnsafe(
        `UPDATE fin_budget_transfers
            SET status = 'APPROVED',
                approved_by = $1::uuid,
                transferred_at = now(),
                updated_at = now()
          WHERE school_id = $2::uuid AND id = $3::uuid
          RETURNING id::text AS id, school_id::text AS school_id,
                    from_budget_id::text AS from_budget_id,
                    to_budget_id::text AS to_budget_id,
                    amount, reason,
                    requested_by::text AS requested_by,
                    approved_by::text AS approved_by, status,
                    transferred_at::text AS transferred_at,
                    rejection_reason,
                    created_at::text AS created_at,
                    updated_at::text AS updated_at`,
        actor.employeeId,
        tenant.schoolId,
        id,
      )) as TransferRow[];

      // Emit fin.budget_transfer.approved durably inside the same tx.
      await this.outbox.enqueueInTx(tx, {
        topic: 'fin.budget_transfer.approved',
        payload: {
          transferId: id,
          schoolId: tenant.schoolId,
          fromBudgetId: transfer.from_budget_id,
          toBudgetId: transfer.to_budget_id,
          amount,
          approvedBy: actor.employeeId,
          sourceRefId: id,
        },
        sourceModule: 'commerce',
        eventId: deterministicBudgetTransferApprovedEventId(id),
        tenantId: tenant.schoolId,
        tenantSubdomain: tenant.subdomain,
        key: id,
      });

      return this.toDto(updated[0]!);
    });
  }

  async reject(
    actor: ResolvedActor,
    id: string,
    input: RejectBudgetTransferDto,
  ): Promise<BudgetTransferDto> {
    await assertFinanceAdmin(actor, this.permCheck, 'Reject budget transfer');
    const tenant = getCurrentTenant();
    if (!actor.employeeId) {
      throw new BadRequestException('Caller does not have an employee record in this school');
    }
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const existing = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id, status
           FROM fin_budget_transfers
          WHERE school_id = $1::uuid AND id = $2::uuid
          FOR UPDATE`,
        tenant.schoolId,
        id,
      )) as Array<{ id: string; status: string }>;
      if (existing.length === 0) throw new NotFoundException('Budget transfer not found');
      if (existing[0]!.status !== 'PENDING') {
        throw new BadRequestException(
          `Budget transfer is in status ${existing[0]!.status} — only PENDING transfers can be rejected`,
        );
      }
      const rows = (await tx.$queryRawUnsafe(
        `UPDATE fin_budget_transfers
            SET status = 'REJECTED',
                approved_by = $1::uuid,
                rejection_reason = $2,
                updated_at = now()
          WHERE school_id = $3::uuid AND id = $4::uuid
          RETURNING id::text AS id, school_id::text AS school_id,
                    from_budget_id::text AS from_budget_id,
                    to_budget_id::text AS to_budget_id,
                    amount, reason,
                    requested_by::text AS requested_by,
                    approved_by::text AS approved_by, status,
                    transferred_at::text AS transferred_at,
                    rejection_reason,
                    created_at::text AS created_at,
                    updated_at::text AS updated_at`,
        actor.employeeId,
        input.rejectionReason,
        tenant.schoolId,
        id,
      )) as TransferRow[];
      return this.toDto(rows[0]!);
    });
  }
}
