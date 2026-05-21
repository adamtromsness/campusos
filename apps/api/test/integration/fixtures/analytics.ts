import type { PrismaClient } from '@prisma/client';
import {
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_ORG_ID,
} from '../helpers/tenant-context';
import {
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_TEACHER_EMPLOYEE_ID,
} from '../helpers/actor';
import { ensureSisFixtures } from './sis';
import { ensureFinanceFixtures } from './finance';

/**
 * Wave 8 — m110-analytics fixtures.
 *
 * Seeds a self-contained academic/finance/discipline footprint that the
 * analytics workers can roll up into the rpt_* read models:
 *
 *   - sis_academic_years (CURRENT) + sis_terms — needed by every
 *     classroom/SIS worker; sis_terms is the cls grain.
 *   - sis_courses + sis_classes (A + B) — the per-class grain.
 *   - sis_class_teachers (admin employee assigned to class A) — used by
 *     SchoolSummaryWorker's total_staff aggregate.
 *   - platform_students + sis_students for two students (A and B) so the
 *     SISReadModelWorker has rows.
 *   - sis_enrollments — populates total_enrolled + classroom student_count
 *     + AtRisk teacherClassIds path.
 *   - cls_assignment_types + cls_assignments + cls_submissions + cls_grades
 *     — drive the academic summary GPA pipeline.
 *   - sis_attendance_records — drive the attendance summary path. School
 *     year `2025-08-01` lands inside the seeded 2025-26 partition.
 *   - sis_discipline_categories + sis_discipline_incidents — incident_count
 *     on SchoolSummary.
 *   - pay_family_accounts + pay_invoices + pay_payments + pay_refunds —
 *     FinanceARWorker buckets.
 *   - svc_wellbeing_* (questions + checkins + responses + alerts) for
 *     WellbeingTrendsWorker.
 *   - hr_leave_types + hr_leave_requests for the staff summary leave_days.
 *
 * Every table cleared and re-seeded per test via resetAndSeedAnalytics so
 * worker re-runs see deterministic input. School B mirror rows live in
 * the same tenant_test schema with school_id=TEST_SCHOOL_B_ID.
 *
 * IDs follow the suite convention: `019e0cf8-aaaa-7777-8888-000000110xxx`
 * for analytics-owned fixtures. Other modules' IDs (sis fixtures, finance
 * fixtures) are read directly from helpers/actor.ts so we don't clash.
 */

// School A
export const TEST_ANA_ACADEMIC_YEAR_ID = '019e0cf8-aaaa-7777-8888-000000110001';
export const TEST_ANA_TERM_ID = '019e0cf8-aaaa-7777-8888-000000110002';
export const TEST_ANA_COURSE_ID = '019e0cf8-aaaa-7777-8888-000000110003';
export const TEST_ANA_CLASS_ID = '019e0cf8-aaaa-7777-8888-000000110004';
export const TEST_ANA_PLATFORM_STUDENT_ID = '019e0cf8-aaaa-7777-8888-000000110010';
export const TEST_ANA_STUDENT_ID = '019e0cf8-aaaa-7777-8888-000000110011';
export const TEST_ANA_PLATFORM_STUDENT2_ID = '019e0cf8-aaaa-7777-8888-000000110012';
export const TEST_ANA_STUDENT2_ID = '019e0cf8-aaaa-7777-8888-000000110013';
export const TEST_ANA_STUDENT_PERSON_ID = '019e0cf8-aaaa-7777-8888-000000110015';
export const TEST_ANA_STUDENT2_PERSON_ID = '019e0cf8-aaaa-7777-8888-000000110014';
export const TEST_ANA_ASSIGNMENT_TYPE_ID = '019e0cf8-aaaa-7777-8888-000000110020';
export const TEST_ANA_ASSIGNMENT_ID = '019e0cf8-aaaa-7777-8888-000000110021';
export const TEST_ANA_SUBMISSION_ID = '019e0cf8-aaaa-7777-8888-000000110022';
export const TEST_ANA_GRADE_ID = '019e0cf8-aaaa-7777-8888-000000110023';
export const TEST_ANA_DISCIPLINE_CATEGORY_ID = '019e0cf8-aaaa-7777-8888-000000110030';
export const TEST_ANA_DISCIPLINE_INCIDENT_ID = '019e0cf8-aaaa-7777-8888-000000110031';
export const TEST_ANA_FAMILY_ACCOUNT_ID = '019e0cf8-aaaa-7777-8888-000000110040';
export const TEST_ANA_INVOICE_OVERDUE_ID = '019e0cf8-aaaa-7777-8888-000000110041';
export const TEST_ANA_INVOICE_CURRENT_ID = '019e0cf8-aaaa-7777-8888-000000110042';
export const TEST_ANA_PAYMENT_ID = '019e0cf8-aaaa-7777-8888-000000110043';
export const TEST_ANA_WB_QUESTION_ID = '019e0cf8-aaaa-7777-8888-000000110050';
export const TEST_ANA_WB_CHECKIN_ID = '019e0cf8-aaaa-7777-8888-000000110051';
export const TEST_ANA_WB_RESPONSE_ID = '019e0cf8-aaaa-7777-8888-000000110052';
export const TEST_ANA_WB_ALERT_ID = '019e0cf8-aaaa-7777-8888-000000110053';
export const TEST_ANA_WB_TEMPLATE_ID = '019e0cf8-aaaa-7777-8888-000000110054';
export const TEST_ANA_LEAVE_TYPE_ID = '019e0cf8-aaaa-7777-8888-000000110060';
export const TEST_ANA_LEAVE_REQUEST_ID = '019e0cf8-aaaa-7777-8888-000000110061';
// School B mirrors
export const TEST_ANA_CLASS_B_ID = '019e0cf8-aaaa-7777-8888-00000011b004';
export const TEST_ANA_FAMILY_ACCOUNT_B_ID = '019e0cf8-aaaa-7777-8888-00000011b040';
export const TEST_ANA_INVOICE_B_ID = '019e0cf8-aaaa-7777-8888-00000011b041';

// Use a date that lives in the 2025_26 partition seeded by migration 004.
export const TEST_ANA_SCHOOL_YEAR_DATE = '2025-08-01';
export const TEST_ANA_ATTENDANCE_DATE = '2025-09-15';

const ANALYTICS_TENANT_TABLES = [
  'rpt_event_contributions',
  'rpt_scheduled_reports',
  'rpt_report_runs',
  'rpt_report_definitions',
  'rpt_state_report_templates',
  'rpt_fin_aged_debtors',
  'rpt_wellbeing_trends',
  'rpt_district_school_comparison',
  'rpt_district_summary',
  'rpt_school_summary',
  'rpt_staff_summary',
  'rpt_class_performance_summary',
  'rpt_student_academic_summary',
  'rpt_daily_attendance_summary',
  'rpt_at_risk_configurations',
  'rpt_rebuild_snapshots',
  'rpt_analytics_worker_checkpoints',
  'rpt_procurement_summary',
  'rpt_store_sales',
  'rpt_fds_meal_counts',
  'rpt_fds_nslp_summary',
  'rpt_trn_ridership_summary',
  'rpt_facilities_condition',
  'rpt_facilities_kpi',
  'rpt_tech_fleet_status',
  'rpt_lib_circulation_summary',
  'rpt_enr_funnel_summary',
  'rpt_ath_season_summary',
  'rpt_officials_marketplace',
  'rpt_game_results',
  'rpt_grp_engagement_summary',
  'rpt_pub_distribution_summary',
  'rpt_ext_service_summary',
  'rpt_msg_communication_metrics',
  'rpt_wellbeing_domain_trends',
];

const UPSTREAM_TENANT_TABLES = [
  'cls_grades',
  'cls_submissions',
  'cls_assignments',
  'cls_assignment_types',
  'sis_attendance_records',
  'sis_enrollments',
  'sis_class_teachers',
  'svc_wellbeing_alerts',
  'svc_wellbeing_responses',
  'svc_wellbeing_checkins',
  'svc_wellbeing_questions',
  'svc_wellbeing_survey_templates',
  'sis_discipline_incidents',
  'sis_discipline_categories',
  'pay_refunds',
  'pay_payments',
  'pay_invoices',
  'pay_family_accounts',
  'hr_leave_requests',
  'hr_leave_balances',
  'hr_leave_types',
  'sis_students',
  'sis_classes',
  'sis_courses',
  'sis_departments',
  'sis_terms',
  'sis_academic_years',
];

/**
 * Wipe analytics output tables + the seeded upstream rows.
 *
 * Keep the shared platform fixtures (organisations, schools, iam_person,
 * platform_users, hr_employees) — they're seeded by setup.ts globalSetup
 * and shared by every spec. Per-test wipe ONLY the per-test tables.
 *
 * platform.platform_students is platform-scoped: we delete only the rows
 * we created so re-runs are clean but the shared admin/teacher rows
 * survive.
 */
export async function resetAnalyticsTables(client: PrismaClient): Promise<void> {
  const tenantList = [...ANALYTICS_TENANT_TABLES, ...UPSTREAM_TENANT_TABLES]
    .map((t) => `${TEST_SCHEMA}.${t}`)
    .join(', ');
  await client.$executeRawUnsafe(`TRUNCATE ${tenantList} RESTART IDENTITY CASCADE`);

  // Per-fixture platform_students rows. UPDATE to NULL first because
  // sis_students.platform_student_id is UNIQUE; bring it down before
  // deletion or the next INSERT will collide.
  await client.$executeRawUnsafe(
    `DELETE FROM platform.platform_students
     WHERE id IN ($1::uuid, $2::uuid)`,
    TEST_ANA_PLATFORM_STUDENT_ID,
    TEST_ANA_PLATFORM_STUDENT2_ID,
  );
  await client.$executeRawUnsafe(
    `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
    [TEST_ANA_STUDENT_PERSON_ID, TEST_ANA_STUDENT2_PERSON_ID],
  );

  // The TRUNCATE above wipes sis_academic_years / sis_terms / sis_courses /
  // sis_classes including the canonical TEST_SIS_* fixture rows that
  // m83-finance, m20-sis, m84-payments and many other specs depend on
  // for cross-school setup. Re-seed the canonical baseline so the
  // global state survives this module's resets. Both fixture functions
  // use ON CONFLICT DO NOTHING so it's safe to call repeatedly.
  //   - ensureSisFixtures restores TEST_SIS_ACADEMIC_YEAR_ID + sis_classes
  //   - ensureFinanceFixtures restores TEST_ACADEMIC_YEAR_ID (used by
  //     m84-payments FinancialAidService.createApplication validation)
  await ensureSisFixtures(client);
  await ensureFinanceFixtures(client);
}

/**
 * Seed the analytics upstream rows. Idempotent — every INSERT uses
 * ON CONFLICT DO NOTHING so callers can sequence resetAnalyticsTables
 * followed by ensureAnalyticsSeed (or call resetAndSeedAnalytics).
 */
export async function ensureAnalyticsSeed(client: PrismaClient): Promise<void> {
  // ── iam_person + platform_students for the two students ──
  await client.$executeRawUnsafe(
    `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
     VALUES ($1::uuid, 'Analytics', 'Student1', 'STUDENT', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_STUDENT_PERSON_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
     VALUES ($1::uuid, 'Analytics', 'Student2', 'STUDENT', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_STUDENT2_PERSON_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_students
       (id, person_id, first_name, last_name, is_active)
     VALUES ($1::uuid, $2::uuid, 'Integration', 'Student', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_PLATFORM_STUDENT_ID,
    TEST_ANA_STUDENT_PERSON_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_students
       (id, person_id, first_name, last_name, is_active)
     VALUES ($1::uuid, $2::uuid, 'Analytics', 'Student2', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_PLATFORM_STUDENT2_ID,
    TEST_ANA_STUDENT2_PERSON_ID,
  );

  // ── Academic year (CURRENT) ──
  // Reset is_current on any other rows so this one wins. The test schema
  // ships several academic_years rows from other waves' fixtures (sis,
  // finance) — we explicitly own the current flag here. Use a start_date
  // unique against (school_id, start_date) UNIQUE so we never collide.
  await client.$executeRawUnsafe(
    `UPDATE ${TEST_SCHEMA}.sis_academic_years SET is_current = false`,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_academic_years (id, school_id, name, start_date, end_date, is_current)
     VALUES ($1::uuid, $2::uuid, 'Analytics 2025-26', '2025-08-05', '2026-07-30', true)
     ON CONFLICT (id) DO UPDATE SET is_current = true`,
    TEST_ANA_ACADEMIC_YEAR_ID,
    TEST_SCHOOL_ID,
  );

  // ── Term ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_terms (id, academic_year_id, name, start_date, end_date, term_type)
     VALUES ($1::uuid, $2::uuid, 'Fall 2025', '2025-08-05', '2025-12-15', 'SEMESTER')
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_TERM_ID,
    TEST_ANA_ACADEMIC_YEAR_ID,
  );

  // ── Department + course + class (A) ──
  // Department: reuse the SIS fixture department to avoid collisions, or
  // create a new one. Use the SIS fixture's TEST_SIS_DEPARTMENT_ID instead.
  const departmentRow = (await client.$queryRawUnsafe(
    `SELECT id::text FROM ${TEST_SCHEMA}.sis_departments WHERE school_id = $1::uuid LIMIT 1`,
    TEST_SCHOOL_ID,
  )) as Array<{ id: string }>;
  let departmentId: string;
  if (departmentRow.length > 0) {
    departmentId = departmentRow[0]!.id;
  } else {
    departmentId = '019e0cf8-aaaa-7777-8888-000000110099';
    await client.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_departments (id, school_id, name)
       VALUES ($1::uuid, $2::uuid, 'Analytics Dept') ON CONFLICT (id) DO NOTHING`,
      departmentId,
      TEST_SCHOOL_ID,
    );
  }

  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_courses
       (id, school_id, department_id, code, name, credit_hours, grade_level)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'ANA-101', 'Analytics Course', 1.0, '5')
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_COURSE_ID,
    TEST_SCHOOL_ID,
    departmentId,
  );

  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_classes
       (id, school_id, course_id, academic_year_id, term_id, section_code, max_enrollment)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'A', 30)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_CLASS_ID,
    TEST_SCHOOL_ID,
    TEST_ANA_COURSE_ID,
    TEST_ANA_ACADEMIC_YEAR_ID,
    TEST_ANA_TERM_ID,
  );

  // School B class
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_courses
       (id, school_id, department_id, code, name, credit_hours, grade_level)
     SELECT $1::uuid, $2::uuid, d.id, 'ANA-101-B', 'Analytics B', 1.0, '5'
       FROM ${TEST_SCHEMA}.sis_departments d
      WHERE d.school_id = $2::uuid
      LIMIT 1
     ON CONFLICT (id) DO NOTHING`,
    '019e0cf8-aaaa-7777-8888-00000011b003',
    TEST_SCHOOL_B_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_classes
       (id, school_id, course_id, academic_year_id, section_code, max_enrollment)
     SELECT $1::uuid, $2::uuid, $3::uuid, ay.id, 'B', 30
       FROM ${TEST_SCHEMA}.sis_academic_years ay
       WHERE ay.school_id = $2::uuid
       LIMIT 1
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_CLASS_B_ID,
    TEST_SCHOOL_B_ID,
    '019e0cf8-aaaa-7777-8888-00000011b003',
  );

  // ── sis_class_teachers — admin assigned to class A ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_class_teachers
       (id, class_id, teacher_employee_id, is_primary_teacher)
     VALUES ($1::uuid, $2::uuid, $3::uuid, true)
     ON CONFLICT (id) DO NOTHING`,
    '019e0cf8-aaaa-7777-8888-000000110005',
    TEST_ANA_CLASS_ID,
    TEST_ADMIN_EMPLOYEE_ID,
  );
  // Teacher is also a class A teacher for non-manager scope tests
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_class_teachers
       (id, class_id, teacher_employee_id, is_primary_teacher)
     VALUES ($1::uuid, $2::uuid, $3::uuid, false)
     ON CONFLICT (id) DO NOTHING`,
    '019e0cf8-aaaa-7777-8888-000000110006',
    TEST_ANA_CLASS_ID,
    TEST_TEACHER_EMPLOYEE_ID,
  );

  // ── Students ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_students
       (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'A0001', '5', 'ENROLLED')
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_STUDENT_ID,
    TEST_ANA_PLATFORM_STUDENT_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_students
       (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'A0002', '5', 'ENROLLED')
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_STUDENT2_ID,
    TEST_ANA_PLATFORM_STUDENT2_ID,
    TEST_SCHOOL_ID,
  );

  // ── Enrollments ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_enrollments (id, student_id, class_id, status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'ACTIVE')
     ON CONFLICT (id) DO NOTHING`,
    '019e0cf8-aaaa-7777-8888-000000110007',
    TEST_ANA_STUDENT_ID,
    TEST_ANA_CLASS_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_enrollments (id, student_id, class_id, status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'ACTIVE')
     ON CONFLICT (id) DO NOTHING`,
    '019e0cf8-aaaa-7777-8888-000000110008',
    TEST_ANA_STUDENT2_ID,
    TEST_ANA_CLASS_ID,
  );

  // ── Assignment + submission + grade ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.cls_assignment_types (id, school_id, name, category, is_active)
     VALUES ($1::uuid, $2::uuid, 'Analytics Quiz', 'QUIZ', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_ASSIGNMENT_TYPE_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.cls_assignments
       (id, class_id, assignment_type_id, title, due_date, max_points, is_published)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'Quiz 1', '2025-09-01', 100, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_ASSIGNMENT_ID,
    TEST_ANA_CLASS_ID,
    TEST_ANA_ASSIGNMENT_TYPE_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.cls_submissions
       (id, assignment_id, student_id, status, submitted_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'GRADED', '2025-09-02T00:00:00Z')
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_SUBMISSION_ID,
    TEST_ANA_ASSIGNMENT_ID,
    TEST_ANA_STUDENT_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.cls_grades
       (id, assignment_id, student_id, submission_id, teacher_id, grade_value, letter_grade, is_published, published_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 92, 'A', true, '2025-09-03T00:00:00Z')
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_GRADE_ID,
    TEST_ANA_ASSIGNMENT_ID,
    TEST_ANA_STUDENT_ID,
    TEST_ANA_SUBMISSION_ID,
    TEST_ADMIN_EMPLOYEE_ID,
  );

  // ── Attendance records (use 2025-08-01 school_year) ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_attendance_records
       (id, school_id, school_year, student_id, class_id, date, period, status)
     VALUES (gen_random_uuid(), $1::uuid, $2::date, $3::uuid, $4::uuid, $5::date, '1', 'PRESENT')
     ON CONFLICT (school_year, class_id, student_id, date, period) DO NOTHING`,
    TEST_SCHOOL_ID,
    TEST_ANA_SCHOOL_YEAR_DATE,
    TEST_ANA_STUDENT_ID,
    TEST_ANA_CLASS_ID,
    TEST_ANA_ATTENDANCE_DATE,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_attendance_records
       (id, school_id, school_year, student_id, class_id, date, period, status)
     VALUES (gen_random_uuid(), $1::uuid, $2::date, $3::uuid, $4::uuid, $5::date, '1', 'ABSENT')
     ON CONFLICT (school_year, class_id, student_id, date, period) DO NOTHING`,
    TEST_SCHOOL_ID,
    TEST_ANA_SCHOOL_YEAR_DATE,
    TEST_ANA_STUDENT2_ID,
    TEST_ANA_CLASS_ID,
    TEST_ANA_ATTENDANCE_DATE,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_attendance_records
       (id, school_id, school_year, student_id, class_id, date, period, status)
     VALUES (gen_random_uuid(), $1::uuid, $2::date, $3::uuid, $4::uuid, $5::date, '1', 'TARDY')
     ON CONFLICT (school_year, class_id, student_id, date, period) DO NOTHING`,
    TEST_SCHOOL_ID,
    TEST_ANA_SCHOOL_YEAR_DATE,
    TEST_ANA_STUDENT_ID,
    TEST_ANA_CLASS_ID,
    '2025-09-16',
  );

  // ── Discipline category + incident ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_discipline_categories
       (id, school_id, name, severity, is_active)
     VALUES ($1::uuid, $2::uuid, 'Tardy', 'LOW', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_DISCIPLINE_CATEGORY_ID,
    TEST_SCHOOL_ID,
  );
  // incident_date within last 90 days from "now" — use today minus 7d so
  // it lands in the rolling window.
  const today = new Date();
  const recent = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const recentISO = recent.toISOString().slice(0, 10);
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_discipline_incidents
       (id, school_id, student_id, category_id, description, incident_date, status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'fixture incident', $5::date, 'OPEN')
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_DISCIPLINE_INCIDENT_ID,
    TEST_SCHOOL_ID,
    TEST_ANA_STUDENT_ID,
    TEST_ANA_DISCIPLINE_CATEGORY_ID,
    recentISO,
  );

  // ── Finance: family account + 1 overdue invoice (days_60) + 1 current invoice + 1 partial payment ──
  // Account holder = admin person.
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.pay_family_accounts
       (id, school_id, account_holder_id, account_number, status, payment_authorisation_policy)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'FA-001', 'ACTIVE', 'ACCOUNT_HOLDER_ONLY')
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_FAMILY_ACCOUNT_ID,
    TEST_SCHOOL_ID,
    TEST_ADMIN_PERSON_ID,
  );
  // Overdue: due 45 days ago, status SENT, 500 outstanding.
  const dueOverdue = new Date(today.getTime() - 45 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.pay_invoices
       (id, school_id, family_account_id, title, total_amount, due_date, status, sent_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'Overdue', 500.00, $4::date, 'SENT', now())
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_INVOICE_OVERDUE_ID,
    TEST_SCHOOL_ID,
    TEST_ANA_FAMILY_ACCOUNT_ID,
    dueOverdue,
  );
  // Current invoice (due 5 days from now, status SENT, 200 outstanding)
  const dueCurrent = new Date(today.getTime() + 5 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.pay_invoices
       (id, school_id, family_account_id, title, total_amount, due_date, status, sent_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'Current', 200.00, $4::date, 'SENT', now())
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_INVOICE_CURRENT_ID,
    TEST_SCHOOL_ID,
    TEST_ANA_FAMILY_ACCOUNT_ID,
    dueCurrent,
  );
  // Completed payment of 100 against overdue
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.pay_payments
       (id, school_id, invoice_id, family_account_id, amount, payment_method, status, paid_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 100.00, 'CASH', 'COMPLETED', now())
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_PAYMENT_ID,
    TEST_SCHOOL_ID,
    TEST_ANA_INVOICE_OVERDUE_ID,
    TEST_ANA_FAMILY_ACCOUNT_ID,
  );

  // School B finance row (cross-school isolation)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.pay_family_accounts
       (id, school_id, account_holder_id, account_number, status, payment_authorisation_policy)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'FA-B-001', 'ACTIVE', 'ACCOUNT_HOLDER_ONLY')
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_FAMILY_ACCOUNT_B_ID,
    TEST_SCHOOL_B_ID,
    TEST_ADMIN_PERSON_ID,
  );

  // ── Wellbeing ──
  // svc_wellbeing_survey_templates → checkins → responses → alerts.
  // The schema needs a template+question pair so the join compiles.
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.svc_wellbeing_survey_templates
       (id, school_id, name, frequency_recommendation, is_active, created_by)
     VALUES ($1::uuid, $2::uuid, 'Daily Check-in', 'DAILY', true, $3::uuid)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_WB_TEMPLATE_ID,
    TEST_SCHOOL_ID,
    TEST_ADMIN_EMPLOYEE_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.svc_wellbeing_questions
       (id, template_id, question_text, question_type, domain, sort_order)
     VALUES ($1::uuid, $2::uuid, 'Do you feel safe?', 'SCALE_1_5', 'SAFETY', 1)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_WB_QUESTION_ID,
    TEST_ANA_WB_TEMPLATE_ID,
  );
  // Checkin completed last month (so the WellbeingTrendsWorker default
  // "previous month" window includes it).
  const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15);
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.svc_wellbeing_checkins
       (id, school_id, template_id, student_id, completed_at, flagged_for_follow_up)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_WB_CHECKIN_ID,
    TEST_SCHOOL_ID,
    TEST_ANA_WB_TEMPLATE_ID,
    TEST_ANA_STUDENT_ID,
    lastMonth.toISOString(),
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.svc_wellbeing_responses
       (id, checkin_id, question_id, numeric_response)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 1)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_WB_RESPONSE_ID,
    TEST_ANA_WB_CHECKIN_ID,
    TEST_ANA_WB_QUESTION_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.svc_wellbeing_alerts
       (id, student_id, response_id, alert_type, status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'WANTS_TO_TALK', 'NEW')
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_WB_ALERT_ID,
    TEST_ANA_STUDENT_ID,
    TEST_ANA_WB_RESPONSE_ID,
  );

  // ── HR leave ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_leave_types
       (id, school_id, name, is_paid, accrual_rate, is_active)
     VALUES ($1::uuid, $2::uuid, 'Analytics Sick', true, 0, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_LEAVE_TYPE_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_leave_requests
       (id, employee_id, leave_type_id, start_date, end_date, days_requested, status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, '2025-09-01', '2025-09-02', 2.0, 'APPROVED')
     ON CONFLICT (id) DO NOTHING`,
    TEST_ANA_LEAVE_REQUEST_ID,
    TEST_ADMIN_EMPLOYEE_ID,
    TEST_ANA_LEAVE_TYPE_ID,
  );
}

/** Convenience helper: wipe + re-seed in one call. */
export async function resetAndSeedAnalytics(client: PrismaClient): Promise<void> {
  await resetAnalyticsTables(client);
  await ensureAnalyticsSeed(client);
}

