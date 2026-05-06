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
import type {
  CreateDistributionDto,
  CreateReturnDto,
  DistDestinationModule,
  DistributionDto,
  DistributionLineDto,
  ProcurementSettingsDto,
  ReturnDto,
  ReturnResolution,
  ReturnStatus,
  ReturnType,
  UpdateProcurementSettingsDto,
  UpdateReturnDto,
  VendorPerformanceDto,
} from './dto/procurement.dto';

@Injectable()
export class DistributionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  private isProcurementOfficer(actor: ResolvedActor): boolean {
    if (actor.isSchoolAdmin) return true;
    return actor.personType === 'STAFF';
  }

  private async loadLines(distributionId: string): Promise<DistributionLineDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT dl.id::text AS id, dl.distribution_id::text AS distribution_id, dl.receipt_line_id::text AS receipt_line_id, dl.quantity_distributed, dl.item_description, dl.unit_cost FROM prc_distribution_lines dl WHERE dl.distribution_id = $1::uuid ORDER BY dl.id`,
        distributionId,
      );
    })) as Array<{
      id: string;
      distribution_id: string;
      receipt_line_id: string;
      quantity_distributed: number;
      item_description: string;
      unit_cost: string | number | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      distributionId: r.distribution_id,
      receiptLineId: r.receipt_line_id,
      quantityDistributed: Number(r.quantity_distributed),
      itemDescription: r.item_description,
      unitCost: r.unit_cost === null ? null : Number(r.unit_cost),
    }));
  }

  async listForReceipt(receiptId: string): Promise<DistributionDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT d.id::text AS id, d.receipt_id::text AS receipt_id, d.distributed_by::text AS distributed_by, (SELECT ip.first_name || ' ' || ip.last_name FROM hr_employees e JOIN platform.iam_person ip ON ip.id = e.person_id WHERE e.id = d.distributed_by LIMIT 1) AS distributed_by_name, d.distributed_at::text AS distributed_at, d.destination_module, d.destination_department, d.notes FROM prc_distributions d WHERE d.receipt_id = $1::uuid ORDER BY d.distributed_at DESC`,
        receiptId,
      );
    })) as Array<{
      id: string;
      receipt_id: string;
      distributed_by: string;
      distributed_by_name: string | null;
      distributed_at: string;
      destination_module: string;
      destination_department: string | null;
      notes: string | null;
    }>;
    const out: DistributionDto[] = [];
    for (const r of rows) {
      out.push({
        id: r.id,
        receiptId: r.receipt_id,
        distributedBy: r.distributed_by,
        distributedByName: r.distributed_by_name,
        distributedAt: r.distributed_at,
        destinationModule: r.destination_module as DistDestinationModule,
        destinationDepartment: r.destination_department,
        notes: r.notes,
        lines: await this.loadLines(r.id),
      });
    }
    return out;
  }

  /**
   * CROSS-MODULE DISTRIBUTION KEYSTONE.
   *
   * Creates the distribution row + lines inside one tenant tx,
   * validates every receipt line exists under the parent receipt + has
   * sufficient un-distributed quantity, and emits
   * `prc.distribution.completed` AFTER tx commits with the
   * destination_module set so downstream modules (tech / trn / fds /
   * lib / ath / ext / fac / str) can react.
   */
  async create(
    actor: ResolvedActor,
    receiptId: string,
    input: CreateDistributionDto,
  ): Promise<DistributionDto> {
    if (!this.isProcurementOfficer(actor)) {
      throw new ForbiddenException(
        'Only procurement staff or admins may distribute received goods',
      );
    }
    if (!actor.employeeId) {
      throw new BadRequestException('Distribution requires an employee actor');
    }
    const tenant = getCurrentTenant();
    const distributionId = generateId();
    let poId: string | null = null;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const receiptRows = (await tx.$queryRawUnsafe(
        `SELECT gr.purchase_order_id::text AS purchase_order_id, (SELECT po_number FROM prc_purchase_orders WHERE id = gr.purchase_order_id) AS po_number FROM prc_goods_receipts gr WHERE gr.id = $1::uuid LIMIT 1`,
        receiptId,
      )) as Array<{ purchase_order_id: string; po_number: string }>;
      if (receiptRows.length === 0) throw new NotFoundException('Goods receipt not found');
      poId = receiptRows[0]!.purchase_order_id;
      // Validate each line + lock receipt lines
      for (const line of input.lines) {
        const rl = (await tx.$queryRawUnsafe(
          `SELECT rl.quantity_accepted, COALESCE((SELECT SUM(quantity_distributed)::int FROM prc_distribution_lines WHERE receipt_line_id = rl.id), 0) AS already_distributed FROM prc_goods_receipt_lines rl WHERE rl.id = $1::uuid AND rl.receipt_id = $2::uuid FOR UPDATE OF rl LIMIT 1`,
          line.receiptLineId,
          receiptId,
        )) as Array<{ quantity_accepted: number; already_distributed: number }>;
        if (rl.length === 0) {
          throw new BadRequestException(
            `receipt_line_id ${line.receiptLineId} does not belong to this receipt`,
          );
        }
        const remaining = Number(rl[0]!.quantity_accepted) - Number(rl[0]!.already_distributed);
        if (line.quantityDistributed > remaining) {
          throw new BadRequestException(
            `quantity_distributed ${line.quantityDistributed} exceeds remaining accepted ${remaining} on receipt line ${line.receiptLineId}`,
          );
        }
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO prc_distributions (id, receipt_id, distributed_by, distributed_at, destination_module, destination_department, notes) VALUES ($1::uuid, $2::uuid, $3::uuid, now(), $4, $5, $6)`,
        distributionId,
        receiptId,
        actor.employeeId,
        input.destinationModule,
        input.destinationDepartment ?? null,
        input.notes ?? null,
      );
      for (const line of input.lines) {
        await tx.$executeRawUnsafe(
          `INSERT INTO prc_distribution_lines (id, distribution_id, receipt_line_id, quantity_distributed, item_description, unit_cost) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)`,
          generateId(),
          distributionId,
          line.receiptLineId,
          line.quantityDistributed,
          line.itemDescription,
          line.unitCost ?? null,
        );
      }
      // Mark linked requisition as DISTRIBUTED if PO is RECEIVED
      await tx.$executeRawUnsafe(
        `UPDATE prc_requisitions SET status = 'DISTRIBUTED', updated_at = now() WHERE id = (SELECT requisition_id FROM prc_purchase_orders WHERE id = $1::uuid) AND status = 'RECEIVED'`,
        poId,
      );
    });

    const all = await this.listForReceipt(receiptId);
    const created = all.find((d) => d.id === distributionId);
    if (!created) throw new NotFoundException('Distribution not found post-insert');

    // Emit AFTER tx commits — broker hiccup must not roll back the user's action.
    await this.kafka.emit({
      topic: 'prc.distribution.completed',
      key: distributionId,
      sourceModule: 'procurement',
      payload: {
        distributionId,
        receiptId,
        purchaseOrderId: poId,
        schoolId: tenant.schoolId,
        destinationModule: input.destinationModule,
        destinationDepartment: input.destinationDepartment ?? null,
        distributedAt: created.distributedAt,
        sourceRefId: distributionId,
        lines: created.lines.map((l) => ({
          receiptLineId: l.receiptLineId,
          itemDescription: l.itemDescription,
          quantity: l.quantityDistributed,
          unitCost: l.unitCost,
        })),
      },
    });

    return created;
  }
}

const RESOLVED_STATUSES: ReturnStatus[] = ['RESOLVED'];

interface ReturnRow {
  id: string;
  receipt_line_id: string;
  return_type: string;
  quantity_returned: number;
  return_reference: string | null;
  vendor_rma_number: string | null;
  status: string;
  resolution: string | null;
  resolution_notes: string | null;
  initiated_by: string;
  initiated_by_name: string | null;
  initiated_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

@Injectable()
export class ReturnService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private isProcurementOfficer(actor: ResolvedActor): boolean {
    if (actor.isSchoolAdmin) return true;
    return actor.personType === 'STAFF';
  }

  private toDto(r: ReturnRow): ReturnDto {
    return {
      id: r.id,
      receiptLineId: r.receipt_line_id,
      returnType: r.return_type as ReturnType,
      quantityReturned: Number(r.quantity_returned),
      returnReference: r.return_reference,
      vendorRmaNumber: r.vendor_rma_number,
      status: r.status as ReturnStatus,
      resolution: r.resolution as ReturnResolution | null,
      resolutionNotes: r.resolution_notes,
      initiatedBy: r.initiated_by,
      initiatedByName: r.initiated_by_name,
      initiatedAt: r.initiated_at,
      resolvedAt: r.resolved_at,
      resolvedBy: r.resolved_by,
    };
  }

  async listForReceiptLine(receiptLineId: string): Promise<ReturnDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT r.id::text AS id, r.receipt_line_id::text AS receipt_line_id, r.return_type, r.quantity_returned, r.return_reference, r.vendor_rma_number, r.status, r.resolution, r.resolution_notes, r.initiated_by::text AS initiated_by, (SELECT ip.first_name || ' ' || ip.last_name FROM hr_employees e JOIN platform.iam_person ip ON ip.id = e.person_id WHERE e.id = r.initiated_by LIMIT 1) AS initiated_by_name, r.initiated_at::text AS initiated_at, r.resolved_at::text AS resolved_at, r.resolved_by::text AS resolved_by FROM prc_returns r WHERE r.receipt_line_id = $1::uuid ORDER BY r.initiated_at DESC`,
        receiptLineId,
      );
    })) as ReturnRow[];
    return rows.map((r) => this.toDto(r));
  }

  async listAll(filter?: { status?: string }): Promise<ReturnDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = [
      `EXISTS (SELECT 1 FROM prc_goods_receipt_lines rl JOIN prc_goods_receipts gr ON gr.id = rl.receipt_id JOIN prc_purchase_orders po ON po.id = gr.purchase_order_id WHERE rl.id = r.receipt_line_id AND po.school_id = $1::uuid)`,
    ];
    const params: unknown[] = [tenant.schoolId];
    let i = 2;
    if (filter?.status) {
      where.push(`r.status = $${i++}`);
      params.push(filter.status);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT r.id::text AS id, r.receipt_line_id::text AS receipt_line_id, r.return_type, r.quantity_returned, r.return_reference, r.vendor_rma_number, r.status, r.resolution, r.resolution_notes, r.initiated_by::text AS initiated_by, (SELECT ip.first_name || ' ' || ip.last_name FROM hr_employees e JOIN platform.iam_person ip ON ip.id = e.person_id WHERE e.id = r.initiated_by LIMIT 1) AS initiated_by_name, r.initiated_at::text AS initiated_at, r.resolved_at::text AS resolved_at, r.resolved_by::text AS resolved_by FROM prc_returns r WHERE ${where.join(' AND ')} ORDER BY r.initiated_at DESC LIMIT 200`,
        ...params,
      );
    })) as ReturnRow[];
    return rows.map((r) => this.toDto(r));
  }

  async getById(id: string): Promise<ReturnDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT r.id::text AS id, r.receipt_line_id::text AS receipt_line_id, r.return_type, r.quantity_returned, r.return_reference, r.vendor_rma_number, r.status, r.resolution, r.resolution_notes, r.initiated_by::text AS initiated_by, (SELECT ip.first_name || ' ' || ip.last_name FROM hr_employees e JOIN platform.iam_person ip ON ip.id = e.person_id WHERE e.id = r.initiated_by LIMIT 1) AS initiated_by_name, r.initiated_at::text AS initiated_at, r.resolved_at::text AS resolved_at, r.resolved_by::text AS resolved_by FROM prc_returns r WHERE r.id = $1::uuid LIMIT 1`,
        id,
      );
    })) as ReturnRow[];
    if (rows.length === 0) throw new NotFoundException('Return not found');
    return this.toDto(rows[0]!);
  }

  async create(
    actor: ResolvedActor,
    receiptLineId: string,
    input: CreateReturnDto,
  ): Promise<ReturnDto> {
    if (!this.isProcurementOfficer(actor)) {
      throw new ForbiddenException('Only procurement staff or admins may initiate returns');
    }
    if (!actor.employeeId) {
      throw new BadRequestException('Return initiation requires an employee actor');
    }
    const tenant = getCurrentTenant();
    const returnId = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Validate receipt line belongs to this school + has sufficient quantity_received
      const rows = (await tx.$queryRawUnsafe(
        `SELECT rl.quantity_received, COALESCE((SELECT SUM(quantity_returned)::int FROM prc_returns WHERE receipt_line_id = rl.id AND status <> 'CANCELLED'), 0) AS already_returned, po.school_id::text AS school_id FROM prc_goods_receipt_lines rl JOIN prc_goods_receipts gr ON gr.id = rl.receipt_id JOIN prc_purchase_orders po ON po.id = gr.purchase_order_id WHERE rl.id = $1::uuid LIMIT 1`,
        receiptLineId,
      )) as Array<{ quantity_received: number; already_returned: number; school_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Receipt line not found');
      if (rows[0]!.school_id !== tenant.schoolId) {
        throw new NotFoundException('Receipt line not found');
      }
      const remaining = Number(rows[0]!.quantity_received) - Number(rows[0]!.already_returned);
      if (input.quantityReturned > remaining) {
        throw new BadRequestException(
          `quantity_returned ${input.quantityReturned} exceeds remaining ${remaining} on receipt line`,
        );
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO prc_returns (id, receipt_line_id, return_type, quantity_returned, return_reference, vendor_rma_number, status, initiated_by, initiated_at) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, 'INITIATED', $7::uuid, now())`,
        returnId,
        receiptLineId,
        input.returnType,
        input.quantityReturned,
        input.returnReference ?? null,
        input.vendorRmaNumber ?? null,
        actor.employeeId,
      );
    });
    return this.getById(returnId);
  }

  async update(actor: ResolvedActor, returnId: string, input: UpdateReturnDto): Promise<ReturnDto> {
    if (!this.isProcurementOfficer(actor)) {
      throw new ForbiddenException('Only procurement staff or admins may update returns');
    }
    if (!actor.employeeId) {
      throw new BadRequestException('Return update requires an employee actor');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT status FROM prc_returns WHERE id = $1::uuid FOR UPDATE`,
        returnId,
      )) as Array<{ status: string }>;
      if (rows.length === 0) throw new NotFoundException('Return not found');
      const current = rows[0]!.status as ReturnStatus;
      if (input.action === 'SHIP') {
        if (current !== 'INITIATED') {
          throw new BadRequestException(`Cannot ship return in status ${current}`);
        }
        await tx.$executeRawUnsafe(
          `UPDATE prc_returns SET status = 'SHIPPED_TO_VENDOR', updated_at = now() WHERE id = $1::uuid`,
          returnId,
        );
      } else if (input.action === 'RESOLVE') {
        if (current !== 'SHIPPED_TO_VENDOR' && current !== 'INITIATED') {
          throw new BadRequestException(
            `Cannot resolve return in status ${current}. Must be INITIATED or SHIPPED_TO_VENDOR.`,
          );
        }
        if (!input.resolution) {
          throw new BadRequestException('resolution is required when action=RESOLVE');
        }
        await tx.$executeRawUnsafe(
          `UPDATE prc_returns SET status = 'RESOLVED', resolution = $1, resolution_notes = $2, resolved_at = now(), resolved_by = $3::uuid, updated_at = now() WHERE id = $4::uuid`,
          input.resolution,
          input.resolutionNotes ?? null,
          actor.employeeId,
          returnId,
        );
      } else if (input.action === 'CANCEL') {
        if (RESOLVED_STATUSES.includes(current)) {
          throw new BadRequestException('Cannot cancel a RESOLVED return');
        }
        await tx.$executeRawUnsafe(
          `UPDATE prc_returns SET status = 'CANCELLED', updated_at = now() WHERE id = $1::uuid`,
          returnId,
        );
      }
    });
    return this.getById(returnId);
  }
}

@Injectable()
export class VendorPerformanceService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(): Promise<VendorPerformanceDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT vp.id::text AS id, vp.vendor_id::text AS vendor_id, (SELECT supplier_name FROM fin_suppliers WHERE id = vp.vendor_id) AS vendor_name, vp.school_id::text AS school_id, vp.total_orders, vp.on_time_deliveries, vp.late_deliveries, vp.accepted_count, vp.rejected_count, vp.average_quality_score, vp.average_delivery_score, vp.last_updated_at::text AS last_updated_at FROM prc_vendor_performance vp WHERE vp.school_id = $1::uuid ORDER BY vp.last_updated_at DESC`,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      vendor_id: string;
      vendor_name: string | null;
      school_id: string;
      total_orders: number;
      on_time_deliveries: number;
      late_deliveries: number;
      accepted_count: number;
      rejected_count: number;
      average_quality_score: string | number | null;
      average_delivery_score: string | number | null;
      last_updated_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      vendorId: r.vendor_id,
      vendorName: r.vendor_name,
      schoolId: r.school_id,
      totalOrders: Number(r.total_orders),
      onTimeDeliveries: Number(r.on_time_deliveries),
      lateDeliveries: Number(r.late_deliveries),
      acceptedCount: Number(r.accepted_count),
      rejectedCount: Number(r.rejected_count),
      averageQualityScore:
        r.average_quality_score === null ? null : Number(r.average_quality_score),
      averageDeliveryScore:
        r.average_delivery_score === null ? null : Number(r.average_delivery_score),
      lastUpdatedAt: r.last_updated_at,
    }));
  }

  async getForVendor(vendorId: string): Promise<VendorPerformanceDto | null> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT vp.id::text AS id, vp.vendor_id::text AS vendor_id, (SELECT supplier_name FROM fin_suppliers WHERE id = vp.vendor_id) AS vendor_name, vp.school_id::text AS school_id, vp.total_orders, vp.on_time_deliveries, vp.late_deliveries, vp.accepted_count, vp.rejected_count, vp.average_quality_score, vp.average_delivery_score, vp.last_updated_at::text AS last_updated_at FROM prc_vendor_performance vp WHERE vp.vendor_id = $1::uuid AND vp.school_id = $2::uuid LIMIT 1`,
        vendorId,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      vendor_id: string;
      vendor_name: string | null;
      school_id: string;
      total_orders: number;
      on_time_deliveries: number;
      late_deliveries: number;
      accepted_count: number;
      rejected_count: number;
      average_quality_score: string | number | null;
      average_delivery_score: string | number | null;
      last_updated_at: string;
    }>;
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      id: r.id,
      vendorId: r.vendor_id,
      vendorName: r.vendor_name,
      schoolId: r.school_id,
      totalOrders: Number(r.total_orders),
      onTimeDeliveries: Number(r.on_time_deliveries),
      lateDeliveries: Number(r.late_deliveries),
      acceptedCount: Number(r.accepted_count),
      rejectedCount: Number(r.rejected_count),
      averageQualityScore:
        r.average_quality_score === null ? null : Number(r.average_quality_score),
      averageDeliveryScore:
        r.average_delivery_score === null ? null : Number(r.average_delivery_score),
      lastUpdatedAt: r.last_updated_at,
    };
  }
}

@Injectable()
export class ProcurementSettingsService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async get(): Promise<ProcurementSettingsDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, auto_po_threshold, default_payment_terms, po_number_prefix, po_number_next_seq, require_three_quotes_above FROM prc_procurement_settings WHERE school_id = $1::uuid LIMIT 1`,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      auto_po_threshold: string | number | null;
      default_payment_terms: string;
      po_number_prefix: string;
      po_number_next_seq: number;
      require_three_quotes_above: string | number | null;
    }>;
    if (rows.length === 0) {
      // Auto-create defaults
      const id = generateId();
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `INSERT INTO prc_procurement_settings (id, school_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT (school_id) DO NOTHING`,
          id,
          tenant.schoolId,
        );
      });
      return this.get();
    }
    const r = rows[0]!;
    return {
      id: r.id,
      schoolId: r.school_id,
      autoPoThreshold: r.auto_po_threshold === null ? null : Number(r.auto_po_threshold),
      defaultPaymentTerms: r.default_payment_terms,
      poNumberPrefix: r.po_number_prefix,
      poNumberNextSeq: Number(r.po_number_next_seq),
      requireThreeQuotesAbove:
        r.require_three_quotes_above === null ? null : Number(r.require_three_quotes_above),
    };
  }

  async update(
    actor: ResolvedActor,
    input: UpdateProcurementSettingsDto,
  ): Promise<ProcurementSettingsDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins may update procurement settings');
    }
    const tenant = getCurrentTenant();
    const fields: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (input.autoPoThreshold !== undefined) {
      fields.push(`auto_po_threshold = $${i++}`);
      params.push(input.autoPoThreshold);
    }
    if (input.defaultPaymentTerms !== undefined) {
      fields.push(`default_payment_terms = $${i++}`);
      params.push(input.defaultPaymentTerms);
    }
    if (input.poNumberPrefix !== undefined) {
      fields.push(`po_number_prefix = $${i++}`);
      params.push(input.poNumberPrefix);
    }
    if (input.requireThreeQuotesAbove !== undefined) {
      fields.push(`require_three_quotes_above = $${i++}`);
      params.push(input.requireThreeQuotesAbove);
    }
    if (fields.length > 0) {
      params.push(tenant.schoolId);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `UPDATE prc_procurement_settings SET ${fields.join(', ')}, updated_at = now() WHERE school_id = $${i}::uuid`,
          ...params,
        );
      });
    }
    return this.get();
  }
}
