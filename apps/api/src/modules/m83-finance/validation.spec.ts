import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '@shared/tenant';
import { FinanceValidationService } from './validation';

/**
 * P2-H4 test coverage uplift — validation.ts (179 LOC, critical-path
 * Tier 1 Financial ≥95%).
 *
 * FinanceValidationService is the shared async-validator surface used by every
 * finance write path (BudgetService, APVoucherService, PostingService,
 * GrantService, RoomBookingService, etc.). REVIEW-CYCLE26 BLOCKING 5 added
 * service-layer validation here so DTO failures surface with finance-domain
 * language (e.g. "expected one of EXPENSE, ASSET, LIABILITY") instead of raw
 * FK-violation noise.
 *
 * Five helpers, each with the same shape — required field, existence check
 * scoped to current tenant, optional state/type constraint, friendly 400
 * with the offending value inlined.
 */

const SCHOOL: TenantInfo = {
  schoolId: '019e0cf8-bbb8-7556-8c81-f07b3369e584',
  schemaName: 'tenant_demo',
  organisationId: 'org-1',
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'MEDIUM',
  homeRegion: 'us-east-1',
};

interface CapturedCall {
  sql: string;
  args: unknown[];
}

function makeTenantPrisma(rowsToReturn: unknown[]) {
  const captures: CapturedCall[] = [];
  const tenantPrisma = {
    executeInTenantContext: async <T>(fn: (client: unknown) => Promise<T>) =>
      fn({
        $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
          captures.push({ sql, args });
          return rowsToReturn;
        },
      }),
  };
  return { tenantPrisma, captures };
}

async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant: SCHOOL }, fn);
}

describe('FinanceValidationService.assertActiveFund', () => {
  it('passes when fund exists and is active', async () => {
    const { tenantPrisma } = makeTenantPrisma([{ '?column?': 1 }]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(() => expect(svc.assertActiveFund('fund-1')).resolves.toBeUndefined());
  });

  it('throws when fundId is empty string', async () => {
    const { tenantPrisma } = makeTenantPrisma([]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.assertActiveFund('')).rejects.toThrow('fundId is required');
    });
  });

  it('uses the fieldName parameter in the error message', async () => {
    const { tenantPrisma } = makeTenantPrisma([]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.assertActiveFund('', 'grantFundId')).rejects.toThrow(
        'grantFundId is required',
      );
    });
  });

  it('throws BadRequest with finance-domain language when no fund matches', async () => {
    const { tenantPrisma } = makeTenantPrisma([]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.assertActiveFund('bogus-fund')).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.assertActiveFund('bogus-fund')).rejects.toThrow(
        'fundId does not match an active fund in this school',
      );
    });
  });

  it('SQL filters by school_id AND is_active=true (cross-tenant + deactivated funds excluded)', async () => {
    const { tenantPrisma, captures } = makeTenantPrisma([{ '?column?': 1 }]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(() => svc.assertActiveFund('fund-1'));
    expect(captures[0].sql).toContain('FROM fin_funds');
    expect(captures[0].sql).toContain('school_id = $2::uuid');
    expect(captures[0].sql).toContain('is_active = true');
    expect(captures[0].args).toEqual(['fund-1', SCHOOL.schoolId]);
  });
});

describe('FinanceValidationService.assertActiveAccount', () => {
  const sampleAccount = {
    account_type: 'EXPENSE',
    account_code: '5100',
    account_name: 'Salaries Expense',
    is_active: true,
  };

  it('passes when account exists, is active, and no type constraint is supplied', async () => {
    const { tenantPrisma } = makeTenantPrisma([sampleAccount]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(() => expect(svc.assertActiveAccount('acct-1')).resolves.toBeUndefined());
  });

  it('throws when accountId is missing', async () => {
    const { tenantPrisma } = makeTenantPrisma([]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.assertActiveAccount('')).rejects.toThrow('accountId is required');
    });
  });

  it('throws when the account does not exist in this tenant', async () => {
    const { tenantPrisma } = makeTenantPrisma([]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.assertActiveAccount('foreign-acct')).rejects.toThrow(
        'accountId does not match a chart-of-accounts row in this school',
      );
    });
  });

  it('throws when the account is INACTIVE with code+name inlined for operator clarity', async () => {
    const { tenantPrisma } = makeTenantPrisma([{ ...sampleAccount, is_active: false }]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.assertActiveAccount('acct-1')).rejects.toThrow(
        'accountId (5100 Salaries Expense) is inactive',
      );
    });
  });

  it('throws when account_type is not in the allowedTypes list', async () => {
    const { tenantPrisma } = makeTenantPrisma([{ ...sampleAccount, account_type: 'REVENUE' }]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.assertActiveAccount('acct-1', ['EXPENSE', 'ASSET', 'LIABILITY']),
      ).rejects.toThrow('account_type=REVENUE; expected one of EXPENSE, ASSET, LIABILITY');
    });
  });

  it('passes when account_type is in the allowedTypes list', async () => {
    const { tenantPrisma } = makeTenantPrisma([sampleAccount]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(() =>
      expect(svc.assertActiveAccount('acct-1', ['EXPENSE', 'ASSET'])).resolves.toBeUndefined(),
    );
  });

  it('skips the type check when allowedTypes is an empty array', async () => {
    const { tenantPrisma } = makeTenantPrisma([{ ...sampleAccount, account_type: 'REVENUE' }]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(() => expect(svc.assertActiveAccount('acct-1', [])).resolves.toBeUndefined());
  });

  it('uses the fieldName parameter in error messages', async () => {
    const { tenantPrisma } = makeTenantPrisma([{ ...sampleAccount, account_type: 'REVENUE' }]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.assertActiveAccount('acct-1', ['EXPENSE'], 'glAccountId')).rejects.toThrow(
        'glAccountId (5100 Salaries Expense)',
      );
    });
  });
});

describe('FinanceValidationService.assertPeriodInState', () => {
  it('passes when period exists and no state constraint is supplied', async () => {
    const { tenantPrisma } = makeTenantPrisma([{ status: 'OPEN' }]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(() => expect(svc.assertPeriodInState('period-1')).resolves.toBeUndefined());
  });

  it('throws when periodId is missing', async () => {
    const { tenantPrisma } = makeTenantPrisma([]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.assertPeriodInState('')).rejects.toThrow('periodId is required');
    });
  });

  it('throws when the period does not exist in this tenant', async () => {
    const { tenantPrisma } = makeTenantPrisma([]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.assertPeriodInState('foreign-period')).rejects.toThrow(
        'periodId does not match an accounting period in this school',
      );
    });
  });

  it('throws when status is not in the allowedStatuses list', async () => {
    const { tenantPrisma } = makeTenantPrisma([{ status: 'CLOSED' }]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.assertPeriodInState('period-1', ['OPEN'])).rejects.toThrow(
        'periodId has status=CLOSED; expected one of OPEN',
      );
    });
  });

  it('passes when status matches one of the allowedStatuses', async () => {
    const { tenantPrisma } = makeTenantPrisma([{ status: 'OPEN' }]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(() =>
      expect(svc.assertPeriodInState('period-1', ['OPEN', 'CLOSED'])).resolves.toBeUndefined(),
    );
  });

  it('skips the status check when allowedStatuses is empty', async () => {
    const { tenantPrisma } = makeTenantPrisma([{ status: 'FUTURE' }]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(() => expect(svc.assertPeriodInState('period-1', [])).resolves.toBeUndefined());
  });
});

describe('FinanceValidationService.assertBudgetLineInCurrentTenant', () => {
  it('passes when budget line exists and parent budget is APPROVED', async () => {
    const { tenantPrisma } = makeTenantPrisma([
      { budget_status: 'APPROVED', account_code: '5100', account_type: 'EXPENSE' },
    ]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(() =>
      expect(svc.assertBudgetLineInCurrentTenant('bl-1')).resolves.toBeUndefined(),
    );
  });

  it('throws when budgetLineId is missing', async () => {
    const { tenantPrisma } = makeTenantPrisma([]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.assertBudgetLineInCurrentTenant('')).rejects.toThrow(
        'budgetLineId is required',
      );
    });
  });

  it('throws when the budget line does not exist in this tenant', async () => {
    const { tenantPrisma } = makeTenantPrisma([]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.assertBudgetLineInCurrentTenant('foreign-bl')).rejects.toThrow(
        'budgetLineId does not match a budget line in this school',
      );
    });
  });

  it('rejects budget lines belonging to a DRAFT budget (only APPROVED accepts commitments)', async () => {
    const { tenantPrisma } = makeTenantPrisma([
      { budget_status: 'DRAFT', account_code: '5100', account_type: 'EXPENSE' },
    ]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.assertBudgetLineInCurrentTenant('bl-1')).rejects.toThrow(
        'belongs to a budget in status=DRAFT; only APPROVED budget lines accept procurement commitments',
      );
    });
  });

  it('rejects REJECTED + CLOSED budgets the same way', async () => {
    for (const status of ['REJECTED', 'CLOSED'] as const) {
      const { tenantPrisma } = makeTenantPrisma([
        { budget_status: status, account_code: '5100', account_type: 'EXPENSE' },
      ]);
      const svc = new FinanceValidationService(tenantPrisma as never);
      await inTenant(async () => {
        await expect(svc.assertBudgetLineInCurrentTenant('bl-1')).rejects.toThrow(
          `status=${status}`,
        );
      });
    }
  });

  it('SQL JOINs fin_budget_lines → fin_budgets → fin_chart_of_accounts with school predicate on the parent budget', async () => {
    const { tenantPrisma, captures } = makeTenantPrisma([
      { budget_status: 'APPROVED', account_code: '5100', account_type: 'EXPENSE' },
    ]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(() => svc.assertBudgetLineInCurrentTenant('bl-1'));
    expect(captures[0].sql).toContain('FROM fin_budget_lines bl');
    expect(captures[0].sql).toContain('JOIN fin_budgets b ON b.id = bl.budget_id');
    expect(captures[0].sql).toContain('JOIN fin_chart_of_accounts a ON a.id = bl.account_id');
    expect(captures[0].sql).toContain('b.school_id = $2::uuid');
  });
});

describe('FinanceValidationService.assertActiveSupplier', () => {
  const sample = {
    supplier_code: 'SUP-001',
    supplier_name: 'Office Supplies Inc',
    is_active: true,
  };

  it('passes when supplier exists and is active', async () => {
    const { tenantPrisma } = makeTenantPrisma([sample]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(() => expect(svc.assertActiveSupplier('sup-1')).resolves.toBeUndefined());
  });

  it('throws when supplierId is missing', async () => {
    const { tenantPrisma } = makeTenantPrisma([]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.assertActiveSupplier('')).rejects.toThrow('supplierId is required');
    });
  });

  it('throws when the supplier does not exist in this tenant', async () => {
    const { tenantPrisma } = makeTenantPrisma([]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.assertActiveSupplier('foreign-sup')).rejects.toThrow(
        'supplierId does not match a supplier in this school',
      );
    });
  });

  it('throws when supplier is INACTIVE with code+name inlined', async () => {
    const { tenantPrisma } = makeTenantPrisma([{ ...sample, is_active: false }]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.assertActiveSupplier('sup-1')).rejects.toThrow(
        'supplierId (SUP-001 Office Supplies Inc) is inactive',
      );
    });
  });

  it('uses the fieldName parameter in error messages', async () => {
    const { tenantPrisma } = makeTenantPrisma([]);
    const svc = new FinanceValidationService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.assertActiveSupplier('s', 'vendorId')).rejects.toThrow(
        'vendorId does not match a supplier in this school',
      );
    });
  });
});
