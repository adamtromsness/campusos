import type { PrismaClient } from '@prisma/client';
import { TEST_SCHOOL_ID, TEST_SCHEMA } from '../helpers/tenant-context';

/**
 * Finance fixtures for the procurement integration suite (Loop 3 expansion).
 *
 * The procurement services dereference these tenant tables via
 * FinanceValidationService.assert* helpers and via the BUDGET COMMITMENT
 * keystone in PurchaseOrderService.transition. Stable across the suite,
 * seeded once by globalSetup.
 *
 * IDs use the 'aaaa-7777-8888-0000000001xx' pattern so they cannot collide
 * with org/school/actor IDs (which use the 0000000000xx and 0000000000Yx
 * ranges).
 */
export const TEST_ACADEMIC_YEAR_ID = '019e0cf8-aaaa-7777-8888-000000000100';
export const TEST_FUND_ID = '019e0cf8-aaaa-7777-8888-000000000110';
export const TEST_COA_CASH_ID = '019e0cf8-aaaa-7777-8888-000000000120';
export const TEST_COA_AR_ID = '019e0cf8-aaaa-7777-8888-000000000121';
export const TEST_COA_SUPPLIES_ID = '019e0cf8-aaaa-7777-8888-000000000122';
export const TEST_PERIOD_ID = '019e0cf8-aaaa-7777-8888-000000000130';
export const TEST_BUDGET_ID = '019e0cf8-aaaa-7777-8888-000000000140';
export const TEST_BUDGET_LINE_ID = '019e0cf8-aaaa-7777-8888-000000000150';
export const TEST_SUPPLIER_A_ID = '019e0cf8-aaaa-7777-8888-000000000160';
export const TEST_SUPPLIER_B_ID = '019e0cf8-aaaa-7777-8888-000000000161';
export const TEST_INACTIVE_SUPPLIER_ID = '019e0cf8-aaaa-7777-8888-000000000162';

const TEST_FISCAL_YEAR = '2026';
const TEST_BUDGET_AMOUNT = 10000;

export async function ensureFinanceFixtures(prisma: PrismaClient): Promise<void> {
  // ─── 1. sis_academic_years ───
  // Required by fin_budgets.fiscal_year FK semantics + the procurement plan
  // requires a current-year row exists. Use 2025-08 → 2026-07 so today's
  // date lands inside the OPEN accounting period that we create below.
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_academic_years (id, school_id, name, start_date, end_date, is_current)
     VALUES ($1::uuid, $2::uuid, '2025-2026 Test', '2025-08-01', '2026-07-31', false)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ACADEMIC_YEAR_ID,
    TEST_SCHOOL_ID,
  );

  // ─── 2. fin_funds ───
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.fin_funds (id, school_id, fund_code, fund_name, fund_type, is_active)
     VALUES ($1::uuid, $2::uuid, 'GENERAL', 'General Fund', 'GENERAL', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_FUND_ID,
    TEST_SCHOOL_ID,
  );

  // ─── 3. fin_chart_of_accounts ───
  const accounts = [
    { id: TEST_COA_CASH_ID, code: '1000', name: 'Cash', type: 'ASSET', normal: 'DEBIT' },
    {
      id: TEST_COA_AR_ID,
      code: '1100',
      name: 'Accounts Receivable',
      type: 'ASSET',
      normal: 'DEBIT',
    },
    {
      id: TEST_COA_SUPPLIES_ID,
      code: '5000',
      name: 'Office Supplies',
      type: 'EXPENSE',
      normal: 'DEBIT',
    },
  ];
  for (const a of accounts) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.fin_chart_of_accounts
         (id, school_id, account_code, account_name, account_type, normal_balance, fund_id, is_active)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, true)
       ON CONFLICT (id) DO NOTHING`,
      a.id,
      TEST_SCHOOL_ID,
      a.code,
      a.name,
      a.type,
      a.normal,
      TEST_FUND_ID,
    );
  }

  // ─── 4. fin_accounting_periods ───
  // OPEN period covering 2025-08 → 2026-07. Some receipt + distribution
  // paths may post to this period later in Loop 4/5.
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.fin_accounting_periods
       (id, school_id, fiscal_year, period_number, period_name, start_date, end_date, status)
     VALUES ($1::uuid, $2::uuid, $3, 1, 'Test FY ${TEST_FISCAL_YEAR}', '2025-08-01', '2026-07-31', 'OPEN')
     ON CONFLICT (id) DO NOTHING`,
    TEST_PERIOD_ID,
    TEST_SCHOOL_ID,
    TEST_FISCAL_YEAR,
  );

  // ─── 5. fin_budgets ───
  // APPROVED so FinanceValidationService.assertBudgetLineInCurrentTenant passes.
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.fin_budgets
       (id, school_id, fiscal_year, fund_id, name, total_revenue, total_expense, status)
     VALUES ($1::uuid, $2::uuid, $3, $4::uuid, 'Test Operating Budget', 0, $5, 'APPROVED')
     ON CONFLICT (id) DO NOTHING`,
    TEST_BUDGET_ID,
    TEST_SCHOOL_ID,
    TEST_FISCAL_YEAR,
    TEST_FUND_ID,
    TEST_BUDGET_AMOUNT,
  );

  // ─── 6. fin_budget_lines ───
  // Single line pointing at Office Supplies, $10,000 budgeted, $0 actual,
  // $0 encumbered. Reset every test via helpers/reset.ts::resetEncumberedAmount.
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.fin_budget_lines
       (id, budget_id, account_id, budgeted_amount, actual_amount, encumbered_amount)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 0, 0)
     ON CONFLICT (id) DO NOTHING`,
    TEST_BUDGET_LINE_ID,
    TEST_BUDGET_ID,
    TEST_COA_SUPPLIES_ID,
    TEST_BUDGET_AMOUNT,
  );

  // ─── 7. fin_suppliers ───
  const suppliers = [
    { id: TEST_SUPPLIER_A_ID, code: 'SUP-A', name: 'Test Vendor Alpha', active: true },
    { id: TEST_SUPPLIER_B_ID, code: 'SUP-B', name: 'Test Vendor Beta', active: true },
    {
      id: TEST_INACTIVE_SUPPLIER_ID,
      code: 'SUP-INACTIVE',
      name: 'Decommissioned Vendor',
      active: false,
    },
  ];
  for (const s of suppliers) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.fin_suppliers
         (id, school_id, supplier_code, supplier_name, supplier_type, payment_terms, is_active)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'VENDOR', 'NET_30', $5)
       ON CONFLICT (id) DO NOTHING`,
      s.id,
      TEST_SCHOOL_ID,
      s.code,
      s.name,
      s.active,
    );
  }
}

export async function assertFinanceFixtures(prisma: PrismaClient): Promise<void> {
  const checks: Array<{ label: string; sql: string }> = [
    {
      label: 'sis_academic_years',
      sql: `SELECT 1 FROM ${TEST_SCHEMA}.sis_academic_years WHERE id = '${TEST_ACADEMIC_YEAR_ID}'::uuid`,
    },
    {
      label: 'fin_funds',
      sql: `SELECT 1 FROM ${TEST_SCHEMA}.fin_funds WHERE id = '${TEST_FUND_ID}'::uuid`,
    },
    {
      label: 'fin_chart_of_accounts (Supplies)',
      sql: `SELECT 1 FROM ${TEST_SCHEMA}.fin_chart_of_accounts WHERE id = '${TEST_COA_SUPPLIES_ID}'::uuid AND account_type = 'EXPENSE'`,
    },
    {
      label: 'fin_accounting_periods (OPEN)',
      sql: `SELECT 1 FROM ${TEST_SCHEMA}.fin_accounting_periods WHERE id = '${TEST_PERIOD_ID}'::uuid AND status = 'OPEN'`,
    },
    {
      label: 'fin_budgets (APPROVED)',
      sql: `SELECT 1 FROM ${TEST_SCHEMA}.fin_budgets WHERE id = '${TEST_BUDGET_ID}'::uuid AND status = 'APPROVED'`,
    },
    {
      label: 'fin_budget_lines',
      sql: `SELECT 1 FROM ${TEST_SCHEMA}.fin_budget_lines WHERE id = '${TEST_BUDGET_LINE_ID}'::uuid`,
    },
    {
      label: 'fin_suppliers (active alpha)',
      sql: `SELECT 1 FROM ${TEST_SCHEMA}.fin_suppliers WHERE id = '${TEST_SUPPLIER_A_ID}'::uuid AND is_active = true`,
    },
    {
      label: 'fin_suppliers (inactive)',
      sql: `SELECT 1 FROM ${TEST_SCHEMA}.fin_suppliers WHERE id = '${TEST_INACTIVE_SUPPLIER_ID}'::uuid AND is_active = false`,
    },
  ];
  for (const check of checks) {
    const rows = (await prisma.$queryRawUnsafe(check.sql)) as unknown[];
    if (rows.length === 0) {
      throw new Error(
        `Integration test fixture missing: ${check.label}. ` +
          'Re-run globalSetup or delete tenant_test and try again.',
      );
    }
  }
}
