import type { PrismaClient } from '@prisma/client';
import { TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SCHOOL_B_ID } from '../helpers/tenant-context';
import {
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_TEACHER_EMPLOYEE_ID,
  TEST_OFFICER_EMPLOYEE_ID,
} from '../helpers/actor';

/**
 * Wave 8 — m80-hr fixtures (supplements fixtures/employees.ts).
 *
 * fixtures/employees.ts already seeds the canonical hr_employees rows for
 * admin / officer / teacher actors plus their iam_person + platform_users.
 * This file layers in:
 *
 *   - A current academic year (`is_current=true`) at School A — leave +
 *     appraisal flows refuse to run without one.
 *   - A non-current academic year at School B.
 *   - Catalogue rows used by tests across all four spec files:
 *       hr_positions (A + B)
 *       hr_document_types (A + B)
 *       hr_leave_types (A + B)
 *       hr_pay_grades + hr_salary_scales (A + B)
 *       hr_training_programmes + hr_certification_types (A + B)
 *       hr_appraisal_frameworks (A only — cycle is created per-test)
 *       hr_training_requirements (A only)
 *   - A shadow School B hr_employees row (FK target for cross-school
 *     payroll / leave / training tests).
 *
 * All IDs reserved in `019e0cf8-aaaa-7777-8888-0000000080xx` (School A)
 * and `00000000b08xx` (School B) per the suite convention.
 *
 * `resetHrTables(client)` truncates every hr_* table EXCEPT hr_employees
 * (which holds the actor fixtures) + the catalogues this file seeds.
 * `resetAndSeedHr(client)` runs the truncate + re-seeds the catalogues.
 */

// ── School A catalogue IDs (0080xx range) ────────────────────────────
export const TEST_HR_ACADEMIC_YEAR_ID = '019e0cf8-aaaa-7777-8888-000000080100';
export const TEST_HR_POSITION_TEACHER_ID = '019e0cf8-aaaa-7777-8888-000000080101';
export const TEST_HR_POSITION_ADMIN_ID = '019e0cf8-aaaa-7777-8888-000000080102';
export const TEST_HR_DOC_TYPE_CONTRACT_ID = '019e0cf8-aaaa-7777-8888-000000080103';
export const TEST_HR_DOC_TYPE_RESUME_ID = '019e0cf8-aaaa-7777-8888-000000080104';
export const TEST_HR_LEAVE_TYPE_VACATION_ID = '019e0cf8-aaaa-7777-8888-000000080105';
export const TEST_HR_LEAVE_TYPE_SICK_ID = '019e0cf8-aaaa-7777-8888-000000080106';
export const TEST_HR_PAY_GRADE_A_ID = '019e0cf8-aaaa-7777-8888-000000080107';
export const TEST_HR_PAY_GRADE_B_ID = '019e0cf8-aaaa-7777-8888-000000080108';
export const TEST_HR_SALARY_SCALE_A1_ID = '019e0cf8-aaaa-7777-8888-000000080109';
export const TEST_HR_SALARY_SCALE_A2_ID = '019e0cf8-aaaa-7777-8888-00000008010a';
export const TEST_HR_SALARY_SCALE_B1_ID = '019e0cf8-aaaa-7777-8888-00000008010b';
export const TEST_HR_TRAINING_PROG_MAND_ID = '019e0cf8-aaaa-7777-8888-00000008010c';
export const TEST_HR_TRAINING_PROG_OPT_ID = '019e0cf8-aaaa-7777-8888-00000008010d';
export const TEST_HR_CERT_TYPE_FIRST_AID_ID = '019e0cf8-aaaa-7777-8888-00000008010e';
export const TEST_HR_APPRAISAL_FW_ID = '019e0cf8-aaaa-7777-8888-00000008010f';
export const TEST_HR_TRAINING_REQUIREMENT_ID = '019e0cf8-aaaa-7777-8888-000000080110';

// ── School B catalogue IDs ───────────────────────────────────────────
export const TEST_HR_ACADEMIC_YEAR_B_ID = '019e0cf8-aaaa-7777-8888-00000000b800';
export const TEST_HR_POSITION_B_ID = '019e0cf8-aaaa-7777-8888-00000000b801';
export const TEST_HR_LEAVE_TYPE_B_ID = '019e0cf8-aaaa-7777-8888-00000000b802';
export const TEST_HR_PAY_GRADE_B_SCHOOL_ID = '019e0cf8-aaaa-7777-8888-00000000b803';
export const TEST_HR_TRAINING_PROG_B_ID = '019e0cf8-aaaa-7777-8888-00000000b804';

// ── School B shadow employee (own person + account because hr_employees
//    is UNIQUE on both) ───────────────────────────────────────────────
export const TEST_HR_SHADOW_PERSON_ID = '019e0cf8-aaaa-7777-8888-00000000b820';
export const TEST_HR_SHADOW_ACCOUNT_ID = '019e0cf8-aaaa-7777-8888-00000000b821';
export const TEST_HR_SHADOW_EMPLOYEE_B_ID = '019e0cf8-aaaa-7777-8888-00000000b822';

// Per-test mutation surfaces wiped between specs. Catalogues like
// hr_pay_grades / hr_salary_scales / hr_training_programmes get
// reseeded by ensureHrFixtures (ON CONFLICT DO UPDATE on the canonical
// fixture rows), so we don't truncate them here.
const TENANT_TABLES_RESET = [
  'hr_appraisal_comments',
  'hr_lesson_observations',
  'hr_appraisal_goals',
  'hr_appraisals',
  'hr_appraisal_cycles',
  'hr_expense_claims',
  'hr_employee_certifications',
  'hr_training_completions',
  'hr_training_events',
  'hr_training_compliance',
  'hr_offers',
  'hr_interview_evaluations',
  'hr_interviews',
  'hr_interview_panel_members',
  'hr_interview_panels',
  'hr_applications',
  'hr_job_postings',
  'hr_salary_review_requests',
  'hr_payroll_deductions',
  'hr_payroll_adjustments',
  'hr_payroll_records',
  'hr_pay_periods',
  'hr_employee_benefits',
  'hr_employee_tax_info',
  'hr_employee_documents',
  'hr_staff_certifications',
  'hr_leave_requests',
  'hr_leave_balances',
  'hr_emergency_contacts',
];

/**
 * Truncate the per-test hr_* surfaces. Keeps catalogues (hr_positions,
 * hr_leave_types, hr_pay_grades, hr_salary_scales, hr_training_programmes,
 * hr_certification_types, hr_appraisal_frameworks, hr_training_requirements,
 * hr_document_types, hr_employee_positions) + hr_employees intact so the
 * actor / canonical-row fixtures survive.
 */
export async function resetHrTables(client: PrismaClient): Promise<void> {
  const list = TENANT_TABLES_RESET.map((t) => `${TEST_SCHEMA}.${t}`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);

  // Drop any hr/leave/payroll/training outbox rows so each test starts
  // with an empty platform_outbox view for its tenant.
  await client.$executeRawUnsafe(
    `DELETE FROM platform.platform_outbox
       WHERE topic LIKE 'hr.%'
         AND tenant_id IN ($1::uuid, $2::uuid)`,
    TEST_SCHOOL_ID,
    TEST_SCHOOL_B_ID,
  );

  // Clear consumer idempotency rows so a redelivery-test re-run can
  // re-claim deterministically.
  await client.$executeRawUnsafe(
    `DELETE FROM platform.platform_event_consumer_idempotency
       WHERE consumer_group IN ('leave-approval-consumer', 'leave-notification-consumer')`,
  );
}

/**
 * Seed catalogues. Idempotent — every INSERT uses ON CONFLICT DO NOTHING.
 * Called from globalSetup AND before each test that needs the catalogue
 * rows guaranteed to exist.
 */
export async function ensureHrFixtures(client: PrismaClient): Promise<void> {
  // ── Current academic year (School A) — leave + appraisals NEED this.
  //    Another fixture may already have one for the school; we set
  //    is_current=true on this row and demote any other current row in
  //    the same school first to satisfy the partial UNIQUE INDEX.
  await client.$executeRawUnsafe(
    `UPDATE ${TEST_SCHEMA}.sis_academic_years SET is_current = false
       WHERE school_id = $1::uuid AND is_current = true AND id <> $2::uuid`,
    TEST_SCHOOL_ID,
    TEST_HR_ACADEMIC_YEAR_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_academic_years
       (id, school_id, name, start_date, end_date, is_current)
     VALUES ($1::uuid, $2::uuid, '2027-2028 HR Test', '2027-08-15', '2028-07-15', true)
     ON CONFLICT (id) DO UPDATE SET is_current = true`,
    TEST_HR_ACADEMIC_YEAR_ID,
    TEST_SCHOOL_ID,
  );

  // School B academic year (no is_current — appraisals/leave tests
  // exercise School B only for cross-school assertions).
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_academic_years
       (id, school_id, name, start_date, end_date, is_current)
     VALUES ($1::uuid, $2::uuid, '2027-2028 HR Test B', '2027-08-16', '2028-07-14', false)
     ON CONFLICT (id) DO NOTHING`,
    TEST_HR_ACADEMIC_YEAR_B_ID,
    TEST_SCHOOL_B_ID,
  );

  // ── Positions (School A) ─────────────────────────────────────────
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_positions
       (id, school_id, title, department_id, is_teaching_role, is_active)
     VALUES ($1::uuid, $2::uuid, 'HR Test Teacher Position', NULL, true, true)
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, is_teaching_role = EXCLUDED.is_teaching_role, is_active = EXCLUDED.is_active`,
    TEST_HR_POSITION_TEACHER_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_positions
       (id, school_id, title, department_id, is_teaching_role, is_active)
     VALUES ($1::uuid, $2::uuid, 'HR Test Admin Position', NULL, false, true)
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, is_teaching_role = EXCLUDED.is_teaching_role, is_active = EXCLUDED.is_active`,
    TEST_HR_POSITION_ADMIN_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_positions
       (id, school_id, title, department_id, is_teaching_role, is_active)
     VALUES ($1::uuid, $2::uuid, 'HR Test Position B', NULL, false, true)
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, is_teaching_role = EXCLUDED.is_teaching_role, is_active = EXCLUDED.is_active`,
    TEST_HR_POSITION_B_ID,
    TEST_SCHOOL_B_ID,
  );

  // Tie the canonical admin employee to the admin position (effective
  // today) so payroll resolveEmployeesForProcessing can locate a
  // current-effective primary position when assignment is set.
  // Idempotent — ON CONFLICT DO NOTHING on the partial-unique idx by
  // checking existence first; the table has a unique partial idx on
  // is_primary AND effective_to IS NULL.
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_employee_positions
       (id, employee_id, position_id, is_primary, fte, effective_from)
     VALUES ($1::uuid, $2::uuid, $3::uuid, true, 1.000, '2024-01-01')
     ON CONFLICT DO NOTHING`,
    '019e0cf8-aaaa-7777-8888-000000080200',
    TEST_ADMIN_EMPLOYEE_ID,
    TEST_HR_POSITION_ADMIN_ID,
  );

  // ── Document types ────────────────────────────────────────────────
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_document_types
       (id, school_id, name, description, is_required, is_active)
     VALUES ($1::uuid, $2::uuid, 'HR Contract', 'Employment contract', false, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_HR_DOC_TYPE_CONTRACT_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_document_types
       (id, school_id, name, description, is_required, is_active)
     VALUES ($1::uuid, $2::uuid, 'HR Resume', 'Candidate resume', false, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_HR_DOC_TYPE_RESUME_ID,
    TEST_SCHOOL_ID,
  );

  // ── Leave types ───────────────────────────────────────────────────
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_leave_types
       (id, school_id, name, description, is_paid, accrual_rate, max_balance, is_active)
     VALUES ($1::uuid, $2::uuid, 'HR Vacation', 'Annual leave', true, 20, 30, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_HR_LEAVE_TYPE_VACATION_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_leave_types
       (id, school_id, name, description, is_paid, accrual_rate, max_balance, is_active)
     VALUES ($1::uuid, $2::uuid, 'HR Sick', 'Sick leave', true, 10, 15, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_HR_LEAVE_TYPE_SICK_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_leave_types
       (id, school_id, name, description, is_paid, accrual_rate, max_balance, is_active)
     VALUES ($1::uuid, $2::uuid, 'HR Leave B', 'School B leave', true, 12, 18, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_HR_LEAVE_TYPE_B_ID,
    TEST_SCHOOL_B_ID,
  );

  // ── Pay grades + salary scales ────────────────────────────────────
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_pay_grades
       (id, school_id, grade_name, description, min_salary, max_salary, is_active)
     VALUES ($1::uuid, $2::uuid, 'HR Grade A', 'Junior band', 30000, 50000, true)
     ON CONFLICT (id) DO UPDATE SET grade_name = EXCLUDED.grade_name, is_active = true, min_salary = EXCLUDED.min_salary, max_salary = EXCLUDED.max_salary`,
    TEST_HR_PAY_GRADE_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_pay_grades
       (id, school_id, grade_name, description, min_salary, max_salary, is_active)
     VALUES ($1::uuid, $2::uuid, 'HR Grade B', 'Senior band', 50000, 80000, true)
     ON CONFLICT (id) DO UPDATE SET grade_name = EXCLUDED.grade_name, is_active = true`,
    TEST_HR_PAY_GRADE_B_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_pay_grades
       (id, school_id, grade_name, description, min_salary, max_salary, is_active)
     VALUES ($1::uuid, $2::uuid, 'HR Grade School B', 'B-school band', 35000, 55000, true)
     ON CONFLICT (id) DO UPDATE SET grade_name = EXCLUDED.grade_name, is_active = true`,
    TEST_HR_PAY_GRADE_B_SCHOOL_ID,
    TEST_SCHOOL_B_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_salary_scales
       (id, pay_grade_id, step, annual_salary, notes)
     VALUES ($1::uuid, $2::uuid, 1, 40000, 'Step 1')
     ON CONFLICT (id) DO NOTHING`,
    TEST_HR_SALARY_SCALE_A1_ID,
    TEST_HR_PAY_GRADE_A_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_salary_scales
       (id, pay_grade_id, step, annual_salary, notes)
     VALUES ($1::uuid, $2::uuid, 2, 45000, 'Step 2')
     ON CONFLICT (id) DO NOTHING`,
    TEST_HR_SALARY_SCALE_A2_ID,
    TEST_HR_PAY_GRADE_A_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_salary_scales
       (id, pay_grade_id, step, annual_salary, notes)
     VALUES ($1::uuid, $2::uuid, 1, 60000, 'Senior step 1')
     ON CONFLICT (id) DO NOTHING`,
    TEST_HR_SALARY_SCALE_B1_ID,
    TEST_HR_PAY_GRADE_B_ID,
  );

  // ── Training programmes + cert types ──────────────────────────────
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_training_programmes
       (id, school_id, name, description, is_mandatory, renewal_months, is_active)
     VALUES ($1::uuid, $2::uuid, 'HR First Aid Training', 'Mandatory training', true, 12, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_HR_TRAINING_PROG_MAND_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_training_programmes
       (id, school_id, name, description, is_mandatory, renewal_months, is_active)
     VALUES ($1::uuid, $2::uuid, 'HR Soft Skills', 'Optional', false, NULL, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_HR_TRAINING_PROG_OPT_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_training_programmes
       (id, school_id, name, description, is_mandatory, renewal_months, is_active)
     VALUES ($1::uuid, $2::uuid, 'HR Prog B', 'School B prog', false, NULL, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_HR_TRAINING_PROG_B_ID,
    TEST_SCHOOL_B_ID,
  );
  // Matching cert type for the mandatory programme so completion
  // auto-issues a certification.
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_certification_types
       (id, school_id, name, issuing_body, description, validity_months, is_required, is_active)
     VALUES ($1::uuid, $2::uuid, 'HR First Aid Training', 'Red Cross', 'Cert', 12, false, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_HR_CERT_TYPE_FIRST_AID_ID,
    TEST_SCHOOL_ID,
  );

  // ── Appraisal framework (School A) ────────────────────────────────
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_appraisal_frameworks
       (id, school_id, name, description, criteria, is_active)
     VALUES ($1::uuid, $2::uuid, 'HR Test Framework', 'Test rubric',
             '[{"id":"c1","label":"Pedagogy","weight":1}]'::jsonb, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_HR_APPRAISAL_FW_ID,
    TEST_SCHOOL_ID,
  );

  // ── Training requirement (used by compliance dashboard) ──────────
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_training_requirements
       (id, school_id, position_id, training_name, description,
        certification_type, frequency, is_active)
     VALUES ($1::uuid, $2::uuid, NULL, 'Safeguarding Review', 'Annual',
             'SAFEGUARDING_LEVEL1', 'ANNUAL', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_HR_TRAINING_REQUIREMENT_ID,
    TEST_SCHOOL_ID,
  );

  // ── School B shadow employee for cross-school FK tests ───────────
  await client.$executeRawUnsafe(
    `INSERT INTO platform.iam_person
       (id, first_name, last_name, person_type, is_active)
     VALUES ($1::uuid, 'HRShadow', 'SchoolB', 'STAFF', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_HR_SHADOW_PERSON_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_users
       (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
     VALUES ($1::uuid, $2::uuid, 'hrshadow.schoolb@test.local',
             'HR Shadow B', 'ACTIVE', 'HUMAN', false)
     ON CONFLICT (id) DO NOTHING`,
    TEST_HR_SHADOW_ACCOUNT_ID,
    TEST_HR_SHADOW_PERSON_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_employees
       (id, person_id, account_id, school_id, employee_number,
        employment_type, employment_status, hire_date)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'HR-B-001',
             'FULL_TIME', 'ACTIVE', '2024-01-01')
     ON CONFLICT (id) DO NOTHING`,
    TEST_HR_SHADOW_EMPLOYEE_B_ID,
    TEST_HR_SHADOW_PERSON_ID,
    TEST_HR_SHADOW_ACCOUNT_ID,
    TEST_SCHOOL_B_ID,
  );

  // Reference the actor IDs so the linter doesn't complain about
  // unused imports.
  void TEST_TEACHER_EMPLOYEE_ID;
  void TEST_OFFICER_EMPLOYEE_ID;
}

export async function resetAndSeedHr(client: PrismaClient): Promise<void> {
  await resetHrTables(client);
  await ensureHrFixtures(client);
}
