import { Injectable, Logger } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { WorkerRunSummaryDto, WorkerStatusDto } from './dto/analytics.dto';

/**
 * Worker checkpoint helper. Records position per (consumer_group, topic,
 * partition) inside rpt_analytics_worker_checkpoints. The batch workers
 * in this cycle use synthetic offsets (the row count materialised in the
 * run) — the schema is set up for real Kafka offsets when consumer
 * wiring lands in Phase 2 per ADR-049.
 */
@Injectable()
export class CheckpointService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async record(
    consumerGroup: string,
    topic: string,
    partition: number,
    committedOffset: number,
    logEndOffset?: number,
  ): Promise<void> {
    const lag = logEndOffset !== undefined ? Math.max(logEndOffset - committedOffset, 0) : null;
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `INSERT INTO rpt_analytics_worker_checkpoints (id, consumer_group, topic, partition, committed_offset, log_end_offset, lag, recorded_at)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (consumer_group, topic, partition) DO UPDATE
           SET committed_offset = EXCLUDED.committed_offset,
               log_end_offset = EXCLUDED.log_end_offset,
               lag = EXCLUDED.lag,
               recorded_at = now()`,
        generateId(),
        consumerGroup,
        topic,
        partition,
        committedOffset,
        logEndOffset ?? null,
        lag,
      );
    });
  }

  async list(): Promise<WorkerStatusDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT consumer_group, topic, partition, committed_offset, log_end_offset, lag, recorded_at::text AS recorded_at
         FROM rpt_analytics_worker_checkpoints
         ORDER BY consumer_group, topic, partition`,
      );
    })) as Array<{
      consumer_group: string;
      topic: string;
      partition: number;
      committed_offset: bigint | string;
      log_end_offset: bigint | string | null;
      lag: bigint | string | null;
      recorded_at: string;
    }>;
    return rows.map((r) => ({
      consumerGroup: r.consumer_group,
      topic: r.topic,
      partition: Number(r.partition),
      committedOffset: Number(r.committed_offset),
      logEndOffset: r.log_end_offset === null ? null : Number(r.log_end_offset),
      lag: r.lag === null ? null : Number(r.lag),
      recordedAt: r.recorded_at,
    }));
  }
}

/**
 * SISReadModelWorker — materialises rpt_daily_attendance_summary +
 * rpt_student_academic_summary from operational tables. Idempotent
 * UPSERT on UNIQUE keys.
 *
 * Cycle 29 ships nightly batch materialisation only. Real Kafka consumer
 * wiring (subscribe to att.attendance.confirmed + cls.grade.published) is
 * Phase 2 per ADR-049. (P2-H3 Step 4 — stale comment said cls.grade.posted;
 * the canonical producer-side topic name is cls.grade.published, emitted
 * by GradeService.publish + batchPublish.)
 */
@Injectable()
export class SISReadModelWorker {
  private readonly logger = new Logger(SISReadModelWorker.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly checkpoints: CheckpointService,
  ) {}

  async materialise(asOfDate?: string): Promise<WorkerRunSummaryDto> {
    const start = Date.now();
    let rowsWritten = 0;
    try {
      const tenant = getCurrentTenant();
      const dateAnchor = asOfDate ?? new Date().toISOString().slice(0, 10);
      // Daily attendance: per (school, class, date) for the last 30 days
      // computed as PRESENT / TARDY / ABSENT_* groupings from
      // sis_attendance_records joined to sis_classes.
      const attendanceRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          `WITH d AS (
             SELECT $1::uuid AS school_id, ar.class_id, ar.date AS summary_date,
                    SUM(CASE WHEN ar.status='PRESENT' THEN 1 ELSE 0 END)::int AS present_count,
                    SUM(CASE WHEN ar.status IN ('ABSENT','ABSENT_EXCUSED','ABSENT_UNEXCUSED') THEN 1 ELSE 0 END)::int AS absent_count,
                    SUM(CASE WHEN ar.status IN ('TARDY','LATE') THEN 1 ELSE 0 END)::int AS late_count,
                    count(*)::int AS total_marked
             FROM sis_attendance_records ar
             JOIN sis_classes c ON c.id = ar.class_id
             WHERE ar.date >= ($2::date - INTERVAL '30 days')::date AND ar.date <= $2::date
             GROUP BY ar.class_id, ar.date
           )
           SELECT * FROM d`,
          tenant.schoolId,
          dateAnchor,
        );
      })) as Array<{
        school_id: string;
        class_id: string;
        summary_date: string;
        present_count: number;
        absent_count: number;
        late_count: number;
        total_marked: number;
      }>;

      for (const r of attendanceRows) {
        const total = Number(r.total_marked) || 0;
        const presentLike = Number(r.present_count) + Number(r.late_count);
        const rate = total > 0 ? Math.min(presentLike / total, 1) : null;
        await this.tenantPrisma.executeInTenantContext(async (client) => {
          await client.$executeRawUnsafe(
            `INSERT INTO rpt_daily_attendance_summary (id, school_id, class_id, summary_date, present_count, absent_count, late_count, total_enrolled, attendance_rate, generated_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6, $7, $8, $9::numeric, now())
             ON CONFLICT (school_id, class_id, summary_date) DO UPDATE
               SET present_count = EXCLUDED.present_count,
                   absent_count = EXCLUDED.absent_count,
                   late_count = EXCLUDED.late_count,
                   total_enrolled = EXCLUDED.total_enrolled,
                   attendance_rate = EXCLUDED.attendance_rate,
                   generated_at = now()`,
            generateId(),
            r.school_id,
            r.class_id,
            r.summary_date,
            r.present_count,
            r.absent_count,
            r.late_count,
            total,
            rate === null ? null : rate.toFixed(4),
          );
        });
        rowsWritten++;
      }

      // Student academic: per (student, current academic_year) — joins
      // cls_grades for GPA + sis_attendance_records for rate.
      const yearRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          `SELECT id::text AS id FROM sis_academic_years WHERE is_current = true LIMIT 1`,
        );
      })) as Array<{ id: string }>;
      if (yearRows.length === 0) {
        await this.checkpoints.record(
          'sis-readmodel-worker',
          'rpt_daily_attendance_summary',
          0,
          rowsWritten,
        );
        return {
          worker: 'sis',
          status: 'OK',
          rowsWritten,
          durationMs: Date.now() - start,
        };
      }
      const yearId = yearRows[0]!.id;

      const studentRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          `SELECT s.id::text AS student_id,
                  COALESCE(AVG(g.grade_value), AVG(g.grade_value))::numeric AS avg_score,
                  COALESCE(SUM(CASE WHEN sub.status = 'GRADED' THEN 1 ELSE 0 END), 0)::int AS completed_assignments,
                  COALESCE(COUNT(DISTINCT sub.id), 0)::int AS total_assignments,
                  (SELECT
                     CASE WHEN count(*) = 0 THEN NULL ELSE
                       (SUM(CASE WHEN ar.status IN ('PRESENT','TARDY','LATE') THEN 1 ELSE 0 END)::numeric / count(*))
                     END
                   FROM sis_attendance_records ar
                   WHERE ar.student_id = s.id
                     AND ar.date >= (CURRENT_DATE - INTERVAL '90 days')::date
                  ) AS attendance_rate
           FROM sis_students s
           LEFT JOIN cls_submissions sub ON sub.student_id = s.id
           LEFT JOIN cls_grades g ON g.submission_id = sub.id AND g.is_published = true
           GROUP BY s.id`,
        );
      })) as Array<{
        student_id: string;
        avg_score: string | number | null;
        completed_assignments: number;
        total_assignments: number;
        attendance_rate: string | number | null;
      }>;

      for (const r of studentRows) {
        // Convert raw % score to 4-point GPA (lossy; demo proxy):
        // 100=4.0, 90=3.6, 80=3.0, 70=2.0, 60=1.0, <60=0.5
        const avgScore = r.avg_score === null ? null : Number(r.avg_score);
        let gpa: number | null = null;
        if (avgScore !== null) {
          if (avgScore >= 90) gpa = 4.0;
          else if (avgScore >= 80) gpa = 3.0 + ((avgScore - 80) / 10) * 1.0;
          else if (avgScore >= 70) gpa = 2.0 + ((avgScore - 70) / 10) * 1.0;
          else if (avgScore >= 60) gpa = 1.0 + ((avgScore - 60) / 10) * 1.0;
          else gpa = Math.max(0, avgScore / 60);
        }
        const attendanceRate =
          r.attendance_rate === null ? null : Math.min(Number(r.attendance_rate), 1);
        await this.tenantPrisma.executeInTenantContext(async (client) => {
          await client.$executeRawUnsafe(
            `INSERT INTO rpt_student_academic_summary (id, student_id, academic_year_id, school_id, current_gpa, credits_earned, credits_attempted, attendance_rate, total_assignments, completed_assignments, at_risk_flags, generated_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9, $10, COALESCE((SELECT at_risk_flags FROM rpt_student_academic_summary WHERE student_id = $2::uuid AND academic_year_id = $3::uuid), '{}'::jsonb), now())
             ON CONFLICT (student_id, academic_year_id) DO UPDATE
               SET current_gpa = EXCLUDED.current_gpa,
                   credits_earned = EXCLUDED.credits_earned,
                   credits_attempted = EXCLUDED.credits_attempted,
                   attendance_rate = EXCLUDED.attendance_rate,
                   total_assignments = EXCLUDED.total_assignments,
                   completed_assignments = EXCLUDED.completed_assignments,
                   generated_at = now()`,
            generateId(),
            r.student_id,
            yearId,
            tenant.schoolId,
            gpa === null ? null : gpa.toFixed(3),
            gpa === null ? '0' : (gpa * 4).toFixed(1),
            '24',
            attendanceRate === null ? null : attendanceRate.toFixed(4),
            Number(r.total_assignments),
            Number(r.completed_assignments),
          );
        });
        rowsWritten++;
      }

      await this.checkpoints.record(
        'sis-readmodel-worker',
        'rpt_daily_attendance_summary',
        0,
        rowsWritten,
      );
      return { worker: 'sis', status: 'OK', rowsWritten, durationMs: Date.now() - start };
    } catch (err: unknown) {
      this.logger.error(`SISReadModelWorker failed: ${(err as Error).message}`);
      return {
        worker: 'sis',
        status: 'FAILED',
        rowsWritten,
        durationMs: Date.now() - start,
        errorMessage: (err as Error).message,
      };
    }
  }
}

/**
 * ClassroomReadModelWorker — materialises rpt_class_performance_summary
 * + rpt_staff_summary. Idempotent UPSERT on UNIQUE keys.
 */
@Injectable()
export class ClassroomReadModelWorker {
  private readonly logger = new Logger(ClassroomReadModelWorker.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly checkpoints: CheckpointService,
  ) {}

  async materialise(): Promise<WorkerRunSummaryDto> {
    const start = Date.now();
    let rowsWritten = 0;
    try {
      const tenant = getCurrentTenant();
      const yearRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          `SELECT y.id::text AS year_id, t.id::text AS term_id
           FROM sis_academic_years y
           LEFT JOIN sis_terms t ON t.academic_year_id = y.id
           WHERE y.is_current = true
           ORDER BY t.start_date
           LIMIT 1`,
        );
      })) as Array<{ year_id: string; term_id: string | null }>;
      if (yearRows.length === 0 || !yearRows[0]!.term_id) {
        return {
          worker: 'classroom',
          status: 'SKIPPED',
          rowsWritten: 0,
          durationMs: Date.now() - start,
        };
      }
      const termId = yearRows[0]!.term_id;
      const yearId = yearRows[0]!.year_id;

      const classRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          `SELECT c.id::text AS class_id,
                  AVG(g.grade_value)::numeric AS avg_grade,
                  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY g.grade_value)::numeric AS median_grade,
                  count(DISTINCT s.student_id)::int AS student_count,
                  COALESCE(
                    (SUM(CASE WHEN sub.status = 'GRADED' THEN 1 ELSE 0 END)::numeric)
                    / NULLIF(COUNT(DISTINCT sub.id), 0),
                    NULL
                  ) AS completion_rate,
                  jsonb_build_object(
                    'A', SUM(CASE WHEN g.grade_value >= 90 THEN 1 ELSE 0 END),
                    'B', SUM(CASE WHEN g.grade_value >= 80 AND g.grade_value < 90 THEN 1 ELSE 0 END),
                    'C', SUM(CASE WHEN g.grade_value >= 70 AND g.grade_value < 80 THEN 1 ELSE 0 END),
                    'D', SUM(CASE WHEN g.grade_value >= 60 AND g.grade_value < 70 THEN 1 ELSE 0 END),
                    'F', SUM(CASE WHEN g.grade_value < 60 THEN 1 ELSE 0 END)
                  ) AS grade_distribution
           FROM sis_classes c
           LEFT JOIN cls_assignments a ON a.class_id = c.id
           LEFT JOIN cls_submissions sub ON sub.assignment_id = a.id
           LEFT JOIN cls_grades g ON g.submission_id = sub.id AND g.is_published = true
           LEFT JOIN sis_enrollments s ON s.class_id = c.id AND s.status = 'ACTIVE'
           GROUP BY c.id`,
        );
      })) as Array<{
        class_id: string;
        avg_grade: string | number | null;
        median_grade: string | number | null;
        student_count: number;
        completion_rate: string | number | null;
        grade_distribution: Record<string, number>;
      }>;

      for (const r of classRows) {
        await this.tenantPrisma.executeInTenantContext(async (client) => {
          await client.$executeRawUnsafe(
            `INSERT INTO rpt_class_performance_summary (id, class_id, term_id, school_id, avg_grade, median_grade, grade_distribution, assignment_completion_rate, student_count, generated_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, $6::numeric, $7::jsonb, $8::numeric, $9, now())
             ON CONFLICT (class_id, term_id) DO UPDATE
               SET avg_grade = EXCLUDED.avg_grade,
                   median_grade = EXCLUDED.median_grade,
                   grade_distribution = EXCLUDED.grade_distribution,
                   assignment_completion_rate = EXCLUDED.assignment_completion_rate,
                   student_count = EXCLUDED.student_count,
                   generated_at = now()`,
            generateId(),
            r.class_id,
            termId,
            tenant.schoolId,
            r.avg_grade === null ? null : Number(r.avg_grade).toFixed(2),
            r.median_grade === null ? null : Number(r.median_grade).toFixed(2),
            JSON.stringify(r.grade_distribution ?? {}),
            r.completion_rate === null ? null : Number(r.completion_rate).toFixed(4),
            Number(r.student_count),
          );
        });
        rowsWritten++;
      }

      // Staff summary
      const staffRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          `SELECT e.id::text AS employee_id,
                  COUNT(DISTINCT ct.class_id)::int AS classes_taught,
                  COUNT(DISTINCT en.student_id)::int AS total_students,
                  COALESCE(SUM(lr.days_requested), 0)::numeric AS leave_days_taken
           FROM hr_employees e
           LEFT JOIN sis_class_teachers ct ON ct.teacher_employee_id = e.id
           LEFT JOIN sis_enrollments en ON en.class_id = ct.class_id AND en.status = 'ACTIVE'
           LEFT JOIN hr_leave_requests lr ON lr.employee_id = e.id AND lr.status = 'APPROVED'
           GROUP BY e.id`,
        );
      })) as Array<{
        employee_id: string;
        classes_taught: number;
        total_students: number;
        leave_days_taken: string | number;
      }>;

      for (const r of staffRows) {
        await this.tenantPrisma.executeInTenantContext(async (client) => {
          await client.$executeRawUnsafe(
            `INSERT INTO rpt_staff_summary (id, employee_id, academic_year_id, school_id, classes_taught, total_students, leave_days_taken, avg_class_performance, generated_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::numeric, NULL, now())
             ON CONFLICT (employee_id, academic_year_id) DO UPDATE
               SET classes_taught = EXCLUDED.classes_taught,
                   total_students = EXCLUDED.total_students,
                   leave_days_taken = EXCLUDED.leave_days_taken,
                   generated_at = now()`,
            generateId(),
            r.employee_id,
            yearId,
            tenant.schoolId,
            Number(r.classes_taught),
            Number(r.total_students),
            Number(r.leave_days_taken).toFixed(1),
          );
        });
        rowsWritten++;
      }

      await this.checkpoints.record(
        'classroom-readmodel-worker',
        'rpt_class_performance_summary',
        0,
        rowsWritten,
      );
      return { worker: 'classroom', status: 'OK', rowsWritten, durationMs: Date.now() - start };
    } catch (err: unknown) {
      this.logger.error(`ClassroomReadModelWorker failed: ${(err as Error).message}`);
      return {
        worker: 'classroom',
        status: 'FAILED',
        rowsWritten,
        durationMs: Date.now() - start,
        errorMessage: (err as Error).message,
      };
    }
  }
}

/**
 * AtRiskEvaluationWorker — evaluates active rpt_at_risk_configurations
 * against rpt_student_academic_summary. Sets at_risk_flags JSONB on
 * matching students. Emits rpt.at_risk.flagged for newly flagged
 * students (i.e. flag wasn't present before this run).
 */
@Injectable()
export class AtRiskEvaluationWorker {
  private readonly logger = new Logger(AtRiskEvaluationWorker.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly checkpoints: CheckpointService,
    private readonly kafka: KafkaProducerService,
  ) {}

  async evaluate(): Promise<WorkerRunSummaryDto> {
    const start = Date.now();
    let rowsWritten = 0;
    const newFlags: Array<{
      studentId: string;
      academicYearId: string;
      configId: string;
      configName: string;
      conditionsMatched: string[];
    }> = [];
    try {
      const tenant = getCurrentTenant();
      const configs = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          `SELECT id::text, name, trigger_conditions FROM rpt_at_risk_configurations
           WHERE school_id = $1::uuid AND is_active = true`,
          tenant.schoolId,
        );
      })) as Array<{ id: string; name: string; trigger_conditions: Record<string, unknown> }>;

      const students = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          `SELECT id::text AS row_id,
                  student_id::text AS student_id,
                  academic_year_id::text AS academic_year_id,
                  current_gpa, attendance_rate,
                  total_assignments, completed_assignments,
                  at_risk_flags
           FROM rpt_student_academic_summary
           WHERE school_id = $1::uuid`,
          tenant.schoolId,
        );
      })) as Array<{
        row_id: string;
        student_id: string;
        academic_year_id: string;
        current_gpa: string | number | null;
        attendance_rate: string | number | null;
        total_assignments: number;
        completed_assignments: number;
        at_risk_flags: Record<string, unknown>;
      }>;

      for (const stu of students) {
        const newFlagsForStudent: Record<
          string,
          { triggered_at: string; conditions_matched: string[] }
        > = {};
        for (const cfg of configs) {
          const cond = cfg.trigger_conditions ?? {};
          const matched: string[] = [];
          const attThreshold = cond.attendance_threshold as number | undefined;
          const gradeThreshold = cond.grade_threshold as number | undefined;
          const missedThreshold = cond.missed_assignments_threshold as number | undefined;
          if (attThreshold !== undefined && stu.attendance_rate !== null) {
            if (Number(stu.attendance_rate) < attThreshold)
              matched.push(`attendance<${attThreshold}`);
          }
          if (gradeThreshold !== undefined && stu.current_gpa !== null) {
            if (Number(stu.current_gpa) < gradeThreshold) matched.push(`gpa<${gradeThreshold}`);
          }
          if (missedThreshold !== undefined) {
            const missed = Number(stu.total_assignments) - Number(stu.completed_assignments);
            if (missed >= missedThreshold) matched.push(`missed_assignments>=${missedThreshold}`);
          }
          // AND of populated conditions: all must trip
          const populated = [
            attThreshold !== undefined,
            gradeThreshold !== undefined,
            missedThreshold !== undefined,
          ].filter(Boolean).length;
          if (populated > 0 && matched.length === populated) {
            newFlagsForStudent[cfg.name] = {
              triggered_at: new Date().toISOString(),
              conditions_matched: matched,
            };
            // Was this student flagged for this config before?
            const wasFlagged =
              stu.at_risk_flags &&
              Object.prototype.hasOwnProperty.call(stu.at_risk_flags, cfg.name);
            if (!wasFlagged) {
              newFlags.push({
                studentId: stu.student_id,
                academicYearId: stu.academic_year_id,
                configId: cfg.id,
                configName: cfg.name,
                conditionsMatched: matched,
              });
            }
          }
        }
        // UPDATE — overwrite at_risk_flags with the latest evaluation set
        await this.tenantPrisma.executeInTenantContext(async (client) => {
          await client.$executeRawUnsafe(
            `UPDATE rpt_student_academic_summary
             SET at_risk_flags = $1::jsonb, generated_at = now()
             WHERE id = $2::uuid`,
            JSON.stringify(newFlagsForStudent),
            stu.row_id,
          );
        });
        rowsWritten++;
      }

      // Emit AFTER tx commits — kafka best-effort outside
      for (const f of newFlags) {
        await this.kafka.emit({
          topic: 'rpt.at_risk.flagged',
          key: f.studentId,
          sourceModule: 'analytics',
          payload: {
            studentId: f.studentId,
            academicYearId: f.academicYearId,
            configId: f.configId,
            configName: f.configName,
            conditionsMatched: f.conditionsMatched,
            schoolId: tenant.schoolId,
            sourceRefId: f.studentId,
          },
        });
      }

      await this.checkpoints.record(
        'at-risk-evaluation-worker',
        'rpt_student_academic_summary',
        0,
        rowsWritten,
      );
      return {
        worker: 'at-risk',
        status: 'OK',
        rowsWritten,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      this.logger.error(`AtRiskEvaluationWorker failed: ${(err as Error).message}`);
      return {
        worker: 'at-risk',
        status: 'FAILED',
        rowsWritten,
        durationMs: Date.now() - start,
        errorMessage: (err as Error).message,
      };
    }
  }
}
