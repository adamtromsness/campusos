import type { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import {
  TEST_ACADEMIC_YEAR_ID,
  TEST_FUND_ID,
  TEST_COA_CASH_ID,
  TEST_COA_AR_ID,
  TEST_COA_AP_ID,
  TEST_COA_REVENUE_ID,
  TEST_COA_SUPPLIES_ID,
  TEST_PERIOD_ID,
  TEST_BUDGET_ID,
  TEST_BUDGET_LINE_ID,
  TEST_SUPPLIER_A_ID,
  TEST_SUPPLIER_B_ID,
  TEST_INACTIVE_SUPPLIER_ID,
  TEST_FUND_B_ID,
  TEST_COA_SUPPLIES_B_ID,
  TEST_PERIOD_B_ID,
  TEST_BUDGET_B_ID,
  TEST_BUDGET_LINE_B_ID,
  TEST_SUPPLIER_B_SCHOOL_ID,
} from '../fixtures/finance';
import {
  TEST_SIS_ACADEMIC_YEAR_ID,
  TEST_SIS_ACADEMIC_YEAR_B_ID,
} from '../fixtures/sis';
import {
  TEST_HR_ACADEMIC_YEAR_ID,
  TEST_HR_ACADEMIC_YEAR_B_ID,
} from '../fixtures/hr';
import { TEST_ANA_ACADEMIC_YEAR_ID } from '../fixtures/analytics';

/**
 * Procurement tables in dependency order — children first, then parents.
 * Used in TRUNCATE … CASCADE so the order doesn't strictly matter for
 * FK satisfaction, but listing children first makes the intent clear.
 *
 * Per D2 in docs/procurement-integration-test-harness.md: each test
 * starts with a clean procurement slate. Shared infrastructure
 * (school, employees, suppliers, budget) is NOT touched — those live
 * across tests and are seeded once in globalSetup.
 */
const PROCUREMENT_TABLES = [
  'prc_distribution_lines',
  'prc_distributions',
  'prc_returns',
  'prc_goods_receipt_lines',
  'prc_goods_receipts',
  'prc_purchase_order_lines',
  'prc_purchase_orders',
  'prc_requisition_lines',
  'prc_requisitions',
  'prc_budget_commitments',
  'prc_vendor_performance',
  'prc_procurement_settings',
];

/**
 * Wipe every prc_* table in the integration test schema. Safe to call
 * inside beforeEach; the test runs single-fork so there's no race.
 */
export async function resetProcurementTables(tenantPrisma: TenantPrismaService): Promise<void> {
  const tableList = PROCUREMENT_TABLES.join(', ');
  await tenantPrisma.executeInTenantContext(async (client) => {
    await client.$executeRawUnsafe(`TRUNCATE ${tableList} CASCADE`);
  });
}

/**
 * Reset the encumbered_amount on every fin_budget_line in the test
 * schema back to 0. Used in beforeEach for tests that exercise the
 * BUDGET COMMITMENT keystone (PO ISSUE bumps encumbered_amount;
 * CLOSE/CANCEL release it). Without this reset, a failed prior test
 * could leave encumbrance state that breaks subsequent assertions.
 */
export async function resetEncumberedAmount(tenantPrisma: TenantPrismaService): Promise<void> {
  await tenantPrisma.executeInTenantContext(async (client) => {
    await client.$executeRawUnsafe(`UPDATE fin_budget_lines SET encumbered_amount = 0`);
  });
}

/**
 * Fixture allowlists — every row created by globalSetup must survive
 * per-test resets. Tests that create extra accounts / funds / periods
 * are responsible for using fresh UUIDs; the reset wipes everything
 * outside this allowlist.
 */
const FIXTURE_FUND_IDS = [TEST_FUND_ID, TEST_FUND_B_ID];
const FIXTURE_COA_IDS = [
  TEST_COA_CASH_ID,
  TEST_COA_AR_ID,
  TEST_COA_AP_ID,
  TEST_COA_REVENUE_ID,
  TEST_COA_SUPPLIES_ID,
  TEST_COA_SUPPLIES_B_ID,
];
const FIXTURE_PERIOD_IDS = [TEST_PERIOD_ID, TEST_PERIOD_B_ID];
const FIXTURE_BUDGET_IDS = [TEST_BUDGET_ID, TEST_BUDGET_B_ID];
const FIXTURE_BUDGET_LINE_IDS = [TEST_BUDGET_LINE_ID, TEST_BUDGET_LINE_B_ID];
const FIXTURE_SUPPLIER_IDS = [
  TEST_SUPPLIER_A_ID,
  TEST_SUPPLIER_B_ID,
  TEST_INACTIVE_SUPPLIER_ID,
  TEST_SUPPLIER_B_SCHOOL_ID,
];
const FIXTURE_ACADEMIC_YEAR_IDS = [
  TEST_ACADEMIC_YEAR_ID,
  TEST_SIS_ACADEMIC_YEAR_ID,
  TEST_SIS_ACADEMIC_YEAR_B_ID,
  // Wave 8 — m80-hr seeds its own current academic year for leave +
  // appraisal flows; m110-analytics seeds one to anchor cls_/sis_
  // upstream rows for read-model materialisation. Both leak into
  // platform state after their last spec runs (their per-test reset
  // re-seeds them); without these in the allowlist resetFinanceTables
  // tries to DELETE them and the sis_classes FK rejects it.
  TEST_HR_ACADEMIC_YEAR_ID,
  TEST_HR_ACADEMIC_YEAR_B_ID,
  TEST_ANA_ACADEMIC_YEAR_ID,
];

function uuidList(ids: string[]): string {
  // Build a Postgres ARRAY[$1::uuid, $2::uuid, ...] literal at the SQL
  // call site. Cleaner than dragging dynamic parameter binding through
  // every executeRaw call for a reset helper.
  return ids.map((id) => `'${id}'::uuid`).join(', ');
}

/**
 * Reset finance tables so every test starts on the fixture baseline.
 *
 * fin_gl_entries and fin_journal_batches have no fixture rows, so they
 * are TRUNCATEd. TRUNCATE bypasses BEFORE ROW triggers, which matters
 * because fin_gl_entries has an IMMUTABLE prevent_mutation trigger
 * (migration 177) — a DELETE would otherwise raise SQLSTATE 23001.
 *
 * fin_chart_of_accounts, fin_funds, fin_accounting_periods, fin_budgets,
 * fin_budget_lines, fin_suppliers all hold fixture rows seeded by
 * globalSetup. The DELETE WHERE id NOT IN (...allowlist) preserves the
 * fixtures while wiping anything a test created.
 *
 * Also resets fin_budget_lines fixture rows back to encumbered=0 and
 * actual=0 so budget-management tests start clean.
 */
export async function resetFinanceTables(tenantPrisma: TenantPrismaService): Promise<void> {
  await tenantPrisma.executeInTenantContext(async (client) => {
    // GL data — no fixtures, safe to TRUNCATE. CASCADE also drops any
    // child references discovered later. TRUNCATE bypasses BEFORE ROW
    // triggers, which matters because fin_gl_entries carries the
    // IMMUTABLE prevent_mutation trigger (migration 177) — a DELETE
    // would otherwise raise SQLSTATE 23001.
    await client.$executeRawUnsafe(
      `TRUNCATE fin_gl_entries, fin_journal_batches RESTART IDENTITY CASCADE`,
    );

    // AP layer — also no protected fixtures yet.
    await client.$executeRawUnsafe(
      `TRUNCATE fin_ap_payments, fin_ap_vouchers RESTART IDENTITY CASCADE`,
    );

    // Departmental budgets + transfers + manual journal entry batches —
    // financial-advanced surfaces (M83 advanced). All test-created.
    await client.$executeRawUnsafe(
      `TRUNCATE fin_journal_entry_lines, fin_journal_entry_batches, fin_budget_transfers, fin_departmental_budgets RESTART IDENTITY CASCADE`,
    );

    // Wipe any test-created rows in the fixture-bearing tables. Order
    // respects FK dependency: children first.
    await client.$executeRawUnsafe(
      `DELETE FROM fin_budget_lines WHERE id NOT IN (${uuidList(FIXTURE_BUDGET_LINE_IDS)})`,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM fin_budgets WHERE id NOT IN (${uuidList(FIXTURE_BUDGET_IDS)})`,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM fin_chart_of_accounts WHERE id NOT IN (${uuidList(FIXTURE_COA_IDS)})`,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM fin_funds WHERE id NOT IN (${uuidList(FIXTURE_FUND_IDS)})`,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM fin_accounting_periods WHERE id NOT IN (${uuidList(FIXTURE_PERIOD_IDS)})`,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM fin_suppliers WHERE id NOT IN (${uuidList(FIXTURE_SUPPLIER_IDS)})`,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM sis_academic_years WHERE id NOT IN (${uuidList(FIXTURE_ACADEMIC_YEAR_IDS)})`,
    );

    // Reset fixture budget_lines back to zeroed encumbrance + actuals so
    // budget-management tests have a clean baseline.
    await client.$executeRawUnsafe(
      `UPDATE fin_budget_lines SET encumbered_amount = 0, actual_amount = 0`,
    );

    // Reset fixture period back to OPEN — some tests may transition it
    // to CLOSED or LOCKED and we want each test to start from the
    // fixture baseline. closed_at/locked_at zeroed.
    await client.$executeRawUnsafe(
      `UPDATE fin_accounting_periods
         SET status = 'OPEN', closed_at = NULL, closed_by = NULL,
             locked_at = NULL, locked_by = NULL
         WHERE id IN (${uuidList(FIXTURE_PERIOD_IDS)})`,
    );

    // Reset fixture chart-of-accounts rows back to is_active=true so
    // tests that deactivate an account during the run don't poison the
    // next test.
    await client.$executeRawUnsafe(
      `UPDATE fin_chart_of_accounts SET is_active = true WHERE id IN (${uuidList(FIXTURE_COA_IDS)})`,
    );
  });
}

/**
 * Reset every m84-payments-owned table. pay_credit_notes, pay_payment_reversals,
 * pay_lunch_account_balance_transfers carry IMMUTABLE prevent_mutation triggers
 * (migration 177) — TRUNCATE bypasses BEFORE ROW triggers, so this is the
 * only safe per-test reset. Order respects FK cascades (children first).
 */
export async function resetPaymentsTables(tenantPrisma: TenantPrismaService): Promise<void> {
  await tenantPrisma.executeInTenantContext(async (client) => {
    // Children first: reversals → refunds → credit notes → ledger → payments
    // → invoice line items → invoices → late fees → discount rules →
    // financial aid → fee schedules → payment plans → lunch accounts →
    // saved payment methods → family account students → family accounts.
    await client.$executeRawUnsafe(
      `TRUNCATE
         pay_payment_reversals,
         pay_credit_notes,
         pay_refunds,
         pay_payment_allocations,
         pay_ledger_entries,
         pay_payments,
         pay_invoice_line_items,
         pay_invoices,
         pay_invoice_generation_runs,
         pay_auto_invoice_rules,
         pay_late_payment_policies,
         pay_discount_rules,
         pay_financial_aid_awards,
         pay_financial_aid_applications,
         pay_financial_aid_programs,
         pay_fee_schedules,
         pay_fee_categories,
         pay_payment_plan_installments,
         pay_payment_plans,
         pay_lunch_account_balance_transfers,
         pay_lunch_transactions,
         pay_lunch_accounts,
         pay_saved_payment_methods,
         pay_stripe_accounts,
         pay_family_account_students,
         pay_family_accounts
       RESTART IDENTITY CASCADE`,
    );
  });
}

/**
 * Extended reset for tests that touch the GL reconciliation + bank-
 * reconciliation + grants + board-reports + supplier-contact surfaces
 * in addition to the core finance tables. Call this from gl-reconciliation,
 * ap-voucher, reconciliation, grants, and board-reports specs instead of
 * the bare resetFinanceTables.
 *
 * Also wipes the m84-payments tables because the GL reconciliation worker
 * scans pay_invoices / pay_payments / pay_refunds / pay_credit_notes /
 * pay_payment_reversals as source surfaces for its checks.
 */
export async function resetFinanceAdvancedTables(
  tenantPrisma: TenantPrismaService,
): Promise<void> {
  await resetFinanceTables(tenantPrisma);
  await resetPaymentsTables(tenantPrisma);
  await tenantPrisma.executeInTenantContext(async (client) => {
    await client.$executeRawUnsafe(
      `TRUNCATE fin_reconciliation_runs, fin_grants, fin_board_report_snapshots, fin_supplier_contacts RESTART IDENTITY CASCADE`,
    );
    await client.$executeRawUnsafe(`TRUNCATE rpt_gl_reconciliation RESTART IDENTITY CASCADE`);
  });
}
