import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-payroll.ts — Phase 2 Cycle 4 (P2C4) sub-cycle a.
 *
 * Idempotent — gated on whether hr_pay_grades already has rows for
 * the demo school.
 *
 * Sections:
 *   A) 3 pay grades — Grade 1 ($35K-$45K), Grade 2 ($45K-$60K),
 *      Grade 3 ($55K-$80K).
 *   B) 5 salary scales per grade (steps 1..5) — annual salaries.
 *   C) 1 PAID pay period — last completed bi-weekly cycle, with the
 *      processed_at + paid_at + paid_by populated so the dashboard
 *      shows historical activity at first paint.
 *   D) 3 payroll records — one per seeded employee (Mitchell, Rivera,
 *      Park) tied to the PAID period. Pay records carry their own
 *      computed gross / deductions / net so the demo doesn't depend
 *      on the worker running.
 *   E) 7 deduction line items — federal tax, state tax, social
 *      security, medicare, health insurance per record.
 *   F) 1 BONUS adjustment — APPROVED but not yet APPLIED on Park's
 *      record. Demonstrates the adjustment lifecycle.
 *   G) 1 APPROVED salary review — Mitchell recommended Step 5 of
 *      Grade 3 (annual increment).
 *   H) 3 employee tax info rows — federal_allowances=2 each, state
 *      allowances varying.
 *   I) 3 employee benefit rows — Mitchell HEALTH ($150 / $300),
 *      Rivera HEALTH ($150 / $300), Park RETIREMENT ($100 / $200).
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedPayroll() {
  console.log('');
  console.log('  Payroll Seed (P2C4 sub-cycle a)');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' + TENANT_SCHEMA + '.hr_pay_grades WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  hr_pay_grades already populated for demo school. Skipping.');
    return;
  }

  await client.$executeRawUnsafe('SET search_path TO ' + TENANT_SCHEMA + ', platform, public');

  const employees = (await client.$queryRawUnsafe(
    'SELECT e.id::text AS id, ip.first_name AS first, ip.last_name AS last ' +
      'FROM ' +
      TENANT_SCHEMA +
      '.hr_employees e ' +
      'LEFT JOIN platform.iam_person ip ON ip.id = e.person_id ' +
      'WHERE e.school_id = $1::uuid ' +
      'ORDER BY ip.last_name LIMIT 3',
    schoolId,
  )) as Array<{ id: string; first: string; last: string }>;
  if (employees.length === 0) {
    console.log('  no hr_employees found. Run seed:hr first. Skipping.');
    return;
  }
  const adminUser = await client.platformUser.findFirst({
    where: { email: 'principal@demo.campusos.dev' },
  });
  if (!adminUser) throw new Error('principal user not found — run pnpm seed first');

  // --- A. Pay grades ---
  const grades = [
    { name: 'Grade 1 — Support Staff', min: 35000, max: 45000 },
    { name: 'Grade 2 — Teacher', min: 45000, max: 60000 },
    { name: 'Grade 3 — Senior / Lead', min: 55000, max: 80000 },
  ];
  const gradeIds: string[] = [];
  for (const g of grades) {
    const id = generateId();
    gradeIds.push(id);
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hr_pay_grades (id, school_id, grade_name, min_salary, max_salary) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
      id,
      schoolId,
      g.name,
      g.min,
      g.max,
    );
  }
  console.log('  A. ' + grades.length + ' pay grades');

  // --- B. Salary scales (5 steps per grade) ---
  const scaleByGradeStep: Record<string, Record<number, { id: string; salary: number }>> = {};
  for (let gi = 0; gi < grades.length; gi++) {
    const gradeId = gradeIds[gi]!;
    const min = grades[gi]!.min;
    const max = grades[gi]!.max;
    scaleByGradeStep[gradeId] = {};
    for (let step = 1; step <= 5; step++) {
      const id = generateId();
      const salary = Math.round(min + ((max - min) * (step - 1)) / 4);
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.hr_salary_scales (id, pay_grade_id, step, annual_salary) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4)',
        id,
        gradeId,
        step,
        salary,
      );
      scaleByGradeStep[gradeId]![step] = { id, salary };
    }
  }
  console.log('  B. ' + grades.length * 5 + ' salary scales');

  // --- C. 1 PAID pay period (most recent bi-weekly) ---
  const today = new Date();
  // Anchor Sunday two weeks ago.
  const periodEnd = new Date(today);
  periodEnd.setDate(today.getDate() - today.getDay() - 1); // last Saturday
  const periodStart = new Date(periodEnd);
  periodStart.setDate(periodEnd.getDate() - 13);
  const payDate = new Date(periodEnd);
  payDate.setDate(periodEnd.getDate() + 5); // pay 5 days after end
  const periodId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_pay_periods (id, school_id, period_label, start_date, end_date, pay_date, status, processed_at, processed_by, paid_at, paid_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4::date, $5::date, $6::date, 'PAID', now() - interval '6 days', $7::uuid, now() - interval '5 days', $7::uuid)",
    periodId,
    schoolId,
    'Pay Period — ' + isoDate(periodStart) + ' to ' + isoDate(periodEnd),
    isoDate(periodStart),
    isoDate(periodEnd),
    isoDate(payDate),
    adminUser.id,
  );
  console.log(
    '  C. 1 PAID pay period (' + isoDate(periodStart) + ' to ' + isoDate(periodEnd) + ')',
  );

  // --- D + E. Payroll records + deductions per employee ---
  const grade2Step3 = scaleByGradeStep[gradeIds[1]!]![3]!; // Grade 2 step 3 — typical teacher
  const grade3Step5 = scaleByGradeStep[gradeIds[2]!]![5]!; // Grade 3 step 5 — principal
  const grade1Step3 = scaleByGradeStep[gradeIds[0]!]![3]!; // Grade 1 step 3 — VP / counsellor

  const recordTemplates = [
    { emp: employees[0]!, scale: grade3Step5, label: 'Principal' },
    { emp: employees[1]!, scale: grade2Step3, label: 'Teacher' },
    { emp: employees[2]!, scale: grade1Step3, label: 'VP / Counsellor' },
  ];

  for (const t of recordTemplates) {
    const grossPay = round2(t.scale.salary / 26);
    const federalTax = round2(grossPay * 0.2 - 100);
    const stateTax = round2(grossPay * 0.06 - 50);
    const socialSecurity = round2(grossPay * 0.062);
    const medicare = round2(grossPay * 0.0145);
    const healthInsurance = 150.0;
    const totalDeductions = round2(
      federalTax + stateTax + socialSecurity + medicare + healthInsurance,
    );
    const netPay = round2(grossPay - totalDeductions);
    const recordId = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hr_payroll_records (id, school_id, employee_id, pay_period_id, salary_scale_id, gross_pay, total_deductions, net_pay, status) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, 'PAID')",
      recordId,
      schoolId,
      t.emp.id,
      periodId,
      t.scale.id,
      grossPay,
      totalDeductions,
      netPay,
    );
    const deds = [
      { type: 'FEDERAL_TAX', amt: Math.max(0, federalTax), pretax: false },
      { type: 'STATE_TAX', amt: Math.max(0, stateTax), pretax: false },
      { type: 'SOCIAL_SECURITY', amt: socialSecurity, pretax: false },
      { type: 'MEDICARE', amt: medicare, pretax: false },
      { type: 'HEALTH_INSURANCE', amt: healthInsurance, pretax: true },
    ];
    for (const d of deds) {
      if (d.amt <= 0) continue;
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.hr_payroll_deductions (id, payroll_record_id, deduction_type, amount, is_pretax) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
        generateId(),
        recordId,
        d.type,
        d.amt,
        d.pretax,
      );
    }
  }
  console.log('  D. 3 payroll records (1 per employee) + E. ~15 deductions');

  // --- F. 1 APPROVED bonus adjustment on Park's record ---
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_payroll_adjustments (id, school_id, employee_id, effective_pay_period_id, adjustment_type, amount, reason, requested_by, approved_by, approved_at, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'BONUS', 500.00, 'Q4 instructional improvement bonus.', $5::uuid, $5::uuid, now() - interval '7 days', 'APPROVED')",
    generateId(),
    schoolId,
    employees[2]!.id,
    periodId,
    adminUser.id,
  );
  console.log('  F. 1 APPROVED bonus adjustment (Park, $500)');

  // --- G. 1 APPROVED salary review request ---
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_salary_review_requests (id, school_id, employee_id, requested_by, review_type, current_salary, recommended_salary, justification, status, decision_notes, decided_by, decided_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ANNUAL_INCREMENT', $5, $6, 'Mitchell completed FY2025-26 with consistent OUTSTANDING appraisals. Recommend Grade 3 Step 5.', 'APPROVED', 'Approved by board.', $4::uuid, now() - interval '3 days')",
    generateId(),
    schoolId,
    employees[0]!.id,
    adminUser.id,
    grade3Step5.salary - 4000,
    grade3Step5.salary,
  );
  console.log('  G. 1 APPROVED salary review (Mitchell, annual increment)');

  // --- H. Tax info per employee ---
  for (const e of employees) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hr_employee_tax_info (id, employee_id, filing_status, federal_allowances, state_allowances, additional_withholding, state_code) ' +
        "VALUES ($1::uuid, $2::uuid, 'SINGLE', 2, 1, 0, 'KS')",
      generateId(),
      e.id,
    );
  }
  console.log('  H. ' + employees.length + ' tax info rows');

  // --- I. Benefit enrolments ---
  const benefits = [
    { emp: employees[0]!, type: 'HEALTH', plan: 'School Health PPO', emp_c: 150, er_c: 300 },
    { emp: employees[1]!, type: 'HEALTH', plan: 'School Health PPO', emp_c: 150, er_c: 300 },
    { emp: employees[2]!, type: 'RETIREMENT', plan: 'KS Public Pension', emp_c: 100, er_c: 200 },
  ];
  for (const b of benefits) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hr_employee_benefits (id, employee_id, benefit_type, plan_name, employee_contribution, employer_contribution, effective_from) ' +
        "VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, '2025-08-01'::date)",
      generateId(),
      b.emp.id,
      b.type,
      b.plan,
      b.emp_c,
      b.er_c,
    );
  }
  console.log('  I. ' + benefits.length + ' benefit enrolments');

  console.log('  done.');
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

seedPayroll()
  .then(() => disconnectAll())
  .catch((err) => {
    console.error(err);
    return disconnectAll().then(() => {
      process.exit(1);
    });
  });
