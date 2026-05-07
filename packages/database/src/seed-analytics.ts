import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-analytics.ts — Cycle 29 Step 4.
 *
 * M110 Analytics. Idempotent — gated on whether
 * rpt_at_risk_configurations already has at least one row for the
 * demo school.
 *
 * Tenant-only seed targeting tenant_demo:
 *   - 30 attendance summaries: 6 of Rivera's classes × 5 days. Rates
 *     between 88% and 98%.
 *   - 10 student academic summaries: 8 healthy + 2 flagged at-risk
 *     (low GPA + low attendance).
 *   - 3 class performance summaries.
 *   - 2 staff summaries: Rivera (6 classes, 120 students, 3 leave
 *     days) + Mitchell (4 classes, 80 students, 1 leave day).
 *   - 1 school summary: Lincoln 2025-2026 (250 enrolled, 35 staff,
 *     93% attendance, 3.10 avg GPA, 5 at-risk, 12 incidents).
 *   - 1 district summary + 2 school comparisons (Lincoln + a
 *     synthetic Elmwood) so the superintendent dashboard renders.
 *   - 1 wellbeing trends row (Grade 5, October 2025-2026: avg 3.8,
 *     45 responses, 3 wants_to_talk, 1 flagged). NO individual ids.
 *   - 1 aged debtor row: Chen family $150 outstanding.
 *   - 2 at-risk configs: "Academic Risk" (GPA<2.0 AND attendance<85%)
 *     + "Attendance Only" (attendance<80%).
 *   - 2 report definitions + 2 runs (Weekly Attendance + Monthly
 *     Finance Summary, both COMPLETE).
 *   - 1 scheduled report: Weekly Attendance every Monday 8am.
 *   - 2 state report templates: Kansas attendance + student count.
 */

const TENANT_SCHEMA = 'tenant_demo';

interface ChenFamily {
  familyAccountId: string | null;
}

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
    'SELECT id::text AS id, organisation_id::text AS organisation_id FROM platform.schools LIMIT 1',
  )) as Array<{ id: string; organisation_id: string }>;
  const schoolId = schoolRows[0]!.id;
  const organisationId = schoolRows[0]!.organisation_id;

  // Idempotency gate
  const existing = (await client.$queryRawUnsafe(
    `SELECT 1 FROM ${TENANT_SCHEMA}.rpt_at_risk_configurations WHERE school_id = $1::uuid LIMIT 1`,
    schoolId,
  )) as Array<unknown>;
  if (existing.length > 0) {
    console.log('Analytics seed already populated for demo school — skipping');
    await disconnectAll();
    return;
  }

  // Resolve identities + cross-cycle anchors
  const academicYearRows = (await client.$queryRawUnsafe(
    `SELECT id::text AS id, name FROM ${TENANT_SCHEMA}.sis_academic_years WHERE is_current = true LIMIT 1`,
  )) as Array<{ id: string; name: string }>;
  const academicYearId = academicYearRows[0]!.id;

  // Get classes (Rivera's 6 + Mitchell's 4 if available, else first 6)
  const classRows = (await client.$queryRawUnsafe(
    `SELECT id::text AS id, section_code FROM ${TENANT_SCHEMA}.sis_classes ORDER BY section_code LIMIT 10`,
  )) as Array<{ id: string; section_code: string }>;
  if (classRows.length < 6) {
    console.error('Need at least 6 sis_classes — run sis seed first');
    process.exit(1);
  }
  const riveraClasses = classRows.slice(0, 6);

  // Get the term
  const termRows = (await client.$queryRawUnsafe(
    `SELECT id::text AS id FROM ${TENANT_SCHEMA}.sis_terms WHERE academic_year_id = $1::uuid ORDER BY start_date LIMIT 1`,
    academicYearId,
  )) as Array<{ id: string }>;
  const termId = termRows[0]?.id ?? generateId();

  // Get students
  const studentRows = (await client.$queryRawUnsafe(
    `SELECT s.id::text AS id, ip.first_name || ' ' || ip.last_name AS name FROM ${TENANT_SCHEMA}.sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id JOIN platform.iam_person ip ON ip.id = ps.person_id ORDER BY ip.last_name LIMIT 10`,
  )) as Array<{ id: string; name: string }>;
  if (studentRows.length < 10) {
    console.error(`Need at least 10 sis_students — found ${studentRows.length}`);
    process.exit(1);
  }

  // Get employees
  const employeeRows = (await client.$queryRawUnsafe(
    `SELECT e.id::text AS id, ip.first_name || ' ' || ip.last_name AS name FROM ${TENANT_SCHEMA}.hr_employees e JOIN platform.iam_person ip ON ip.id = e.person_id`,
  )) as Array<{ id: string; name: string }>;
  const rivera = employeeRows.find((e) => e.name === 'James Rivera') ?? employeeRows[0]!;
  const mitchell = employeeRows.find((e) => e.name === 'Sarah Mitchell') ?? employeeRows[1]!;

  // Get principal account for "created_by" + recipient on at-risk
  const principalRows = (await client.$queryRawUnsafe(
    `SELECT id::text AS id FROM platform.platform_users WHERE email = 'principal@demo.campusos.dev' LIMIT 1`,
  )) as Array<{ id: string }>;
  const principalAccountId = principalRows[0]?.id ?? null;

  // Get Chen family account if available
  const familyRows = (await client.$queryRawUnsafe(
    `SELECT id::text AS id FROM ${TENANT_SCHEMA}.pay_family_accounts ORDER BY created_at LIMIT 1`,
  )) as Array<{ id: string }>;
  const chenFamily: ChenFamily = { familyAccountId: familyRows[0]?.id ?? null };

  console.log('Analytics seed — context resolved:');
  console.log(
    `  schoolId=${schoolId.slice(0, 8)}... organisationId=${organisationId.slice(0, 8)}...`,
  );
  console.log(`  academicYearId=${academicYearId.slice(0, 8)}... termId=${termId.slice(0, 8)}...`);
  console.log(
    `  classes=${classRows.length} students=${studentRows.length} employees=${employeeRows.length}`,
  );
  console.log(`  rivera=${rivera.name} mitchell=${mitchell.name}`);
  console.log(
    `  principalAccountId=${principalAccountId?.slice(0, 8) ?? 'null'}... familyAccountId=${chenFamily.familyAccountId?.slice(0, 8) ?? 'null'}...`,
  );

  // ─── A) 30 daily attendance summaries (6 classes × 5 days) ───
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dates: string[] = [];
  for (let d = 4; d >= 0; d--) {
    const x = new Date(today);
    x.setUTCDate(today.getUTCDate() - d);
    dates.push(x.toISOString().slice(0, 10));
  }
  const attendanceRates = [0.96, 0.92, 0.98, 0.88, 0.94];
  let attCount = 0;
  for (const cls of riveraClasses) {
    for (let i = 0; i < dates.length; i++) {
      const enrolled = 25;
      const rate = attendanceRates[i] + (riveraClasses.indexOf(cls) % 2 === 0 ? 0 : -0.02);
      const presentCount = Math.round(enrolled * rate);
      const lateCount = Math.max(0, enrolled - presentCount - (i % 2 === 0 ? 1 : 0));
      const absentCount = enrolled - presentCount - lateCount;
      const attendanceRate = (presentCount + lateCount) / enrolled;
      await client.$executeRawUnsafe(
        `INSERT INTO ${TENANT_SCHEMA}.rpt_daily_attendance_summary (id, school_id, class_id, summary_date, present_count, absent_count, late_count, total_enrolled, attendance_rate) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6, $7, $8, $9::numeric)`,
        generateId(),
        schoolId,
        cls.id,
        dates[i]!,
        presentCount,
        absentCount,
        lateCount,
        enrolled,
        attendanceRate.toFixed(4),
      );
      attCount++;
    }
  }
  console.log(`  ✓ ${attCount} daily attendance summaries`);

  // ─── B) 10 student academic summaries (8 healthy + 2 at-risk) ───
  const academicProfiles = [
    { gpa: 3.8, attendance: 0.97, atRisk: false }, // 0
    { gpa: 3.5, attendance: 0.95, atRisk: false }, // 1
    { gpa: 3.2, attendance: 0.94, atRisk: false }, // 2
    { gpa: 2.8, attendance: 0.91, atRisk: false }, // 3
    { gpa: 2.5, attendance: 0.89, atRisk: false }, // 4
    { gpa: 2.2, attendance: 0.87, atRisk: false }, // 5
    { gpa: 1.8, attendance: 0.82, atRisk: true }, // 6 at-risk
    { gpa: 3.0, attendance: 0.93, atRisk: false }, // 7
    { gpa: 1.5, attendance: 0.78, atRisk: true }, // 8 at-risk
    { gpa: 3.6, attendance: 0.96, atRisk: false }, // 9
  ];
  let acCount = 0;
  for (let i = 0; i < studentRows.length; i++) {
    const stu = studentRows[i]!;
    const profile = academicProfiles[i]!;
    const flags = profile.atRisk
      ? JSON.stringify({
          'Academic Risk': {
            triggered_at: new Date().toISOString(),
            conditions_matched: ['gpa<2.0', 'attendance<85%'],
          },
        })
      : '{}';
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.rpt_student_academic_summary (id, student_id, academic_year_id, school_id, current_gpa, credits_earned, credits_attempted, attendance_rate, total_assignments, completed_assignments, at_risk_flags) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9, $10, $11::jsonb)`,
      generateId(),
      stu.id,
      academicYearId,
      schoolId,
      profile.gpa.toFixed(3),
      (profile.gpa * 4).toFixed(1),
      24,
      profile.attendance.toFixed(4),
      80,
      Math.round(80 * profile.attendance),
      flags,
    );
    acCount++;
  }
  console.log(`  ✓ ${acCount} student academic summaries (2 flagged at-risk)`);

  // ─── C) 3 class performance summaries ───
  const perfClasses = riveraClasses.slice(0, 3);
  const perfData = [
    { avg: 87.5, median: 88, dist: { A: 8, B: 12, C: 4, D: 1, F: 0 } },
    { avg: 79.2, median: 80, dist: { A: 4, B: 10, C: 8, D: 3, F: 0 } },
    { avg: 91.0, median: 92, dist: { A: 14, B: 8, C: 2, D: 1, F: 0 } },
  ];
  for (let i = 0; i < perfClasses.length; i++) {
    const cls = perfClasses[i]!;
    const data = perfData[i]!;
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.rpt_class_performance_summary (id, class_id, term_id, school_id, avg_grade, median_grade, grade_distribution, assignment_completion_rate, student_count) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, $6::numeric, $7::jsonb, $8::numeric, $9)`,
      generateId(),
      cls.id,
      termId,
      schoolId,
      data.avg.toFixed(2),
      data.median.toFixed(2),
      JSON.stringify(data.dist),
      0.92,
      25,
    );
  }
  console.log(`  ✓ ${perfClasses.length} class performance summaries`);

  // ─── D) 2 staff summaries ───
  for (const [emp, classes, students, leaveDays, perf] of [
    [rivera, 6, 120, 3.0, 87.5],
    [mitchell, 4, 80, 1.0, 91.0],
  ] as const) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.rpt_staff_summary (id, employee_id, academic_year_id, school_id, classes_taught, total_students, leave_days_taken, avg_class_performance) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::numeric, $8::numeric)`,
      generateId(),
      emp.id,
      academicYearId,
      schoolId,
      classes,
      students,
      leaveDays.toFixed(1),
      perf.toFixed(2),
    );
  }
  console.log(`  ✓ 2 staff summaries`);

  // ─── E) 1 school summary ───
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.rpt_school_summary (id, school_id, academic_year_id, total_enrolled, total_staff, avg_attendance_rate, avg_gpa, at_risk_count, incident_count) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::numeric, $7::numeric, $8, $9)`,
    generateId(),
    schoolId,
    academicYearId,
    250,
    35,
    '0.9300',
    '3.100',
    5,
    12,
  );
  console.log('  ✓ 1 school summary');

  // ─── F) 1 district summary + 2 school comparisons ───
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.rpt_district_summary (id, organisation_id, academic_year_id, school_count, total_enrolled, total_staff, avg_attendance_rate, avg_gpa, total_at_risk, total_incidents) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::numeric, $8::numeric, $9, $10)`,
    generateId(),
    organisationId,
    academicYearId,
    2,
    500,
    65,
    '0.9100',
    '3.050',
    11,
    24,
  );

  // Lincoln Academy ranked #1 attendance
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.rpt_district_school_comparison (id, organisation_id, academic_year_id, school_id, rank_by_attendance, rank_by_performance, metrics) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::jsonb)`,
    generateId(),
    organisationId,
    academicYearId,
    schoolId,
    1,
    1,
    JSON.stringify({ attendance_rate: 0.93, avg_gpa: 3.1, at_risk_count: 5, incident_count: 12 }),
  );
  // Synthetic Elmwood comparison row (school_id is a soft ref so we can use a placeholder)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.rpt_district_school_comparison (id, organisation_id, academic_year_id, school_id, rank_by_attendance, rank_by_performance, metrics) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::jsonb)`,
    generateId(),
    organisationId,
    academicYearId,
    generateId(), // synthetic Elmwood school_id
    2,
    2,
    JSON.stringify({
      attendance_rate: 0.89,
      avg_gpa: 3.0,
      at_risk_count: 6,
      incident_count: 12,
      school_name: 'Elmwood Middle (synthetic comparison row)',
    }),
  );
  console.log('  ✓ 1 district summary + 2 school comparisons (Lincoln #1, Elmwood #2)');

  // ─── G) 1 wellbeing trends row (NO individual ids) ───
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.rpt_wellbeing_trends (id, school_id, grade_level, period_start, period_end, avg_wellbeing_score, response_count, wants_to_talk_count, flagged_count) VALUES ($1::uuid, $2::uuid, $3, $4::date, $5::date, $6::numeric, $7, $8, $9)`,
    generateId(),
    schoolId,
    '5',
    '2025-10-01',
    '2025-10-31',
    '3.8',
    45,
    3,
    1,
  );
  console.log('  ✓ 1 wellbeing trends row (Grade 5, October — NO individual ids)');

  // ─── H) 1 aged debtor row (Chen family if available) ───
  const debtorFamilyId = chenFamily.familyAccountId ?? generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.rpt_fin_aged_debtors (id, school_id, family_account_id, total_outstanding, current_bucket, days_30, days_60, days_90_plus, last_payment_date) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::numeric, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9::date)`,
    generateId(),
    schoolId,
    debtorFamilyId,
    '150.00',
    '100.00',
    '50.00',
    '0.00',
    '0.00',
    '2026-04-15',
  );
  console.log('  ✓ 1 aged debtor row (Chen family, $150 outstanding)');

  // ─── I) 2 at-risk configurations ───
  const academicRiskId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.rpt_at_risk_configurations (id, school_id, name, description, trigger_conditions, alert_recipients, is_active, created_by) VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::uuid[], $7, $8::uuid)`,
    academicRiskId,
    schoolId,
    'Academic Risk',
    'Students with GPA below 2.0 AND attendance below 85%.',
    JSON.stringify({ attendance_threshold: 0.85, grade_threshold: 2.0 }),
    principalAccountId ? [principalAccountId] : [],
    true,
    principalAccountId,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.rpt_at_risk_configurations (id, school_id, name, description, trigger_conditions, alert_recipients, is_active, created_by) VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::uuid[], $7, $8::uuid)`,
    generateId(),
    schoolId,
    'Attendance Only',
    'Students with attendance below 80%.',
    JSON.stringify({ attendance_threshold: 0.8 }),
    principalAccountId ? [principalAccountId] : [],
    true,
    principalAccountId,
  );
  console.log('  ✓ 2 at-risk configurations (Academic Risk + Attendance Only)');

  // ─── J) 2 report definitions + 2 runs ───
  const weeklyAttendanceDefId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.rpt_report_definitions (id, school_id, name, description, report_type, template_config, is_active, created_by) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7, $8::uuid)`,
    weeklyAttendanceDefId,
    schoolId,
    'Weekly Attendance Report',
    'Per-class attendance summary for the prior week.',
    'ATTENDANCE',
    JSON.stringify({
      data_source: 'rpt_daily_attendance_summary',
      filters: { period: 'last_7_days' },
      columns: ['class_section', 'present_count', 'absent_count', 'attendance_rate'],
      grouping: ['class_section'],
    }),
    true,
    principalAccountId,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.rpt_report_runs (id, report_definition_id, run_by, status, output_format, output_s3_key, row_count, started_at, generated_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, now() - interval '2 hours', now() - interval '2 hours')`,
    generateId(),
    weeklyAttendanceDefId,
    principalAccountId,
    'COMPLETE',
    'CSV',
    `s3://campusos-reports/${TENANT_SCHEMA}/weekly-attendance-2026-04-30.csv`,
    6,
  );

  const monthlyFinanceDefId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.rpt_report_definitions (id, school_id, name, description, report_type, template_config, is_active, created_by) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7, $8::uuid)`,
    monthlyFinanceDefId,
    schoolId,
    'Monthly Finance Summary',
    'Aged debtors + total outstanding for the month.',
    'FINANCE',
    JSON.stringify({
      data_source: 'rpt_fin_aged_debtors',
      filters: { period: 'current_month' },
      columns: ['family', 'total_outstanding', 'days_30', 'days_60', 'days_90_plus'],
      grouping: ['family'],
    }),
    true,
    principalAccountId,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.rpt_report_runs (id, report_definition_id, run_by, status, output_format, output_s3_key, row_count, started_at, generated_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, now() - interval '1 day', now() - interval '1 day')`,
    generateId(),
    monthlyFinanceDefId,
    principalAccountId,
    'COMPLETE',
    'CSV',
    `s3://campusos-reports/${TENANT_SCHEMA}/monthly-finance-2026-04.csv`,
    1,
  );
  console.log(
    '  ✓ 2 report definitions + 2 runs (Weekly Attendance + Monthly Finance, both COMPLETE)',
  );

  // ─── K) 1 scheduled report (Weekly Attendance every Monday 8am) ───
  const nextMonday = new Date(today);
  const dayOfWeek = nextMonday.getUTCDay(); // 0=Sun, 1=Mon
  const daysUntilMonday = (1 - dayOfWeek + 7) % 7 || 7;
  nextMonday.setUTCDate(today.getUTCDate() + daysUntilMonday);
  nextMonday.setUTCHours(8, 0, 0, 0);
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.rpt_scheduled_reports (id, school_id, report_name, template_name, report_params, schedule_cron, timezone, delivery_channel, recipient_ids, output_format, is_active, next_run_at, created_by) VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7, $8, $9::uuid[], $10, $11, $12::timestamptz, $13::uuid)`,
    generateId(),
    schoolId,
    'Weekly Attendance Auto-Send',
    'Weekly Attendance Report',
    JSON.stringify({ definition_id: weeklyAttendanceDefId }),
    '0 8 * * MON',
    'America/Chicago',
    'EMAIL',
    principalAccountId ? [principalAccountId] : [],
    'CSV',
    true,
    nextMonday.toISOString(),
    principalAccountId,
  );
  console.log(
    `  ✓ 1 scheduled report (Weekly Attendance Mon 8am, next_run_at=${nextMonday.toISOString().slice(0, 10)})`,
  );

  // ─── L) 2 state report templates ───
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.rpt_state_report_templates (id, state_code, report_type, schema_version, template_config, is_active) VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6)`,
    generateId(),
    'KS',
    'attendance',
    'v2024.1',
    JSON.stringify({
      title: 'Kansas State Attendance Report',
      data_source: 'rpt_school_summary',
      required_columns: ['school_id', 'avg_attendance_rate', 'total_enrolled'],
      output_format: 'CSV',
      submission_url: 'https://example.ksde.org/submit/attendance',
    }),
    true,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.rpt_state_report_templates (id, state_code, report_type, schema_version, template_config, is_active) VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6)`,
    generateId(),
    'KS',
    'student_count',
    'v2024.1',
    JSON.stringify({
      title: 'Kansas Student Count Report',
      data_source: 'rpt_school_summary',
      required_columns: ['school_id', 'total_enrolled', 'enrolment_by_grade'],
      output_format: 'CSV',
      submission_url: 'https://example.ksde.org/submit/student-count',
    }),
    true,
  );
  console.log('  ✓ 2 state report templates (Kansas attendance + student count)');

  console.log('Analytics seed complete.');
  await disconnectAll();
}

main().catch(async (err) => {
  console.error('seed-analytics failed:', err);
  await disconnectAll();
  process.exit(1);
});
