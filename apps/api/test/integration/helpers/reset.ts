import type { TenantPrismaService } from '../../../src/tenant/tenant-prisma.service';

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
