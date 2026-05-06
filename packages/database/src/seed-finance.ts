import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-finance.ts — Cycle 26 Step 4.
 *
 * M83 Finance & Accounting. Idempotent — gated on whether the
 * GENERAL fund already exists for the demo school.
 *
 * Tenant-only seed targeting tenant_demo:
 *   - 3 funds (GENERAL operating, SPECIAL_REVENUE Title I,
 *     CAPITAL_PROJECTS building fund).
 *   - 15 chart of accounts: Assets (1000 Cash + 1100 AR + 1200
 *     Prepaid), Liabilities (2000 AP + 2100 Accrued), Equity
 *     (3000 Fund Balance), Revenue (4000 Tuition + 4100 Fees +
 *     4200 Grants), Expenses (5000 Supplies + 5100 Salaries +
 *     5200 Utilities + 5300 Maintenance + 5400 Technology + 5500
 *     Food Service). 1000/1100/2000 flagged is_system.
 *   - 12 accounting periods covering FY2025-2026 (Jul 2025 – Jun
 *     2026). Jul–Sep CLOSED + Jul also LOCKED. Oct–Apr OPEN.
 *     May–Jun FUTURE.
 *   - 2 journal batches with 4 GL entries: AUTO_PAYMENT $3,500
 *     tuition (DEBIT Cash + CREDIT Tuition) and MANUAL $1,200
 *     supplies (DEBIT Supplies + CREDIT Cash). Both POSTED.
 *   - 1 budget GENERAL FY2025-2026 with 10 lines spanning revenue
 *     + expense accounts. actual_amount populated where the
 *     seeded GL entries hit.
 *   - 1 supplier "Office Supplies Inc" + 1 primary contact.
 *   - 1 AP voucher V-2025-0001 (Office Supplies Inc, $1,200,
 *     PAID) + 1 ap_payment linked to the manual supplies batch.
 *   - 1 reconciliation_run for Cash account in October period —
 *     gl=125,000 / bank=124,850 / variance $150 outstanding check
 *     — status VARIANCE_FLAGGED.
 *   - 1 board_report_snapshot BUDGET_VS_ACTUAL for September.
 *   - 1 grant "Title I Reading Improvement" SPECIAL_REVENUE,
 *     $50,000 award / $12,000 drawn / ACTIVE.
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

  // Idempotency gate — GENERAL fund existence
  const existing = (await client.$queryRawUnsafe(
    `SELECT 1 FROM ${TENANT_SCHEMA}.fin_funds WHERE school_id = $1::uuid AND fund_code = 'GENERAL' LIMIT 1`,
    schoolId,
  )) as Array<unknown>;
  if (existing.length > 0) {
    console.log('GENERAL fund already exists for demo school — skipping');
    await disconnectAll();
    return;
  }

  // Resolve a stand-in CFO actor — Sarah Mitchell (school admin) doubles
  // as the CFO for the demo seed. The Step 5 CFO role split is a Phase 2
  // backlog item alongside the other persona-split work.
  const employees = (await client.$queryRawUnsafe(
    `SELECT e.id::text AS employee_id, ip.first_name, ip.last_name, pu.id::text AS account_id
     FROM ${TENANT_SCHEMA}.hr_employees e
     JOIN platform.iam_person ip ON ip.id = e.person_id
     LEFT JOIN platform.platform_users pu ON pu.person_id = ip.id
     WHERE ip.first_name IN ('Sarah')`,
  )) as Array<{ employee_id: string; first_name: string; last_name: string; account_id: string }>;
  const mitchell = employees.find((e) => e.last_name === 'Mitchell')!;
  if (!mitchell) {
    console.error('Sarah Mitchell not found — cannot seed Cycle 26 actors');
    process.exit(1);
  }

  // ── Funds ──
  const generalFundId = generateId();
  const specialFundId = generateId();
  const capitalFundId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.fin_funds (id, school_id, fund_code, fund_name, fund_type) VALUES
     ($1::uuid, $2::uuid, 'GENERAL', 'General Operating Fund', 'GENERAL'),
     ($3::uuid, $2::uuid, 'TITLE_I', 'Title I Reading Improvement Fund', 'SPECIAL_REVENUE'),
     ($4::uuid, $2::uuid, 'CAPITAL', 'Building Fund', 'CAPITAL_PROJECTS')`,
    generalFundId,
    schoolId,
    specialFundId,
    capitalFundId,
  );

  // ── Chart of Accounts ──
  const acct = (
    code: string,
    name: string,
    type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE',
    normal: 'DEBIT' | 'CREDIT',
    fundId: string | null,
    isSystem = false,
  ) => ({ id: generateId(), code, name, type, normal, fundId, isSystem });

  const accounts = [
    acct('1000', 'Cash', 'ASSET', 'DEBIT', generalFundId, true),
    acct('1100', 'Accounts Receivable', 'ASSET', 'DEBIT', generalFundId, true),
    acct('1200', 'Prepaid Expenses', 'ASSET', 'DEBIT', generalFundId),
    acct('2000', 'Accounts Payable', 'LIABILITY', 'CREDIT', generalFundId, true),
    acct('2100', 'Accrued Liabilities', 'LIABILITY', 'CREDIT', generalFundId),
    acct('3000', 'Fund Balance', 'EQUITY', 'CREDIT', generalFundId),
    acct('4000', 'Tuition Revenue', 'REVENUE', 'CREDIT', generalFundId),
    acct('4100', 'Fee Revenue', 'REVENUE', 'CREDIT', generalFundId),
    acct('4200', 'Grant Revenue', 'REVENUE', 'CREDIT', specialFundId),
    acct('5000', 'Supplies Expense', 'EXPENSE', 'DEBIT', generalFundId),
    acct('5100', 'Salaries Expense', 'EXPENSE', 'DEBIT', generalFundId),
    acct('5200', 'Utilities Expense', 'EXPENSE', 'DEBIT', generalFundId),
    acct('5300', 'Maintenance Expense', 'EXPENSE', 'DEBIT', generalFundId),
    acct('5400', 'Technology Expense', 'EXPENSE', 'DEBIT', generalFundId),
    acct('5500', 'Food Service Expense', 'EXPENSE', 'DEBIT', generalFundId),
  ];

  for (const a of accounts) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.fin_chart_of_accounts (id, school_id, account_code, account_name, account_type, normal_balance, fund_id, is_system) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8)`,
      a.id,
      schoolId,
      a.code,
      a.name,
      a.type,
      a.normal,
      a.fundId,
      a.isSystem,
    );
  }
  const acctMap = new Map(accounts.map((a) => [a.code, a.id]));

  // ── Accounting Periods (Jul 2025 – Jun 2026) ──
  const periods = [
    {
      num: 1,
      name: 'July 2025',
      start: '2025-07-01',
      end: '2025-07-31',
      status: 'CLOSED',
      locked: true,
    },
    { num: 2, name: 'August 2025', start: '2025-08-01', end: '2025-08-31', status: 'CLOSED' },
    { num: 3, name: 'September 2025', start: '2025-09-01', end: '2025-09-30', status: 'CLOSED' },
    { num: 4, name: 'October 2025', start: '2025-10-01', end: '2025-10-31', status: 'OPEN' },
    { num: 5, name: 'November 2025', start: '2025-11-01', end: '2025-11-30', status: 'OPEN' },
    { num: 6, name: 'December 2025', start: '2025-12-01', end: '2025-12-31', status: 'OPEN' },
    { num: 7, name: 'January 2026', start: '2026-01-01', end: '2026-01-31', status: 'OPEN' },
    { num: 8, name: 'February 2026', start: '2026-02-01', end: '2026-02-28', status: 'OPEN' },
    { num: 9, name: 'March 2026', start: '2026-03-01', end: '2026-03-31', status: 'OPEN' },
    { num: 10, name: 'April 2026', start: '2026-04-01', end: '2026-04-30', status: 'OPEN' },
    { num: 11, name: 'May 2026', start: '2026-05-01', end: '2026-05-31', status: 'FUTURE' },
    { num: 12, name: 'June 2026', start: '2026-06-01', end: '2026-06-30', status: 'FUTURE' },
  ];
  const periodIds: Record<number, string> = {};
  for (const p of periods) {
    const id = generateId();
    periodIds[p.num] = id;
    const status = (p as { status: string }).status;
    const locked = (p as { locked?: boolean }).locked === true;
    if (locked) {
      await client.$executeRawUnsafe(
        `INSERT INTO ${TENANT_SCHEMA}.fin_accounting_periods (id, school_id, fiscal_year, period_number, period_name, start_date, end_date, status, closed_at, closed_by, locked_at, locked_by) VALUES ($1::uuid, $2::uuid, 'FY2025-2026', $3, $4, $5::date, $6::date, 'LOCKED', now() - interval '60 days', $7::uuid, now() - interval '30 days', $7::uuid)`,
        id,
        schoolId,
        p.num,
        p.name,
        p.start,
        p.end,
        mitchell.employee_id,
      );
    } else if (status === 'CLOSED') {
      await client.$executeRawUnsafe(
        `INSERT INTO ${TENANT_SCHEMA}.fin_accounting_periods (id, school_id, fiscal_year, period_number, period_name, start_date, end_date, status, closed_at, closed_by) VALUES ($1::uuid, $2::uuid, 'FY2025-2026', $3, $4, $5::date, $6::date, 'CLOSED', now() - interval '30 days', $7::uuid)`,
        id,
        schoolId,
        p.num,
        p.name,
        p.start,
        p.end,
        mitchell.employee_id,
      );
    } else {
      await client.$executeRawUnsafe(
        `INSERT INTO ${TENANT_SCHEMA}.fin_accounting_periods (id, school_id, fiscal_year, period_number, period_name, start_date, end_date, status) VALUES ($1::uuid, $2::uuid, 'FY2025-2026', $3, $4, $5::date, $6::date, $7)`,
        id,
        schoolId,
        p.num,
        p.name,
        p.start,
        p.end,
        status,
      );
    }
  }

  // ── 2 Journal Batches + 4 GL Entries (both POSTED) ──
  // Batch 1 — AUTO_PAYMENT $3,500 tuition. Period 4 = October.
  const batch1Id = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.fin_journal_batches (id, school_id, batch_number, description, batch_type, source_module, source_event_id, accounting_period_id, posted_by, posted_at, status) VALUES ($1::uuid, $2::uuid, 'JB-2025-001', $3, 'AUTO_PAYMENT', 'payments', $4::uuid, $5::uuid, $6::uuid, now() - interval '20 days', 'POSTED')`,
    batch1Id,
    schoolId,
    'Tuition payment — David Chen for Maya — $3,500',
    generateId(),
    periodIds[4],
    mitchell.employee_id,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.fin_gl_entries (id, batch_id, account_id, fund_id, debit, credit, description, line_order) VALUES
     ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 3500.00, 0.00, 'Cash received from family', 0),
     ($5::uuid, $2::uuid, $6::uuid, $4::uuid, 0.00, 3500.00, 'Tuition revenue earned', 1)`,
    generateId(),
    batch1Id,
    acctMap.get('1000'),
    generalFundId,
    generateId(),
    acctMap.get('4000'),
  );

  // Batch 2 — MANUAL $1,200 supplies. Period 3 = September CLOSED but historical so accept.
  const batch2Id = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.fin_journal_batches (id, school_id, batch_number, description, batch_type, accounting_period_id, posted_by, posted_at, status) VALUES ($1::uuid, $2::uuid, 'JB-2025-002', $3, 'MANUAL', $4::uuid, $5::uuid, now() - interval '40 days', 'POSTED')`,
    batch2Id,
    schoolId,
    'Office Supplies Inc — V-2025-0001 — $1,200',
    periodIds[3],
    mitchell.employee_id,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.fin_gl_entries (id, batch_id, account_id, fund_id, debit, credit, description, line_order) VALUES
     ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1200.00, 0.00, 'Office supplies purchased', 0),
     ($5::uuid, $2::uuid, $6::uuid, $4::uuid, 0.00, 1200.00, 'Cash paid to supplier', 1)`,
    generateId(),
    batch2Id,
    acctMap.get('5000'),
    generalFundId,
    generateId(),
    acctMap.get('1000'),
  );

  // ── Budget + Lines ──
  const budgetId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.fin_budgets (id, school_id, fiscal_year, fund_id, name, total_revenue, total_expense, status, approved_by, approved_at) VALUES ($1::uuid, $2::uuid, 'FY2025-2026', $3::uuid, 'GENERAL FY2025-2026', 500000.00, 480000.00, 'APPROVED', $4::uuid, now() - interval '90 days')`,
    budgetId,
    schoolId,
    generalFundId,
    mitchell.employee_id,
  );
  const budgetLines = [
    { code: '4000', budgeted: 400000, actual: 3500, encumbered: 0 },
    { code: '4100', budgeted: 50000, actual: 0, encumbered: 0 },
    { code: '4200', budgeted: 50000, actual: 0, encumbered: 0 },
    { code: '5000', budgeted: 50000, actual: 1200, encumbered: 0 },
    { code: '5100', budgeted: 300000, actual: 0, encumbered: 0 },
    { code: '5200', budgeted: 40000, actual: 0, encumbered: 0 },
    { code: '5300', budgeted: 25000, actual: 0, encumbered: 0 },
    { code: '5400', budgeted: 35000, actual: 0, encumbered: 0 },
    { code: '5500', budgeted: 30000, actual: 0, encumbered: 0 },
    { code: '1200', budgeted: 0, actual: 0, encumbered: 0 },
  ];
  for (const bl of budgetLines) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.fin_budget_lines (id, budget_id, account_id, budgeted_amount, actual_amount, encumbered_amount) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)`,
      generateId(),
      budgetId,
      acctMap.get(bl.code),
      bl.budgeted,
      bl.actual,
      bl.encumbered,
    );
  }

  // ── Supplier + Contact ──
  const supplierId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.fin_suppliers (id, school_id, supplier_code, supplier_name, supplier_type, payment_terms, address_line1, city, region, postal_code, country) VALUES ($1::uuid, $2::uuid, 'SUP-001', 'Office Supplies Inc', 'VENDOR', 'Net 30', '450 Industrial Way', 'Springfield', 'IL', '62701', 'USA')`,
    supplierId,
    schoolId,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.fin_supplier_contacts (id, supplier_id, contact_name, email, phone, role, is_primary) VALUES ($1::uuid, $2::uuid, 'Patricia Henson', 'pat@officesupplies.test', '+1-217-555-0199', 'Account Manager', true)`,
    generateId(),
    supplierId,
  );

  // ── AP Voucher + Payment ──
  const voucherId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.fin_ap_vouchers (id, school_id, supplier_id, voucher_number, invoice_number, invoice_date, due_date, total_amount, description, gl_account_id, fund_id, status, approved_by, approved_at) VALUES ($1::uuid, $2::uuid, $3::uuid, 'V-2025-0001', 'OSI-INV-3942', '2025-09-01'::date, '2025-10-01'::date, 1200.00, 'Q1 office supplies — paper, pens, toner', $4::uuid, $5::uuid, 'PAID', $6::uuid, now() - interval '40 days')`,
    voucherId,
    schoolId,
    supplierId,
    acctMap.get('5000'),
    generalFundId,
    mitchell.employee_id,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.fin_ap_payments (id, voucher_id, payment_method, payment_reference, amount, paid_at, paid_by, journal_batch_id, notes) VALUES ($1::uuid, $2::uuid, 'CHECK', 'CHK-1042', 1200.00, now() - interval '40 days', $3::uuid, $4::uuid, 'Paid by check #1042')`,
    generateId(),
    voucherId,
    mitchell.employee_id,
    batch2Id,
  );

  // ── Reconciliation Run (October Cash, VARIANCE_FLAGGED) ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.fin_reconciliation_runs (id, school_id, account_id, period_id, gl_balance, bank_balance, difference, outstanding_items, status) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 125000.00, 124850.00, 150.00, $5::jsonb, 'VARIANCE_FLAGGED')`,
    generateId(),
    schoolId,
    acctMap.get('1000'),
    periodIds[4],
    JSON.stringify([
      {
        type: 'OUTSTANDING_CHECK',
        reference: 'CHK-1051',
        amount: 150.0,
        note: 'Issued to Vendor X — not yet cleared',
      },
    ]),
  );

  // ── Board Report Snapshot (September BUDGET_VS_ACTUAL) ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.fin_board_report_snapshots (id, school_id, report_type, period_id, generated_at, generated_by, report_data) VALUES ($1::uuid, $2::uuid, 'BUDGET_VS_ACTUAL', $3::uuid, now() - interval '20 days', $4::uuid, $5::jsonb)`,
    generateId(),
    schoolId,
    periodIds[3],
    mitchell.employee_id,
    JSON.stringify({
      fiscalYear: 'FY2025-2026',
      periodName: 'September 2025',
      lines: [
        { account: '4000 Tuition', budgeted: 400000, actual: 3500, variance: -396500 },
        { account: '5000 Supplies', budgeted: 50000, actual: 1200, variance: 48800 },
      ],
      generatedBy: 'Sarah Mitchell',
    }),
  );

  // ── Grant ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.fin_grants (id, school_id, fund_id, grant_name, grantor, grant_number, award_amount, drawn_amount, start_date, end_date, status) VALUES ($1::uuid, $2::uuid, $3::uuid, 'Title I Reading Improvement', 'U.S. Department of Education', 'TITLE-I-2025-IL-LCN', 50000.00, 12000.00, '2025-07-01'::date, '2026-06-30'::date, 'ACTIVE')`,
    generateId(),
    schoolId,
    specialFundId,
  );

  console.log('seeded 3 funds, 15 accounts, 12 periods (1 LOCKED + 2 CLOSED + 7 OPEN + 2 FUTURE)');
  console.log('seeded 2 POSTED journal batches with 4 balanced GL entries');
  console.log('seeded 1 budget + 10 lines, 1 supplier + 1 contact, 1 AP voucher + 1 payment');
  console.log('seeded 1 VARIANCE_FLAGGED reconciliation, 1 board report snapshot, 1 ACTIVE grant');

  await disconnectAll();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
