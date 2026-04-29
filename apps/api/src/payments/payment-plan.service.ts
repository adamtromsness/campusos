import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  CreatePaymentPlanDto,
  InstallmentStatus,
  PaymentPlanInstallmentDto,
  PaymentPlanResponseDto,
  PlanFrequency,
  PlanStatus,
} from './dto/payment-plan.dto';

interface PlanRow {
  id: string;
  school_id: string;
  family_account_id: string;
  invoice_id: string;
  total_amount: string;
  installment_count: number;
  frequency: string;
  start_date: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface InstallmentRow {
  id: string;
  plan_id: string;
  installment_number: number;
  amount: string;
  due_date: string;
  status: string;
  payment_id: string | null;
  paid_at: string | null;
}

function installmentRowToDto(r: InstallmentRow): PaymentPlanInstallmentDto {
  return {
    id: r.id,
    planId: r.plan_id,
    installmentNumber: Number(r.installment_number),
    amount: Number(r.amount),
    dueDate: r.due_date,
    status: r.status as InstallmentStatus,
    paymentId: r.payment_id,
    paidAt: r.paid_at,
  };
}

function planRowToDto(p: PlanRow, installments: InstallmentRow[]): PaymentPlanResponseDto {
  return {
    id: p.id,
    schoolId: p.school_id,
    familyAccountId: p.family_account_id,
    invoiceId: p.invoice_id,
    totalAmount: Number(p.total_amount),
    installmentCount: Number(p.installment_count),
    frequency: p.frequency as PlanFrequency,
    startDate: p.start_date,
    status: p.status as PlanStatus,
    installments: installments.filter((i) => i.plan_id === p.id).map(installmentRowToDto),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

var SELECT_PLAN_BASE =
  'SELECT id, school_id, family_account_id, invoice_id, total_amount::text, installment_count, ' +
  "frequency, TO_CHAR(start_date, 'YYYY-MM-DD') AS start_date, status, created_at, updated_at " +
  'FROM pay_payment_plans ';

@Injectable()
export class PaymentPlanService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Create a payment plan for an invoice. Admin-only. Auto-generates
   * the installment rows in the same tx so the plan + installments
   * land atomically. Installment due_dates = start_date + n * (1 month
   * | 3 months) for n in 0..installment_count-1.
   *
   * Schema enforces UNIQUE(invoice_id) on pay_payment_plans, so a
   * second-plan-on-same-invoice attempt returns 23505 — we catch the
   * duplicate via a pre-flight check.
   */
  async create(
    invoiceId: string,
    body: CreatePaymentPlanDto,
    actor: ResolvedActor,
  ): Promise<PaymentPlanResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can create payment plans');
    }
    if (body.installmentCount < 2) {
      throw new BadRequestException('installmentCount must be >= 2');
    }
    var schoolId = getCurrentTenant().schoolId;
    var planId = generateId();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var invoiceRows = (await tx.$queryRawUnsafe(
        'SELECT id, family_account_id, total_amount::text, status FROM pay_invoices WHERE id = $1::uuid FOR UPDATE',
        invoiceId,
      )) as Array<{
        id: string;
        family_account_id: string;
        total_amount: string;
        status: string;
      }>;
      if (invoiceRows.length === 0) {
        throw new NotFoundException('Invoice ' + invoiceId + ' not found');
      }
      var inv = invoiceRows[0]!;
      if (inv.status === 'PAID' || inv.status === 'CANCELLED') {
        throw new BadRequestException(
          'Cannot create payment plan on invoice in status ' + inv.status,
        );
      }
      var existing = (await tx.$queryRawUnsafe(
        'SELECT id FROM pay_payment_plans WHERE invoice_id = $1::uuid',
        invoiceId,
      )) as Array<{ id: string }>;
      if (existing.length > 0) {
        throw new BadRequestException('Invoice already has a payment plan');
      }

      var totalAmount = Number(inv.total_amount);
      var perInstallment = Number((totalAmount / body.installmentCount).toFixed(2));
      // Round-off correction: last installment absorbs any sub-cent residue
      // so SUM(installments.amount) === total_amount exactly.
      var residue = Number((totalAmount - perInstallment * body.installmentCount).toFixed(2));

      await tx.$executeRawUnsafe(
        'INSERT INTO pay_payment_plans (id, school_id, family_account_id, invoice_id, total_amount, installment_count, frequency, start_date, status, created_by) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, $6::int, $7, $8::date, 'ACTIVE', $9::uuid)",
        planId,
        schoolId,
        inv.family_account_id,
        invoiceId,
        totalAmount.toFixed(2),
        body.installmentCount,
        body.frequency,
        body.startDate,
        actor.accountId,
      );

      var monthsPerInstallment = body.frequency === 'MONTHLY' ? 1 : 3;
      var startDate = new Date(body.startDate + 'T00:00:00Z');
      for (var n = 0; n < body.installmentCount; n++) {
        var due = new Date(startDate.getTime());
        due.setUTCMonth(due.getUTCMonth() + monthsPerInstallment * n);
        var amount = perInstallment;
        if (n === body.installmentCount - 1) {
          amount = Number((perInstallment + residue).toFixed(2));
        }
        await tx.$executeRawUnsafe(
          'INSERT INTO pay_payment_plan_installments (id, plan_id, installment_number, amount, due_date, status) ' +
            "VALUES ($1::uuid, $2::uuid, $3::int, $4::numeric, $5::date, 'UPCOMING')",
          generateId(),
          planId,
          n + 1,
          amount.toFixed(2),
          due.toISOString().substring(0, 10),
        );
      }
    });

    return this.getById(planId);
  }

  async getById(id: string): Promise<PaymentPlanResponseDto> {
    var data = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var planRows = await client.$queryRawUnsafe<PlanRow[]>(
        SELECT_PLAN_BASE + 'WHERE id = $1::uuid',
        id,
      );
      if (planRows.length === 0) return null;
      var installments = await client.$queryRawUnsafe<InstallmentRow[]>(
        'SELECT id, plan_id, installment_number, amount::text, ' +
          "TO_CHAR(due_date, 'YYYY-MM-DD') AS due_date, status, payment_id, paid_at " +
          'FROM pay_payment_plan_installments WHERE plan_id = $1::uuid ORDER BY installment_number',
        id,
      );
      return { plan: planRows[0]!, installments };
    });
    if (!data) throw new NotFoundException('Payment plan ' + id + ' not found');
    return planRowToDto(data.plan, data.installments);
  }
}
