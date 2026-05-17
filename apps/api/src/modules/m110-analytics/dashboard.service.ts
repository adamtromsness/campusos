import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import type {
  AgedDebtorDto,
  AtRiskConfigDto,
  AtRiskStudentDto,
  ClassPerformanceSummaryDto,
  CreateAtRiskConfigDto,
  DailyAttendanceSummaryDto,
  DistrictSchoolComparisonDto,
  DistrictSummaryDto,
  ListAcademicArgs,
  ListAttendanceArgs,
  SchoolSummaryDto,
  StaffSummaryDto,
  StateReportTemplateDto,
  StudentAcademicSummaryDto,
  UpdateAtRiskConfigDto,
  WellbeingTrendsDto,
} from './dto/analytics.dto';

/**
 * DashboardService — read-only access to every rpt_* table that
 * Step 8 + 9 UI consume. Persona-scoped: managers (admin OR Staff
 * with rpt-002:read) see everything in tenant; teachers see only
 * their own classes via sis_class_teachers row scope.
 *
 * No writes — workers in workers.service.ts + cross-domain.service.ts
 * are the sole materialisers per ADR-008.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  /**
   * "Manager" = anyone holding rpt-002:read OR school admin. STAFF
   * persona alone is not enough — admin gate is at the permission tier.
   */
  private async isManager(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'rpt-002:read',
    ]);
  }

  private async hasDistrictScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'rpt-003:read',
    ]);
  }

  /**
   * REVIEW-CYCLE29 BLOCKING 2 — validate trigger_conditions JSON.
   * Only known keys with sane ranges are accepted.
   */
  private validateTriggerConditions(input: unknown): Record<string, number> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new BadRequestException('triggerConditions must be an object.');
    }
    const allowedKeys = [
      'attendance_threshold',
      'grade_threshold',
      'missed_assignments_threshold',
      'behaviour_incident_threshold',
    ] as const;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(input)) {
      if (!allowedKeys.includes(key as (typeof allowedKeys)[number])) {
        throw new BadRequestException(
          `triggerConditions has unknown key "${key}". Allowed keys: ${allowedKeys.join(', ')}.`,
        );
      }
      const n = Number(value);
      if (!Number.isFinite(n)) {
        throw new BadRequestException(
          `triggerConditions.${key} must be a finite number, got ${JSON.stringify(value)}.`,
        );
      }
      if (key === 'attendance_threshold') {
        if (n < 0 || n > 1) {
          throw new BadRequestException(
            'triggerConditions.attendance_threshold must be between 0 and 1 (inclusive).',
          );
        }
      } else if (key === 'grade_threshold') {
        if (n < 0 || n > 5) {
          throw new BadRequestException(
            'triggerConditions.grade_threshold must be between 0 and 5 (inclusive).',
          );
        }
      } else if (key === 'missed_assignments_threshold' || key === 'behaviour_incident_threshold') {
        if (!Number.isInteger(n) || n < 0) {
          throw new BadRequestException(`triggerConditions.${key} must be a non-negative integer.`);
        }
      }
      out[key] = n;
    }
    if (Object.keys(out).length === 0) {
      throw new BadRequestException(
        'triggerConditions must include at least one of: ' + allowedKeys.join(', '),
      );
    }
    return out;
  }

  /**
   * REVIEW-CYCLE29 BLOCKING 3 — every supplied platform_users.id must
   * project into the calling tenant via sis_students / sis_guardians /
   * hr_employees. Mirrors the Cycle 6.1 / Cycle 22 / Cycle 25 pattern.
   */
  async assertAccountsInCurrentTenant(accountIds: string[], fieldName: string): Promise<void> {
    if (accountIds.length === 0) return;
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT pu.id::text AS account_id
           FROM platform.platform_users pu
          WHERE pu.id = ANY($1::uuid[])
            AND (
              EXISTS (SELECT 1 FROM sis_students s
                       JOIN platform.platform_students ps ON ps.id = s.platform_student_id
                       WHERE ps.person_id = pu.person_id)
              OR EXISTS (SELECT 1 FROM sis_guardians g WHERE g.person_id = pu.person_id)
              OR EXISTS (SELECT 1 FROM hr_employees e WHERE e.person_id = pu.person_id)
            )`,
        accountIds,
      );
    })) as Array<{ account_id: string }>;
    const found = new Set(rows.map((r) => r.account_id));
    const missing = accountIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(
        `${fieldName} contains account ids not affiliated with this school: ${missing.join(', ')}`,
      );
    }
    void tenant;
  }

  private async teacherClassIds(actor: ResolvedActor): Promise<string[]> {
    if (!actor.employeeId) return [];
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT class_id::text AS class_id FROM sis_class_teachers WHERE teacher_employee_id = $1::uuid`,
        actor.employeeId,
      );
    })) as Array<{ class_id: string }>;
    return rows.map((r) => r.class_id);
  }

  /** ─── Daily attendance ──────────────────────────────────────── */

  async listDailyAttendance(
    actor: ResolvedActor,
    args?: ListAttendanceArgs,
  ): Promise<DailyAttendanceSummaryDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['s.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    let i = 2;

    if (!(await this.isManager(actor))) {
      const classIds = await this.teacherClassIds(actor);
      if (classIds.length === 0) return [];
      where.push(`s.class_id = ANY($${i++}::uuid[])`);
      params.push(classIds);
    }
    if (args?.classId) {
      where.push(`s.class_id = $${i++}::uuid`);
      params.push(args.classId);
    }
    if (args?.fromDate) {
      where.push(`s.summary_date >= $${i++}::date`);
      params.push(args.fromDate);
    }
    if (args?.toDate) {
      where.push(`s.summary_date <= $${i++}::date`);
      params.push(args.toDate);
    }
    const limit = Math.min(args?.limit ?? 100, 500);

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT s.id::text AS id,
                s.school_id::text AS school_id,
                s.class_id::text AS class_id,
                COALESCE(co.name || ' (' || c.section_code || ')', c.section_code) AS class_name,
                s.summary_date::text AS summary_date,
                s.present_count, s.absent_count, s.late_count, s.total_enrolled,
                s.attendance_rate, s.generated_at::text AS generated_at
         FROM rpt_daily_attendance_summary s
         LEFT JOIN sis_classes c ON c.id = s.class_id
         LEFT JOIN sis_courses co ON co.id = c.course_id
         WHERE ${where.join(' AND ')}
         ORDER BY s.summary_date DESC, s.class_id
         LIMIT ${limit}`,
        ...params,
      );
    })) as Array<{
      id: string;
      school_id: string;
      class_id: string;
      class_name: string | null;
      summary_date: string;
      present_count: number;
      absent_count: number;
      late_count: number;
      total_enrolled: number;
      attendance_rate: string | number | null;
      generated_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      classId: r.class_id,
      className: r.class_name,
      summaryDate: r.summary_date,
      presentCount: Number(r.present_count),
      absentCount: Number(r.absent_count),
      lateCount: Number(r.late_count),
      totalEnrolled: Number(r.total_enrolled),
      attendanceRate: r.attendance_rate === null ? null : Number(r.attendance_rate),
      generatedAt: r.generated_at,
    }));
  }

  /** ─── Student academic summary ──────────────────────────────── */

  async listAcademic(
    actor: ResolvedActor,
    args?: ListAcademicArgs,
  ): Promise<StudentAcademicSummaryDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['s.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    let i = 2;

    // REVIEW-CYCLE29 BLOCKING 1: at-risk flags + filter are RPT-002:read
    // territory. Teachers (RPT-001:read only) get the academic summary
    // for their own class enrollments WITHOUT raw at_risk_flags and
    // CANNOT use atRiskOnly to enumerate flagged students.
    const isMgr = await this.isManager(actor);
    if (!isMgr) {
      const classIds = await this.teacherClassIds(actor);
      if (classIds.length === 0) return [];
      where.push(
        `s.student_id IN (SELECT student_id FROM sis_enrollments WHERE class_id = ANY($${i++}::uuid[]) AND status = 'ACTIVE')`,
      );
      params.push(classIds);
    }
    if (args?.gradeLevel) {
      where.push(
        `EXISTS (SELECT 1 FROM sis_students st WHERE st.id = s.student_id AND st.grade_level = $${i++})`,
      );
      params.push(args.gradeLevel);
    }
    if (args?.atRiskOnly) {
      if (!isMgr) {
        throw new ForbiddenException(
          'atRiskOnly filter requires the rpt-002:read permission. Teachers can only see academic summaries for their own classes without at-risk attribution.',
        );
      }
      where.push(`s.at_risk_flags <> '{}'::jsonb`);
    }
    const limit = Math.min(args?.limit ?? 100, 500);

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT s.id::text AS id, s.student_id::text AS student_id,
                ip.first_name || ' ' || ip.last_name AS student_name,
                st.grade_level, s.academic_year_id::text AS academic_year_id,
                s.school_id::text AS school_id,
                s.current_gpa, s.credits_earned, s.credits_attempted,
                s.attendance_rate, s.total_assignments, s.completed_assignments,
                s.at_risk_flags, s.generated_at::text AS generated_at
         FROM rpt_student_academic_summary s
         LEFT JOIN sis_students st ON st.id = s.student_id
         LEFT JOIN platform.platform_students ps ON ps.id = st.platform_student_id
         LEFT JOIN platform.iam_person ip ON ip.id = ps.person_id
         WHERE ${where.join(' AND ')}
         ORDER BY (s.at_risk_flags <> '{}'::jsonb) DESC, ip.last_name NULLS LAST, ip.first_name NULLS LAST
         LIMIT ${limit}`,
        ...params,
      );
    })) as Array<{
      id: string;
      student_id: string;
      student_name: string | null;
      grade_level: string | null;
      academic_year_id: string;
      school_id: string;
      current_gpa: string | number | null;
      credits_earned: string | number;
      credits_attempted: string | number;
      attendance_rate: string | number | null;
      total_assignments: number;
      completed_assignments: number;
      at_risk_flags: Record<string, unknown>;
      generated_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      studentId: r.student_id,
      studentName: r.student_name,
      gradeLevel: r.grade_level,
      academicYearId: r.academic_year_id,
      schoolId: r.school_id,
      currentGpa: r.current_gpa === null ? null : Number(r.current_gpa),
      creditsEarned: Number(r.credits_earned),
      creditsAttempted: Number(r.credits_attempted),
      attendanceRate: r.attendance_rate === null ? null : Number(r.attendance_rate),
      totalAssignments: Number(r.total_assignments),
      completedAssignments: Number(r.completed_assignments),
      // REVIEW-CYCLE29 BLOCKING 1: at-risk flags are RPT-002 territory.
      // Non-manager actors get an empty object on every row so the wire
      // shape stays stable but the attribution doesn't leak.
      atRiskFlags: isMgr ? (r.at_risk_flags ?? {}) : {},
      generatedAt: r.generated_at,
    }));
  }

  /** ─── Class performance ──────────────────────────────────────── */

  async listClassPerformance(actor: ResolvedActor): Promise<ClassPerformanceSummaryDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['s.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    let i = 2;
    if (!(await this.isManager(actor))) {
      const classIds = await this.teacherClassIds(actor);
      if (classIds.length === 0) return [];
      where.push(`s.class_id = ANY($${i++}::uuid[])`);
      params.push(classIds);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT s.id::text, s.class_id::text AS class_id,
                COALESCE(co.name || ' (' || c.section_code || ')', c.section_code) AS class_name,
                s.term_id::text AS term_id, s.school_id::text AS school_id,
                s.avg_grade, s.median_grade, s.grade_distribution,
                s.assignment_completion_rate, s.student_count, s.generated_at::text AS generated_at
         FROM rpt_class_performance_summary s
         LEFT JOIN sis_classes c ON c.id = s.class_id
         LEFT JOIN sis_courses co ON co.id = c.course_id
         WHERE ${where.join(' AND ')}
         ORDER BY class_name`,
        ...params,
      );
    })) as Array<{
      id: string;
      class_id: string;
      class_name: string | null;
      term_id: string;
      school_id: string;
      avg_grade: string | number | null;
      median_grade: string | number | null;
      grade_distribution: Record<string, number>;
      assignment_completion_rate: string | number | null;
      student_count: number;
      generated_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      classId: r.class_id,
      className: r.class_name,
      termId: r.term_id,
      schoolId: r.school_id,
      avgGrade: r.avg_grade === null ? null : Number(r.avg_grade),
      medianGrade: r.median_grade === null ? null : Number(r.median_grade),
      gradeDistribution: r.grade_distribution ?? {},
      assignmentCompletionRate:
        r.assignment_completion_rate === null ? null : Number(r.assignment_completion_rate),
      studentCount: Number(r.student_count),
      generatedAt: r.generated_at,
    }));
  }

  /** ─── Staff summary ──────────────────────────────────────────── */

  async listStaffSummary(actor: ResolvedActor): Promise<StaffSummaryDto[]> {
    if (!(await this.isManager(actor))) {
      throw new ForbiddenException('Staff summaries are restricted to school managers and admins.');
    }
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT s.id::text, s.employee_id::text AS employee_id,
                ip.first_name || ' ' || ip.last_name AS employee_name,
                s.academic_year_id::text AS academic_year_id, s.school_id::text AS school_id,
                s.classes_taught, s.total_students, s.leave_days_taken, s.avg_class_performance,
                s.generated_at::text AS generated_at
         FROM rpt_staff_summary s
         LEFT JOIN hr_employees e ON e.id = s.employee_id
         LEFT JOIN platform.iam_person ip ON ip.id = e.person_id
         WHERE s.school_id = $1::uuid
         ORDER BY ip.last_name`,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      employee_id: string;
      employee_name: string | null;
      academic_year_id: string;
      school_id: string;
      classes_taught: number;
      total_students: number;
      leave_days_taken: string | number;
      avg_class_performance: string | number | null;
      generated_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      academicYearId: r.academic_year_id,
      schoolId: r.school_id,
      classesTaught: Number(r.classes_taught),
      totalStudents: Number(r.total_students),
      leaveDaysTaken: Number(r.leave_days_taken),
      avgClassPerformance:
        r.avg_class_performance === null ? null : Number(r.avg_class_performance),
      generatedAt: r.generated_at,
    }));
  }

  /** ─── School / district summaries ────────────────────────────── */

  async getSchoolSummary(actor: ResolvedActor): Promise<SchoolSummaryDto | null> {
    if (!(await this.isManager(actor))) {
      throw new ForbiddenException('School summary is restricted to managers and admins.');
    }
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT s.id::text, s.school_id::text AS school_id,
                (SELECT name FROM platform.schools WHERE id = s.school_id) AS school_name,
                s.academic_year_id::text AS academic_year_id,
                s.total_enrolled, s.total_staff, s.avg_attendance_rate, s.avg_gpa,
                s.at_risk_count, s.incident_count, s.generated_at::text AS generated_at
         FROM rpt_school_summary s
         WHERE s.school_id = $1::uuid
         ORDER BY s.generated_at DESC LIMIT 1`,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      school_name: string | null;
      academic_year_id: string;
      total_enrolled: number;
      total_staff: number;
      avg_attendance_rate: string | number | null;
      avg_gpa: string | number | null;
      at_risk_count: number;
      incident_count: number;
      generated_at: string;
    }>;
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      id: r.id,
      schoolId: r.school_id,
      schoolName: r.school_name,
      academicYearId: r.academic_year_id,
      totalEnrolled: Number(r.total_enrolled),
      totalStaff: Number(r.total_staff),
      avgAttendanceRate: r.avg_attendance_rate === null ? null : Number(r.avg_attendance_rate),
      avgGpa: r.avg_gpa === null ? null : Number(r.avg_gpa),
      atRiskCount: Number(r.at_risk_count),
      incidentCount: Number(r.incident_count),
      generatedAt: r.generated_at,
    };
  }

  async getDistrictSummary(actor: ResolvedActor): Promise<DistrictSummaryDto | null> {
    if (!(await this.hasDistrictScope(actor))) {
      throw new ForbiddenException('District summary requires the rpt-003:read permission.');
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text, organisation_id::text AS organisation_id, academic_year_id::text AS academic_year_id,
                school_count, total_enrolled, total_staff, avg_attendance_rate, avg_gpa,
                total_at_risk, total_incidents, generated_at::text AS generated_at
         FROM rpt_district_summary ORDER BY generated_at DESC LIMIT 1`,
      );
    })) as Array<{
      id: string;
      organisation_id: string;
      academic_year_id: string;
      school_count: number;
      total_enrolled: number;
      total_staff: number;
      avg_attendance_rate: string | number | null;
      avg_gpa: string | number | null;
      total_at_risk: number;
      total_incidents: number;
      generated_at: string;
    }>;
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      id: r.id,
      organisationId: r.organisation_id,
      academicYearId: r.academic_year_id,
      schoolCount: Number(r.school_count),
      totalEnrolled: Number(r.total_enrolled),
      totalStaff: Number(r.total_staff),
      avgAttendanceRate: r.avg_attendance_rate === null ? null : Number(r.avg_attendance_rate),
      avgGpa: r.avg_gpa === null ? null : Number(r.avg_gpa),
      totalAtRisk: Number(r.total_at_risk),
      totalIncidents: Number(r.total_incidents),
      generatedAt: r.generated_at,
    };
  }

  async listDistrictComparison(actor: ResolvedActor): Promise<DistrictSchoolComparisonDto[]> {
    if (!(await this.hasDistrictScope(actor))) {
      throw new ForbiddenException('District comparison requires the rpt-003:read permission.');
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT c.id::text, c.organisation_id::text AS organisation_id, c.academic_year_id::text AS academic_year_id,
                c.school_id::text AS school_id,
                COALESCE((SELECT name FROM platform.schools WHERE id = c.school_id), c.metrics->>'school_name') AS school_name,
                c.rank_by_attendance, c.rank_by_performance, c.metrics, c.generated_at::text AS generated_at
         FROM rpt_district_school_comparison c
         ORDER BY c.rank_by_attendance NULLS LAST`,
      );
    })) as Array<{
      id: string;
      organisation_id: string;
      academic_year_id: string;
      school_id: string;
      school_name: string | null;
      rank_by_attendance: number | null;
      rank_by_performance: number | null;
      metrics: Record<string, unknown>;
      generated_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      organisationId: r.organisation_id,
      academicYearId: r.academic_year_id,
      schoolId: r.school_id,
      schoolName: r.school_name,
      rankByAttendance: r.rank_by_attendance === null ? null : Number(r.rank_by_attendance),
      rankByPerformance: r.rank_by_performance === null ? null : Number(r.rank_by_performance),
      metrics: r.metrics ?? {},
      generatedAt: r.generated_at,
    }));
  }

  /** ─── Wellbeing trends + aged debtors ────────────────────────── */

  async listWellbeingTrends(actor: ResolvedActor): Promise<WellbeingTrendsDto[]> {
    if (!(await this.isManager(actor))) {
      throw new ForbiddenException(
        'Wellbeing trends are restricted to school managers and admins.',
      );
    }
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text, school_id::text AS school_id, grade_level,
                period_start::text AS period_start, period_end::text AS period_end,
                avg_wellbeing_score, response_count, wants_to_talk_count, flagged_count,
                generated_at::text AS generated_at
         FROM rpt_wellbeing_trends WHERE school_id = $1::uuid
         ORDER BY period_end DESC, grade_level`,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      grade_level: string;
      period_start: string;
      period_end: string;
      avg_wellbeing_score: string | number | null;
      response_count: number;
      wants_to_talk_count: number;
      flagged_count: number;
      generated_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      gradeLevel: r.grade_level,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      avgWellbeingScore: r.avg_wellbeing_score === null ? null : Number(r.avg_wellbeing_score),
      responseCount: Number(r.response_count),
      wantsToTalkCount: Number(r.wants_to_talk_count),
      flaggedCount: Number(r.flagged_count),
      generatedAt: r.generated_at,
    }));
  }

  async listAgedDebtors(actor: ResolvedActor): Promise<AgedDebtorDto[]> {
    if (!(await this.isManager(actor))) {
      throw new ForbiddenException('Aged debtors report is restricted to managers and admins.');
    }
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT d.id::text, d.school_id::text AS school_id,
                d.family_account_id::text AS family_account_id,
                COALESCE(ip.first_name || ' ' || ip.last_name, fa.account_number) AS account_holder_name,
                d.total_outstanding, d.current_bucket, d.days_30, d.days_60, d.days_90_plus,
                d.last_payment_date::text AS last_payment_date, d.generated_at::text AS generated_at
         FROM rpt_fin_aged_debtors d
         LEFT JOIN pay_family_accounts fa ON fa.id = d.family_account_id
         LEFT JOIN platform.iam_person ip ON ip.id = fa.account_holder_id
         WHERE d.school_id = $1::uuid
         ORDER BY d.total_outstanding DESC`,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      family_account_id: string;
      account_holder_name: string | null;
      total_outstanding: string | number;
      current_bucket: string | number;
      days_30: string | number;
      days_60: string | number;
      days_90_plus: string | number;
      last_payment_date: string | null;
      generated_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      familyAccountId: r.family_account_id,
      accountHolderName: r.account_holder_name,
      totalOutstanding: Number(r.total_outstanding),
      currentBucket: Number(r.current_bucket),
      days30: Number(r.days_30),
      days60: Number(r.days_60),
      days90Plus: Number(r.days_90_plus),
      lastPaymentDate: r.last_payment_date,
      generatedAt: r.generated_at,
    }));
  }

  /** ─── At-risk students + configurations ──────────────────────── */

  async listAtRiskStudents(actor: ResolvedActor): Promise<AtRiskStudentDto[]> {
    if (!(await this.isManager(actor))) {
      throw new ForbiddenException('At-risk dashboard is restricted to managers and admins.');
    }
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT s.student_id::text AS student_id,
                ip.first_name || ' ' || ip.last_name AS student_name,
                st.grade_level, s.academic_year_id::text AS academic_year_id,
                s.current_gpa, s.attendance_rate, s.total_assignments, s.completed_assignments,
                s.at_risk_flags
         FROM rpt_student_academic_summary s
         LEFT JOIN sis_students st ON st.id = s.student_id
         LEFT JOIN platform.platform_students ps ON ps.id = st.platform_student_id
         LEFT JOIN platform.iam_person ip ON ip.id = ps.person_id
         WHERE s.school_id = $1::uuid AND s.at_risk_flags <> '{}'::jsonb
         ORDER BY s.current_gpa NULLS LAST, ip.last_name`,
        tenant.schoolId,
      );
    })) as Array<{
      student_id: string;
      student_name: string | null;
      grade_level: string | null;
      academic_year_id: string;
      current_gpa: string | number | null;
      attendance_rate: string | number | null;
      total_assignments: number;
      completed_assignments: number;
      at_risk_flags: Record<string, unknown>;
    }>;
    return rows.map((r) => ({
      studentId: r.student_id,
      studentName: r.student_name,
      gradeLevel: r.grade_level,
      academicYearId: r.academic_year_id,
      currentGpa: r.current_gpa === null ? null : Number(r.current_gpa),
      attendanceRate: r.attendance_rate === null ? null : Number(r.attendance_rate),
      totalAssignments: Number(r.total_assignments),
      completedAssignments: Number(r.completed_assignments),
      atRiskFlags: r.at_risk_flags ?? {},
      flaggedConfigs: Object.keys(r.at_risk_flags ?? {}),
    }));
  }

  async listAtRiskConfigs(actor: ResolvedActor): Promise<AtRiskConfigDto[]> {
    if (!(await this.isManager(actor))) {
      throw new ForbiddenException('At-risk configuration is restricted to managers and admins.');
    }
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text, school_id::text AS school_id, name, description,
                trigger_conditions, alert_recipients, is_active,
                created_by::text AS created_by, created_at::text AS created_at, updated_at::text AS updated_at
         FROM rpt_at_risk_configurations
         WHERE school_id = $1::uuid
         ORDER BY name`,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      name: string;
      description: string | null;
      trigger_conditions: Record<string, unknown>;
      alert_recipients: string[];
      is_active: boolean;
      created_by: string | null;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      name: r.name,
      description: r.description,
      triggerConditions: r.trigger_conditions ?? {},
      alertRecipients: r.alert_recipients ?? [],
      isActive: r.is_active,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async createAtRiskConfig(
    actor: ResolvedActor,
    input: CreateAtRiskConfigDto,
  ): Promise<AtRiskConfigDto> {
    if (!(await this.isManager(actor))) {
      throw new ForbiddenException('Only managers and admins may create at-risk configurations.');
    }
    // REVIEW-CYCLE29 BLOCKING 2 — validate trigger_conditions ranges
    const conditions = this.validateTriggerConditions(input.triggerConditions);
    // REVIEW-CYCLE29 BLOCKING 3 — every recipient must be in this tenant
    const recipients = input.alertRecipients ?? [];
    await this.assertAccountsInCurrentTenant(recipients, 'alertRecipients');

    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `INSERT INTO rpt_at_risk_configurations (id, school_id, name, description, trigger_conditions, alert_recipients, is_active, created_by)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::uuid[], $7, $8::uuid)`,
          id,
          tenant.schoolId,
          input.name,
          input.description ?? null,
          JSON.stringify(conditions),
          recipients,
          input.isActive ?? true,
          actor.accountId,
        );
      });
    } catch (err: unknown) {
      const e = err as { meta?: { code?: string }; code?: string };
      if (e.meta?.code === '23505' || e.code === 'P2002') {
        throw new BadRequestException(
          `An at-risk configuration named "${input.name}" already exists in this school.`,
        );
      }
      throw err;
    }
    const list = await this.listAtRiskConfigs(actor);
    const found = list.find((c) => c.id === id);
    if (!found) throw new NotFoundException('Configuration not found after create');
    return found;
  }

  async updateAtRiskConfig(
    actor: ResolvedActor,
    id: string,
    input: UpdateAtRiskConfigDto,
  ): Promise<AtRiskConfigDto> {
    if (!(await this.isManager(actor))) {
      throw new ForbiddenException('Only managers and admins may update at-risk configurations.');
    }
    const tenant = getCurrentTenant();
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (input.name !== undefined) {
      sets.push(`name = $${i++}`);
      params.push(input.name);
    }
    if (input.description !== undefined) {
      sets.push(`description = $${i++}`);
      params.push(input.description);
    }
    if (input.triggerConditions !== undefined) {
      // REVIEW-CYCLE29 BLOCKING 2 — validate before update
      const conditions = this.validateTriggerConditions(input.triggerConditions);
      sets.push(`trigger_conditions = $${i++}::jsonb`);
      params.push(JSON.stringify(conditions));
    }
    if (input.alertRecipients !== undefined) {
      // REVIEW-CYCLE29 BLOCKING 3 — validate recipients in current tenant
      await this.assertAccountsInCurrentTenant(input.alertRecipients, 'alertRecipients');
      sets.push(`alert_recipients = $${i++}::uuid[]`);
      params.push(input.alertRecipients);
    }
    if (input.isActive !== undefined) {
      sets.push(`is_active = $${i++}`);
      params.push(input.isActive);
    }
    if (sets.length === 0) {
      const list = await this.listAtRiskConfigs(actor);
      const found = list.find((c) => c.id === id);
      if (!found) throw new NotFoundException('Configuration not found');
      return found;
    }
    sets.push(`updated_at = now()`);
    const updated = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        `UPDATE rpt_at_risk_configurations SET ${sets.join(', ')} WHERE id = $${i}::uuid AND school_id = $${i + 1}::uuid`,
        ...params,
        id,
        tenant.schoolId,
      );
    })) as number;
    if (updated === 0) throw new NotFoundException('Configuration not found');
    const list = await this.listAtRiskConfigs(actor);
    const found = list.find((c) => c.id === id);
    if (!found) throw new NotFoundException('Configuration not found after update');
    return found;
  }

  /** ─── State report templates (read for Step 7's StateReportService) ── */

  async listStateReportTemplates(): Promise<StateReportTemplateDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text, state_code, report_type, schema_version, template_config,
                is_active, created_at::text AS created_at, updated_at::text AS updated_at
         FROM rpt_state_report_templates
         ORDER BY state_code, report_type`,
      );
    })) as Array<{
      id: string;
      state_code: string;
      report_type: string;
      schema_version: string;
      template_config: Record<string, unknown>;
      is_active: boolean;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      stateCode: r.state_code,
      reportType: r.report_type,
      schemaVersion: r.schema_version,
      templateConfig: r.template_config ?? {},
      isActive: r.is_active,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }
}
