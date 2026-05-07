import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { FinanceValidationService } from '../finance/validation';
import type { ResolvedActor } from '../iam/actor-context.service';
import { isUniqueViolation } from './requisitions.service';
import type {
  BudgetCommitmentDto,
  CommitmentStatus,
  CreateGoodsReceiptDto,
  CreatePurchaseOrderDto,
  DestinationModule,
  GoodsReceiptDto,
  InspectionOutcome,
  POStatus,
  POTransitionDto,
  PurchaseOrderDto,
  PurchaseOrderLineDto,
  ReceiptCondition,
  ReceiptLineDto,
} from './dto/procurement.dto';

interface POLineRow {
  id: string;
  purchase_order_id: string;
  requisition_line_id: string | null;
  item_description: string;
  quantity_ordered: number;
  quantity_received: number;
  unit_cost: string | number;
  line_total: string | number;
  gl_account_id: string | null;
  gl_account_code: string | null;
  destination_module: string;
  line_order: number;
}

interface PORow {
  id: string;
  school_id: string;
  po_number: string;
  vendor_id: string;
  vendor_name: string | null;
  requisition_id: string | null;
  delivery_address: string;
  expected_delivery_date: string | null;
  payment_terms: string | null;
  status: string;
  total_amount: string | number;
  notes: string | null;
  issued_by: string | null;
  issued_by_name: string | null;
  issued_at: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_PO_BASE = `
  SELECT po.id::text AS id,
         po.school_id::text AS school_id,
         po.po_number,
         po.vendor_id::text AS vendor_id,
         (SELECT supplier_name FROM fin_suppliers WHERE id = po.vendor_id) AS vendor_name,
         po.requisition_id::text AS requisition_id,
         po.delivery_address,
         po.expected_delivery_date::text AS expected_delivery_date,
         po.payment_terms,
         po.status,
         po.total_amount,
         po.notes,
         po.issued_by::text AS issued_by,
         (SELECT ip.first_name || ' ' || ip.last_name FROM hr_employees e JOIN platform.iam_person ip ON ip.id = e.person_id WHERE e.id = po.issued_by LIMIT 1) AS issued_by_name,
         po.issued_at::text AS issued_at,
         po.cancelled_at::text AS cancelled_at,
         po.cancelled_by::text AS cancelled_by,
         po.cancel_reason,
         po.created_at::text AS created_at,
         po.updated_at::text AS updated_at
  FROM prc_purchase_orders po
`;

const ALLOWED_PO_TRANSITIONS: Record<POStatus, POStatus[]> = {
  DRAFT: ['ISSUED', 'CANCELLED'],
  ISSUED: ['ACKNOWLEDGED', 'SHIPPED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
  ACKNOWLEDGED: ['SHIPPED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
  SHIPPED: ['PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
  PARTIALLY_RECEIVED: ['PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
  RECEIVED: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
};

@Injectable()
export class PurchaseOrderService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly financeValidation: FinanceValidationService,
  ) {}

  private isProcurementOfficer(actor: ResolvedActor): boolean {
    if (actor.isSchoolAdmin) return true;
    return actor.personType === 'STAFF';
  }

  private async loadLines(poId: string): Promise<PurchaseOrderLineDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT pol.id::text AS id, pol.purchase_order_id::text AS purchase_order_id, pol.requisition_line_id::text AS requisition_line_id, pol.item_description, pol.quantity_ordered, COALESCE((SELECT SUM(quantity_received)::int FROM prc_goods_receipt_lines WHERE po_line_id = pol.id), 0) AS quantity_received, pol.unit_cost, pol.line_total, pol.gl_account_id::text AS gl_account_id, (SELECT account_code FROM fin_chart_of_accounts WHERE id = pol.gl_account_id) AS gl_account_code, pol.destination_module, pol.line_order FROM prc_purchase_order_lines pol WHERE pol.purchase_order_id = $1::uuid ORDER BY pol.line_order, pol.id`,
        poId,
      );
    })) as POLineRow[];
    return rows.map((r) => ({
      id: r.id,
      purchaseOrderId: r.purchase_order_id,
      requisitionLineId: r.requisition_line_id,
      itemDescription: r.item_description,
      quantityOrdered: Number(r.quantity_ordered),
      quantityReceived: Number(r.quantity_received),
      unitCost: Number(r.unit_cost),
      lineTotal: Number(r.line_total),
      glAccountId: r.gl_account_id,
      glAccountCode: r.gl_account_code,
      destinationModule: r.destination_module as DestinationModule,
      lineOrder: Number(r.line_order),
    }));
  }

  private async loadCommitments(poId: string): Promise<BudgetCommitmentDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT bc.id::text AS id, bc.purchase_order_id::text AS purchase_order_id, bc.budget_line_id::text AS budget_line_id, (SELECT a.account_code FROM fin_budget_lines bl JOIN fin_chart_of_accounts a ON a.id = bl.account_id WHERE bl.id = bc.budget_line_id) AS budget_account_code, bc.committed_amount, bc.released_amount, bc.status, bc.released_at::text AS released_at FROM prc_budget_commitments bc WHERE bc.purchase_order_id = $1::uuid ORDER BY bc.created_at`,
        poId,
      );
    })) as Array<{
      id: string;
      purchase_order_id: string;
      budget_line_id: string;
      budget_account_code: string | null;
      committed_amount: string | number;
      released_amount: string | number;
      status: string;
      released_at: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      purchaseOrderId: r.purchase_order_id,
      budgetLineId: r.budget_line_id,
      budgetAccountCode: r.budget_account_code,
      committedAmount: Number(r.committed_amount),
      releasedAmount: Number(r.released_amount),
      status: r.status as CommitmentStatus,
      releasedAt: r.released_at,
    }));
  }

  private async toDto(r: PORow): Promise<PurchaseOrderDto> {
    return {
      id: r.id,
      schoolId: r.school_id,
      poNumber: r.po_number,
      vendorId: r.vendor_id,
      vendorName: r.vendor_name,
      requisitionId: r.requisition_id,
      deliveryAddress: r.delivery_address,
      expectedDeliveryDate: r.expected_delivery_date,
      paymentTerms: r.payment_terms,
      status: r.status as POStatus,
      totalAmount: Number(r.total_amount),
      notes: r.notes,
      issuedBy: r.issued_by,
      issuedByName: r.issued_by_name,
      issuedAt: r.issued_at,
      cancelledAt: r.cancelled_at,
      cancelReason: r.cancel_reason,
      lines: await this.loadLines(r.id),
      commitments: await this.loadCommitments(r.id),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async list(filter?: { status?: string; vendorId?: string }): Promise<PurchaseOrderDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = [`po.school_id = $1::uuid`];
    const params: unknown[] = [tenant.schoolId];
    let i = 2;
    if (filter?.status) {
      where.push(`po.status = $${i++}`);
      params.push(filter.status);
    }
    if (filter?.vendorId) {
      where.push(`po.vendor_id = $${i++}::uuid`);
      params.push(filter.vendorId);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_PO_BASE + ` WHERE ${where.join(' AND ')} ORDER BY po.created_at DESC LIMIT 200`,
        ...params,
      );
    })) as PORow[];
    const out: PurchaseOrderDto[] = [];
    for (const r of rows) out.push(await this.toDto(r));
    return out;
  }

  async getById(id: string): Promise<PurchaseOrderDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_PO_BASE + ` WHERE po.id = $1::uuid AND po.school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as PORow[];
    if (rows.length === 0) throw new NotFoundException('Purchase order not found');
    return this.toDto(rows[0]!);
  }

  async create(actor: ResolvedActor, input: CreatePurchaseOrderDto): Promise<PurchaseOrderDto> {
    if (!this.isProcurementOfficer(actor)) {
      throw new ForbiddenException('Only procurement staff or admins may create POs');
    }
    if (!actor.employeeId) {
      throw new BadRequestException('PO creation requires an employee actor');
    }
    // REVIEW-CYCLE27 BLOCKING 2 — validate each gl_account_id is an active EXPENSE / ASSET
    // / LIABILITY account in this tenant before any tx work. Mirrors Cycle 26
    // FinanceValidationService.assertActiveAccount usage on AP voucher create.
    for (const line of input.lines) {
      if (line.glAccountId) {
        await this.financeValidation.assertActiveAccount(
          line.glAccountId,
          ['EXPENSE', 'ASSET', 'LIABILITY'],
          'lines[].glAccountId',
        );
      }
    }
    const tenant = getCurrentTenant();
    const poId = generateId();
    const total = input.lines.reduce((sum, l) => sum + l.unitCost * l.quantityOrdered, 0);
    let poNumber: string;
    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        // Validate vendor exists + active
        const vendor = (await tx.$queryRawUnsafe(
          `SELECT supplier_name, is_active FROM fin_suppliers WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
          input.vendorId,
          tenant.schoolId,
        )) as Array<{ supplier_name: string; is_active: boolean }>;
        if (vendor.length === 0) {
          throw new BadRequestException('vendorId does not match a supplier in this school');
        }
        if (!vendor[0]!.is_active) {
          throw new BadRequestException(
            `Vendor "${vendor[0]!.supplier_name}" is inactive — POs cannot be issued to deactivated suppliers`,
          );
        }
        // REVIEW-CYCLE27 BLOCKING 2 — when requisitionId is supplied, validate
        // it belongs to this school + is in an approved state ready for ordering.
        if (input.requisitionId) {
          const reqRows = (await tx.$queryRawUnsafe(
            `SELECT status FROM prc_requisitions WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
            input.requisitionId,
            tenant.schoolId,
          )) as Array<{ status: string }>;
          if (reqRows.length === 0) {
            throw new BadRequestException(
              'requisitionId does not match a requisition in this school',
            );
          }
          const allowed = ['ADMIN_APPROVED', 'DISTRICT_APPROVED'];
          if (!allowed.includes(reqRows[0]!.status)) {
            throw new BadRequestException(
              `Cannot create a PO from a requisition in status=${reqRows[0]!.status}. Requisition must be ADMIN_APPROVED or DISTRICT_APPROVED before order creation.`,
            );
          }
          // Validate every supplied requisitionLineId belongs to this requisition.
          const reqLineIds = input.lines
            .map((l) => l.requisitionLineId)
            .filter((id): id is string => !!id);
          if (reqLineIds.length > 0) {
            const matchingRows = (await tx.$queryRawUnsafe(
              `SELECT id::text AS id FROM prc_requisition_lines WHERE id = ANY($1::uuid[]) AND requisition_id = $2::uuid`,
              reqLineIds,
              input.requisitionId,
            )) as Array<{ id: string }>;
            const matched = new Set(matchingRows.map((r) => r.id));
            const orphans = reqLineIds.filter((id) => !matched.has(id));
            if (orphans.length > 0) {
              throw new BadRequestException(
                `These requisitionLineId values do not belong to requisition ${input.requisitionId}: ${orphans.join(', ')}`,
              );
            }
          }
        } else {
          // Standalone PO: requisitionLineId must NOT be set on any line.
          const orphanReqLines = input.lines.filter((l) => l.requisitionLineId);
          if (orphanReqLines.length > 0) {
            throw new BadRequestException(
              'Cannot supply requisitionLineId on PO lines when requisitionId is not set on the PO',
            );
          }
        }
        // Allocate po_number from settings sequence under FOR UPDATE
        const settingsRows = (await tx.$queryRawUnsafe(
          `SELECT po_number_prefix, po_number_next_seq FROM prc_procurement_settings WHERE school_id = $1::uuid FOR UPDATE`,
          tenant.schoolId,
        )) as Array<{ po_number_prefix: string; po_number_next_seq: number }>;
        let prefix = 'PO';
        let nextSeq = 1;
        if (settingsRows.length === 0) {
          // Auto-create settings on first PO
          await tx.$executeRawUnsafe(
            `INSERT INTO prc_procurement_settings (id, school_id, po_number_prefix, po_number_next_seq) VALUES ($1::uuid, $2::uuid, 'PO', 1) ON CONFLICT (school_id) DO NOTHING`,
            generateId(),
            tenant.schoolId,
          );
        } else {
          prefix = settingsRows[0]!.po_number_prefix;
          nextSeq = Number(settingsRows[0]!.po_number_next_seq);
        }
        const year = new Date().getFullYear();
        poNumber = `${prefix}-${year}-${String(nextSeq).padStart(3, '0')}`;
        await tx.$executeRawUnsafe(
          `UPDATE prc_procurement_settings SET po_number_next_seq = $1, updated_at = now() WHERE school_id = $2::uuid`,
          nextSeq + 1,
          tenant.schoolId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO prc_purchase_orders (id, school_id, po_number, vendor_id, requisition_id, delivery_address, expected_delivery_date, payment_terms, status, total_amount, notes, issued_by) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6, $7::date, $8, 'DRAFT', $9, $10, $11::uuid)`,
          poId,
          tenant.schoolId,
          poNumber,
          input.vendorId,
          input.requisitionId ?? null,
          input.deliveryAddress,
          input.expectedDeliveryDate ?? null,
          input.paymentTerms ?? null,
          total,
          input.notes ?? null,
          actor.employeeId,
        );
        let order = 0;
        for (const line of input.lines) {
          await tx.$executeRawUnsafe(
            `INSERT INTO prc_purchase_order_lines (id, purchase_order_id, requisition_line_id, item_description, quantity_ordered, unit_cost, line_total, gl_account_id, destination_module, line_order) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid, $9, $10)`,
            generateId(),
            poId,
            line.requisitionLineId ?? null,
            line.itemDescription,
            line.quantityOrdered,
            line.unitCost,
            line.unitCost * line.quantityOrdered,
            line.glAccountId ?? null,
            line.destinationModule,
            order++,
          );
        }
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('PO number collision — please retry');
      }
      throw err;
    }
    return this.getById(poId);
  }

  /**
   * BUDGET COMMITMENT KEYSTONE — DRAFT → ISSUED creates the
   * prc_budget_commitments row AND increments
   * fin_budget_lines.encumbered_amount inside one tenant tx.
   * If budget_line_id is supplied at issue time it overrides the
   * parent requisition's budget_line_id; otherwise the parent's
   * is used. Validates the line is active + has sufficient
   * remaining balance.
   */
  async transition(
    actor: ResolvedActor,
    poId: string,
    input: POTransitionDto,
    budgetLineIdOverride?: string,
  ): Promise<PurchaseOrderDto> {
    if (!this.isProcurementOfficer(actor)) {
      throw new ForbiddenException('Only procurement staff or admins may transition POs');
    }
    if (!actor.employeeId) {
      throw new BadRequestException('PO transition requires an employee actor');
    }
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT po.status, po.total_amount, po.requisition_id::text AS requisition_id, (SELECT budget_line_id::text FROM prc_requisitions WHERE id = po.requisition_id) AS req_budget_line_id FROM prc_purchase_orders po WHERE po.id = $1::uuid AND po.school_id = $2::uuid FOR UPDATE OF po`,
        poId,
        tenant.schoolId,
      )) as Array<{
        status: string;
        total_amount: string | number;
        requisition_id: string | null;
        req_budget_line_id: string | null;
      }>;
      if (rows.length === 0) throw new NotFoundException('Purchase order not found');
      const r = rows[0]!;
      const target = this.actionToStatus(input.action, r.status as POStatus);
      const allowed = ALLOWED_PO_TRANSITIONS[r.status as POStatus];
      if (!allowed.includes(target)) {
        throw new BadRequestException(
          `Cannot transition PO from ${r.status} to ${target}. Allowed: ${allowed.join(', ') || 'none'}.`,
        );
      }

      if (target === 'ISSUED') {
        // BUDGET COMMITMENT KEYSTONE
        const budgetLineId = budgetLineIdOverride ?? r.req_budget_line_id;
        if (budgetLineId) {
          const blRows = (await tx.$queryRawUnsafe(
            `SELECT budgeted_amount, actual_amount, encumbered_amount FROM fin_budget_lines WHERE id = $1::uuid FOR UPDATE`,
            budgetLineId,
          )) as Array<{
            budgeted_amount: string | number;
            actual_amount: string | number;
            encumbered_amount: string | number;
          }>;
          if (blRows.length === 0) {
            throw new BadRequestException(
              'budget_line_id does not match a budget line in this school',
            );
          }
          const bl = blRows[0]!;
          const remaining =
            Number(bl.budgeted_amount) - Number(bl.actual_amount) - Number(bl.encumbered_amount);
          const total = Number(r.total_amount);
          if (total > remaining + 0.005) {
            throw new BadRequestException(
              `Insufficient budget remaining on this line. PO total ${total.toFixed(2)}, remaining ${remaining.toFixed(2)}.`,
            );
          }
          await tx.$executeRawUnsafe(
            `INSERT INTO prc_budget_commitments (id, purchase_order_id, budget_line_id, committed_amount, status) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'COMMITTED')`,
            generateId(),
            poId,
            budgetLineId,
            total,
          );
          await tx.$executeRawUnsafe(
            `UPDATE fin_budget_lines SET encumbered_amount = encumbered_amount + $1, updated_at = now() WHERE id = $2::uuid`,
            total,
            budgetLineId,
          );
        }
        await tx.$executeRawUnsafe(
          `UPDATE prc_purchase_orders SET status = 'ISSUED', issued_at = now(), issued_by = COALESCE(issued_by, $1::uuid), updated_at = now() WHERE id = $2::uuid`,
          actor.employeeId,
          poId,
        );
        // REVIEW-CYCLE27 MAJOR 8 — tighten ORDERED cascade to APPROVED states
        // only. A linked requisition must have reached ADMIN_APPROVED or
        // DISTRICT_APPROVED before its status can advance to ORDERED via PO
        // issue. DRAFT / SUBMITTED requisitions should not be quietly
        // promoted by a PO write.
        if (r.requisition_id) {
          await tx.$executeRawUnsafe(
            `UPDATE prc_requisitions SET status = 'ORDERED', updated_at = now() WHERE id = $1::uuid AND status IN ('ADMIN_APPROVED', 'DISTRICT_APPROVED')`,
            r.requisition_id,
          );
        }
      } else if (target === 'CLOSED') {
        // BUDGET COMMITMENT RELEASE — flip COMMITTED rows to RELEASED + decrement encumbered.
        await tx.$executeRawUnsafe(
          `UPDATE fin_budget_lines bl SET encumbered_amount = GREATEST(bl.encumbered_amount - sub.amt, 0), updated_at = now() FROM (SELECT bc.budget_line_id, SUM(bc.committed_amount - bc.released_amount) AS amt FROM prc_budget_commitments bc WHERE bc.purchase_order_id = $1::uuid AND bc.status <> 'RELEASED' GROUP BY bc.budget_line_id) sub WHERE bl.id = sub.budget_line_id`,
          poId,
        );
        await tx.$executeRawUnsafe(
          `UPDATE prc_budget_commitments SET status = 'RELEASED', released_amount = committed_amount, released_at = now(), released_by = $1::uuid, updated_at = now() WHERE purchase_order_id = $2::uuid AND status <> 'RELEASED'`,
          actor.employeeId,
          poId,
        );
        await tx.$executeRawUnsafe(
          `UPDATE prc_purchase_orders SET status = 'CLOSED', updated_at = now() WHERE id = $1::uuid`,
          poId,
        );
        // Mark linked requisition as CLOSED if it was DISTRIBUTED.
        if (r.requisition_id) {
          await tx.$executeRawUnsafe(
            `UPDATE prc_requisitions SET status = 'CLOSED', updated_at = now() WHERE id = $1::uuid AND status IN ('DISTRIBUTED', 'RECEIVED')`,
            r.requisition_id,
          );
        }
      } else if (target === 'CANCELLED') {
        // Release any commitment on cancel + stamp cancellation audit.
        await tx.$executeRawUnsafe(
          `UPDATE fin_budget_lines bl SET encumbered_amount = GREATEST(bl.encumbered_amount - sub.amt, 0), updated_at = now() FROM (SELECT bc.budget_line_id, SUM(bc.committed_amount - bc.released_amount) AS amt FROM prc_budget_commitments bc WHERE bc.purchase_order_id = $1::uuid AND bc.status <> 'RELEASED' GROUP BY bc.budget_line_id) sub WHERE bl.id = sub.budget_line_id`,
          poId,
        );
        await tx.$executeRawUnsafe(
          `UPDATE prc_budget_commitments SET status = 'RELEASED', released_amount = committed_amount, released_at = now(), released_by = $1::uuid, updated_at = now() WHERE purchase_order_id = $2::uuid AND status <> 'RELEASED'`,
          actor.employeeId,
          poId,
        );
        await tx.$executeRawUnsafe(
          `UPDATE prc_purchase_orders SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $1::uuid, cancel_reason = $2, updated_at = now() WHERE id = $3::uuid`,
          actor.employeeId,
          input.reason ?? 'Cancelled',
          poId,
        );
      } else {
        await tx.$executeRawUnsafe(
          `UPDATE prc_purchase_orders SET status = $1, updated_at = now() WHERE id = $2::uuid`,
          target,
          poId,
        );
      }
    });
    return this.getById(poId);
  }

  private actionToStatus(action: POTransitionDto['action'], current: POStatus): POStatus {
    if (action === 'ISSUE') return 'ISSUED';
    if (action === 'ACKNOWLEDGE') return 'ACKNOWLEDGED';
    if (action === 'SHIP') return 'SHIPPED';
    if (action === 'CLOSE') return 'CLOSED';
    if (action === 'CANCEL') return 'CANCELLED';
    return current;
  }
}

@Injectable()
export class GoodsReceiptService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private isProcurementOfficer(actor: ResolvedActor): boolean {
    if (actor.isSchoolAdmin) return true;
    return actor.personType === 'STAFF';
  }

  private async loadLines(receiptId: string): Promise<ReceiptLineDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT rl.id::text AS id, rl.receipt_id::text AS receipt_id, rl.po_line_id::text AS po_line_id, (SELECT item_description FROM prc_purchase_order_lines WHERE id = rl.po_line_id) AS po_item_description, rl.quantity_received, rl.quantity_accepted, rl.quantity_rejected, rl.condition, rl.discrepancy_notes FROM prc_goods_receipt_lines rl WHERE rl.receipt_id = $1::uuid ORDER BY rl.id`,
        receiptId,
      );
    })) as Array<{
      id: string;
      receipt_id: string;
      po_line_id: string;
      po_item_description: string;
      quantity_received: number;
      quantity_accepted: number;
      quantity_rejected: number;
      condition: string;
      discrepancy_notes: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      receiptId: r.receipt_id,
      poLineId: r.po_line_id,
      poItemDescription: r.po_item_description,
      quantityReceived: Number(r.quantity_received),
      quantityAccepted: Number(r.quantity_accepted),
      quantityRejected: Number(r.quantity_rejected),
      condition: r.condition as ReceiptCondition,
      discrepancyNotes: r.discrepancy_notes,
    }));
  }

  async listForPO(poId: string): Promise<GoodsReceiptDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT gr.id::text AS id, gr.purchase_order_id::text AS purchase_order_id, (SELECT po_number FROM prc_purchase_orders WHERE id = gr.purchase_order_id) AS po_number, gr.received_by::text AS received_by, (SELECT ip.first_name || ' ' || ip.last_name FROM hr_employees e JOIN platform.iam_person ip ON ip.id = e.person_id WHERE e.id = gr.received_by LIMIT 1) AS received_by_name, gr.received_at::text AS received_at, gr.inspection_outcome, gr.notes FROM prc_goods_receipts gr WHERE gr.purchase_order_id = $1::uuid ORDER BY gr.received_at DESC`,
        poId,
      );
    })) as Array<{
      id: string;
      purchase_order_id: string;
      po_number: string;
      received_by: string;
      received_by_name: string | null;
      received_at: string;
      inspection_outcome: string;
      notes: string | null;
    }>;
    const out: GoodsReceiptDto[] = [];
    for (const r of rows) {
      out.push({
        id: r.id,
        purchaseOrderId: r.purchase_order_id,
        poNumber: r.po_number,
        receivedBy: r.received_by,
        receivedByName: r.received_by_name,
        receivedAt: r.received_at,
        inspectionOutcome: r.inspection_outcome as InspectionOutcome,
        notes: r.notes,
        lines: await this.loadLines(r.id),
      });
    }
    return out;
  }

  /**
   * Create a goods receipt — atomically writes the receipt + lines,
   * updates prc_vendor_performance, and flips PO status to
   * PARTIALLY_RECEIVED or RECEIVED based on cumulative quantities.
   */
  async create(
    actor: ResolvedActor,
    poId: string,
    input: CreateGoodsReceiptDto,
  ): Promise<GoodsReceiptDto> {
    if (!this.isProcurementOfficer(actor)) {
      throw new ForbiddenException('Only procurement staff or admins may receive goods');
    }
    if (!actor.employeeId) {
      throw new BadRequestException('Receipt requires an employee actor');
    }
    const tenant = getCurrentTenant();
    const receiptId = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock PO + read vendor + expected delivery
      const poRows = (await tx.$queryRawUnsafe(
        `SELECT vendor_id::text AS vendor_id, status, expected_delivery_date::text AS expected_delivery_date FROM prc_purchase_orders WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE`,
        poId,
        tenant.schoolId,
      )) as Array<{ vendor_id: string; status: string; expected_delivery_date: string | null }>;
      if (poRows.length === 0) throw new NotFoundException('Purchase order not found');
      const po = poRows[0]!;
      if (!['ISSUED', 'ACKNOWLEDGED', 'SHIPPED', 'PARTIALLY_RECEIVED'].includes(po.status)) {
        throw new BadRequestException(
          `Cannot receive against a ${po.status} PO. PO must be ISSUED / ACKNOWLEDGED / SHIPPED / PARTIALLY_RECEIVED.`,
        );
      }
      // Validate every po_line_id belongs to this PO + has remaining quantity.
      for (const line of input.lines) {
        const polRows = (await tx.$queryRawUnsafe(
          `SELECT pol.quantity_ordered, COALESCE((SELECT SUM(quantity_received)::int FROM prc_goods_receipt_lines WHERE po_line_id = pol.id), 0) AS already_received FROM prc_purchase_order_lines pol WHERE pol.id = $1::uuid AND pol.purchase_order_id = $2::uuid LIMIT 1`,
          line.poLineId,
          poId,
        )) as Array<{ quantity_ordered: number; already_received: number }>;
        if (polRows.length === 0) {
          throw new BadRequestException(`po_line_id ${line.poLineId} does not belong to this PO`);
        }
        const remaining =
          Number(polRows[0]!.quantity_ordered) - Number(polRows[0]!.already_received);
        if (line.quantityReceived > remaining) {
          throw new BadRequestException(
            `quantity_received ${line.quantityReceived} exceeds remaining ${remaining} on PO line ${line.poLineId}`,
          );
        }
      }
      // REVIEW-CYCLE27 BLOCKING 3 — vendor performance counters must be
      // PO-level for `total_orders` and `on_time_deliveries` /
      // `late_deliveries`; only `accepted_count` / `rejected_count` are
      // line-level. Determine whether this receipt is the first for the PO
      // BEFORE we insert it. The bump for `total_orders` happens only on
      // the first receipt; `on_time / late` bump happens only on the
      // receipt that completes the PO (newStatus = RECEIVED).
      const priorReceiptRows = (await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM prc_goods_receipts WHERE purchase_order_id = $1::uuid`,
        poId,
      )) as Array<{ n: number }>;
      const isFirstReceipt = Number(priorReceiptRows[0]!.n) === 0;
      // INSERT receipt + lines
      await tx.$executeRawUnsafe(
        `INSERT INTO prc_goods_receipts (id, purchase_order_id, received_by, received_at, inspection_outcome, notes) VALUES ($1::uuid, $2::uuid, $3::uuid, now(), $4, $5)`,
        receiptId,
        poId,
        actor.employeeId,
        input.inspectionOutcome,
        input.notes ?? null,
      );
      let totalAccepted = 0;
      let totalRejected = 0;
      for (const line of input.lines) {
        await tx.$executeRawUnsafe(
          `INSERT INTO prc_goods_receipt_lines (id, receipt_id, po_line_id, quantity_received, quantity_accepted, quantity_rejected, condition, discrepancy_notes) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8)`,
          generateId(),
          receiptId,
          line.poLineId,
          line.quantityReceived,
          line.quantityAccepted,
          line.quantityRejected,
          line.condition,
          line.discrepancyNotes ?? null,
        );
        totalAccepted += line.quantityAccepted;
        totalRejected += line.quantityRejected;
      }
      // Recompute PO status from cumulative receipts (now including this one)
      const cumRows = (await tx.$queryRawUnsafe(
        `SELECT COALESCE(SUM(pol.quantity_ordered)::int, 0) AS ordered, COALESCE(SUM((SELECT COALESCE(SUM(quantity_received), 0) FROM prc_goods_receipt_lines WHERE po_line_id = pol.id))::int, 0) AS received FROM prc_purchase_order_lines pol WHERE pol.purchase_order_id = $1::uuid`,
        poId,
      )) as Array<{ ordered: number; received: number }>;
      const { ordered, received } = cumRows[0]!;
      const newStatus = received >= ordered ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
      await tx.$executeRawUnsafe(
        `UPDATE prc_purchase_orders SET status = $1, updated_at = now() WHERE id = $2::uuid`,
        newStatus,
        poId,
      );
      // PO-level vendor-performance bumps:
      //   * total_orders: bump only when this is the first receipt for the PO
      //   * on_time / late: bump only when the PO transitions to RECEIVED,
      //     using the final delivery date for the on-time check
      //   * accepted / rejected: line-level, always bump by the receipt's totals
      const isFinalReceipt = newStatus === 'RECEIVED';
      const today = new Date().toISOString().slice(0, 10);
      const onTime =
        isFinalReceipt && (po.expected_delivery_date ? today <= po.expected_delivery_date : true);
      const orderBump = isFirstReceipt ? 1 : 0;
      const onTimeBump = isFinalReceipt && onTime ? 1 : 0;
      const lateBump = isFinalReceipt && !onTime ? 1 : 0;
      await tx.$executeRawUnsafe(
        `INSERT INTO prc_vendor_performance (id, vendor_id, school_id, total_orders, on_time_deliveries, late_deliveries, accepted_count, rejected_count, average_quality_score, average_delivery_score, last_updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8,
                 CASE WHEN ($7 + $8) > 0 THEN $7::numeric / ($7 + $8)::numeric ELSE NULL END,
                 CASE WHEN $4 > 0 THEN $5::numeric / $4::numeric ELSE NULL END,
                 now())
         ON CONFLICT (vendor_id, school_id) DO UPDATE SET
           total_orders = prc_vendor_performance.total_orders + $4,
           on_time_deliveries = prc_vendor_performance.on_time_deliveries + $5,
           late_deliveries = prc_vendor_performance.late_deliveries + $6,
           accepted_count = prc_vendor_performance.accepted_count + $7,
           rejected_count = prc_vendor_performance.rejected_count + $8,
           average_quality_score = CASE
             WHEN (prc_vendor_performance.accepted_count + $7 + prc_vendor_performance.rejected_count + $8) > 0
             THEN (prc_vendor_performance.accepted_count + $7)::numeric /
                  (prc_vendor_performance.accepted_count + $7 + prc_vendor_performance.rejected_count + $8)::numeric
             ELSE NULL
           END,
           average_delivery_score = CASE
             WHEN (prc_vendor_performance.total_orders + $4) > 0
             THEN (prc_vendor_performance.on_time_deliveries + $5)::numeric /
                  (prc_vendor_performance.total_orders + $4)::numeric
             ELSE NULL
           END,
           last_updated_at = now()`,
        generateId(),
        po.vendor_id,
        tenant.schoolId,
        orderBump,
        onTimeBump,
        lateBump,
        totalAccepted,
        totalRejected,
      );
      // Mark linked requisition as RECEIVED if PO fully received.
      if (newStatus === 'RECEIVED') {
        await tx.$executeRawUnsafe(
          `UPDATE prc_requisitions SET status = 'RECEIVED', updated_at = now() WHERE id = (SELECT requisition_id FROM prc_purchase_orders WHERE id = $1::uuid) AND status IN ('ORDERED', 'ADMIN_APPROVED', 'DISTRICT_APPROVED')`,
          poId,
        );
      }
    });
    const all = await this.listForPO(poId);
    const created = all.find((r) => r.id === receiptId);
    if (!created) throw new NotFoundException('Receipt not found post-insert');
    return created;
  }
}
