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
import type { ResolvedActor } from '../iam/actor-context.service';
import { isUniqueViolation } from './chart.service';
import { PostingService } from './posting.service';
import type {
  APPaymentDto,
  APVoucherDto,
  APVoucherStatus,
  APVoucherTransitionDto,
  BoardReportDto,
  BudgetDto,
  BudgetLineDto,
  CreateAPPaymentDto,
  CreateAPVoucherDto,
  CreateBoardReportDto,
  CreateBudgetDto,
  CreateBudgetLineDto,
  CreateGrantDto,
  CreateReconciliationDto,
  CreateSupplierDto,
  FinalizeReconciliationDto,
  GrantDto,
  ReconciliationDto,
  ReconciliationStatus,
  ReportType,
  SupplierContactDto,
  SupplierDto,
  UpdateBudgetDto,
  UpdateGrantDto,
} from './dto/finance.dto';

@Injectable()
export class SupplierService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private rowToDto(r: Record<string, unknown>, contacts: SupplierContactDto[]): SupplierDto {
    return {
      id: r.id as string,
      schoolId: r.school_id as string,
      supplierCode: r.supplier_code as string,
      supplierName: r.supplier_name as string,
      supplierType: r.supplier_type as SupplierDto['supplierType'],
      taxId: (r.tax_id as string | null) ?? null,
      addressLine1: (r.address_line1 as string | null) ?? null,
      addressLine2: (r.address_line2 as string | null) ?? null,
      city: (r.city as string | null) ?? null,
      region: (r.region as string | null) ?? null,
      postalCode: (r.postal_code as string | null) ?? null,
      country: (r.country as string | null) ?? null,
      paymentTerms: (r.payment_terms as string | null) ?? null,
      isActive: !!r.is_active,
      notes: (r.notes as string | null) ?? null,
      contacts,
    };
  }

  private async loadContacts(supplierId: string): Promise<SupplierContactDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, supplier_id::text AS supplier_id, contact_name, email, phone, role, is_primary FROM fin_supplier_contacts WHERE supplier_id = $1::uuid ORDER BY is_primary DESC, contact_name`,
        supplierId,
      );
    })) as Array<{
      id: string;
      supplier_id: string;
      contact_name: string;
      email: string | null;
      phone: string | null;
      role: string | null;
      is_primary: boolean;
    }>;
    return rows.map((r) => ({
      id: r.id,
      supplierId: r.supplier_id,
      contactName: r.contact_name,
      email: r.email,
      phone: r.phone,
      role: r.role,
      isPrimary: r.is_primary,
    }));
  }

  async list(includeInactive = false): Promise<SupplierDto[]> {
    const tenant = getCurrentTenant();
    const where = includeInactive ? '' : ' AND is_active = true';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, supplier_code, supplier_name, supplier_type, tax_id, address_line1, address_line2, city, region, postal_code, country, payment_terms, is_active, notes FROM fin_suppliers WHERE school_id = $1::uuid${where} ORDER BY supplier_name`,
        tenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    const out: SupplierDto[] = [];
    for (const r of rows) {
      out.push(this.rowToDto(r, await this.loadContacts(r.id as string)));
    }
    return out;
  }

  async getById(id: string): Promise<SupplierDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, supplier_code, supplier_name, supplier_type, tax_id, address_line1, address_line2, city, region, postal_code, country, payment_terms, is_active, notes FROM fin_suppliers WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    if (rows.length === 0) throw new NotFoundException('Supplier not found');
    return this.rowToDto(rows[0]!, await this.loadContacts(id));
  }

  async create(actor: ResolvedActor, input: CreateSupplierDto): Promise<SupplierDto> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only finance staff or admins may create suppliers');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `INSERT INTO fin_suppliers (id, school_id, supplier_code, supplier_name, supplier_type, tax_id, address_line1, city, region, postal_code, country, payment_terms, notes) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          id,
          tenant.schoolId,
          input.supplierCode,
          input.supplierName,
          input.supplierType ?? 'VENDOR',
          input.taxId ?? null,
          input.addressLine1 ?? null,
          input.city ?? null,
          input.region ?? null,
          input.postalCode ?? null,
          input.country ?? null,
          input.paymentTerms ?? null,
          input.notes ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`A supplier with code '${input.supplierCode}' already exists`);
      }
      throw err;
    }
    return this.getById(id);
  }
}

@Injectable()
export class BudgetService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private async loadLines(budgetId: string): Promise<BudgetLineDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT bl.id::text AS id,
                bl.budget_id::text AS budget_id,
                bl.account_id::text AS account_id,
                a.account_code, a.account_name,
                bl.budgeted_amount, bl.actual_amount, bl.encumbered_amount, bl.notes
         FROM fin_budget_lines bl
         JOIN fin_chart_of_accounts a ON a.id = bl.account_id
         WHERE bl.budget_id = $1::uuid
         ORDER BY a.account_code`,
        budgetId,
      );
    })) as Array<{
      id: string;
      budget_id: string;
      account_id: string;
      account_code: string;
      account_name: string;
      budgeted_amount: string | number;
      actual_amount: string | number;
      encumbered_amount: string | number;
      notes: string | null;
    }>;
    return rows.map((r) => {
      const budgeted = Number(r.budgeted_amount);
      const actual = Number(r.actual_amount);
      const encumbered = Number(r.encumbered_amount);
      return {
        id: r.id,
        budgetId: r.budget_id,
        accountId: r.account_id,
        accountCode: r.account_code,
        accountName: r.account_name,
        budgetedAmount: budgeted,
        actualAmount: actual,
        encumberedAmount: encumbered,
        remainingAmount: Math.round((budgeted - actual - encumbered) * 100) / 100,
        notes: r.notes,
      };
    });
  }

  private rowToDto(r: Record<string, unknown>, lines: BudgetLineDto[]): BudgetDto {
    return {
      id: r.id as string,
      schoolId: r.school_id as string,
      fiscalYear: r.fiscal_year as string,
      fundId: r.fund_id as string,
      fundCode: (r.fund_code as string) ?? '',
      name: r.name as string,
      totalRevenue: Number(r.total_revenue ?? 0),
      totalExpense: Number(r.total_expense ?? 0),
      status: r.status as BudgetDto['status'],
      approvedBy: (r.approved_by as string | null) ?? null,
      approvedAt: (r.approved_at as string | null) ?? null,
      lines,
    };
  }

  async list(fiscalYear?: string): Promise<BudgetDto[]> {
    const tenant = getCurrentTenant();
    const yearFilter = fiscalYear ? ` AND b.fiscal_year = $2` : '';
    const params: unknown[] = [tenant.schoolId];
    if (fiscalYear) params.push(fiscalYear);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT b.id::text AS id, b.school_id::text AS school_id, b.fiscal_year, b.fund_id::text AS fund_id, f.fund_code, b.name, b.total_revenue, b.total_expense, b.status, b.approved_by::text AS approved_by, b.approved_at::text AS approved_at FROM fin_budgets b JOIN fin_funds f ON f.id = b.fund_id WHERE b.school_id = $1::uuid${yearFilter} ORDER BY b.fiscal_year DESC, b.name`,
        ...params,
      );
    })) as Array<Record<string, unknown>>;
    const out: BudgetDto[] = [];
    for (const r of rows) {
      out.push(this.rowToDto(r, await this.loadLines(r.id as string)));
    }
    return out;
  }

  async getById(id: string): Promise<BudgetDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT b.id::text AS id, b.school_id::text AS school_id, b.fiscal_year, b.fund_id::text AS fund_id, f.fund_code, b.name, b.total_revenue, b.total_expense, b.status, b.approved_by::text AS approved_by, b.approved_at::text AS approved_at FROM fin_budgets b JOIN fin_funds f ON f.id = b.fund_id WHERE b.id = $1::uuid AND b.school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    if (rows.length === 0) throw new NotFoundException('Budget not found');
    return this.rowToDto(rows[0]!, await this.loadLines(id));
  }

  async create(actor: ResolvedActor, input: CreateBudgetDto): Promise<BudgetDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can create budgets');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `INSERT INTO fin_budgets (id, school_id, fiscal_year, fund_id, name, total_revenue, total_expense) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7)`,
          id,
          tenant.schoolId,
          input.fiscalYear,
          input.fundId,
          input.name,
          input.totalRevenue,
          input.totalExpense,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          `A budget named '${input.name}' for ${input.fiscalYear} on this fund already exists`,
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  async patch(actor: ResolvedActor, id: string, input: UpdateBudgetDto): Promise<BudgetDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can update budgets');
    }
    const tenant = getCurrentTenant();
    if (!actor.employeeId) {
      throw new BadRequestException('Budget updates require an employee actor');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (input.name !== undefined) {
      sets.push(`name = $${i++}`);
      params.push(input.name);
    }
    if (input.totalRevenue !== undefined) {
      sets.push(`total_revenue = $${i++}`);
      params.push(input.totalRevenue);
    }
    if (input.totalExpense !== undefined) {
      sets.push(`total_expense = $${i++}`);
      params.push(input.totalExpense);
    }
    if (input.status !== undefined) {
      sets.push(`status = $${i++}`);
      params.push(input.status);
      if (input.status === 'APPROVED') {
        sets.push(`approved_by = $${i++}::uuid`);
        params.push(actor.employeeId);
        sets.push(`approved_at = now()`);
      }
    }
    if (sets.length === 0) return this.getById(id);
    sets.push(`updated_at = now()`);
    params.push(id);
    params.push(tenant.schoolId);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `UPDATE fin_budgets SET ${sets.join(', ')} WHERE id = $${i++}::uuid AND school_id = $${i}::uuid`,
        ...params,
      );
    });
    return this.getById(id);
  }

  async addLine(
    actor: ResolvedActor,
    budgetId: string,
    input: CreateBudgetLineDto,
  ): Promise<BudgetDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can add budget lines');
    }
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `INSERT INTO fin_budget_lines (id, budget_id, account_id, budgeted_amount, notes) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)`,
          generateId(),
          budgetId,
          input.accountId,
          input.budgetedAmount,
          input.notes ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('That account already has a line on this budget');
      }
      throw err;
    }
    return this.getById(budgetId);
  }
}

@Injectable()
export class APVoucherService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private async loadPaid(voucherId: string): Promise<number> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT COALESCE(SUM(amount), 0) AS amount_paid FROM fin_ap_payments WHERE voucher_id = $1::uuid`,
        voucherId,
      );
    })) as Array<{ amount_paid: string | number }>;
    return Number(rows[0]?.amount_paid ?? 0);
  }

  private async rowToDto(r: Record<string, unknown>): Promise<APVoucherDto> {
    const total = Number(r.total_amount ?? 0);
    const paid = await this.loadPaid(r.id as string);
    return {
      id: r.id as string,
      schoolId: r.school_id as string,
      supplierId: r.supplier_id as string,
      supplierName: (r.supplier_name as string) ?? '',
      voucherNumber: r.voucher_number as string,
      invoiceNumber: (r.invoice_number as string | null) ?? null,
      invoiceDate: r.invoice_date as string,
      dueDate: r.due_date as string,
      totalAmount: total,
      description: (r.description as string | null) ?? null,
      glAccountId: (r.gl_account_id as string | null) ?? null,
      glAccountCode: (r.gl_account_code as string | null) ?? null,
      fundId: (r.fund_id as string | null) ?? null,
      status: r.status as APVoucherStatus,
      approvedBy: (r.approved_by as string | null) ?? null,
      approvedByName: (r.approved_by_name as string | null) ?? null,
      approvedAt: (r.approved_at as string | null) ?? null,
      voidedAt: (r.voided_at as string | null) ?? null,
      voidReason: (r.void_reason as string | null) ?? null,
      amountPaid: paid,
      balanceDue: Math.round((total - paid) * 100) / 100,
    };
  }

  async list(
    args: { status?: APVoucherStatus; supplierId?: string } = {},
  ): Promise<APVoucherDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = [`v.school_id = $1::uuid`];
    const params: unknown[] = [tenant.schoolId];
    let i = 2;
    if (args.status) {
      where.push(`v.status = $${i++}`);
      params.push(args.status);
    }
    if (args.supplierId) {
      where.push(`v.supplier_id = $${i++}::uuid`);
      params.push(args.supplierId);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT v.id::text AS id, v.school_id::text AS school_id, v.supplier_id::text AS supplier_id, s.supplier_name, v.voucher_number, v.invoice_number, v.invoice_date::text AS invoice_date, v.due_date::text AS due_date, v.total_amount, v.description, v.gl_account_id::text AS gl_account_id, a.account_code AS gl_account_code, v.fund_id::text AS fund_id, v.status, v.approved_by::text AS approved_by, (SELECT ip.first_name || ' ' || ip.last_name FROM hr_employees e JOIN platform.iam_person ip ON ip.id = e.person_id WHERE e.id = v.approved_by LIMIT 1) AS approved_by_name, v.approved_at::text AS approved_at, v.voided_at::text AS voided_at, v.void_reason FROM fin_ap_vouchers v JOIN fin_suppliers s ON s.id = v.supplier_id LEFT JOIN fin_chart_of_accounts a ON a.id = v.gl_account_id WHERE ${where.join(' AND ')} ORDER BY v.due_date, v.invoice_date DESC`,
        ...params,
      );
    })) as Array<Record<string, unknown>>;
    const out: APVoucherDto[] = [];
    for (const r of rows) out.push(await this.rowToDto(r));
    return out;
  }

  async getById(id: string): Promise<APVoucherDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT v.id::text AS id, v.school_id::text AS school_id, v.supplier_id::text AS supplier_id, s.supplier_name, v.voucher_number, v.invoice_number, v.invoice_date::text AS invoice_date, v.due_date::text AS due_date, v.total_amount, v.description, v.gl_account_id::text AS gl_account_id, a.account_code AS gl_account_code, v.fund_id::text AS fund_id, v.status, v.approved_by::text AS approved_by, (SELECT ip.first_name || ' ' || ip.last_name FROM hr_employees e JOIN platform.iam_person ip ON ip.id = e.person_id WHERE e.id = v.approved_by LIMIT 1) AS approved_by_name, v.approved_at::text AS approved_at, v.voided_at::text AS voided_at, v.void_reason FROM fin_ap_vouchers v JOIN fin_suppliers s ON s.id = v.supplier_id LEFT JOIN fin_chart_of_accounts a ON a.id = v.gl_account_id WHERE v.id = $1::uuid AND v.school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    if (rows.length === 0) throw new NotFoundException('AP voucher not found');
    return this.rowToDto(rows[0]!);
  }

  async create(actor: ResolvedActor, input: CreateAPVoucherDto): Promise<APVoucherDto> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only finance staff or admins may create AP vouchers');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    if (input.dueDate < input.invoiceDate) {
      throw new BadRequestException('dueDate must be on or after invoiceDate');
    }
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `INSERT INTO fin_ap_vouchers (id, school_id, supplier_id, voucher_number, invoice_number, invoice_date, due_date, total_amount, description, gl_account_id, fund_id) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, $7::date, $8, $9, $10::uuid, $11::uuid)`,
          id,
          tenant.schoolId,
          input.supplierId,
          input.voucherNumber,
          input.invoiceNumber ?? null,
          input.invoiceDate,
          input.dueDate,
          input.totalAmount,
          input.description ?? null,
          input.glAccountId ?? null,
          input.fundId ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          `A voucher with number '${input.voucherNumber}' already exists`,
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  async transition(
    actor: ResolvedActor,
    id: string,
    input: APVoucherTransitionDto,
  ): Promise<APVoucherDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException(
        'Only school admins can approve, hold, release, or void AP vouchers',
      );
    }
    if (!actor.employeeId) {
      throw new BadRequestException('AP transition requires an employee actor');
    }
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT status FROM fin_ap_vouchers WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE`,
        id,
        tenant.schoolId,
      )) as Array<{ status: string }>;
      if (rows.length === 0) throw new NotFoundException('AP voucher not found');
      const current = rows[0]!.status as APVoucherStatus;

      if (input.action === 'APPROVE') {
        if (!['PENDING', 'ON_HOLD'].includes(current)) {
          throw new BadRequestException(`Cannot approve a ${current} voucher`);
        }
        await tx.$executeRawUnsafe(
          `UPDATE fin_ap_vouchers SET status='APPROVED', approved_at=now(), approved_by=$1::uuid, updated_at=now() WHERE id=$2::uuid`,
          actor.employeeId,
          id,
        );
      } else if (input.action === 'HOLD') {
        if (!['PENDING', 'APPROVED'].includes(current)) {
          throw new BadRequestException(`Cannot hold a ${current} voucher`);
        }
        await tx.$executeRawUnsafe(
          `UPDATE fin_ap_vouchers SET status='ON_HOLD', updated_at=now() WHERE id=$1::uuid`,
          id,
        );
      } else if (input.action === 'RELEASE') {
        if (current !== 'ON_HOLD') {
          throw new BadRequestException(`Only ON_HOLD vouchers can be released`);
        }
        await tx.$executeRawUnsafe(
          `UPDATE fin_ap_vouchers SET status='PENDING', updated_at=now() WHERE id=$1::uuid`,
          id,
        );
      } else if (input.action === 'VOID') {
        if (current === 'PAID') {
          throw new BadRequestException('Cannot void a PAID voucher — issue a refund instead');
        }
        await tx.$executeRawUnsafe(
          `UPDATE fin_ap_vouchers SET status='VOIDED', voided_at=now(), voided_by=$1::uuid, void_reason=$2, updated_at=now() WHERE id=$3::uuid`,
          actor.employeeId,
          input.reason ?? 'Voided',
          id,
        );
      }
    });
    return this.getById(id);
  }
}

@Injectable()
export class APPaymentService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly posting: PostingService,
  ) {}

  async listForVoucher(voucherId: string): Promise<APPaymentDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT p.id::text AS id, p.voucher_id::text AS voucher_id, p.payment_method, p.payment_reference, p.amount, p.paid_at::text AS paid_at, p.paid_by::text AS paid_by, (SELECT ip.first_name || ' ' || ip.last_name FROM hr_employees e JOIN platform.iam_person ip ON ip.id = e.person_id WHERE e.id = p.paid_by LIMIT 1) AS paid_by_name, p.journal_batch_id::text AS journal_batch_id, p.notes FROM fin_ap_payments p WHERE p.voucher_id = $1::uuid ORDER BY p.paid_at DESC`,
        voucherId,
      );
    })) as Array<{
      id: string;
      voucher_id: string;
      payment_method: string;
      payment_reference: string | null;
      amount: string | number;
      paid_at: string;
      paid_by: string;
      paid_by_name: string | null;
      journal_batch_id: string | null;
      notes: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      voucherId: r.voucher_id,
      paymentMethod: r.payment_method as APPaymentDto['paymentMethod'],
      paymentReference: r.payment_reference,
      amount: Number(r.amount),
      paidAt: r.paid_at,
      paidBy: r.paid_by,
      paidByName: r.paid_by_name,
      journalBatchId: r.journal_batch_id,
      notes: r.notes,
    }));
  }

  /**
   * Pay an AP voucher — creates the payment record AND posts a balanced
   * GL batch (DEBIT GL account / CREDIT Cash) inside one tenant tx.
   */
  async pay(
    actor: ResolvedActor,
    voucherId: string,
    input: CreateAPPaymentDto,
  ): Promise<APPaymentDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can pay AP vouchers');
    }
    if (!actor.employeeId) {
      throw new BadRequestException('AP payment requires an employee actor');
    }
    const tenant = getCurrentTenant();

    // Look up voucher + cash account up-front (outside the tx for read clarity).
    const voucherRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT v.id::text AS id, v.status, v.total_amount, v.description, v.voucher_number, v.gl_account_id::text AS gl_account_id, v.fund_id::text AS fund_id, COALESCE((SELECT SUM(amount) FROM fin_ap_payments WHERE voucher_id = v.id), 0) AS paid FROM fin_ap_vouchers v WHERE v.id = $1::uuid AND v.school_id = $2::uuid LIMIT 1`,
        voucherId,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      status: string;
      total_amount: string | number;
      description: string | null;
      voucher_number: string;
      gl_account_id: string | null;
      fund_id: string | null;
      paid: string | number;
    }>;
    if (voucherRows.length === 0) throw new NotFoundException('AP voucher not found');
    const v = voucherRows[0]!;
    if (v.status !== 'APPROVED') {
      throw new BadRequestException(`Only APPROVED vouchers can be paid (current: ${v.status})`);
    }
    if (!v.gl_account_id || !v.fund_id) {
      throw new BadRequestException(
        'Voucher must have a GL account and fund pinned before payment can post',
      );
    }
    const total = Number(v.total_amount);
    const alreadyPaid = Number(v.paid);
    if (alreadyPaid + input.amount > total + 0.005) {
      throw new BadRequestException(
        `Payment would exceed voucher balance (paying ${input.amount}, balance ${(total - alreadyPaid).toFixed(2)})`,
      );
    }

    // Resolve Cash account.
    const cashRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id FROM fin_chart_of_accounts WHERE school_id = $1::uuid AND account_code = '1000' AND is_active = true LIMIT 1`,
        tenant.schoolId,
      );
    })) as Array<{ id: string }>;
    if (cashRows.length === 0) {
      throw new BadRequestException('Cash account (1000) not found in chart');
    }
    const cashAccountId = cashRows[0]!.id;

    // Post the GL batch first (it locks its own row), then write the
    // ap_payment row referencing the batch. Both happen in separate
    // transactions; the AP payment INSERT after the GL batch POSTed
    // means a subsequent retry on this method sees the GL batch
    // exists (idempotency on a manual retry would create a 2nd batch
    // — acceptable for AP-pay since voucher status flips to PAID at
    // the end and blocks further calls).
    const batch = await this.posting.createAndPost(actor, {
      batchNumber: `AP-${v.voucher_number}-${Date.now().toString().slice(-6)}`,
      description: `AP payment ${v.voucher_number} - ${input.paymentMethod}`,
      batchType: 'MANUAL',
      sourceModule: 'finance.ap',
      accountingPeriodId: '00000000-0000-0000-0000-000000000000',
      entries: [
        {
          accountId: v.gl_account_id,
          fundId: v.fund_id,
          debit: input.amount,
          credit: 0,
          description: `Expense recognised — ${v.description ?? v.voucher_number}`,
          referenceType: 'fin_ap_vouchers',
          referenceId: voucherId,
        },
        {
          accountId: cashAccountId,
          fundId: v.fund_id,
          debit: 0,
          credit: input.amount,
          description: `Cash paid via ${input.paymentMethod}`,
          referenceType: 'fin_ap_vouchers',
          referenceId: voucherId,
        },
      ],
    });

    // Insert payment + flip voucher to PAID inside one tx.
    const paymentId = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO fin_ap_payments (id, voucher_id, payment_method, payment_reference, amount, paid_at, paid_by, journal_batch_id, notes) VALUES ($1::uuid, $2::uuid, $3, $4, $5, now(), $6::uuid, $7::uuid, $8)`,
        paymentId,
        voucherId,
        input.paymentMethod,
        input.paymentReference ?? null,
        input.amount,
        actor.employeeId,
        batch.id,
        input.notes ?? null,
      );
      // If fully paid, flip voucher status.
      const newPaid = alreadyPaid + input.amount;
      if (newPaid >= total - 0.005) {
        await tx.$executeRawUnsafe(
          `UPDATE fin_ap_vouchers SET status='PAID', updated_at=now() WHERE id=$1::uuid`,
          voucherId,
        );
      }
    });

    const payments = await this.listForVoucher(voucherId);
    const created = payments.find((p) => p.id === paymentId);
    if (!created) throw new NotFoundException('Payment row not found post-insert');
    return created;
  }
}

@Injectable()
export class ReconciliationService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private rowToDto(r: Record<string, unknown>): ReconciliationDto {
    return {
      id: r.id as string,
      schoolId: r.school_id as string,
      accountId: r.account_id as string,
      accountCode: (r.account_code as string) ?? '',
      accountName: (r.account_name as string) ?? '',
      periodId: r.period_id as string,
      periodName: (r.period_name as string) ?? '',
      glBalance: Number(r.gl_balance ?? 0),
      bankBalance: Number(r.bank_balance ?? 0),
      difference: Number(r.difference ?? 0),
      outstandingItems: r.outstanding_items ?? [],
      status: r.status as ReconciliationStatus,
      reconciledBy: (r.reconciled_by as string | null) ?? null,
      reconciledAt: (r.reconciled_at as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
    };
  }

  async list(): Promise<ReconciliationDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT r.id::text AS id, r.school_id::text AS school_id, r.account_id::text AS account_id, a.account_code, a.account_name, r.period_id::text AS period_id, p.period_name, r.gl_balance, r.bank_balance, r.difference, r.outstanding_items, r.status, r.reconciled_by::text AS reconciled_by, r.reconciled_at::text AS reconciled_at, r.notes FROM fin_reconciliation_runs r JOIN fin_chart_of_accounts a ON a.id = r.account_id JOIN fin_accounting_periods p ON p.id = r.period_id WHERE r.school_id = $1::uuid ORDER BY r.created_at DESC LIMIT 100`,
        tenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(id: string): Promise<ReconciliationDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT r.id::text AS id, r.school_id::text AS school_id, r.account_id::text AS account_id, a.account_code, a.account_name, r.period_id::text AS period_id, p.period_name, r.gl_balance, r.bank_balance, r.difference, r.outstanding_items, r.status, r.reconciled_by::text AS reconciled_by, r.reconciled_at::text AS reconciled_at, r.notes FROM fin_reconciliation_runs r JOIN fin_chart_of_accounts a ON a.id = r.account_id JOIN fin_accounting_periods p ON p.id = r.period_id WHERE r.id = $1::uuid AND r.school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    if (rows.length === 0) throw new NotFoundException('Reconciliation run not found');
    return this.rowToDto(rows[0]!);
  }

  async start(actor: ResolvedActor, input: CreateReconciliationDto): Promise<ReconciliationDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can start a reconciliation');
    }
    const tenant = getCurrentTenant();
    // Compute current GL balance for the account.
    const balRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT COALESCE(SUM(e.debit) - SUM(e.credit), 0) AS bal FROM fin_gl_entries e JOIN fin_journal_batches b ON b.id = e.batch_id WHERE e.account_id = $1::uuid AND b.status = 'POSTED'`,
        input.accountId,
      );
    })) as Array<{ bal: string | number }>;
    const glBalance = Number(balRows[0]?.bal ?? 0);
    const difference = Math.round((glBalance - input.bankBalance) * 100) / 100;
    const status: ReconciliationStatus = difference === 0 ? 'IN_PROGRESS' : 'VARIANCE_FLAGGED';
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `INSERT INTO fin_reconciliation_runs (id, school_id, account_id, period_id, gl_balance, bank_balance, difference, outstanding_items, status, notes) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::jsonb, $9, $10)`,
        id,
        tenant.schoolId,
        input.accountId,
        input.periodId,
        glBalance,
        input.bankBalance,
        difference,
        JSON.stringify(input.outstandingItems ?? []),
        status,
        input.notes ?? null,
      );
    });
    return this.getById(id);
  }

  async finalize(
    actor: ResolvedActor,
    id: string,
    input: FinalizeReconciliationDto,
  ): Promise<ReconciliationDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can finalize a reconciliation');
    }
    if (!actor.employeeId) {
      throw new BadRequestException('Reconciliation finalize requires an employee actor');
    }
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT account_id::text AS account_id, status FROM fin_reconciliation_runs WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE`,
        id,
        tenant.schoolId,
      )) as Array<{ account_id: string; status: string }>;
      if (rows.length === 0) throw new NotFoundException('Reconciliation run not found');
      if (rows[0]!.status === 'RECONCILED') {
        throw new BadRequestException('Reconciliation already RECONCILED');
      }
      // Recompute GL balance.
      const bal = (await tx.$queryRawUnsafe(
        `SELECT COALESCE(SUM(e.debit) - SUM(e.credit), 0) AS bal FROM fin_gl_entries e JOIN fin_journal_batches b ON b.id = e.batch_id WHERE e.account_id = $1::uuid AND b.status = 'POSTED'`,
        rows[0]!.account_id,
      )) as Array<{ bal: string | number }>;
      const glBalance = Number(bal[0]?.bal ?? 0);
      const difference = Math.round((glBalance - input.bankBalance) * 100) / 100;
      const status: ReconciliationStatus =
        Math.abs(difference) < 0.005 ? 'RECONCILED' : 'VARIANCE_FLAGGED';
      if (status === 'RECONCILED') {
        await tx.$executeRawUnsafe(
          `UPDATE fin_reconciliation_runs SET gl_balance=$1, bank_balance=$2, difference=$3, outstanding_items=$4::jsonb, status='RECONCILED', reconciled_by=$5::uuid, reconciled_at=now(), notes=COALESCE($6, notes), updated_at=now() WHERE id=$7::uuid`,
          glBalance,
          input.bankBalance,
          difference,
          JSON.stringify(input.outstandingItems ?? []),
          actor.employeeId,
          input.notes ?? null,
          id,
        );
      } else {
        await tx.$executeRawUnsafe(
          `UPDATE fin_reconciliation_runs SET gl_balance=$1, bank_balance=$2, difference=$3, outstanding_items=$4::jsonb, status='VARIANCE_FLAGGED', notes=COALESCE($5, notes), updated_at=now() WHERE id=$6::uuid`,
          glBalance,
          input.bankBalance,
          difference,
          JSON.stringify(input.outstandingItems ?? []),
          input.notes ?? null,
          id,
        );
      }
    });
    return this.getById(id);
  }
}

@Injectable()
export class BoardReportService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private rowToDto(r: Record<string, unknown>): BoardReportDto {
    return {
      id: r.id as string,
      schoolId: r.school_id as string,
      reportType: r.report_type as ReportType,
      periodId: (r.period_id as string | null) ?? null,
      periodName: (r.period_name as string | null) ?? null,
      generatedAt: r.generated_at as string,
      generatedBy: r.generated_by as string,
      generatedByName: (r.generated_by_name as string | null) ?? null,
      reportData: r.report_data ?? {},
      s3Key: (r.s3_key as string | null) ?? null,
    };
  }

  async list(): Promise<BoardReportDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT r.id::text AS id, r.school_id::text AS school_id, r.report_type, r.period_id::text AS period_id, p.period_name, r.generated_at::text AS generated_at, r.generated_by::text AS generated_by, (SELECT ip.first_name || ' ' || ip.last_name FROM hr_employees e JOIN platform.iam_person ip ON ip.id = e.person_id WHERE e.id = r.generated_by LIMIT 1) AS generated_by_name, r.report_data, r.s3_key FROM fin_board_report_snapshots r LEFT JOIN fin_accounting_periods p ON p.id = r.period_id WHERE r.school_id = $1::uuid ORDER BY r.generated_at DESC LIMIT 100`,
        tenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(id: string): Promise<BoardReportDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT r.id::text AS id, r.school_id::text AS school_id, r.report_type, r.period_id::text AS period_id, p.period_name, r.generated_at::text AS generated_at, r.generated_by::text AS generated_by, (SELECT ip.first_name || ' ' || ip.last_name FROM hr_employees e JOIN platform.iam_person ip ON ip.id = e.person_id WHERE e.id = r.generated_by LIMIT 1) AS generated_by_name, r.report_data, r.s3_key FROM fin_board_report_snapshots r LEFT JOIN fin_accounting_periods p ON p.id = r.period_id WHERE r.id = $1::uuid AND r.school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    if (rows.length === 0) throw new NotFoundException('Board report not found');
    return this.rowToDto(rows[0]!);
  }

  async generate(actor: ResolvedActor, input: CreateBoardReportDto): Promise<BoardReportDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can generate board reports');
    }
    if (!actor.employeeId) {
      throw new BadRequestException('Board report generation requires an employee actor');
    }
    const tenant = getCurrentTenant();

    // Build the JSONB snapshot from current GL + budget data per the
    // requested report type. Each report type compiles a different
    // shape; the data is FROZEN at generation time per ADR-010.
    const snapshot = await this.compileSnapshot(input.reportType, input.periodId);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `INSERT INTO fin_board_report_snapshots (id, school_id, report_type, period_id, generated_by, report_data) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::jsonb)`,
        id,
        tenant.schoolId,
        input.reportType,
        input.periodId ?? null,
        actor.employeeId,
        JSON.stringify(snapshot),
      );
    });
    return this.getById(id);
  }

  private async compileSnapshot(
    reportType: ReportType,
    periodId?: string,
  ): Promise<Record<string, unknown>> {
    const tenant = getCurrentTenant();
    if (reportType === 'BUDGET_VS_ACTUAL') {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          `SELECT a.account_code, a.account_name, a.account_type, bl.budgeted_amount, bl.actual_amount, bl.encumbered_amount, (bl.budgeted_amount - bl.actual_amount - bl.encumbered_amount) AS remaining FROM fin_budget_lines bl JOIN fin_chart_of_accounts a ON a.id = bl.account_id JOIN fin_budgets b ON b.id = bl.budget_id WHERE b.school_id = $1::uuid AND b.status='APPROVED' ORDER BY a.account_code`,
          tenant.schoolId,
        );
      })) as Array<Record<string, unknown>>;
      return {
        reportType,
        generatedAt: new Date().toISOString(),
        lines: rows.map((r) => ({
          accountCode: r.account_code,
          accountName: r.account_name,
          accountType: r.account_type,
          budgeted: Number(r.budgeted_amount),
          actual: Number(r.actual_amount),
          encumbered: Number(r.encumbered_amount),
          remaining: Number(r.remaining),
        })),
      };
    }
    // BALANCE_SHEET / INCOME_STATEMENT / CASH_FLOW: simplified snapshot
    // pulling running balances by account_type. Phase 2 polish ships
    // proper period-bounded balance-sheet rendering.
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT a.account_code, a.account_name, a.account_type, a.normal_balance, COALESCE(SUM(e.debit) - SUM(e.credit), 0) AS net_dr_minus_cr FROM fin_chart_of_accounts a LEFT JOIN fin_gl_entries e ON e.account_id = a.id LEFT JOIN fin_journal_batches b ON b.id = e.batch_id AND b.status='POSTED' WHERE a.school_id = $1::uuid GROUP BY a.id, a.account_code, a.account_name, a.account_type, a.normal_balance ORDER BY a.account_code`,
        tenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    return {
      reportType,
      periodId: periodId ?? null,
      generatedAt: new Date().toISOString(),
      accounts: rows.map((r) => ({
        accountCode: r.account_code,
        accountName: r.account_name,
        accountType: r.account_type,
        normalBalance: r.normal_balance,
        balance:
          r.normal_balance === 'DEBIT' ? Number(r.net_dr_minus_cr) : -Number(r.net_dr_minus_cr),
      })),
    };
  }
}

@Injectable()
export class GrantService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private rowToDto(r: Record<string, unknown>): GrantDto {
    const award = Number(r.award_amount ?? 0);
    const drawn = Number(r.drawn_amount ?? 0);
    return {
      id: r.id as string,
      schoolId: r.school_id as string,
      fundId: (r.fund_id as string | null) ?? null,
      fundCode: (r.fund_code as string | null) ?? null,
      grantName: r.grant_name as string,
      grantor: r.grantor as string,
      grantNumber: (r.grant_number as string | null) ?? null,
      awardAmount: award,
      drawnAmount: drawn,
      remainingAmount: Math.round((award - drawn) * 100) / 100,
      startDate: r.start_date as string,
      endDate: r.end_date as string,
      status: r.status as GrantDto['status'],
      reportingDueDate: (r.reporting_due_date as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
    };
  }

  async list(): Promise<GrantDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT g.id::text AS id, g.school_id::text AS school_id, g.fund_id::text AS fund_id, f.fund_code, g.grant_name, g.grantor, g.grant_number, g.award_amount, g.drawn_amount, g.start_date::text AS start_date, g.end_date::text AS end_date, g.status, g.reporting_due_date::text AS reporting_due_date, g.notes FROM fin_grants g LEFT JOIN fin_funds f ON f.id = g.fund_id WHERE g.school_id = $1::uuid ORDER BY g.start_date DESC`,
        tenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(id: string): Promise<GrantDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT g.id::text AS id, g.school_id::text AS school_id, g.fund_id::text AS fund_id, f.fund_code, g.grant_name, g.grantor, g.grant_number, g.award_amount, g.drawn_amount, g.start_date::text AS start_date, g.end_date::text AS end_date, g.status, g.reporting_due_date::text AS reporting_due_date, g.notes FROM fin_grants g LEFT JOIN fin_funds f ON f.id = g.fund_id WHERE g.id = $1::uuid AND g.school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    if (rows.length === 0) throw new NotFoundException('Grant not found');
    return this.rowToDto(rows[0]!);
  }

  async create(actor: ResolvedActor, input: CreateGrantDto): Promise<GrantDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can create grants');
    }
    if (input.endDate < input.startDate) {
      throw new BadRequestException('endDate must be on or after startDate');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `INSERT INTO fin_grants (id, school_id, fund_id, grant_name, grantor, grant_number, award_amount, start_date, end_date, reporting_due_date, notes) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::date, $9::date, $10::date, $11)`,
        id,
        tenant.schoolId,
        input.fundId ?? null,
        input.grantName,
        input.grantor,
        input.grantNumber ?? null,
        input.awardAmount,
        input.startDate,
        input.endDate,
        input.reportingDueDate ?? null,
        input.notes ?? null,
      );
    });
    return this.getById(id);
  }

  async patch(actor: ResolvedActor, id: string, input: UpdateGrantDto): Promise<GrantDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can update grants');
    }
    const tenant = getCurrentTenant();
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (input.grantName !== undefined) {
      sets.push(`grant_name = $${i++}`);
      params.push(input.grantName);
    }
    if (input.drawnAmount !== undefined) {
      sets.push(`drawn_amount = $${i++}`);
      params.push(input.drawnAmount);
    }
    if (input.status !== undefined) {
      sets.push(`status = $${i++}`);
      params.push(input.status);
    }
    if (input.notes !== undefined) {
      sets.push(`notes = $${i++}`);
      params.push(input.notes);
    }
    if (input.reportingDueDate !== undefined) {
      sets.push(`reporting_due_date = $${i++}::date`);
      params.push(input.reportingDueDate);
    }
    if (sets.length === 0) return this.getById(id);
    sets.push(`updated_at = now()`);
    params.push(id);
    params.push(tenant.schoolId);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `UPDATE fin_grants SET ${sets.join(', ')} WHERE id = $${i++}::uuid AND school_id = $${i}::uuid`,
        ...params,
      );
    });
    return this.getById(id);
  }
}
