import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';

// REVIEW-CYCLE26 BLOCKING 5 — service-layer finance validation
// helpers. The migration's tenant-local FKs reject IDs from other
// tables, but a finance module needs business-semantics validation
// too: account exists AND is active; account_type matches the
// expected role for the operation; fund is active; period is OPEN
// (or in a permitted set). These helpers throw friendly 400s with
// finance-domain language so callers + consumers + UIs surface a
// clear message instead of a raw FK violation message.

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

@Injectable()
export class FinanceValidationService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Verifies the supplied fund_id exists in this tenant AND is_active=true.
   * Throws 400 with the field name on miss so error messages identify
   * which DTO field tripped.
   */
  async assertActiveFund(fundId: string, fieldName = 'fundId'): Promise<void> {
    if (!fundId) throw new BadRequestException(`${fieldName} is required`);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT 1 FROM fin_funds WHERE id = $1::uuid AND school_id = $2::uuid AND is_active = true LIMIT 1`,
        fundId,
        tenant.schoolId,
      );
    })) as Array<unknown>;
    if (rows.length === 0) {
      throw new BadRequestException(
        `${fieldName} does not match an active fund in this school. Confirm the id and that the fund has not been deactivated.`,
      );
    }
  }

  /**
   * Verifies the supplied account_id exists in this tenant, is active,
   * and (when allowedTypes is supplied) carries one of those account_types.
   */
  async assertActiveAccount(
    accountId: string,
    allowedTypes?: AccountType[],
    fieldName = 'accountId',
  ): Promise<void> {
    if (!accountId) throw new BadRequestException(`${fieldName} is required`);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT account_type, account_code, account_name, is_active FROM fin_chart_of_accounts WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        accountId,
        tenant.schoolId,
      );
    })) as Array<{
      account_type: string;
      account_code: string;
      account_name: string;
      is_active: boolean;
    }>;
    if (rows.length === 0) {
      throw new BadRequestException(
        `${fieldName} does not match a chart-of-accounts row in this school.`,
      );
    }
    const a = rows[0]!;
    if (!a.is_active) {
      throw new BadRequestException(
        `${fieldName} (${a.account_code} ${a.account_name}) is inactive — deactivated accounts cannot be used in new finance writes.`,
      );
    }
    if (
      allowedTypes &&
      allowedTypes.length > 0 &&
      !allowedTypes.includes(a.account_type as AccountType)
    ) {
      throw new BadRequestException(
        `${fieldName} (${a.account_code} ${a.account_name}) has account_type=${a.account_type}; expected one of ${allowedTypes.join(', ')}.`,
      );
    }
  }

  /**
   * Verifies the supplied period_id exists in this tenant. When
   * allowedStatuses is supplied, also asserts the period status is
   * one of those values. Used by reconciliation start (any non-FUTURE
   * period accepted) and other finance writes that pin to a period.
   */
  async assertPeriodInState(
    periodId: string,
    allowedStatuses?: Array<'FUTURE' | 'OPEN' | 'CLOSED' | 'LOCKED'>,
    fieldName = 'periodId',
  ): Promise<void> {
    if (!periodId) throw new BadRequestException(`${fieldName} is required`);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT status FROM fin_accounting_periods WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        periodId,
        tenant.schoolId,
      );
    })) as Array<{ status: string }>;
    if (rows.length === 0) {
      throw new BadRequestException(
        `${fieldName} does not match an accounting period in this school.`,
      );
    }
    if (
      allowedStatuses &&
      allowedStatuses.length > 0 &&
      !allowedStatuses.includes(rows[0]!.status as 'FUTURE' | 'OPEN' | 'CLOSED' | 'LOCKED')
    ) {
      throw new BadRequestException(
        `${fieldName} has status=${rows[0]!.status}; expected one of ${allowedStatuses.join(', ')}.`,
      );
    }
  }

  /**
   * Verifies the supplied budget_line_id exists in this tenant + the
   * parent budget is APPROVED (not DRAFT or REJECTED). Used by Cycle
   * 27 procurement: requisitions and POs reference budget lines for
   * the budget commitment keystone, and a draft budget should not
   * yet hold real procurement encumbrance.
   */
  async assertBudgetLineInCurrentTenant(
    budgetLineId: string,
    fieldName = 'budgetLineId',
  ): Promise<void> {
    if (!budgetLineId) throw new BadRequestException(`${fieldName} is required`);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT b.status AS budget_status, a.account_code, a.account_type FROM fin_budget_lines bl JOIN fin_budgets b ON b.id = bl.budget_id JOIN fin_chart_of_accounts a ON a.id = bl.account_id WHERE bl.id = $1::uuid AND b.school_id = $2::uuid LIMIT 1`,
        budgetLineId,
        tenant.schoolId,
      );
    })) as Array<{ budget_status: string; account_code: string; account_type: string }>;
    if (rows.length === 0) {
      throw new BadRequestException(
        `${fieldName} does not match a budget line in this school. Confirm the id is from an active budget.`,
      );
    }
    const r = rows[0]!;
    if (r.budget_status !== 'APPROVED') {
      throw new BadRequestException(
        `${fieldName} belongs to a budget in status=${r.budget_status}; only APPROVED budget lines accept procurement commitments.`,
      );
    }
  }

  /**
   * Verifies the supplied supplier_id exists + is_active=true in this tenant.
   */
  async assertActiveSupplier(supplierId: string, fieldName = 'supplierId'): Promise<void> {
    if (!supplierId) throw new BadRequestException(`${fieldName} is required`);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT supplier_code, supplier_name, is_active FROM fin_suppliers WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        supplierId,
        tenant.schoolId,
      );
    })) as Array<{ supplier_code: string; supplier_name: string; is_active: boolean }>;
    if (rows.length === 0) {
      throw new BadRequestException(`${fieldName} does not match a supplier in this school.`);
    }
    if (!rows[0]!.is_active) {
      const r = rows[0]!;
      throw new BadRequestException(
        `${fieldName} (${r.supplier_code} ${r.supplier_name}) is inactive — deactivated suppliers cannot receive new vouchers.`,
      );
    }
  }
}
