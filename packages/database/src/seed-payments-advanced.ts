import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-payments-advanced.ts — Phase 2 Cycle 6 (P2-6).
 *
 * Idempotent — gated on whether pay_financial_aid_programs already
 * has rows for the demo school.
 *
 * Sections:
 *   A) 1 financial aid programme (Need-Based Aid, PERCENTAGE 15%,
 *      $50k fund, $35k remaining after the 2 seeded awards).
 *   B) 2 awards (Maya $1,500 + Ethan $750, both APPROVED ACTIVE).
 *   C) 1 application (David Chen for a third hypothetical child,
 *      SUBMITTED + UNDER_REVIEW).
 *   D) 1 auto-invoice rule (TERM_START, fires 14 days before each
 *      term, applies to existing Tuition fee schedule).
 *   E) 1 invoice generation run (COMPLETED, 50 invoices created).
 *   F) 2 discount rules (SIBLING 2nd child 10%, EARLY_PAYMENT 5%).
 *   G) 3 lunch accounts (Maya $36.50, Ethan $22.00, Aiden $5.00 —
 *      Aiden is below the $10 threshold).
 *   H) 10 lunch transactions across the 3 accounts (mix of MEAL
 *      _CHARGE + DEPOSIT).
 *   I) 1 lunch balance transfer (year-end SIBLING_TRANSFER from
 *      a graduating student to a continuing sibling — IMMUTABLE
 *      audit row).
 *   J) 1 credit note ($25 GOODWILL on the existing seeded SENT
 *      invoice — IMMUTABLE) with offsetting CREDIT ledger entry.
 *   K) 1 payment reversal (BOUNCED_CHEQUE on the existing seeded
 *      historical CARD payment — IMMUTABLE) with offsetting CHARGE
 *      ledger entry. NOTE — the seeded payment is COMPLETED CARD
 *      so the reversal is contrived for demo coverage. The Cycle 6
 *      payment row stays COMPLETED (the seed does NOT flip status
 *      to FAILED) so the broader downstream demo data is not
 *      disturbed. Runtime ReversalService.reverse() is the path
 *      that flips the status.
 *   L) 2 payment allocations (the existing seeded $12K payment
 *      allocated to the 2 seeded invoices in proportion).
 *   M) 1 late payment policy (FIXED $25, 7-day grace, ACTIVE).
 *   N) 1 saved payment method (Visa ending 4242 on the Chen
 *      family account, default).
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedPaymentsAdvanced(): Promise<void> {
  console.log('');
  console.log('  Payments Advanced Seed (P2-6)');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.pay_financial_aid_programs WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  pay_financial_aid_programs already populated for demo school. Skipping.');
    return;
  }

  await client.$executeRawUnsafe('SET search_path TO ' + TENANT_SCHEMA + ', platform, public');

  const principal = await client.platformUser.findFirst({
    where: { email: 'principal@demo.campusos.dev' },
  });
  if (!principal) throw new Error('principal user not found');
  const principalPersonId = principal.personId;

  const parentUser = await client.platformUser.findFirst({
    where: { email: 'parent@demo.campusos.dev' },
  });
  if (!parentUser) throw new Error('parent user not found');
  const parentPersonId = parentUser.personId;

  // Look up tenant rows we'll reference. tenant_demo seed sets up the
  // Chen family with Maya + Ethan as students; sis_guardians has David
  // as the guardian.
  type SisRow = { id: string };

  const academicYearRows = (await client.$queryRawUnsafe(
    'SELECT id FROM ' + TENANT_SCHEMA + '.sis_academic_years WHERE is_current = true LIMIT 1',
  )) as SisRow[];
  if (academicYearRows.length === 0) {
    console.log(
      '  No current academic year found in tenant_demo. Skipping payments-advanced seed.',
    );
    return;
  }
  const academicYearId = academicYearRows[0]!.id;

  const studentRows = (await client.$queryRawUnsafe(
    'SELECT s.id, ip.first_name FROM ' +
      TENANT_SCHEMA +
      '.sis_students s ' +
      'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
      'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
      "WHERE ip.first_name IN ('Maya','Ethan','Aiden') ORDER BY ip.first_name",
  )) as Array<{ id: string; first_name: string }>;
  const byName: Record<string, string> = {};
  for (const r of studentRows) {
    byName[r.first_name] = r.id;
  }
  const mayaId = byName['Maya'];
  const ethanId = byName['Ethan'];
  const aidenId = byName['Aiden'];
  if (!mayaId || !ethanId) {
    console.log('  Maya or Ethan student row not found — run seed-sis first.');
    return;
  }

  const guardianRows = (await client.$queryRawUnsafe(
    'SELECT id FROM ' + TENANT_SCHEMA + '.sis_guardians WHERE person_id = $1::uuid LIMIT 1',
    parentPersonId,
  )) as SisRow[];
  if (guardianRows.length === 0) {
    console.log('  David Chen guardian row not found — run seed-sis first.');
    return;
  }
  const davidGuardianId = guardianRows[0]!.id;

  const familyAccountRows = (await client.$queryRawUnsafe(
    'SELECT id FROM ' +
      TENANT_SCHEMA +
      '.pay_family_accounts WHERE account_holder_id = $1::uuid LIMIT 1',
    parentPersonId,
  )) as SisRow[];
  if (familyAccountRows.length === 0) {
    console.log('  Chen family account not found — run seed-payments first.');
    return;
  }
  const chenFamilyAccountId = familyAccountRows[0]!.id;

  const seededInvoiceRows = (await client.$queryRawUnsafe(
    'SELECT id, total_amount::text AS total, status FROM ' +
      TENANT_SCHEMA +
      '.pay_invoices WHERE family_account_id = $1::uuid ORDER BY created_at',
    chenFamilyAccountId,
  )) as Array<{ id: string; total: string; status: string }>;
  const techFeeInvoice = seededInvoiceRows.find((r) => r.status === 'SENT');
  const tuitionInvoice = seededInvoiceRows.find((r) => r.status === 'PAID');

  const seededPaymentRows = (await client.$queryRawUnsafe(
    'SELECT id FROM ' +
      TENANT_SCHEMA +
      '.pay_payments WHERE family_account_id = $1::uuid ORDER BY paid_at LIMIT 1',
    chenFamilyAccountId,
  )) as SisRow[];
  const seededPaymentId = seededPaymentRows[0]?.id;

  const tuitionFeeScheduleRows = (await client.$queryRawUnsafe(
    'SELECT id FROM ' +
      TENANT_SCHEMA +
      ".pay_fee_schedules WHERE name ILIKE '%Tuition%' ORDER BY name LIMIT 1",
  )) as SisRow[];
  const tuitionFeeScheduleId = tuitionFeeScheduleRows[0]?.id;

  const tuitionCategoryRows = (await client.$queryRawUnsafe(
    'SELECT id FROM ' + TENANT_SCHEMA + ".pay_fee_categories WHERE name = 'Tuition' LIMIT 1",
  )) as SisRow[];
  const tuitionCategoryId = tuitionCategoryRows[0]?.id;

  /* A) Financial aid programme */
  const programId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.pay_financial_aid_programs ' +
      '(id, school_id, name, description, reduction_type, reduction_value, total_fund_amount, fund_remaining, academic_year_id, is_active, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'Need-Based Aid', 'PERCENTAGE-based reduction for households below the income threshold.', 'PERCENTAGE', 15, 50000, 50000, $3::uuid, true, $4::uuid)",
    programId,
    schoolId,
    academicYearId,
    principalPersonId,
  );

  /* B) 2 awards */
  const mayaAwardId = generateId();
  const ethanAwardId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.pay_financial_aid_awards ' +
      '(id, school_id, student_id, program_id, academic_year_id, award_amount, approved_by, effective_from, status, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1500, $6::uuid, '2025-08-15', 'ACTIVE', 'Approved on review of household income BAND_C documentation.')",
    mayaAwardId,
    schoolId,
    mayaId,
    programId,
    academicYearId,
    principalPersonId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.pay_financial_aid_awards ' +
      '(id, school_id, student_id, program_id, academic_year_id, award_amount, approved_by, effective_from, status, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 750, $6::uuid, '2025-08-15', 'ACTIVE', 'Approved on review of household income BAND_D documentation.')",
    ethanAwardId,
    schoolId,
    ethanId,
    programId,
    academicYearId,
    principalPersonId,
  );

  /* Decrement programme fund_remaining by the sum of approved awards. */
  await client.$executeRawUnsafe(
    'UPDATE ' +
      TENANT_SCHEMA +
      '.pay_financial_aid_programs SET fund_remaining = total_fund_amount - 2250, updated_at = now() WHERE id = $1::uuid',
    programId,
  );

  /* C) 1 SUBMITTED application waiting on review. */
  const applicationId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.pay_financial_aid_applications ' +
      '(id, school_id, student_id, program_id, guardian_id, academic_year_id, household_income_band, supporting_documents, application_statement, status, submitted_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 'BAND_C', $7::jsonb, 'We have experienced a temporary reduction in household income and request consideration for the Need-Based Aid programme.', 'SUBMITTED', now())",
    applicationId,
    schoolId,
    mayaId,
    programId,
    davidGuardianId,
    academicYearId,
    JSON.stringify([
      { s3Key: 'demo/financial-aid/2024-tax-return.pdf', label: '2024 Tax Return' },
      { s3Key: 'demo/financial-aid/income-letter.pdf', label: 'Income Verification Letter' },
    ]),
  );

  /* D) 1 auto-invoice rule */
  let autoRuleId: string | null = null;
  if (tuitionFeeScheduleId) {
    autoRuleId = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.pay_auto_invoice_rules ' +
        '(id, school_id, name, description, trigger_type, fee_schedule_id, trigger_term_offset_days, is_active, created_by) ' +
        "VALUES ($1::uuid, $2::uuid, 'Tuition — fire 14 days before term', 'Auto-generates the canonical tuition invoice for every active student 14 days ahead of each term.', 'TERM_START', $3::uuid, -14, true, $4::uuid)",
      autoRuleId,
      schoolId,
      tuitionFeeScheduleId,
      principalPersonId,
    );
  }

  /* E) 1 historical generation run (COMPLETED). */
  if (autoRuleId) {
    const runId = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.pay_invoice_generation_runs ' +
        '(id, school_id, run_type, fee_schedule_id, auto_rule_id, academic_year_id, initiated_by, total_families_targeted, invoices_created, invoices_skipped, invoices_failed, status, started_at, completed_at) ' +
        "VALUES ($1::uuid, $2::uuid, 'AUTO_RULE_TRIGGERED', $3::uuid, $4::uuid, $5::uuid, $6::uuid, 50, 50, 0, 0, 'COMPLETED', now() - interval '7 days', now() - interval '7 days' + interval '4 minutes')",
      runId,
      schoolId,
      tuitionFeeScheduleId!,
      autoRuleId,
      academicYearId,
      principalPersonId,
    );
  }

  /* F) 2 discount rules. */
  const siblingRuleId = generateId();
  const earlyPaymentRuleId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.pay_discount_rules ' +
      '(id, school_id, name, description, discount_type, calculation_method, value, applies_to_fee_category_id, sibling_order, academic_year_id, is_active, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'Sibling Discount — 2nd Child', '10 percent off tuition for the second enrolled sibling.', 'SIBLING', 'PERCENTAGE', 10, $3::uuid, 2, $4::uuid, true, $5::uuid)",
    siblingRuleId,
    schoolId,
    tuitionCategoryId ?? null,
    academicYearId,
    principalPersonId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.pay_discount_rules ' +
      '(id, school_id, name, description, discount_type, calculation_method, value, minimum_invoice_amount, academic_year_id, is_active, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'Early Payment — 5 percent', 'Pay the full invoice within 14 days of issue and receive 5 percent off.', 'EARLY_PAYMENT', 'PERCENTAGE', 5, 1000, $3::uuid, true, $4::uuid)",
    earlyPaymentRuleId,
    schoolId,
    academicYearId,
    principalPersonId,
  );

  /* G) 3 lunch accounts */
  const mayaLunchId = generateId();
  const ethanLunchId = generateId();
  let aidenLunchId: string | null = null;
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.pay_lunch_accounts (id, school_id, student_id, balance, low_balance_threshold) VALUES ($1::uuid, $2::uuid, $3::uuid, 36.50, 10.00)',
    mayaLunchId,
    schoolId,
    mayaId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.pay_lunch_accounts (id, school_id, student_id, balance, low_balance_threshold) VALUES ($1::uuid, $2::uuid, $3::uuid, 22.00, 10.00)',
    ethanLunchId,
    schoolId,
    ethanId,
  );
  if (aidenId) {
    aidenLunchId = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.pay_lunch_accounts (id, school_id, student_id, balance, low_balance_threshold) VALUES ($1::uuid, $2::uuid, $3::uuid, 5.00, 10.00)',
      aidenLunchId,
      schoolId,
      aidenId,
    );
  }

  /* H) 10 lunch transactions. */
  const txDates = [
    { account: mayaLunchId, type: 'DEPOSIT', amount: 50, daysAgo: 14 },
    { account: mayaLunchId, type: 'MEAL_CHARGE', amount: 4.5, daysAgo: 10 },
    { account: mayaLunchId, type: 'MEAL_CHARGE', amount: 4.5, daysAgo: 9 },
    { account: mayaLunchId, type: 'MEAL_CHARGE', amount: 4.5, daysAgo: 7 },
    { account: ethanLunchId, type: 'DEPOSIT', amount: 30, daysAgo: 14 },
    { account: ethanLunchId, type: 'MEAL_CHARGE', amount: 4, daysAgo: 8 },
    { account: ethanLunchId, type: 'MEAL_CHARGE', amount: 4, daysAgo: 5 },
  ];
  if (aidenLunchId) {
    txDates.push(
      { account: aidenLunchId, type: 'DEPOSIT', amount: 20, daysAgo: 12 },
      { account: aidenLunchId, type: 'MEAL_CHARGE', amount: 5, daysAgo: 9 },
      { account: aidenLunchId, type: 'MEAL_CHARGE', amount: 5, daysAgo: 4 },
    );
  }
  for (const t of txDates) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.pay_lunch_transactions (id, school_id, lunch_account_id, amount, transaction_type, meal_date, created_at) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::numeric, $5, CASE WHEN $5 = 'MEAL_CHARGE' THEN (CURRENT_DATE - ($6 || ' days')::interval)::date ELSE NULL END, now() - ($6 || ' days')::interval)",
      generateId(),
      schoolId,
      t.account,
      t.amount.toFixed(2),
      t.type,
      t.daysAgo,
    );
  }

  /* I) 1 IMMUTABLE balance transfer (year-end SIBLING_TRANSFER). */
  if (aidenLunchId) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.pay_lunch_account_balance_transfers ' +
        '(id, school_id, from_account_id, to_account_id, transfer_type, amount, reason, processed_by, processed_at) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SIBLING_TRANSFER', 6.50, 'Year-end balance transfer to a continuing sibling.', $5::uuid, now() - interval '60 days')",
      generateId(),
      schoolId,
      mayaLunchId,
      ethanLunchId,
      principalPersonId,
    );
  }

  /* J) 1 IMMUTABLE credit note ($25 GOODWILL on the SENT tech fee invoice). */
  if (techFeeInvoice) {
    const creditId = generateId();
    const ledgerEntryId = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.pay_ledger_entries (id, family_account_id, entry_type, amount, reference_id, description, created_by) ' +
        "VALUES ($1::uuid, $2::uuid, 'CREDIT', -25, $3::uuid, 'CREDIT: GOODWILL — late-fee waived', $4::uuid)",
      ledgerEntryId,
      chenFamilyAccountId,
      creditId,
      principalPersonId,
    );
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.pay_credit_notes ' +
        '(id, school_id, invoice_id, family_account_id, credit_amount, credit_category, reason, ledger_entry_id, issued_by) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 25, 'GOODWILL', 'Late fee waived as a goodwill gesture for first-time late payment.', $5::uuid, $6::uuid)",
      creditId,
      schoolId,
      techFeeInvoice.id,
      chenFamilyAccountId,
      ledgerEntryId,
      principalPersonId,
    );
  }

  /* K) 1 IMMUTABLE payment reversal — contrived demo coverage row. */
  if (seededPaymentId && tuitionInvoice) {
    const reversalId = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.pay_payment_reversals ' +
        '(id, school_id, payment_id, family_account_id, invoice_id, reversal_type, reversal_reason, bank_reference, reversed_amount, reversed_by) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'BOUNCED_CHEQUE', 'Demo seed only — runtime ReversalService.reverse() is the path that flips payment status to FAILED. The seed leaves the payment as COMPLETED so downstream demo data is undisturbed.', 'demo-bank-ref-001', 12000, $6::uuid)",
      reversalId,
      schoolId,
      seededPaymentId,
      chenFamilyAccountId,
      tuitionInvoice.id,
      principalPersonId,
    );
  }

  /* L) 2 payment allocations — split the seeded $12K tuition payment
   * across the 2 invoices proportionally. Total $12K invoice + $400
   * tech fee = $12.4K; this is illustrative — runtime allocation
   * insists SUM(allocated) = payment.amount. The seed plants
   * allocations matching the actual paid amount only ($12K to the
   * tuition invoice). */
  if (seededPaymentId && tuitionInvoice) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.pay_payment_allocations ' +
        '(id, school_id, payment_id, invoice_id, allocated_amount, allocated_by) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 12000, $5::uuid)',
      generateId(),
      schoolId,
      seededPaymentId,
      tuitionInvoice.id,
      principalPersonId,
    );
  }

  /* M) 1 active late payment policy. */
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.pay_late_payment_policies ' +
      '(id, school_id, is_active, grace_period_days, fee_type, fee_amount, max_late_fee_amount, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, true, 7, 'FIXED', 25, 100, $3::uuid)",
    generateId(),
    schoolId,
    principalPersonId,
  );

  /* N) 1 saved payment method (Visa 4242, default). */
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.pay_saved_payment_methods ' +
      '(id, school_id, family_account_id, stripe_payment_method_id, method_type, card_last_four, card_brand, card_exp_month, card_exp_year, is_default, added_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'pm_demo_visa_4242', 'CARD', '4242', 'visa', 12, 2027, true, $4::uuid)",
    generateId(),
    schoolId,
    chenFamilyAccountId,
    parentPersonId,
  );

  await client.$executeRawUnsafe('SET search_path TO platform, public');

  console.log(
    '  ✓ Financial aid: 1 programme, 2 awards (Maya $1500 + Ethan $750), 1 SUBMITTED application',
  );
  console.log(
    '  ✓ Fees + auto-invoicing: ' +
      (autoRuleId ? '1 auto-rule + 1 generation run' : 'no fee schedule found, skipped rule + run'),
  );
  console.log('  ✓ Discount rules: SIBLING 2nd-child 10%, EARLY_PAYMENT 5%');
  console.log(
    '  ✓ Lunch accounts: ' +
      (aidenLunchId ? '3 accounts' : '2 accounts') +
      ' + ' +
      txDates.length +
      ' transactions' +
      (aidenLunchId ? ' + 1 IMMUTABLE SIBLING_TRANSFER' : ''),
  );
  console.log(
    '  ✓ Billing ops: ' +
      (techFeeInvoice
        ? '1 IMMUTABLE credit note + offsetting CREDIT ledger entry'
        : 'no SENT invoice, skipped credit note') +
      ', ' +
      (seededPaymentId
        ? '1 IMMUTABLE reversal + 1 allocation'
        : 'no payment, skipped reversal + allocation') +
      ', 1 active FIXED $25 late policy, 1 default Visa saved method',
  );
}

async function main(): Promise<void> {
  try {
    await seedPaymentsAdvanced();
  } finally {
    await disconnectAll();
  }
}

main().catch((e: unknown) => {
  console.error('seed-payments-advanced failed:', e);
  process.exit(1);
});
