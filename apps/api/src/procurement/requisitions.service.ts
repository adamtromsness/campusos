import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import type { PrismaClient } from '@prisma/client';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { FinanceValidationService } from '../finance/validation';
import type { ResolvedActor } from '../iam/actor-context.service';
import type {
  ApproveRequisitionDto,
  CreateRequisitionDto,
  CreateRequisitionLineDto,
  DestinationModule,
  RejectRequisitionDto,
  ReqStatus,
  ReqUrgency,
  RequisitionDto,
  RequisitionLineDto,
} from './dto/procurement.dto';

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e?.code === 'P2002') return true;
  if (e?.code === 'P2010' && e?.meta?.code === '23505') return true;
  if (typeof e?.message === 'string' && e.message.includes('23505')) return true;
  return false;
}

/**
 * SQLSTATE 23514 = check_violation. Used by the budget commitment
 * release paths in PurchaseOrderService to surface accounting drift
 * (a release that would push encumbered_amount below zero) instead
 * of silently clamping to 0. REVIEW-FINAL-2026-05-07 MIN-8.1.
 */
export function isCheckViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e?.code === 'P2010' && e?.meta?.code === '23514') return true;
  if (typeof e?.message === 'string' && e.message.includes('23514')) return true;
  return false;
}

interface ReqRow {
  id: string;
  school_id: string;
  requesting_person_id: string;
  requesting_person_name: string | null;
  requesting_department: string | null;
  urgency: string;
  status: string;
  approval_request_id: string | null;
  total_estimated_cost: string | number | null;
  budget_line_id: string | null;
  budget_account_code: string | null;
  justification: string;
  submitted_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface ReqLineRow {
  id: string;
  requisition_id: string;
  item_description: string;
  quantity: number;
  unit: string | null;
  estimated_unit_cost: string | number | null;
  specifications: string | null;
  preferred_vendor_id: string | null;
  preferred_vendor_name: string | null;
  destination_module: string;
  line_order: number;
}

const SELECT_REQ_BASE = `
  SELECT r.id::text AS id,
         r.school_id::text AS school_id,
         r.requesting_person_id::text AS requesting_person_id,
         (SELECT first_name || ' ' || last_name FROM platform.iam_person WHERE id = r.requesting_person_id) AS requesting_person_name,
         r.requesting_department,
         r.urgency,
         r.status,
         r.approval_request_id::text AS approval_request_id,
         r.total_estimated_cost,
         r.budget_line_id::text AS budget_line_id,
         (SELECT a.account_code FROM fin_budget_lines bl JOIN fin_chart_of_accounts a ON a.id = bl.account_id WHERE bl.id = r.budget_line_id) AS budget_account_code,
         r.justification,
         r.submitted_at::text AS submitted_at,
         r.reviewed_at::text AS reviewed_at,
         r.reviewed_by::text AS reviewed_by,
         (SELECT ip.first_name || ' ' || ip.last_name FROM hr_employees e JOIN platform.iam_person ip ON ip.id = e.person_id WHERE e.id = r.reviewed_by LIMIT 1) AS reviewed_by_name,
         r.rejection_reason,
         r.created_at::text AS created_at,
         r.updated_at::text AS updated_at
  FROM prc_requisitions r
`;

const ALLOWED_APPROVAL_TRANSITIONS: Record<string, ReqStatus[]> = {
  SUBMITTED: ['DEPT_APPROVED'],
  DEPT_APPROVED: ['ADMIN_APPROVED'],
  ADMIN_APPROVED: ['DISTRICT_APPROVED', 'ORDERED'],
};

@Injectable()
export class RequisitionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly financeValidation: FinanceValidationService,
  ) {}

  private isProcurementOfficer(actor: ResolvedActor): boolean {
    if (actor.isSchoolAdmin) return true;
    return actor.personType === 'STAFF';
  }

  private async loadLines(reqId: string): Promise<RequisitionLineDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT l.id::text AS id, l.requisition_id::text AS requisition_id, l.item_description, l.quantity, l.unit, l.estimated_unit_cost, l.specifications, l.preferred_vendor_id::text AS preferred_vendor_id, (SELECT supplier_name FROM fin_suppliers WHERE id = l.preferred_vendor_id) AS preferred_vendor_name, l.destination_module, l.line_order FROM prc_requisition_lines l WHERE l.requisition_id = $1::uuid ORDER BY l.line_order, l.id`,
        reqId,
      );
    })) as ReqLineRow[];
    return rows.map((r) => ({
      id: r.id,
      requisitionId: r.requisition_id,
      itemDescription: r.item_description,
      quantity: Number(r.quantity),
      unit: r.unit,
      estimatedUnitCost: r.estimated_unit_cost === null ? null : Number(r.estimated_unit_cost),
      specifications: r.specifications,
      preferredVendorId: r.preferred_vendor_id,
      preferredVendorName: r.preferred_vendor_name,
      destinationModule: r.destination_module as DestinationModule,
      lineOrder: Number(r.line_order),
    }));
  }

  private async toDto(r: ReqRow): Promise<RequisitionDto> {
    return {
      id: r.id,
      schoolId: r.school_id,
      requestingPersonId: r.requesting_person_id,
      requestingPersonName: r.requesting_person_name,
      requestingDepartment: r.requesting_department,
      urgency: r.urgency as ReqUrgency,
      status: r.status as ReqStatus,
      approvalRequestId: r.approval_request_id,
      totalEstimatedCost: Number(r.total_estimated_cost ?? 0),
      budgetLineId: r.budget_line_id,
      budgetAccountCode: r.budget_account_code,
      justification: r.justification,
      submittedAt: r.submitted_at,
      reviewedAt: r.reviewed_at,
      reviewedBy: r.reviewed_by,
      reviewedByName: r.reviewed_by_name,
      rejectionReason: r.rejection_reason,
      lines: await this.loadLines(r.id),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async list(actor: ResolvedActor, status?: string): Promise<RequisitionDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = [`r.school_id = $1::uuid`];
    const params: unknown[] = [tenant.schoolId];
    let i = 2;
    if (status) {
      where.push(`r.status = $${i++}`);
      params.push(status);
    }
    // Row-scope: non-procurement-officer actors see only their own requisitions.
    if (!this.isProcurementOfficer(actor)) {
      where.push(`r.requesting_person_id = $${i++}::uuid`);
      params.push(actor.personId);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_REQ_BASE + ` WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT 200`,
        ...params,
      );
    })) as ReqRow[];
    const out: RequisitionDto[] = [];
    for (const r of rows) out.push(await this.toDto(r));
    return out;
  }

  async getById(id: string, actor: ResolvedActor): Promise<RequisitionDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_REQ_BASE + ` WHERE r.id = $1::uuid AND r.school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as ReqRow[];
    if (rows.length === 0) throw new NotFoundException('Requisition not found');
    const r = rows[0]!;
    if (!this.isProcurementOfficer(actor) && r.requesting_person_id !== actor.personId) {
      // Don't leak existence to non-owner non-officer actors.
      throw new NotFoundException('Requisition not found');
    }
    return this.toDto(r);
  }

  async create(actor: ResolvedActor, input: CreateRequisitionDto): Promise<RequisitionDto> {
    // REVIEW-CYCLE27 BLOCKING 1 — validate soft refs before insert.
    if (input.budgetLineId) {
      await this.financeValidation.assertBudgetLineInCurrentTenant(
        input.budgetLineId,
        'budgetLineId',
      );
    }
    for (const line of input.lines) {
      if (line.preferredVendorId) {
        await this.financeValidation.assertActiveSupplier(
          line.preferredVendorId,
          'lines[].preferredVendorId',
        );
      }
    }
    const tenant = getCurrentTenant();
    const reqId = generateId();
    const totalEst = input.lines.reduce(
      (sum, l) => sum + (l.estimatedUnitCost ?? 0) * l.quantity,
      0,
    );
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO prc_requisitions (id, school_id, requesting_person_id, requesting_department, urgency, status, total_estimated_cost, budget_line_id, justification) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'DRAFT', $6, $7::uuid, $8)`,
        reqId,
        tenant.schoolId,
        actor.personId,
        input.requestingDepartment ?? null,
        input.urgency ?? 'ROUTINE',
        totalEst,
        input.budgetLineId ?? null,
        input.justification,
      );
      let order = 0;
      for (const line of input.lines) {
        await this.insertLine(tx, reqId, line, order++);
      }
    });
    return this.getById(reqId, actor);
  }

  async addLine(
    actor: ResolvedActor,
    reqId: string,
    input: CreateRequisitionLineDto,
  ): Promise<RequisitionDto> {
    // REVIEW-CYCLE27 BLOCKING 1 — validate preferred vendor before insert.
    if (input.preferredVendorId) {
      await this.financeValidation.assertActiveSupplier(
        input.preferredVendorId,
        'preferredVendorId',
      );
    }
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT requesting_person_id::text AS requesting_person_id, status FROM prc_requisitions WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE`,
        reqId,
        tenant.schoolId,
      )) as Array<{ requesting_person_id: string; status: string }>;
      if (rows.length === 0) throw new NotFoundException('Requisition not found');
      const r = rows[0]!;
      if (!actor.isSchoolAdmin && r.requesting_person_id !== actor.personId) {
        throw new ForbiddenException('Only the requester or an admin may modify a requisition');
      }
      if (r.status !== 'DRAFT') {
        throw new BadRequestException('Only DRAFT requisitions can be modified');
      }
      const orderRows = (await tx.$queryRawUnsafe(
        `SELECT COALESCE(MAX(line_order) + 1, 0) AS next_order FROM prc_requisition_lines WHERE requisition_id = $1::uuid`,
        reqId,
      )) as Array<{ next_order: number | string }>;
      await this.insertLine(tx, reqId, input, Number(orderRows[0]!.next_order));
      // Recompute total
      await tx.$executeRawUnsafe(
        `UPDATE prc_requisitions SET total_estimated_cost = (SELECT COALESCE(SUM(quantity * COALESCE(estimated_unit_cost, 0)), 0) FROM prc_requisition_lines WHERE requisition_id = $1::uuid), updated_at = now() WHERE id = $1::uuid`,
        reqId,
      );
    });
    return this.getById(reqId, actor);
  }

  async removeLine(actor: ResolvedActor, lineId: string): Promise<void> {
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT r.id::text AS req_id, r.status, r.requesting_person_id::text AS requesting_person_id FROM prc_requisition_lines l JOIN prc_requisitions r ON r.id = l.requisition_id WHERE l.id = $1::uuid AND r.school_id = $2::uuid FOR UPDATE OF r`,
        lineId,
        tenant.schoolId,
      )) as Array<{ req_id: string; status: string; requesting_person_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Requisition line not found');
      const r = rows[0]!;
      if (!actor.isSchoolAdmin && r.requesting_person_id !== actor.personId) {
        throw new ForbiddenException('Only the requester or an admin may modify a requisition');
      }
      if (r.status !== 'DRAFT') {
        throw new BadRequestException('Only DRAFT requisitions can have lines removed');
      }
      await tx.$executeRawUnsafe(`DELETE FROM prc_requisition_lines WHERE id = $1::uuid`, lineId);
      await tx.$executeRawUnsafe(
        `UPDATE prc_requisitions SET total_estimated_cost = (SELECT COALESCE(SUM(quantity * COALESCE(estimated_unit_cost, 0)), 0) FROM prc_requisition_lines WHERE requisition_id = $1::uuid), updated_at = now() WHERE id = $1::uuid`,
        r.req_id,
      );
    });
  }

  async submit(actor: ResolvedActor, reqId: string): Promise<RequisitionDto> {
    const tenant = getCurrentTenant();
    let payload: {
      requisitionId: string;
      sourceRefId: string;
      schoolId: string;
      requestingPersonId: string;
      totalEstimatedCost: number;
      urgency: ReqUrgency;
      budgetLineId: string | null;
    } | null = null;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT requesting_person_id::text AS requesting_person_id, status, total_estimated_cost, urgency, budget_line_id::text AS budget_line_id FROM prc_requisitions WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE`,
        reqId,
        tenant.schoolId,
      )) as Array<{
        requesting_person_id: string;
        status: string;
        total_estimated_cost: string | number;
        urgency: string;
        budget_line_id: string | null;
      }>;
      if (rows.length === 0) throw new NotFoundException('Requisition not found');
      const r = rows[0]!;
      if (!actor.isSchoolAdmin && r.requesting_person_id !== actor.personId) {
        throw new ForbiddenException('Only the requester or an admin may submit this requisition');
      }
      if (r.status !== 'DRAFT') {
        throw new BadRequestException(
          `Only DRAFT requisitions can be submitted (current: ${r.status})`,
        );
      }
      // Pre-flight: budget remaining check (when budget_line_id supplied)
      if (r.budget_line_id) {
        const blRows = (await tx.$queryRawUnsafe(
          `SELECT budgeted_amount, actual_amount, encumbered_amount FROM fin_budget_lines WHERE id = $1::uuid LIMIT 1`,
          r.budget_line_id,
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
        const total = Number(r.total_estimated_cost);
        if (total > remaining + 0.005) {
          throw new BadRequestException(
            `Insufficient budget remaining on this line. Requesting ${total.toFixed(2)}, remaining ${remaining.toFixed(2)}.`,
          );
        }
      }
      // Check at least one line
      const lineCount = (await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM prc_requisition_lines WHERE requisition_id = $1::uuid`,
        reqId,
      )) as Array<{ n: number }>;
      if (lineCount[0]!.n === 0) {
        throw new BadRequestException('Cannot submit a requisition with no lines');
      }
      await tx.$executeRawUnsafe(
        `UPDATE prc_requisitions SET status = 'SUBMITTED', submitted_at = now(), updated_at = now() WHERE id = $1::uuid`,
        reqId,
      );
      payload = {
        requisitionId: reqId,
        sourceRefId: reqId,
        schoolId: tenant.schoolId,
        requestingPersonId: r.requesting_person_id,
        totalEstimatedCost: Number(r.total_estimated_cost),
        urgency: r.urgency as ReqUrgency,
        budgetLineId: r.budget_line_id,
      };
    });
    if (payload) {
      await this.kafka.emit({
        topic: 'prc.requisition.submitted',
        key: reqId,
        payload,
        sourceModule: 'procurement',
      });
    }
    return this.getById(reqId, actor);
  }

  async approve(
    actor: ResolvedActor,
    reqId: string,
    input: ApproveRequisitionDto,
  ): Promise<RequisitionDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException(
        'Only school admins (or future approval engine) may approve requisitions',
      );
    }
    if (!actor.employeeId) {
      throw new BadRequestException('Approval requires an employee actor');
    }
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT status FROM prc_requisitions WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE`,
        reqId,
        tenant.schoolId,
      )) as Array<{ status: string }>;
      if (rows.length === 0) throw new NotFoundException('Requisition not found');
      const current = rows[0]!.status;
      const allowed = ALLOWED_APPROVAL_TRANSITIONS[current] ?? [];
      if (!allowed.includes(input.toStatus)) {
        throw new BadRequestException(
          `Cannot transition requisition from ${current} to ${input.toStatus}. Allowed: ${allowed.join(', ') || 'none'}.`,
        );
      }
      await tx.$executeRawUnsafe(
        `UPDATE prc_requisitions SET status = $1, reviewed_at = now(), reviewed_by = $2::uuid, updated_at = now() WHERE id = $3::uuid`,
        input.toStatus,
        actor.employeeId,
        reqId,
      );
    });
    return this.getById(reqId, actor);
  }

  async reject(
    actor: ResolvedActor,
    reqId: string,
    input: RejectRequisitionDto,
  ): Promise<RequisitionDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins may reject requisitions');
    }
    if (!actor.employeeId) {
      throw new BadRequestException('Rejection requires an employee actor');
    }
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT status FROM prc_requisitions WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE`,
        reqId,
        tenant.schoolId,
      )) as Array<{ status: string }>;
      if (rows.length === 0) throw new NotFoundException('Requisition not found');
      const current = rows[0]!.status;
      if (['CLOSED', 'REJECTED', 'DISTRIBUTED'].includes(current)) {
        throw new BadRequestException(`Cannot reject a ${current} requisition`);
      }
      await tx.$executeRawUnsafe(
        `UPDATE prc_requisitions SET status = 'REJECTED', reviewed_at = now(), reviewed_by = $1::uuid, rejection_reason = $2, updated_at = now() WHERE id = $3::uuid`,
        actor.employeeId,
        input.reason,
        reqId,
      );
    });
    return this.getById(reqId, actor);
  }

  /** Public helper used by PurchaseOrderService.create-from-requisition. */
  async markOrdered(_actor: ResolvedActor, reqId: string): Promise<void> {
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `UPDATE prc_requisitions SET status = 'ORDERED', updated_at = now() WHERE id = $1::uuid AND school_id = $2::uuid AND status IN ('ADMIN_APPROVED', 'DISTRICT_APPROVED')`,
        reqId,
        tenant.schoolId,
      );
    });
  }

  private async insertLine(
    tx: PrismaClient,
    reqId: string,
    line: CreateRequisitionLineDto,
    order: number,
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      `INSERT INTO prc_requisition_lines (id, requisition_id, item_description, quantity, unit, estimated_unit_cost, specifications, preferred_vendor_id, destination_module, line_order) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid, $9, $10)`,
      generateId(),
      reqId,
      line.itemDescription,
      line.quantity,
      line.unit ?? null,
      line.estimatedUnitCost ?? null,
      line.specifications ?? null,
      line.preferredVendorId ?? null,
      line.destinationModule,
      order,
    );
  }
}
