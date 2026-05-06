import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-procurement.ts — Cycle 27 Step 4.
 *
 * M86 Procurement. Idempotent — gated on whether prc_procurement_settings
 * already has a row for the demo school.
 *
 * Tenant-only seed targeting tenant_demo:
 *   - 1 procurement settings row (PO prefix 'PO', next seq 2 since
 *     the seeded PO already takes seq 1).
 *   - 2 requisitions + 5 lines:
 *       * Req #1 Rivera 10 Chromebooks (tech) ADMIN_APPROVED.
 *       * Req #2 Cafeteria food supplies (fds) SUBMITTED 3 lines.
 *   - 1 PO + 2 lines: PO-2026-001 to "Office Supplies Inc" (the
 *     Cycle 26 fin_suppliers seed) for 10 Chromebook + 10 cases =
 *     $3,250 RECEIVED. Linked to Req #1.
 *   - 1 goods receipt + 2 lines: 10 Chromebooks (9 GOOD + 1
 *     DAMAGED), 10 cases all GOOD. Inspection ACCEPTED_WITH_DISCREPANCY.
 *   - 1 budget commitment $3,250 against the Cycle 26 Supplies
 *     budget line (since the demo seed has no Technology line on
 *     the budget; Supplies is what the seeded budget actually
 *     carries). Status COMMITTED.
 *   - 1 distribution + 1 line: 9 Chromebooks → tech.
 *   - 1 return: 1 damaged Chromebook WARRANTY_CLAIM, INITIATED.
 *   - 1 vendor performance: 1 order, 1 on-time, 0 late, 19 accepted,
 *     1 rejected, quality 0.95, delivery 1.0.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function main() {
  const client = getPlatformClient();

  const routingRows = (await client.$queryRawUnsafe(
    'SELECT schema_name FROM platform.platform_tenant_routing WHERE schema_name = $1 LIMIT 1',
    TENANT_SCHEMA,
  )) as Array<{ schema_name: string }>;
  if (routingRows.length === 0) {
    console.error(`Tenant ${TENANT_SCHEMA} not provisioned — run pnpm seed first`);
    process.exit(1);
  }

  const schoolRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM platform.schools LIMIT 1',
  )) as Array<{ id: string }>;
  const schoolId = schoolRows[0]!.id;

  // Idempotency gate
  const existing = (await client.$queryRawUnsafe(
    `SELECT 1 FROM ${TENANT_SCHEMA}.prc_procurement_settings WHERE school_id = $1::uuid LIMIT 1`,
    schoolId,
  )) as Array<unknown>;
  if (existing.length > 0) {
    console.log('Procurement settings already exist for demo school — skipping');
    await disconnectAll();
    return;
  }

  // Resolve actors + Cycle 26 refs
  const employees = (await client.$queryRawUnsafe(
    `SELECT e.id::text AS employee_id, ip.id::text AS person_id, ip.first_name, ip.last_name
     FROM ${TENANT_SCHEMA}.hr_employees e
     JOIN platform.iam_person ip ON ip.id = e.person_id`,
  )) as Array<{ employee_id: string; person_id: string; first_name: string; last_name: string }>;
  const rivera = employees.find((e) => e.last_name === 'Rivera')!;
  const mitchell = employees.find((e) => e.last_name === 'Mitchell')!;
  const hayes = employees.find((e) => e.last_name === 'Hayes')!;
  if (!rivera || !mitchell) {
    console.error('Required HR employees (Rivera + Mitchell) not seeded');
    process.exit(1);
  }

  const supplierRows = (await client.$queryRawUnsafe(
    `SELECT id::text AS id, supplier_name FROM ${TENANT_SCHEMA}.fin_suppliers WHERE school_id = $1::uuid LIMIT 1`,
    schoolId,
  )) as Array<{ id: string; supplier_name: string }>;
  if (supplierRows.length === 0) {
    console.error('Cycle 26 fin_suppliers must be seeded first — run seed:finance');
    process.exit(1);
  }
  const supplier = supplierRows[0]!;

  const budgetLineRows = (await client.$queryRawUnsafe(
    `SELECT bl.id::text AS id, a.account_code, a.account_name, bl.budgeted_amount, bl.actual_amount
     FROM ${TENANT_SCHEMA}.fin_budget_lines bl
     JOIN ${TENANT_SCHEMA}.fin_chart_of_accounts a ON a.id = bl.account_id
     WHERE a.account_code = '5000'
     LIMIT 1`,
  )) as Array<{
    id: string;
    account_code: string;
    account_name: string;
    budgeted_amount: string;
    actual_amount: string;
  }>;
  if (budgetLineRows.length === 0) {
    console.error('Cycle 26 budget line for account 5000 must exist — run seed:finance');
    process.exit(1);
  }
  const suppliesLine = budgetLineRows[0]!;

  const techExpenseAcct = (await client.$queryRawUnsafe(
    `SELECT id::text AS id FROM ${TENANT_SCHEMA}.fin_chart_of_accounts WHERE school_id = $1::uuid AND account_code = '5400' LIMIT 1`,
    schoolId,
  )) as Array<{ id: string }>;

  // ── Procurement Settings ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.prc_procurement_settings (id, school_id, default_payment_terms, po_number_prefix, po_number_next_seq, auto_po_threshold, require_three_quotes_above) VALUES ($1::uuid, $2::uuid, 'NET_30', 'PO', 2, 500, 5000)`,
    generateId(),
    schoolId,
  );

  // ── Requisition #1: Rivera Chromebooks ADMIN_APPROVED ──
  const req1Id = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.prc_requisitions (id, school_id, requesting_person_id, requesting_department, urgency, status, total_estimated_cost, budget_line_id, justification, submitted_at, reviewed_at, reviewed_by) VALUES ($1::uuid, $2::uuid, $3::uuid, 'Classroom', 'ROUTINE', 'ADMIN_APPROVED', 3250, $4::uuid, 'Need 10 Chromebooks + protective cases for Grade 5 1:1 device rollout', now() - interval '14 days', now() - interval '10 days', $5::uuid)`,
    req1Id,
    schoolId,
    rivera.person_id,
    suppliesLine.id,
    mitchell.employee_id,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.prc_requisition_lines (id, requisition_id, item_description, quantity, unit, estimated_unit_cost, specifications, preferred_vendor_id, destination_module, line_order) VALUES
     ($1::uuid, $2::uuid, 'Chromebook 14in standard issue', 10, 'each', 300, 'Touchscreen, 4GB RAM, 64GB storage', $3::uuid, 'tech', 0),
     ($4::uuid, $2::uuid, 'Protective case for Chromebook', 10, 'each', 25, 'Drop-rated, school colour navy', $3::uuid, 'tech', 1)`,
    generateId(),
    req1Id,
    supplier.id,
    generateId(),
  );

  // ── Requisition #2: Hayes Cafeteria SUBMITTED ──
  const req2Id = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.prc_requisitions (id, school_id, requesting_person_id, requesting_department, urgency, status, total_estimated_cost, justification, submitted_at) VALUES ($1::uuid, $2::uuid, $3::uuid, 'Food Service', 'URGENT', 'SUBMITTED', 850, 'Weekly food supplies replenishment for the cafeteria', now() - interval '2 days')`,
    req2Id,
    schoolId,
    hayes ? hayes.person_id : rivera.person_id,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.prc_requisition_lines (id, requisition_id, item_description, quantity, unit, estimated_unit_cost, destination_module, line_order) VALUES
     ($1::uuid, $2::uuid, 'Bread loaves', 50, 'loaf', 4, 'fds', 0),
     ($3::uuid, $2::uuid, 'Milk 1gal', 80, 'gallon', 5, 'fds', 1),
     ($4::uuid, $2::uuid, 'Apples', 100, 'lb', 2.50, 'fds', 2)`,
    generateId(),
    req2Id,
    generateId(),
    generateId(),
  );

  // ── PO PO-2026-001 from Req #1 ──
  const poId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.prc_purchase_orders (id, school_id, po_number, vendor_id, requisition_id, delivery_address, expected_delivery_date, payment_terms, status, total_amount, notes, issued_by, issued_at) VALUES ($1::uuid, $2::uuid, 'PO-2026-001', $3::uuid, $4::uuid, '450 School Lane, Springfield, IL 62701', $5::date, 'NET_30', 'RECEIVED', 3250, 'Initial Chromebook rollout', $6::uuid, now() - interval '7 days')`,
    poId,
    schoolId,
    supplier.id,
    req1Id,
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    mitchell.employee_id,
  );
  const poLine1Id = generateId();
  const poLine2Id = generateId();
  const glAcctId = techExpenseAcct[0]?.id ?? null;
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.prc_purchase_order_lines (id, purchase_order_id, item_description, quantity_ordered, unit_cost, line_total, gl_account_id, destination_module, line_order) VALUES
     ($1::uuid, $2::uuid, 'Chromebook 14in standard issue', 10, 300, 3000, $3::uuid, 'tech', 0),
     ($4::uuid, $2::uuid, 'Protective case for Chromebook', 10, 25, 250, $3::uuid, 'tech', 1)`,
    poLine1Id,
    poId,
    glAcctId,
    poLine2Id,
  );

  // ── Goods Receipt — 10 Chromebooks (9 GOOD + 1 DAMAGED) + 10 cases all GOOD ──
  const receiptId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.prc_goods_receipts (id, purchase_order_id, received_by, received_at, inspection_outcome, notes) VALUES ($1::uuid, $2::uuid, $3::uuid, now() - interval '5 days', 'ACCEPTED_WITH_DISCREPANCY', 'One Chromebook arrived with cosmetic damage to the lid')`,
    receiptId,
    poId,
    mitchell.employee_id,
  );
  const recLine1Id = generateId();
  const recLine2Id = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.prc_goods_receipt_lines (id, receipt_id, po_line_id, quantity_received, quantity_accepted, quantity_rejected, condition, discrepancy_notes) VALUES
     ($1::uuid, $2::uuid, $3::uuid, 10, 9, 1, 'DAMAGED', 'Unit #10 has cosmetic damage to lid; rejected for warranty claim'),
     ($4::uuid, $2::uuid, $5::uuid, 10, 10, 0, 'GOOD', NULL)`,
    recLine1Id,
    receiptId,
    poLine1Id,
    recLine2Id,
    poLine2Id,
  );

  // ── Budget Commitment $3,250 against Supplies (since the demo budget has Supplies, not Technology, with non-zero remaining) ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.prc_budget_commitments (id, purchase_order_id, budget_line_id, committed_amount, status) VALUES ($1::uuid, $2::uuid, $3::uuid, 3250, 'COMMITTED')`,
    generateId(),
    poId,
    suppliesLine.id,
  );
  // Bump fin_budget_lines.encumbered_amount to reflect the seeded commitment
  await client.$executeRawUnsafe(
    `UPDATE ${TENANT_SCHEMA}.fin_budget_lines SET encumbered_amount = encumbered_amount + 3250, updated_at = now() WHERE id = $1::uuid`,
    suppliesLine.id,
  );

  // ── Distribution: 9 Chromebooks + 10 cases → tech ──
  const distId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.prc_distributions (id, receipt_id, distributed_by, distributed_at, destination_module, destination_department, notes) VALUES ($1::uuid, $2::uuid, $3::uuid, now() - interval '3 days', 'tech', 'IT Department', 'Distributed to IT for asset tagging and 1:1 rollout')`,
    distId,
    receiptId,
    mitchell.employee_id,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.prc_distribution_lines (id, distribution_id, receipt_line_id, quantity_distributed, item_description, unit_cost, line_order) VALUES
     ($1::uuid, $2::uuid, $3::uuid, 9, 'Chromebook 14in standard issue', 300, 0),
     ($4::uuid, $2::uuid, $5::uuid, 10, 'Protective case for Chromebook', 25, 1)`,
    generateId(),
    distId,
    recLine1Id,
    generateId(),
    recLine2Id,
  );

  // ── Return: 1 damaged Chromebook WARRANTY_CLAIM ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.prc_returns (id, receipt_line_id, return_type, quantity_returned, return_reference, vendor_rma_number, status, initiated_by, initiated_at) VALUES ($1::uuid, $2::uuid, 'WARRANTY_CLAIM', 1, 'INTERNAL-RTN-001', 'OSI-RMA-2026-0042', 'INITIATED', $3::uuid, now() - interval '4 days')`,
    generateId(),
    recLine1Id,
    mitchell.employee_id,
  );

  // ── Vendor Performance ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.prc_vendor_performance (id, vendor_id, school_id, total_orders, on_time_deliveries, late_deliveries, accepted_count, rejected_count, average_quality_score, average_delivery_score) VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 1, 0, 19, 1, 0.9500, 1.0000)`,
    generateId(),
    supplier.id,
    schoolId,
  );

  console.log(`seeded 1 procurement settings, 2 requisitions + 5 lines, 1 PO + 2 lines (RECEIVED)`);
  console.log(
    `seeded 1 receipt + 2 lines (9 GOOD + 1 DAMAGED + 10 GOOD), 1 budget commitment $3250`,
  );
  console.log(
    `seeded 1 distribution + 2 lines → tech, 1 WARRANTY_CLAIM return, 1 vendor performance`,
  );

  await disconnectAll();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
