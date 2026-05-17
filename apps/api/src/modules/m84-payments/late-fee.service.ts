import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import {
  LateFeeType,
  LateFeesScanResponseDto,
  LatePaymentPolicyResponseDto,
  UpsertLatePaymentPolicyDto,
} from './dto/billing-ops.dto';

interface PolicyRow {
  id: string;
  school_id: string;
  is_active: boolean;
  grace_period_days: number;
  fee_type: string;
  fee_amount: string | null;
  fee_percentage: string | null;
  max_late_fee_amount: string | null;
  applies_to_fee_category_id: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_BASE =
  'SELECT id, school_id, is_active, grace_period_days, fee_type, fee_amount::text, ' +
  'fee_percentage::text, max_late_fee_amount::text, applies_to_fee_category_id, ' +
  'created_at, updated_at FROM pay_late_payment_policies ';

function rowToDto(r: PolicyRow): LatePaymentPolicyResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    isActive: r.is_active,
    gracePeriodDays: r.grace_period_days,
    feeType: r.fee_type as LateFeeType,
    feeAmount: r.fee_amount === null ? null : Number(r.fee_amount),
    feePercentage: r.fee_percentage === null ? null : Number(r.fee_percentage),
    maxLateFeeAmount: r.max_late_fee_amount === null ? null : Number(r.max_late_fee_amount),
    appliesToFeeCategoryId: r.applies_to_fee_category_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * LateFeeService — Phase 2 Cycle 6 (P2-6).
 *
 * One late payment policy per school (UNIQUE(school_id) on the
 * schema). The policy is upserted by admins.
 *
 * runScan() is the LateFeesWorker entry point. Walks invoices that
 * are PAST due_date + grace_period_days, in status SENT or PARTIAL
 * or OVERDUE (not PAID, not DRAFT, not CANCELLED), without an
 * existing late-fee line item, and adds a late fee line item of
 * the configured amount (capped at max). Then bumps the invoice
 * total_amount and flips status to OVERDUE.
 */
@Injectable()
export class LateFeeService {
  private readonly logger = new Logger(LateFeeService.name);

  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async getPolicy(actor: ResolvedActor): Promise<LatePaymentPolicyResponseDto | null> {
    if (!actor.isSchoolAdmin)
      throw new ForbiddenException('Only admins can read the late payment policy');
    const schoolId = getCurrentTenant().schoolId;
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<PolicyRow[]>(SELECT_BASE + 'WHERE school_id = $1::uuid', schoolId),
    )) as PolicyRow[];
    if (rows.length === 0) return null;
    return rowToDto(rows[0]!);
  }

  async upsertPolicy(
    body: UpsertLatePaymentPolicyDto,
    actor: ResolvedActor,
  ): Promise<LatePaymentPolicyResponseDto> {
    if (!actor.isSchoolAdmin)
      throw new ForbiddenException('Only admins can configure the late payment policy');
    if (body.feeType === 'FIXED' && body.feeAmount === undefined) {
      throw new BadRequestException('feeAmount is required for FIXED feeType');
    }
    if (body.feeType === 'PERCENTAGE_MONTHLY' && body.feePercentage === undefined) {
      throw new BadRequestException('feePercentage is required for PERCENTAGE_MONTHLY feeType');
    }
    const schoolId = getCurrentTenant().schoolId;
    const existing = await this.getPolicyInternal(schoolId);
    if (existing) {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE pay_late_payment_policies SET is_active = COALESCE($2, is_active), grace_period_days = COALESCE($3, grace_period_days), ' +
            'fee_type = $4, fee_amount = $5::numeric, fee_percentage = $6::numeric, max_late_fee_amount = $7::numeric, ' +
            'applies_to_fee_category_id = $8, updated_at = now() WHERE id = $1::uuid',
          existing.id,
          body.isActive ?? null,
          body.gracePeriodDays ?? null,
          body.feeType,
          body.feeAmount === undefined ? null : body.feeAmount.toFixed(2),
          body.feePercentage === undefined ? null : body.feePercentage.toFixed(4),
          body.maxLateFeeAmount === undefined ? null : body.maxLateFeeAmount.toFixed(2),
          body.appliesToFeeCategoryId ?? null,
        );
      });
    } else {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO pay_late_payment_policies (id, school_id, is_active, grace_period_days, fee_type, fee_amount, fee_percentage, max_late_fee_amount, applies_to_fee_category_id, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9, $10::uuid)',
          generateId(),
          schoolId,
          body.isActive ?? false,
          body.gracePeriodDays ?? 7,
          body.feeType,
          body.feeAmount === undefined ? null : body.feeAmount.toFixed(2),
          body.feePercentage === undefined ? null : body.feePercentage.toFixed(4),
          body.maxLateFeeAmount === undefined ? null : body.maxLateFeeAmount.toFixed(2),
          body.appliesToFeeCategoryId ?? null,
        );
      });
    }
    const next = await this.getPolicy(actor);
    if (!next) throw new NotFoundException('Late payment policy not found after upsert');
    return next;
  }

  /**
   * LateFeesWorker entry point. Synchronous scan + apply. Run by
   * admin via POST /payments/late-fees/scan or by a future cron.
   */
  async runScan(actor: ResolvedActor): Promise<LateFeesScanResponseDto> {
    if (!actor.isSchoolAdmin)
      throw new ForbiddenException('Only admins can run the late fees scan');
    const schoolId = getCurrentTenant().schoolId;
    const policy = await this.getPolicyInternal(schoolId);
    if (!policy || !policy.is_active) {
      return {
        invoicesEvaluated: 0,
        lateFeesApplied: 0,
        invoicesSkipped: 0,
        totalLateFeeAmount: 0,
      };
    }
    const grace = policy.grace_period_days;
    const cap = policy.max_late_fee_amount === null ? null : Number(policy.max_late_fee_amount);
    const fixedAmount = policy.fee_amount === null ? null : Number(policy.fee_amount);
    const monthlyPct = policy.fee_percentage === null ? null : Number(policy.fee_percentage);
    const feeType = policy.fee_type as LateFeeType;

    let evaluated = 0;
    let applied = 0;
    let skipped = 0;
    let totalApplied = 0;

    const overdueInvoices = (await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<{ id: string; total_amount: string; due_date: string }>>(
        'SELECT i.id, i.total_amount::text, i.due_date::text ' +
          'FROM pay_invoices i ' +
          "WHERE i.school_id = $1::uuid AND i.status IN ('SENT','PARTIAL','OVERDUE') " +
          "AND i.due_date IS NOT NULL AND CURRENT_DATE > i.due_date + ($2::int * INTERVAL '1 day') " +
          "AND NOT EXISTS (SELECT 1 FROM pay_invoice_line_items li WHERE li.invoice_id = i.id AND li.description LIKE 'Late fee%')",
        schoolId,
        grace,
      ),
    )) as Array<{ id: string; total_amount: string; due_date: string }>;

    evaluated = overdueInvoices.length;

    for (const inv of overdueInvoices) {
      const balance = Number(inv.total_amount);
      let feeAmount: number;
      if (feeType === 'FIXED' && fixedAmount !== null) {
        feeAmount = fixedAmount;
      } else if (feeType === 'PERCENTAGE_MONTHLY' && monthlyPct !== null) {
        const monthsOverdue = Math.max(
          1,
          Math.ceil((Date.now() - new Date(inv.due_date).getTime()) / (30 * 24 * 60 * 60 * 1000)),
        );
        feeAmount = Number((balance * monthlyPct * monthsOverdue).toFixed(2));
      } else {
        skipped++;
        continue;
      }
      if (cap !== null && feeAmount > cap) feeAmount = cap;
      if (feeAmount <= 0) {
        skipped++;
        continue;
      }
      try {
        await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
          await tx.$queryRawUnsafe(
            'SELECT id FROM pay_invoices WHERE id = $1::uuid FOR UPDATE',
            inv.id,
          );
          // Re-check no late-fee line landed concurrently.
          const existsRows = (await tx.$queryRawUnsafe(
            "SELECT COUNT(*)::int AS c FROM pay_invoice_line_items WHERE invoice_id = $1::uuid AND description LIKE 'Late fee%'",
            inv.id,
          )) as Array<{ c: number }>;
          if (existsRows[0]!.c > 0) {
            return;
          }
          // Compute next sort_order.
          const sortRows = (await tx.$queryRawUnsafe(
            'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM pay_invoice_line_items WHERE invoice_id = $1::uuid',
            inv.id,
          )) as Array<{ next: number }>;
          const sortOrder = sortRows[0]!.next;
          await tx.$executeRawUnsafe(
            'INSERT INTO pay_invoice_line_items (id, invoice_id, fee_schedule_id, description, quantity, unit_price, total, sort_order) ' +
              'VALUES ($1::uuid, $2::uuid, NULL, $3, 1, $4::numeric, $4::numeric, $5::int)',
            generateId(),
            inv.id,
            'Late fee — auto-applied (' +
              (feeType === 'FIXED' ? '$' + feeAmount.toFixed(2) + ' fixed' : 'monthly %') +
              ')',
            feeAmount.toFixed(2),
            sortOrder,
          );
          // Bump invoice total + flip to OVERDUE.
          await tx.$executeRawUnsafe(
            "UPDATE pay_invoices SET total_amount = total_amount + $2::numeric, status = 'OVERDUE', updated_at = now() WHERE id = $1::uuid",
            inv.id,
            feeAmount.toFixed(2),
          );
        });
        applied++;
        totalApplied += feeAmount;
      } catch (err) {
        this.logger.warn(
          'Late fee apply failed for invoice ' +
            inv.id +
            ': ' +
            (err instanceof Error ? err.message : String(err)),
        );
        skipped++;
      }
    }

    return {
      invoicesEvaluated: evaluated,
      lateFeesApplied: applied,
      invoicesSkipped: skipped,
      totalLateFeeAmount: Number(totalApplied.toFixed(2)),
    };
  }

  private async getPolicyInternal(schoolId: string): Promise<PolicyRow | null> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<PolicyRow[]>(SELECT_BASE + 'WHERE school_id = $1::uuid', schoolId),
    )) as PolicyRow[];
    return rows.length > 0 ? rows[0]! : null;
  }
}
