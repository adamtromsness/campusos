/*
  Cycle 29 Step 2 — Core Read Models Schema (M110 Analytics, ADR-008 CQRS-lite)

  Five school-day read models that drive the principal dashboard:

  - rpt_daily_attendance_summary — per-class per-day rollup of present /
    absent / late counts plus computed attendance_rate. UNIQUE per
    (school, class, date). Materialised by SISReadModelWorker.

  - rpt_student_academic_summary — per-student per-year snapshot of GPA,
    credits, attendance_rate, plus at_risk_flags JSONB. Current-year only.
    Materialised by SISReadModelWorker (joins cls_grades + sis_attendance).
    AtRiskEvaluationWorker writes to at_risk_flags after evaluating
    rpt_at_risk_configurations.

  - rpt_class_performance_summary — per-class per-term rollup of avg_grade,
    median_grade, grade distribution histogram (JSONB), assignment
    completion rate. Materialised by ClassroomReadModelWorker.

  - rpt_staff_summary — per-employee per-year rollup of classes_taught,
    total_students, leave_days_taken, avg_class_performance. Materialised
    from hr_leave_requests + cls_grades.

  - rpt_school_summary — per-school per-year aggregate of every metric
    above plus at_risk_count + incident_count. Materialised by
    SchoolSummaryWorker after the SIS + Classroom workers complete.

  All read models use UPSERT-on-UNIQUE-key pattern so worker re-runs are
  idempotent. school_id soft refs per ADR-001/020. No cross-schema FKs.
  Idempotent migration (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT
  EXISTS).
*/

CREATE TABLE IF NOT EXISTS rpt_daily_attendance_summary (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  class_id UUID NOT NULL,
  summary_date DATE NOT NULL,
  present_count INT NOT NULL DEFAULT 0,
  absent_count INT NOT NULL DEFAULT 0,
  late_count INT NOT NULL DEFAULT 0,
  total_enrolled INT NOT NULL DEFAULT 0,
  attendance_rate NUMERIC(5,4),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_daily_attendance_present_chk CHECK (present_count >= 0),
  CONSTRAINT rpt_daily_attendance_absent_chk CHECK (absent_count >= 0),
  CONSTRAINT rpt_daily_attendance_late_chk CHECK (late_count >= 0),
  CONSTRAINT rpt_daily_attendance_enrolled_chk CHECK (total_enrolled >= 0),
  CONSTRAINT rpt_daily_attendance_rate_chk CHECK (attendance_rate IS NULL OR (attendance_rate >= 0 AND attendance_rate <= 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_daily_attendance_uq
  ON rpt_daily_attendance_summary (school_id, class_id, summary_date);

CREATE INDEX IF NOT EXISTS rpt_daily_attendance_school_date_idx
  ON rpt_daily_attendance_summary (school_id, summary_date DESC);

COMMENT ON TABLE rpt_daily_attendance_summary IS
  'Per-(school, class, date) attendance rollup. UPSERT-by-UNIQUE-key idempotent for SISReadModelWorker re-runs. attendance_rate = (present + late) / total_enrolled when total_enrolled > 0, NULL otherwise.';


CREATE TABLE IF NOT EXISTS rpt_student_academic_summary (
  id UUID PRIMARY KEY,
  student_id UUID NOT NULL,
  academic_year_id UUID NOT NULL,
  school_id UUID NOT NULL,
  current_gpa NUMERIC(4,3),
  credits_earned NUMERIC(5,1) NOT NULL DEFAULT 0,
  credits_attempted NUMERIC(5,1) NOT NULL DEFAULT 0,
  attendance_rate NUMERIC(5,4),
  total_assignments INT NOT NULL DEFAULT 0,
  completed_assignments INT NOT NULL DEFAULT 0,
  at_risk_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_student_academic_gpa_chk CHECK (current_gpa IS NULL OR (current_gpa >= 0 AND current_gpa <= 5)),
  CONSTRAINT rpt_student_academic_credits_earned_chk CHECK (credits_earned >= 0),
  CONSTRAINT rpt_student_academic_credits_attempted_chk CHECK (credits_attempted >= 0),
  CONSTRAINT rpt_student_academic_rate_chk CHECK (attendance_rate IS NULL OR (attendance_rate >= 0 AND attendance_rate <= 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_student_academic_uq
  ON rpt_student_academic_summary (student_id, academic_year_id);

CREATE INDEX IF NOT EXISTS rpt_student_academic_school_idx
  ON rpt_student_academic_summary (school_id, academic_year_id);

CREATE INDEX IF NOT EXISTS rpt_student_academic_at_risk_idx
  ON rpt_student_academic_summary (school_id, academic_year_id) WHERE at_risk_flags <> '{}'::jsonb;

COMMENT ON TABLE rpt_student_academic_summary IS
  'Per-(student, year) academic snapshot. Current year only. at_risk_flags JSONB written by AtRiskEvaluationWorker after evaluating rpt_at_risk_configurations against current_gpa + attendance_rate + completed_assignments.';

COMMENT ON COLUMN rpt_student_academic_summary.at_risk_flags IS
  'JSONB map of risk_config_name -> {triggered_at, conditions_matched}. Empty when student not flagged. The partial INDEX on at_risk_flags <> ''{}'' accelerates the at-risk dashboard.';


CREATE TABLE IF NOT EXISTS rpt_class_performance_summary (
  id UUID PRIMARY KEY,
  class_id UUID NOT NULL,
  term_id UUID NOT NULL,
  school_id UUID NOT NULL,
  avg_grade NUMERIC(5,2),
  median_grade NUMERIC(5,2),
  grade_distribution JSONB NOT NULL DEFAULT '{}'::jsonb,
  assignment_completion_rate NUMERIC(5,4),
  student_count INT NOT NULL DEFAULT 0,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_class_perf_avg_chk CHECK (avg_grade IS NULL OR (avg_grade >= 0 AND avg_grade <= 100)),
  CONSTRAINT rpt_class_perf_median_chk CHECK (median_grade IS NULL OR (median_grade >= 0 AND median_grade <= 100)),
  CONSTRAINT rpt_class_perf_completion_chk CHECK (assignment_completion_rate IS NULL OR (assignment_completion_rate >= 0 AND assignment_completion_rate <= 1)),
  CONSTRAINT rpt_class_perf_student_count_chk CHECK (student_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_class_perf_uq
  ON rpt_class_performance_summary (class_id, term_id);

CREATE INDEX IF NOT EXISTS rpt_class_perf_school_idx
  ON rpt_class_performance_summary (school_id, term_id);

COMMENT ON TABLE rpt_class_performance_summary IS
  'Per-(class, term) rollup. grade_distribution JSONB shape: {"A": int, "B": int, "C": int, "D": int, "F": int}. Materialised by ClassroomReadModelWorker from cls_grades.';


CREATE TABLE IF NOT EXISTS rpt_staff_summary (
  id UUID PRIMARY KEY,
  employee_id UUID NOT NULL,
  academic_year_id UUID NOT NULL,
  school_id UUID NOT NULL,
  classes_taught INT NOT NULL DEFAULT 0,
  total_students INT NOT NULL DEFAULT 0,
  leave_days_taken NUMERIC(5,1) NOT NULL DEFAULT 0,
  avg_class_performance NUMERIC(5,2),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_staff_classes_chk CHECK (classes_taught >= 0),
  CONSTRAINT rpt_staff_students_chk CHECK (total_students >= 0),
  CONSTRAINT rpt_staff_leave_chk CHECK (leave_days_taken >= 0),
  CONSTRAINT rpt_staff_avg_chk CHECK (avg_class_performance IS NULL OR (avg_class_performance >= 0 AND avg_class_performance <= 100))
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_staff_summary_uq
  ON rpt_staff_summary (employee_id, academic_year_id);

CREATE INDEX IF NOT EXISTS rpt_staff_summary_school_idx
  ON rpt_staff_summary (school_id, academic_year_id);

COMMENT ON TABLE rpt_staff_summary IS
  'Per-(employee, year) workload snapshot. Materialised from hr_leave_requests + cls_grades + sis_class_teachers join. UPSERT idempotent.';


CREATE TABLE IF NOT EXISTS rpt_school_summary (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  academic_year_id UUID NOT NULL,
  total_enrolled INT NOT NULL DEFAULT 0,
  total_staff INT NOT NULL DEFAULT 0,
  avg_attendance_rate NUMERIC(5,4),
  avg_gpa NUMERIC(4,3),
  at_risk_count INT NOT NULL DEFAULT 0,
  incident_count INT NOT NULL DEFAULT 0,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_school_enrolled_chk CHECK (total_enrolled >= 0),
  CONSTRAINT rpt_school_staff_chk CHECK (total_staff >= 0),
  CONSTRAINT rpt_school_attendance_chk CHECK (avg_attendance_rate IS NULL OR (avg_attendance_rate >= 0 AND avg_attendance_rate <= 1)),
  CONSTRAINT rpt_school_gpa_chk CHECK (avg_gpa IS NULL OR (avg_gpa >= 0 AND avg_gpa <= 5)),
  CONSTRAINT rpt_school_at_risk_chk CHECK (at_risk_count >= 0),
  CONSTRAINT rpt_school_incident_chk CHECK (incident_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_school_summary_uq
  ON rpt_school_summary (school_id, academic_year_id);

COMMENT ON TABLE rpt_school_summary IS
  'Per-(school, year) aggregate dashboard. Materialised nightly by SchoolSummaryWorker. The principal sees this at-a-glance on the Analytics dashboard.';
