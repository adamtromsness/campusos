import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import { assertCanManage } from './buildings.service';
import {
  CreateWorkOrderAttachmentDto,
  CreateWorkOrderPartDto,
  WorkOrderAttachmentResponseDto,
  WorkOrderAttachmentType,
  WorkOrderCostSummaryResponseDto,
  WorkOrderPartResponseDto,
} from './dto/facilities.dto';

/**
 * WorkOrderDepthService — P2-18a Step 2.
 *
 * Per-work-order attachments + parts consumption tracking, plus the
 * cost-summary endpoint that SUMs material costs alongside the parent
 * work order's labour cost.
 */
@Injectable()
export class WorkOrderDepthService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async listAttachments(workOrderId: string): Promise<WorkOrderAttachmentResponseDto[]> {
    await this.assertWorkOrderInTenant(workOrderId);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT a.id::text AS id, a.work_order_id::text AS work_order_id, a.s3_key, a.filename, ' +
          'a.attachment_type, a.file_size_bytes, a.uploaded_by::text AS uploaded_by, a.uploaded_at, ' +
          "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip WHERE ip.id = a.uploaded_by) AS uploaded_by_name " +
          'FROM fac_work_order_attachments a WHERE a.work_order_id = $1::uuid ORDER BY a.uploaded_at DESC',
        workOrderId,
      );
    })) as Array<{
      id: string;
      work_order_id: string;
      s3_key: string;
      filename: string;
      attachment_type: string;
      file_size_bytes: number | bigint | null;
      uploaded_by: string;
      uploaded_at: Date;
      uploaded_by_name: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      workOrderId: r.work_order_id,
      s3Key: r.s3_key,
      filename: r.filename,
      attachmentType: r.attachment_type as WorkOrderAttachmentType,
      fileSizeBytes:
        r.file_size_bytes === null
          ? null
          : typeof r.file_size_bytes === 'bigint'
            ? Number(r.file_size_bytes)
            : r.file_size_bytes,
      uploadedBy: r.uploaded_by,
      uploadedByName: r.uploaded_by_name,
      uploadedAt: r.uploaded_at.toISOString(),
    }));
  }

  async addAttachment(
    workOrderId: string,
    input: CreateWorkOrderAttachmentDto,
    actor: ResolvedActor,
  ): Promise<WorkOrderAttachmentResponseDto> {
    await assertCanManage(actor, this.permCheck);
    if (!actor.personId) {
      throw new ForbiddenException('Attachment upload requires an authenticated person');
    }
    await this.assertWorkOrderInTenant(workOrderId);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO fac_work_order_attachments ' +
          '(id, work_order_id, s3_key, filename, attachment_type, file_size_bytes, uploaded_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid)',
        id,
        workOrderId,
        input.s3Key,
        input.filename,
        input.attachmentType ?? 'OTHER',
        input.fileSizeBytes ?? null,
        actor.personId,
      );
    });
    const all = await this.listAttachments(workOrderId);
    const found = all.find((a) => a.id === id);
    if (!found) throw new NotFoundException('Attachment not found after insert');
    return found;
  }

  async listParts(workOrderId: string): Promise<WorkOrderPartResponseDto[]> {
    await this.assertWorkOrderInTenant(workOrderId);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT p.id::text AS id, p.work_order_id::text AS work_order_id, p.part_name, ' +
          'p.quantity::float AS quantity, p.unit, p.unit_cost::float AS unit_cost, ' +
          'p.total_cost::float AS total_cost, p.supplier, p.notes ' +
          'FROM fac_work_order_parts p WHERE p.work_order_id = $1::uuid ORDER BY p.created_at',
        workOrderId,
      );
    })) as Array<{
      id: string;
      work_order_id: string;
      part_name: string;
      quantity: number;
      unit: string | null;
      unit_cost: number | null;
      total_cost: number | null;
      supplier: string | null;
      notes: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      workOrderId: r.work_order_id,
      partName: r.part_name,
      quantity: r.quantity,
      unit: r.unit,
      unitCost: r.unit_cost,
      totalCost: r.total_cost,
      supplier: r.supplier,
      notes: r.notes,
    }));
  }

  async addPart(
    workOrderId: string,
    input: CreateWorkOrderPartDto,
    actor: ResolvedActor,
  ): Promise<WorkOrderPartResponseDto> {
    await assertCanManage(actor, this.permCheck);
    await this.assertWorkOrderInTenant(workOrderId);
    // Auto-compute total_cost when both unit_cost + quantity are present
    // and the caller did not supply a total_cost override.
    let total_cost: number | null = input.totalCost ?? null;
    if (total_cost === null && input.unitCost !== undefined && input.unitCost !== null) {
      total_cost = Number((input.unitCost * input.quantity).toFixed(2));
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO fac_work_order_parts ' +
          '(id, work_order_id, part_name, quantity, unit, unit_cost, total_cost, supplier, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)',
        id,
        workOrderId,
        input.partName,
        input.quantity,
        input.unit ?? null,
        input.unitCost ?? null,
        total_cost,
        input.supplier ?? null,
        input.notes ?? null,
      );
    });
    const all = await this.listParts(workOrderId);
    const found = all.find((p) => p.id === id);
    if (!found) throw new NotFoundException('Part not found after insert');
    return found;
  }

  async getCostSummary(workOrderId: string): Promise<WorkOrderCostSummaryResponseDto> {
    await this.assertWorkOrderInTenant(workOrderId);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT ' +
          'COALESCE(SUM(p.total_cost), 0)::float AS parts_total, ' +
          'COUNT(p.id)::int AS parts_line_count, ' +
          '(SELECT w.cost::float FROM fac_work_orders w WHERE w.id = $1::uuid) AS labour_cost ' +
          'FROM fac_work_order_parts p WHERE p.work_order_id = $1::uuid',
        workOrderId,
      );
    })) as Array<{
      parts_total: number;
      parts_line_count: number;
      labour_cost: number | null;
    }>;
    const r = rows[0] ?? { parts_total: 0, parts_line_count: 0, labour_cost: null };
    const grand = (r.parts_total ?? 0) + (r.labour_cost ?? 0);
    return {
      workOrderId,
      partsTotal: r.parts_total ?? 0,
      partsLineCount: r.parts_line_count ?? 0,
      labourCost: r.labour_cost,
      grandTotal: Number(grand.toFixed(2)),
    };
  }

  private async assertWorkOrderInTenant(workOrderId: string): Promise<void> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM fac_work_orders WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        workOrderId,
        tenant.schoolId,
      );
    })) as Array<{ ok: number }>;
    if (rows.length === 0) {
      throw new BadRequestException('workOrderId does not match a work order in this school');
    }
  }
}
