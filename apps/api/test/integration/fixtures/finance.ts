/**
 * Finance fixtures placeholder — Loop 3 (requisitions + settings) and
 * Loop 4 (purchase orders + receipts) will fill this in.
 *
 * Per the design doc, the finance prerequisites needed for procurement
 * tests are:
 *   - sis_academic_years × 1 (current year, drives fin_budgets.academic_year_id)
 *   - fin_suppliers × 2 (vendor references for POs and vendor performance)
 *   - fin_funds × 1 (drives fin_budgets.fund_id)
 *   - fin_chart_of_accounts × 3 — Cash (1000) / AR (1100) / Supplies (5000)
 *   - fin_accounting_periods × 1 OPEN (some receipt paths post to GL)
 *   - fin_budgets × 1 + fin_budget_lines × 1 (Supplies $10,000 / 0 actual /
 *     0 encumbered) — the BUDGET COMMITMENT KEYSTONE relies on this row
 *
 * Stub left in place so the import surface is established. The actual
 * INSERTs land in the loop that first needs them so we don't ship dead
 * fixture code in the scaffold.
 */
import type { PrismaClient } from '@prisma/client';

export async function ensureFinanceFixtures(_prisma: PrismaClient): Promise<void> {
  // Intentionally empty in Loop 2. The trivial ProcurementSettingsService
  // spec does not read any fin_* tables. Loop 3 (requisitions) will be
  // the first suite to need finance fixtures and will populate this.
}

export async function assertFinanceFixtures(_prisma: PrismaClient): Promise<void> {
  // Intentionally empty — see ensureFinanceFixtures above.
}
