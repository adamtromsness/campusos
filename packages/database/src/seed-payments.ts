import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

var TENANT_SCHEMA = 'tenant_demo';

async function seedPayments() {
  console.log('');
  console.log('  Payments Seed (Cycle 6 Step 5 — Billing Engine)');
  console.log('');

  var client = getPlatformClient();

  // ── 1. Lookups ────────────────────────────────────────────
  var school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  var schoolId = school.id;

  var davidPerson = await client.iamPerson.findFirst({
    where: { firstName: 'David', lastName: 'Chen' },
    select: { id: true },
  });
  if (!davidPerson) throw new Error('David Chen iam_person not found — run pnpm seed first');

  var davidUser = await client.platformUser.findFirst({
    where: { personId: davidPerson.id },
    select: { id: true },
  });
  if (!davidUser) throw new Error('David Chen platform_user not found');

  var principal = await client.platformUser.findFirst({
    where: { email: 'principal@demo.campusos.dev' },
    select: { id: true },
  });
  if (!principal) throw new Error('principal@demo.campusos.dev not found');

  // ── 2. Idempotency gate — fee categories ──
  var existing = (await client.$queryRawUnsafe(
    'SELECT count(*)::bigint AS c FROM ' + TENANT_SCHEMA + '.pay_fee_categories',
  )) as Array<{ c: bigint }>;
  if (existing[0] && Number(existing[0].c) > 0) {
    console.log('  pay_fee_categories already populated — skipping');
    return;
  }

  // ── 3. Resolve sis_students.id for Maya — needed for the family-account
  //      link table. seed-sis seeded Maya as student_number='S-1001'.
  var mayaRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      ".sis_students WHERE student_number = 'S-1001' LIMIT 1",
  )) as Array<{ id: string }>;
  if (mayaRows.length === 0) throw new Error('Maya sis_students row not found — run seed:sis');
  var mayaSisId = mayaRows[0]!.id;

  // ── 4. Resolve current academic year (2025-2026) ──
  var ayRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, name FROM ' +
      TENANT_SCHEMA +
      '.sis_academic_years WHERE school_id = $1::uuid ORDER BY start_date ASC',
    schoolId,
  )) as Array<{ id: string; name: string }>;
  if (ayRows.length === 0) throw new Error('No sis_academic_years — run seed:sis first');
  var academicYear2025: { id: string; name: string } | undefined;
  for (var ayi = 0; ayi < ayRows.length; ayi++) {
    if (ayRows[ayi]!.name === '2025-2026') academicYear2025 = ayRows[ayi]!;
  }
  if (!academicYear2025)
    throw new Error('Academic year 2025-2026 not found — run seed:sis first');

  // ── 5. Fee categories ──
  console.log('  fee categories:');
  var categoryIdByName: Record<string, string> = {};
  var categories = ['Tuition', 'Registration Fee', 'Technology Fee', 'Activity Fee'];
  for (var ci = 0; ci < categories.length; ci++) {
    var cname = categories[ci]!;
    var cid = generateId();
    categoryIdByName[cname] = cid;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.pay_fee_categories (id, school_id, name, description, is_active) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, true)',
      cid,
      schoolId,
      cname,
      cname + ' for ' + academicYear2025.name,
    );
  }
  console.log('    ' + categories.length + ' categories (Tuition / Reg / Tech / Activity)');

  // ── 6. Fee schedules ──
  console.log('  fee schedules:');
  interface ScheduleSpec {
    name: string;
    categoryName: string;
    gradeLevel: string | null;
    amount: string;
    recurrence: 'ONE_TIME' | 'MONTHLY' | 'QUARTERLY' | 'SEMESTER' | 'ANNUAL';
    isRecurring: boolean;
  }
  var SCHEDULES: ScheduleSpec[] = [
    {
      name: 'Grade 9 Annual Tuition',
      categoryName: 'Tuition',
      gradeLevel: '9',
      amount: '12000.00',
      recurrence: 'ANNUAL',
      isRecurring: true,
    },
    {
      name: 'Grade 10 Annual Tuition',
      categoryName: 'Tuition',
      gradeLevel: '10',
      amount: '12500.00',
      recurrence: 'ANNUAL',
      isRecurring: true,
    },
    {
      name: 'Registration Fee',
      categoryName: 'Registration Fee',
      gradeLevel: null,
      amount: '500.00',
      recurrence: 'ONE_TIME',
      isRecurring: false,
    },
    {
      name: 'Technology Fee 2026',
      categoryName: 'Technology Fee',
      gradeLevel: null,
      amount: '400.00',
      recurrence: 'ANNUAL',
      isRecurring: true,
    },
  ];
  var scheduleIdByName: Record<string, string> = {};
  for (var si = 0; si < SCHEDULES.length; si++) {
    var sched = SCHEDULES[si]!;
    var sid = generateId();
    scheduleIdByName[sched.name] = sid;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.pay_fee_schedules (id, school_id, academic_year_id, fee_category_id, name, description, grade_level, amount, is_recurring, recurrence, is_active) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::numeric, $9, $10, true)',
      sid,
      schoolId,
      academicYear2025.id,
      categoryIdByName[sched.categoryName]!,
      sched.name,
      sched.name + ' for ' + academicYear2025.name,
      sched.gradeLevel,
      sched.amount,
      sched.isRecurring,
      sched.recurrence,
    );
    console.log(
      '    ' +
        sched.name +
        ' — $' +
        sched.amount +
        ' (' +
        sched.recurrence +
        (sched.gradeLevel ? ', Grade ' + sched.gradeLevel : ', all grades') +
        ')',
    );
  }

  // ── 7. Stripe account stub ──
  console.log('  stripe account:');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.pay_stripe_accounts (id, school_id, stripe_account_id, onboarding_complete) ' +
      'VALUES ($1::uuid, $2::uuid, $3, true)',
    generateId(),
    schoolId,
    'acct_demo_lincoln',
  );
  console.log('    acct_demo_lincoln (onboarding_complete=true)');

  // ── 8. Family account — David Chen ──
  console.log('  family account:');
  var chenAccountId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.pay_family_accounts (id, school_id, account_holder_id, account_number, status, payment_authorisation_policy) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ACTIVE', 'ACCOUNT_HOLDER_ONLY')",
    chenAccountId,
    schoolId,
    davidPerson.id,
    'FA-1001',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.pay_family_account_students (id, family_account_id, student_id, added_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)',
    generateId(),
    chenAccountId,
    mayaSisId,
    principal.id,
  );
  console.log('    Chen Family (FA-1001, ACTIVE) — linked to Maya Chen');

  // ── 9. Invoice 1: Fall 2026 Tuition — PAID ──
  console.log('  invoices:');
  var tuitionInvoiceId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.pay_invoices (id, school_id, family_account_id, title, description, total_amount, due_date, status, sent_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::numeric, $7::date, 'PAID', $8::timestamptz)",
    tuitionInvoiceId,
    schoolId,
    chenAccountId,
    'Fall 2026 Tuition',
    'Annual tuition for Maya Chen — Grade 9 (2025-2026 academic year).',
    '12000.00',
    '2025-09-01',
    '2025-08-15T09:00:00Z',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.pay_invoice_line_items (id, invoice_id, fee_schedule_id, description, quantity, unit_price, total, sort_order) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::numeric, $6::numeric, $7::numeric, 1)',
    generateId(),
    tuitionInvoiceId,
    scheduleIdByName['Grade 9 Annual Tuition']!,
    'Grade 9 Annual Tuition — Maya Chen',
    '1.00',
    '12000.00',
    '12000.00',
  );

  // Invoice 2: Tech Fee — SENT, due in 30 days from today (2026-04-28)
  var techInvoiceId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.pay_invoices (id, school_id, family_account_id, title, description, total_amount, due_date, status, sent_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::numeric, $7::date, 'SENT', $8::timestamptz)",
    techInvoiceId,
    schoolId,
    chenAccountId,
    'Technology Fee 2026',
    'Annual technology fee for Maya Chen.',
    '400.00',
    '2026-05-28',
    '2026-04-28T09:00:00Z',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.pay_invoice_line_items (id, invoice_id, fee_schedule_id, description, quantity, unit_price, total, sort_order) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::numeric, $6::numeric, $7::numeric, 1)',
    generateId(),
    techInvoiceId,
    scheduleIdByName['Technology Fee 2026']!,
    'Technology Fee 2026 — Maya Chen',
    '1.00',
    '400.00',
    '400.00',
  );
  console.log('    Fall 2026 Tuition — $12,000 PAID');
  console.log('    Technology Fee 2026 — $400 SENT (due 2026-05-28)');

  // ── 10. Payment — Tuition cleared via CARD ──
  console.log('  payments:');
  var tuitionPaymentId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.pay_payments (id, school_id, invoice_id, family_account_id, amount, payment_method, stripe_payment_intent_id, status, paid_at, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, 'CARD', $6, 'COMPLETED', $7::timestamptz, $8::uuid)",
    tuitionPaymentId,
    schoolId,
    tuitionInvoiceId,
    chenAccountId,
    '12000.00',
    'pi_demo_tuition_2025',
    '2025-08-20T14:22:00Z',
    davidUser.id,
  );
  console.log('    $12,000 CARD COMPLETED (pi_demo_tuition_2025)');

  // ── 11. Ledger entries — CHARGE 12000, PAYMENT -12000, CHARGE 400 ──
  // Balance for the Chen family = SUM(amount) = 0 + 400 = 400 outstanding.
  console.log('  ledger entries:');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.pay_ledger_entries (id, family_account_id, entry_type, amount, reference_id, description, created_at) ' +
      "VALUES ($1::uuid, $2::uuid, 'CHARGE', $3::numeric, $4::uuid, $5, $6::timestamptz)",
    generateId(),
    chenAccountId,
    '12000.00',
    tuitionInvoiceId,
    'CHARGE: Fall 2026 Tuition',
    '2025-08-15T09:00:00Z',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.pay_ledger_entries (id, family_account_id, entry_type, amount, reference_id, description, created_at) ' +
      "VALUES ($1::uuid, $2::uuid, 'PAYMENT', $3::numeric, $4::uuid, $5, $6::timestamptz)",
    generateId(),
    chenAccountId,
    '-12000.00',
    tuitionPaymentId,
    'PAYMENT: Tuition payment via CARD',
    '2025-08-20T14:22:00Z',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.pay_ledger_entries (id, family_account_id, entry_type, amount, reference_id, description, created_at) ' +
      "VALUES ($1::uuid, $2::uuid, 'CHARGE', $3::numeric, $4::uuid, $5, $6::timestamptz)",
    generateId(),
    chenAccountId,
    '400.00',
    techInvoiceId,
    'CHARGE: Technology Fee 2026',
    '2026-04-28T09:00:00Z',
  );
  console.log('    3 entries — CHARGE +12,000 / PAYMENT -12,000 / CHARGE +400');

  // ── 12. Verify balance ──
  var balanceRows = (await client.$queryRawUnsafe(
    'SELECT COALESCE(SUM(amount), 0)::text AS bal FROM ' +
      TENANT_SCHEMA +
      '.pay_ledger_entries WHERE family_account_id = $1::uuid',
    chenAccountId,
  )) as Array<{ bal: string }>;
  var balance = balanceRows[0]!.bal;
  console.log('    Chen family balance: $' + balance + ' (expected $400.00)');

  // ── 13. Summary ──
  console.log('');
  console.log('  Payments seed complete:');
  await summary(client);
}

async function summary(client: any): Promise<void> {
  var rows = [
    ['pay_fee_categories', 'pay_fee_categories'],
    ['pay_fee_schedules', 'pay_fee_schedules'],
    ['pay_stripe_accounts', 'pay_stripe_accounts'],
    ['pay_family_accounts', 'pay_family_accounts'],
    ['pay_family_account_students', 'pay_family_account_students'],
    ['pay_invoices', 'pay_invoices'],
    ['pay_invoice_line_items', 'pay_invoice_line_items'],
    ['pay_payments', 'pay_payments'],
    ['pay_ledger_entries', 'pay_ledger_entries'],
  ];
  for (var i = 0; i < rows.length; i++) {
    var label = rows[i]![0]!;
    var table = rows[i]![1]!;
    var counts = (await client.$queryRawUnsafe(
      'SELECT count(*)::bigint AS c FROM ' + TENANT_SCHEMA + '.' + table,
    )) as Array<{ c: bigint }>;
    var n = counts[0] ? Number(counts[0].c) : 0;
    console.log('    ' + label + ': ' + n);
  }
}

seedPayments()
  .catch(function (err) {
    console.error(err);
    process.exit(1);
  })
  .finally(function () {
    return disconnectAll();
  });
