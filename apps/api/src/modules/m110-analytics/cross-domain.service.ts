import { Injectable, Logger } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { WorkerRunSummaryDto } from './dto/analytics.dto';
import { CheckpointService } from './workers.service';

/**
 * SchoolSummaryWorker — aggregates per-school totals from
 * rpt_daily_attendance_summary + rpt_student_academic_summary +
 * sis_discipline_incidents + hr_employees. UPSERT idempotent on
 * (school_id, academic_year_id).
 */
@Injectable()
export class SchoolSummaryWorker {
  private readonly logger = new Logger(SchoolSummaryWorker.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly checkpoints: CheckpointService,
  ) {}

  async materialise(): Promise<WorkerRunSummaryDto> {
    const start = Date.now();
    try {
      const tenant = getCurrentTenant();
      const yearRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          `SELECT id::text FROM sis_academic_years WHERE is_current = true LIMIT 1`,
        );
      })) as Array<{ id: string }>;
      if (yearRows.length === 0) {
        return {
          worker: 'school-summary',
          status: 'SKIPPED',
          rowsWritten: 0,
          durationMs: Date.now() - start,
        };
      }
      const yearId = yearRows[0]!.id;

      const aggRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          `SELECT
             (SELECT COUNT(*)::int FROM sis_enrollments WHERE status='ACTIVE') AS total_enrolled,
             (SELECT COUNT(*)::int FROM hr_employees WHERE employment_status IN ('ACTIVE','ON_LEAVE')) AS total_staff,
             (SELECT AVG(attendance_rate) FROM rpt_daily_attendance_summary WHERE school_id = $1::uuid AND summary_date >= (CURRENT_DATE - INTERVAL '30 days')::date) AS avg_attendance_rate,
             (SELECT AVG(current_gpa) FROM rpt_student_academic_summary WHERE school_id = $1::uuid AND current_gpa IS NOT NULL) AS avg_gpa,
             (SELECT COUNT(*)::int FROM rpt_student_academic_summary WHERE school_id = $1::uuid AND at_risk_flags <> '{}'::jsonb) AS at_risk_count,
             (SELECT COUNT(*)::int FROM sis_discipline_incidents WHERE incident_date >= (CURRENT_DATE - INTERVAL '90 days')::date) AS incident_count`,
          tenant.schoolId,
        );
      })) as Array<{
        total_enrolled: number;
        total_staff: number;
        avg_attendance_rate: string | number | null;
        avg_gpa: string | number | null;
        at_risk_count: number;
        incident_count: number;
      }>;
      const a = aggRows[0]!;
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `INSERT INTO rpt_school_summary (id, school_id, academic_year_id, total_enrolled, total_staff, avg_attendance_rate, avg_gpa, at_risk_count, incident_count, generated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::numeric, $7::numeric, $8, $9, now())
           ON CONFLICT (school_id, academic_year_id) DO UPDATE
             SET total_enrolled = EXCLUDED.total_enrolled,
                 total_staff = EXCLUDED.total_staff,
                 avg_attendance_rate = EXCLUDED.avg_attendance_rate,
                 avg_gpa = EXCLUDED.avg_gpa,
                 at_risk_count = EXCLUDED.at_risk_count,
                 incident_count = EXCLUDED.incident_count,
                 generated_at = now()`,
          generateId(),
          tenant.schoolId,
          yearId,
          Number(a.total_enrolled),
          Number(a.total_staff),
          a.avg_attendance_rate === null ? null : Number(a.avg_attendance_rate).toFixed(4),
          a.avg_gpa === null ? null : Number(a.avg_gpa).toFixed(3),
          Number(a.at_risk_count),
          Number(a.incident_count),
        );
      });
      await this.checkpoints.record('school-summary-worker', 'rpt_school_summary', 0, 1);
      return {
        worker: 'school-summary',
        status: 'OK',
        rowsWritten: 1,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      this.logger.error(`SchoolSummaryWorker failed: ${(err as Error).message}`);
      return {
        worker: 'school-summary',
        status: 'FAILED',
        rowsWritten: 0,
        durationMs: Date.now() - start,
        errorMessage: (err as Error).message,
      };
    }
  }
}

/**
 * DistrictAnalyticsWorker — aggregates rpt_school_summary across all
 * schools in the organisation into rpt_district_summary +
 * rpt_district_school_comparison with rankings. Runs nightly at
 * 03:00 UTC after every school-level worker.
 *
 * For the demo tenant there's a single school, but the worker supports
 * multi-school orgs by joining platform.schools per organisation_id.
 */
@Injectable()
export class DistrictAnalyticsWorker {
  private readonly logger = new Logger(DistrictAnalyticsWorker.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly checkpoints: CheckpointService,
  ) {}

  async materialise(): Promise<WorkerRunSummaryDto> {
    const start = Date.now();
    try {
      const tenant = getCurrentTenant();
      const orgRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          `SELECT organisation_id::text AS organisation_id FROM platform.schools WHERE id = $1::uuid LIMIT 1`,
          tenant.schoolId,
        );
      })) as Array<{ organisation_id: string }>;
      if (orgRows.length === 0) {
        return {
          worker: 'district',
          status: 'SKIPPED',
          rowsWritten: 0,
          durationMs: Date.now() - start,
        };
      }
      const organisationId = orgRows[0]!.organisation_id;

      const yearRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          `SELECT id::text FROM sis_academic_years WHERE is_current = true LIMIT 1`,
        );
      })) as Array<{ id: string }>;
      if (yearRows.length === 0) {
        return {
          worker: 'district',
          status: 'SKIPPED',
          rowsWritten: 0,
          durationMs: Date.now() - start,
        };
      }
      const yearId = yearRows[0]!.id;

      const summaries = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          `SELECT s.school_id::text AS school_id, s.total_enrolled, s.total_staff,
                  s.avg_attendance_rate, s.avg_gpa, s.at_risk_count, s.incident_count
           FROM rpt_school_summary s
           WHERE s.academic_year_id = $1::uuid`,
          yearId,
        );
      })) as Array<{
        school_id: string;
        total_enrolled: number;
        total_staff: number;
        avg_attendance_rate: string | number | null;
        avg_gpa: string | number | null;
        at_risk_count: number;
        incident_count: number;
      }>;

      const totalEnrolled = summaries.reduce((acc, s) => acc + Number(s.total_enrolled), 0);
      const totalStaff = summaries.reduce((acc, s) => acc + Number(s.total_staff), 0);
      const totalAtRisk = summaries.reduce((acc, s) => acc + Number(s.at_risk_count), 0);
      const totalIncidents = summaries.reduce((acc, s) => acc + Number(s.incident_count), 0);
      const attendanceVals = summaries
        .map((s) => (s.avg_attendance_rate === null ? null : Number(s.avg_attendance_rate)))
        .filter((v): v is number => v !== null);
      const gpaVals = summaries
        .map((s) => (s.avg_gpa === null ? null : Number(s.avg_gpa)))
        .filter((v): v is number => v !== null);
      const avgAttendance =
        attendanceVals.length === 0
          ? null
          : attendanceVals.reduce((a, b) => a + b, 0) / attendanceVals.length;
      const avgGpa =
        gpaVals.length === 0 ? null : gpaVals.reduce((a, b) => a + b, 0) / gpaVals.length;

      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `INSERT INTO rpt_district_summary (id, organisation_id, academic_year_id, school_count, total_enrolled, total_staff, avg_attendance_rate, avg_gpa, total_at_risk, total_incidents, generated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::numeric, $8::numeric, $9, $10, now())
           ON CONFLICT (organisation_id, academic_year_id) DO UPDATE
             SET school_count = EXCLUDED.school_count,
                 total_enrolled = EXCLUDED.total_enrolled,
                 total_staff = EXCLUDED.total_staff,
                 avg_attendance_rate = EXCLUDED.avg_attendance_rate,
                 avg_gpa = EXCLUDED.avg_gpa,
                 total_at_risk = EXCLUDED.total_at_risk,
                 total_incidents = EXCLUDED.total_incidents,
                 generated_at = now()`,
          generateId(),
          organisationId,
          yearId,
          summaries.length,
          totalEnrolled,
          totalStaff,
          avgAttendance === null ? null : avgAttendance.toFixed(4),
          avgGpa === null ? null : avgGpa.toFixed(3),
          totalAtRisk,
          totalIncidents,
        );
      });

      // Compute ranks per metric
      const byAttendance = [...summaries].sort(
        (a, b) =>
          (b.avg_attendance_rate === null ? -1 : Number(b.avg_attendance_rate)) -
          (a.avg_attendance_rate === null ? -1 : Number(a.avg_attendance_rate)),
      );
      const byGpa = [...summaries].sort(
        (a, b) =>
          (b.avg_gpa === null ? -1 : Number(b.avg_gpa)) -
          (a.avg_gpa === null ? -1 : Number(a.avg_gpa)),
      );
      const attendanceRank = new Map<string, number>(
        byAttendance.map((s, i) => [s.school_id, i + 1]),
      );
      const gpaRank = new Map<string, number>(byGpa.map((s, i) => [s.school_id, i + 1]));

      let comparisonRows = 0;
      for (const s of summaries) {
        await this.tenantPrisma.executeInTenantContext(async (client) => {
          await client.$executeRawUnsafe(
            `INSERT INTO rpt_district_school_comparison (id, organisation_id, academic_year_id, school_id, rank_by_attendance, rank_by_performance, metrics, generated_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::jsonb, now())
             ON CONFLICT (organisation_id, academic_year_id, school_id) DO UPDATE
               SET rank_by_attendance = EXCLUDED.rank_by_attendance,
                   rank_by_performance = EXCLUDED.rank_by_performance,
                   metrics = EXCLUDED.metrics,
                   generated_at = now()`,
            generateId(),
            organisationId,
            yearId,
            s.school_id,
            attendanceRank.get(s.school_id) ?? null,
            gpaRank.get(s.school_id) ?? null,
            JSON.stringify({
              attendance_rate:
                s.avg_attendance_rate === null ? null : Number(s.avg_attendance_rate),
              avg_gpa: s.avg_gpa === null ? null : Number(s.avg_gpa),
              at_risk_count: Number(s.at_risk_count),
              incident_count: Number(s.incident_count),
            }),
          );
        });
        comparisonRows++;
      }

      await this.checkpoints.record(
        'district-analytics-worker',
        'rpt_district_summary',
        0,
        comparisonRows + 1,
      );
      return {
        worker: 'district',
        status: 'OK',
        rowsWritten: comparisonRows + 1,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      this.logger.error(`DistrictAnalyticsWorker failed: ${(err as Error).message}`);
      return {
        worker: 'district',
        status: 'FAILED',
        rowsWritten: 0,
        durationMs: Date.now() - start,
        errorMessage: (err as Error).message,
      };
    }
  }
}

/**
 * WellbeingTrendsWorker — aggregates Cycle 11.1 wellbeing data per
 * (school, grade, period). NO individual student identifiers in the
 * output. Schema enforces this via the rpt_wellbeing_trends columns
 * (no student_id field).
 */
@Injectable()
export class WellbeingTrendsWorker {
  private readonly logger = new Logger(WellbeingTrendsWorker.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly checkpoints: CheckpointService,
  ) {}

  async materialise(periodStart?: string, periodEnd?: string): Promise<WorkerRunSummaryDto> {
    const start = Date.now();
    try {
      const tenant = getCurrentTenant();
      const today = new Date();
      const ps =
        periodStart ??
        new Date(today.getFullYear(), today.getMonth() - 1, 1).toISOString().slice(0, 10);
      const pe =
        periodEnd ?? new Date(today.getFullYear(), today.getMonth(), 0).toISOString().slice(0, 10);

      // Aggregate per (grade_level, period) — joins through
      // svc_wellbeing_responses + sis_students for grade. NO individual
      // ids retained. If the wellbeing tables aren't present in this
      // tenant the worker returns SKIPPED.
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          `SELECT st.grade_level,
                  COUNT(DISTINCT c.id)::int AS response_count,
                  AVG(r.numeric_response)::numeric AS avg_score,
                  SUM(CASE WHEN r.numeric_response = 1 AND q.domain = 'SAFETY' THEN 1 ELSE 0 END)::int AS wants_to_talk_count,
                  COUNT(DISTINCT a.id)::int AS flagged_count
           FROM svc_wellbeing_checkins c
           JOIN sis_students st ON st.id = c.student_id
           LEFT JOIN svc_wellbeing_responses r ON r.checkin_id = c.id
           LEFT JOIN svc_wellbeing_questions q ON q.id = r.question_id
           LEFT JOIN svc_wellbeing_alerts a ON a.response_id = r.id
           WHERE c.completed_at IS NOT NULL
             AND c.completed_at::date >= $1::date AND c.completed_at::date <= $2::date
           GROUP BY st.grade_level`,
          ps,
          pe,
        );
      })) as Array<{
        grade_level: string;
        response_count: number;
        avg_score: string | number | null;
        wants_to_talk_count: number;
        flagged_count: number;
      }>;

      let written = 0;
      for (const r of rows) {
        if (!r.grade_level) continue;
        await this.tenantPrisma.executeInTenantContext(async (client) => {
          await client.$executeRawUnsafe(
            `INSERT INTO rpt_wellbeing_trends (id, school_id, grade_level, period_start, period_end, avg_wellbeing_score, response_count, wants_to_talk_count, flagged_count, generated_at)
             VALUES ($1::uuid, $2::uuid, $3, $4::date, $5::date, $6::numeric, $7, $8, $9, now())
             ON CONFLICT (school_id, grade_level, period_start, period_end) DO UPDATE
               SET avg_wellbeing_score = EXCLUDED.avg_wellbeing_score,
                   response_count = EXCLUDED.response_count,
                   wants_to_talk_count = EXCLUDED.wants_to_talk_count,
                   flagged_count = EXCLUDED.flagged_count,
                   generated_at = now()`,
            generateId(),
            tenant.schoolId,
            r.grade_level,
            ps,
            pe,
            r.avg_score === null ? null : Number(r.avg_score).toFixed(1),
            Number(r.response_count),
            Number(r.wants_to_talk_count),
            Number(r.flagged_count),
          );
        });
        written++;
      }

      await this.checkpoints.record('wellbeing-trends-worker', 'rpt_wellbeing_trends', 0, written);
      return {
        worker: 'wellbeing',
        status: 'OK',
        rowsWritten: written,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      this.logger.error(`WellbeingTrendsWorker failed: ${(err as Error).message}`);
      return {
        worker: 'wellbeing',
        status: 'FAILED',
        rowsWritten: 0,
        durationMs: Date.now() - start,
        errorMessage: (err as Error).message,
      };
    }
  }
}

/**
 * FinanceARWorker — reads pay_family_accounts + pay_ledger_entries
 * (Cycle 6) and computes aged-debtor buckets per family account.
 * Idempotent UPSERT on (school_id, family_account_id).
 */
@Injectable()
export class FinanceARWorker {
  private readonly logger = new Logger(FinanceARWorker.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly checkpoints: CheckpointService,
  ) {}

  async materialise(): Promise<WorkerRunSummaryDto> {
    const start = Date.now();
    try {
      const tenant = getCurrentTenant();
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          `WITH unpaid_invoices AS (
             SELECT i.family_account_id,
                    i.id AS invoice_id,
                    i.due_date,
                    (i.total_amount - COALESCE((
                       SELECT SUM(p.amount) FROM pay_payments p
                       WHERE p.invoice_id = i.id AND p.status IN ('COMPLETED','REFUNDED')
                     ), 0)
                     + COALESCE((
                       SELECT SUM(rf.amount) FROM pay_refunds rf
                       JOIN pay_payments rp ON rp.id = rf.payment_id
                       WHERE rp.invoice_id = i.id AND rf.status = 'COMPLETED'
                     ), 0)
                    ) AS balance
             FROM pay_invoices i
             WHERE i.status NOT IN ('PAID','CANCELLED','DRAFT')
           ),
           buckets AS (
             SELECT family_account_id,
                    SUM(GREATEST(balance, 0)) AS total_outstanding,
                    SUM(CASE WHEN (CURRENT_DATE - due_date) <= 0 THEN GREATEST(balance, 0) ELSE 0 END) AS current_bucket,
                    SUM(CASE WHEN (CURRENT_DATE - due_date) BETWEEN 1 AND 30 THEN GREATEST(balance, 0) ELSE 0 END) AS days_30,
                    SUM(CASE WHEN (CURRENT_DATE - due_date) BETWEEN 31 AND 60 THEN GREATEST(balance, 0) ELSE 0 END) AS days_60,
                    SUM(CASE WHEN (CURRENT_DATE - due_date) > 60 THEN GREATEST(balance, 0) ELSE 0 END) AS days_90_plus
             FROM unpaid_invoices
             GROUP BY family_account_id
           )
           SELECT b.family_account_id::text AS family_account_id,
                  COALESCE(b.total_outstanding, 0)::numeric AS total_outstanding,
                  COALESCE(b.current_bucket, 0)::numeric AS current_bucket,
                  COALESCE(b.days_30, 0)::numeric AS days_30,
                  COALESCE(b.days_60, 0)::numeric AS days_60,
                  COALESCE(b.days_90_plus, 0)::numeric AS days_90_plus,
                  (SELECT MAX(p.created_at::date) FROM pay_payments p WHERE p.family_account_id = b.family_account_id AND p.status IN ('COMPLETED','REFUNDED'))::text AS last_payment_date
           FROM buckets b`,
        );
      })) as Array<{
        family_account_id: string;
        total_outstanding: string | number;
        current_bucket: string | number;
        days_30: string | number;
        days_60: string | number;
        days_90_plus: string | number;
        last_payment_date: string | null;
      }>;

      let written = 0;
      for (const r of rows) {
        await this.tenantPrisma.executeInTenantContext(async (client) => {
          await client.$executeRawUnsafe(
            `INSERT INTO rpt_fin_aged_debtors (id, school_id, family_account_id, total_outstanding, current_bucket, days_30, days_60, days_90_plus, last_payment_date, generated_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::numeric, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9::date, now())
             ON CONFLICT (school_id, family_account_id) DO UPDATE
               SET total_outstanding = EXCLUDED.total_outstanding,
                   current_bucket = EXCLUDED.current_bucket,
                   days_30 = EXCLUDED.days_30,
                   days_60 = EXCLUDED.days_60,
                   days_90_plus = EXCLUDED.days_90_plus,
                   last_payment_date = EXCLUDED.last_payment_date,
                   generated_at = now()`,
            generateId(),
            tenant.schoolId,
            r.family_account_id,
            Number(r.total_outstanding).toFixed(2),
            Number(r.current_bucket).toFixed(2),
            Number(r.days_30).toFixed(2),
            Number(r.days_60).toFixed(2),
            Number(r.days_90_plus).toFixed(2),
            r.last_payment_date,
          );
        });
        written++;
      }

      await this.checkpoints.record('finance-ar-worker', 'rpt_fin_aged_debtors', 0, written);
      return {
        worker: 'finance-ar',
        status: 'OK',
        rowsWritten: written,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      this.logger.error(`FinanceARWorker failed: ${(err as Error).message}`);
      return {
        worker: 'finance-ar',
        status: 'FAILED',
        rowsWritten: 0,
        durationMs: Date.now() - start,
        errorMessage: (err as Error).message,
      };
    }
  }
}
