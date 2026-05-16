import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-commerce.ts — P2-29a Step 2.
 *
 * Commerce Bundle — Procurement Advanced + Finance Extensions.
 * Idempotent — gated on whether the demo school already has a
 * prc_vendor_catalogues row.
 *
 * Seeds (only on tenant_demo; tenant_test stays empty by convention):
 *   - 1 vendor catalogue ("Office Supplies Inc — Q2 2026") on the
 *     first available fin_suppliers row + 3 catalogue items.
 *   - 2 contracts (1 ACTIVE in-window, 1 ACTIVE inside the renewal
 *     reminder window so the ContractExpiryWorker will flip it to
 *     EXPIRING on the next sweep) + 1 amendment on the ACTIVE one.
 *   - 4 fin_departmental_budgets for 2025-2026 across IT/SUPPLIES,
 *     IT/EQUIPMENT, CURRICULUM/SUPPLIES, ATHLETICS/TRAVEL with
 *     varying allocated/committed/spent values exercising the
 *     variance dashboard.
 *   - 1 PENDING fin_budget_transfer (IT/EQUIPMENT → CURRICULUM/SUPPLIES,
 *     $500) so the demo can drive the atomic-approve KEYSTONE end-to-
 *     end live.
 *   - 1 DRAFT fin_journal_entry_batch with 2 balanced lines (DR Cash
 *     1000 / CR Tuition 4000, $250) so the demo can drive
 *     JournalBatchService.post BALANCE-VALIDATION KEYSTONE.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedCommerce(): Promise<void> {
  console.log('');
  console.log('  Commerce Bundle Seed (P2-29a Step 2)');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) {
    console.log('  demo school not found — run pnpm seed first');
    return;
  }
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.prc_vendor_catalogues WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  prc_vendor_catalogues already populated for demo school — skipping');
    return;
  }

  async function findEmployeeId(email: string): Promise<string | null> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT e.id::text FROM ' +
        TENANT_SCHEMA +
        '.hr_employees e ' +
        'JOIN platform.platform_users u ON u.person_id = e.person_id ' +
        'WHERE u.email = $1 LIMIT 1',
      email,
    )) as Array<{ id: string }>;
    return rows[0]?.id ?? null;
  }

  const principalEmpId = await findEmployeeId('principal@demo.campusos.dev');
  if (!principalEmpId) {
    console.log('  principal hr_employees row not found — run pnpm seed:hr first');
    return;
  }

  // ── 1. Vendor catalogue ───────────────────────────────────────
  const suppliers = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, supplier_name FROM ' +
      TENANT_SCHEMA +
      '.fin_suppliers WHERE school_id = $1::uuid AND is_active = true ORDER BY supplier_code LIMIT 1',
    schoolId,
  )) as Array<{ id: string; supplier_name: string }>;
  if (suppliers.length === 0) {
    console.log('  fin_suppliers empty — run pnpm seed:finance first');
    return;
  }
  const supplier = suppliers[0]!;
  const catalogueId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.prc_vendor_catalogues (id, vendor_id, school_id, catalogue_name, effective_from, effective_to, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '2026-04-01'::date, '2026-12-31'::date, $5)",
    catalogueId,
    supplier.id,
    schoolId,
    supplier.supplier_name + ' — Q2 2026',
    'Pre-negotiated pricing for Q2 2026 office supplies.',
  );

  const items: Array<{
    code: string;
    description: string;
    unit: string;
    price: number;
    category: string;
    minQty: number;
    leadDays: number;
  }> = [
    {
      code: 'PAPER-A4-CASE',
      description: 'A4 paper, case of 5000 sheets',
      unit: 'CASE',
      price: 38.5,
      category: 'PAPER',
      minQty: 1,
      leadDays: 3,
    },
    {
      code: 'PEN-BIC-BLUE',
      description: 'Bic Cristal blue, box of 50',
      unit: 'BOX',
      price: 12.75,
      category: 'WRITING',
      minQty: 2,
      leadDays: 5,
    },
    {
      code: 'BINDER-2IN',
      description: '2-inch 3-ring binder, white',
      unit: 'EA',
      price: 4.25,
      category: 'BINDING',
      minQty: 10,
      leadDays: 7,
    },
  ];
  for (const i of items) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.prc_catalogue_items (id, catalogue_id, item_code, description, unit, negotiated_price, category, min_order_qty, lead_time_days) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::numeric, $7, $8, $9)',
      generateId(),
      catalogueId,
      i.code,
      i.description,
      i.unit,
      i.price,
      i.category,
      i.minQty,
      i.leadDays,
    );
  }

  // ── 2. Contracts ──────────────────────────────────────────────
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const inWindow = new Date(today);
  inWindow.setUTCDate(inWindow.getUTCDate() + 180);
  const inWindowIso = inWindow.toISOString().slice(0, 10);
  const nearExpiry = new Date(today);
  nearExpiry.setUTCDate(nearExpiry.getUTCDate() + 45); // inside default 90-day reminder
  const nearExpiryIso = nearExpiry.toISOString().slice(0, 10);

  const contractActiveId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.prc_contracts (id, school_id, vendor_id, contract_number, title, description, start_date, end_date, total_value, status, renewal_reminder_days, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::date, $8::date, $9::numeric, 'ACTIVE', 90, $10::uuid)",
    contractActiveId,
    schoolId,
    supplier.id,
    'C-2026-001',
    'Annual office supplies framework agreement',
    'Master services agreement covering paper, writing, binding for FY 2026.',
    todayIso,
    inWindowIso,
    25000,
    principalEmpId,
  );

  const contractExpiringId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.prc_contracts (id, school_id, vendor_id, contract_number, title, description, start_date, end_date, total_value, status, renewal_reminder_days, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::date, $8::date, $9::numeric, 'ACTIVE', 90, $10::uuid)",
    contractExpiringId,
    schoolId,
    supplier.id,
    'C-2025-014',
    'Cleaning services contract',
    'Daily cleaning + monthly deep-clean. Will be flipped to EXPIRING on the next ContractExpiryWorker sweep.',
    '2025-07-01',
    nearExpiryIso,
    18000,
    principalEmpId,
  );

  // ── 3. Amendment on the active contract ──────────────────────
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.prc_contract_amendments (id, contract_id, amendment_number, description, value_change, new_end_date, approved_by, effective_date) ' +
      'VALUES ($1::uuid, $2::uuid, 1, $3, $4::numeric, NULL, $5::uuid, $6::date)',
    generateId(),
    contractActiveId,
    'Add second supplier contact + raise total by $5,000 to cover expanded paper demand.',
    5000,
    principalEmpId,
    todayIso,
  );
  // Apply the value_change to the parent contract — mirrors what
  // ContractService.amend does atomically inside one tx.
  await client.$executeRawUnsafe(
    'UPDATE ' +
      TENANT_SCHEMA +
      '.prc_contracts SET total_value = total_value + 5000, updated_at = now() WHERE id = $1::uuid',
    contractActiveId,
  );

  // ── 4. Departmental budgets ──────────────────────────────────
  const years = (await client.$queryRawUnsafe(
    'SELECT id::text FROM ' +
      TENANT_SCHEMA +
      '.sis_academic_years WHERE school_id = $1::uuid ORDER BY start_date DESC LIMIT 1',
    schoolId,
  )) as Array<{ id: string }>;
  if (years.length === 0) {
    console.log('  sis_academic_years not seeded — skipping departmental budgets');
    await disconnectAll();
    return;
  }
  const yearId = years[0]!.id;

  const budgets: Array<{
    dept: string;
    category: string;
    allocated: number;
    committed: number;
    spent: number;
  }> = [
    { dept: 'IT', category: 'SUPPLIES', allocated: 8000, committed: 1200, spent: 3500 },
    { dept: 'IT', category: 'EQUIPMENT', allocated: 15000, committed: 4500, spent: 8000 },
    { dept: 'CURRICULUM', category: 'SUPPLIES', allocated: 10000, committed: 0, spent: 6200 },
    { dept: 'ATHLETICS', category: 'TRAVEL', allocated: 5000, committed: 800, spent: 3900 },
  ];
  const budgetIds: Record<string, string> = {};
  for (const b of budgets) {
    const id = generateId();
    budgetIds[b.dept + '/' + b.category] = id;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fin_departmental_budgets (id, school_id, academic_year_id, department, budget_category, allocated_amount, committed_amount, spent_amount, approved_by, approved_at) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9::uuid, now())',
      id,
      schoolId,
      yearId,
      b.dept,
      b.category,
      b.allocated,
      b.committed,
      b.spent,
      principalEmpId,
    );
  }

  // ── 5. PENDING budget transfer for the live keystone demo ────
  const transferId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fin_budget_transfers (id, school_id, from_budget_id, to_budget_id, amount, reason, requested_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 500::numeric, $5, $6::uuid)',
    transferId,
    schoolId,
    budgetIds['IT/EQUIPMENT']!,
    budgetIds['CURRICULUM/SUPPLIES']!,
    'Reallocate $500 from IT Equipment to Curriculum Supplies for end-of-year reading workbooks.',
    principalEmpId,
  );

  // ── 6. DRAFT journal entry batch (balanced) ──────────────────
  const accounts = (await client.$queryRawUnsafe(
    'SELECT id::text, account_code FROM ' +
      TENANT_SCHEMA +
      '.fin_chart_of_accounts WHERE school_id = $1::uuid AND account_code IN ($2, $3) AND is_active = true',
    schoolId,
    '1000',
    '4000',
  )) as Array<{ id: string; account_code: string }>;
  if (accounts.length === 2) {
    const cash = accounts.find((a) => a.account_code === '1000')!;
    const tuition = accounts.find((a) => a.account_code === '4000')!;
    const batchId = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fin_journal_entry_batches (id, school_id, batch_name, description, created_by) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid)',
      batchId,
      schoolId,
      'May 2026 cash reclass',
      'Reclass $250 from Cash to Tuition (correcting prior misposting).',
      principalEmpId,
    );
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fin_journal_entry_lines (id, batch_id, account_id, debit, credit, description, line_order) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, 250::numeric, 0::numeric, $4, 1)',
      generateId(),
      batchId,
      cash.id,
      'DR Cash 1000',
    );
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fin_journal_entry_lines (id, batch_id, account_id, debit, credit, description, line_order) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, 0::numeric, 250::numeric, $4, 2)',
      generateId(),
      batchId,
      tuition.id,
      'CR Tuition 4000',
    );
    // Manually materialise the parent totals (mirrors what the
    // service does on every addLine).
    await client.$executeRawUnsafe(
      'UPDATE ' +
        TENANT_SCHEMA +
        '.fin_journal_entry_batches SET entry_count = 2, total_debits = 250, total_credits = 250, is_balanced = true, updated_at = now() WHERE id = $1::uuid',
      batchId,
    );
  } else {
    console.log('  fin_chart_of_accounts missing 1000/4000 — skipping journal batch seed');
  }

  console.log('  ✓ vendor catalogue + 3 items');
  console.log('  ✓ 2 contracts (1 in-window, 1 inside renewal reminder window)');
  console.log('  ✓ 1 contract amendment ($5,000 increase)');
  console.log('  ✓ 4 departmental budgets across 4 (dept, category) tuples');
  console.log('  ✓ 1 PENDING budget transfer (IT Equipment → Curriculum Supplies, $500)');
  console.log('  ✓ 1 DRAFT balanced journal batch ($250 DR Cash / $250 CR Tuition)');
  console.log('');
  console.log('  Commerce Bundle seeded for ' + TENANT_SCHEMA);
  console.log('');
}

async function main(): Promise<void> {
  try {
    await seedCommerce();
  } finally {
    await disconnectAll();
  }
}

void main();
