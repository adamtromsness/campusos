/*
  Cycle 29 Step 3 — District + Cross-Domain Read Models + Report Engine
  (M110 Analytics, ADR-008 / ADR-049 / ADR-050)

  Eight tables completing Wave 7's analytics surface:

  District-level dashboards (superintendent):
   - rpt_district_summary — per-(organisation, year) aggregate
   - rpt_district_school_comparison — per-(district, year, school)
     ranked rows for the comparison dashboard

  Cross-domain read models:
   - rpt_wellbeing_trends — Cycle 11.1 aggregation, NO individual ids
   - rpt_fin_aged_debtors — Cycle 6 outstanding balance buckets

  Report engine:
   - rpt_report_definitions — configurable report templates
   - rpt_report_runs — execution history, S3 output keys
   - rpt_state_report_templates — platform-seeded compliance templates
   - rpt_scheduled_reports — cron-driven scheduled delivery (the first
     cron-driven worker in CampusOS — ScheduledReportWorker)

  All cross-cycle refs are soft per ADR-001/020 (organisation_id,
  school_id, family_account_id, run_by, created_by). No cross-schema FKs.

  Splitter discipline: every comment is /* */ block (line comments
  starting with -- get filtered by the splitter when they precede a SQL
  statement that gets concatenated into the same chunk).
*/

CREATE TABLE IF NOT EXISTS rpt_district_summary (
  id UUID PRIMARY KEY,
  organisation_id UUID NOT NULL,
  academic_year_id UUID NOT NULL,
  school_count INT NOT NULL DEFAULT 0,
  total_enrolled INT NOT NULL DEFAULT 0,
  total_staff INT NOT NULL DEFAULT 0,
  avg_attendance_rate NUMERIC(5,4),
  avg_gpa NUMERIC(4,3),
  total_at_risk INT NOT NULL DEFAULT 0,
  total_incidents INT NOT NULL DEFAULT 0,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_district_school_count_chk CHECK (school_count >= 0),
  CONSTRAINT rpt_district_enrolled_chk CHECK (total_enrolled >= 0),
  CONSTRAINT rpt_district_staff_chk CHECK (total_staff >= 0),
  CONSTRAINT rpt_district_attendance_chk CHECK (avg_attendance_rate IS NULL OR (avg_attendance_rate >= 0 AND avg_attendance_rate <= 1)),
  CONSTRAINT rpt_district_gpa_chk CHECK (avg_gpa IS NULL OR (avg_gpa >= 0 AND avg_gpa <= 5)),
  CONSTRAINT rpt_district_at_risk_chk CHECK (total_at_risk >= 0),
  CONSTRAINT rpt_district_incidents_chk CHECK (total_incidents >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_district_summary_uq
  ON rpt_district_summary (organisation_id, academic_year_id);

COMMENT ON TABLE rpt_district_summary IS
  'Per-(organisation, academic_year) aggregate. Materialised by DistrictAnalyticsWorker nightly at 03:00 UTC after every school-level worker has completed.';


CREATE TABLE IF NOT EXISTS rpt_district_school_comparison (
  id UUID PRIMARY KEY,
  organisation_id UUID NOT NULL,
  academic_year_id UUID NOT NULL,
  school_id UUID NOT NULL,
  rank_by_attendance INT,
  rank_by_performance INT,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_district_comp_attendance_rank_chk CHECK (rank_by_attendance IS NULL OR rank_by_attendance > 0),
  CONSTRAINT rpt_district_comp_performance_rank_chk CHECK (rank_by_performance IS NULL OR rank_by_performance > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_district_comparison_uq
  ON rpt_district_school_comparison (organisation_id, academic_year_id, school_id);

CREATE INDEX IF NOT EXISTS rpt_district_comparison_attendance_rank_idx
  ON rpt_district_school_comparison (organisation_id, academic_year_id, rank_by_attendance);

COMMENT ON TABLE rpt_district_school_comparison IS
  'Per-(district, year, school) row for the superintendent comparison dashboard. Ranks computed within the district, not globally. metrics JSONB carries the underlying numbers (attendance_rate, avg_gpa, at_risk_count, etc.).';


CREATE TABLE IF NOT EXISTS rpt_wellbeing_trends (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  grade_level TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  avg_wellbeing_score NUMERIC(3,1),
  response_count INT NOT NULL DEFAULT 0,
  wants_to_talk_count INT NOT NULL DEFAULT 0,
  flagged_count INT NOT NULL DEFAULT 0,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_wellbeing_period_chk CHECK (period_end >= period_start),
  CONSTRAINT rpt_wellbeing_score_chk CHECK (avg_wellbeing_score IS NULL OR (avg_wellbeing_score >= 0 AND avg_wellbeing_score <= 10)),
  CONSTRAINT rpt_wellbeing_response_count_chk CHECK (response_count >= 0),
  CONSTRAINT rpt_wellbeing_wants_chk CHECK (wants_to_talk_count >= 0),
  CONSTRAINT rpt_wellbeing_flagged_chk CHECK (flagged_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_wellbeing_trends_uq
  ON rpt_wellbeing_trends (school_id, grade_level, period_start, period_end);

CREATE INDEX IF NOT EXISTS rpt_wellbeing_school_period_idx
  ON rpt_wellbeing_trends (school_id, period_end DESC);

COMMENT ON TABLE rpt_wellbeing_trends IS
  'Aggregated Cycle 11.1 wellbeing data per (school, grade, period). NO individual student identifiers — privacy-preserving rollup. WellbeingTrendsWorker materialises from svc_wellbeing_responses + svc_wellbeing_alerts.';


CREATE TABLE IF NOT EXISTS rpt_fin_aged_debtors (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  family_account_id UUID NOT NULL,
  total_outstanding NUMERIC(12,2) NOT NULL DEFAULT 0,
  current_bucket NUMERIC(12,2) NOT NULL DEFAULT 0,
  days_30 NUMERIC(12,2) NOT NULL DEFAULT 0,
  days_60 NUMERIC(12,2) NOT NULL DEFAULT 0,
  days_90_plus NUMERIC(12,2) NOT NULL DEFAULT 0,
  last_payment_date DATE,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_fin_aged_total_chk CHECK (total_outstanding >= 0),
  CONSTRAINT rpt_fin_aged_current_chk CHECK (current_bucket >= 0),
  CONSTRAINT rpt_fin_aged_30_chk CHECK (days_30 >= 0),
  CONSTRAINT rpt_fin_aged_60_chk CHECK (days_60 >= 0),
  CONSTRAINT rpt_fin_aged_90_chk CHECK (days_90_plus >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_fin_aged_debtors_uq
  ON rpt_fin_aged_debtors (school_id, family_account_id);

CREATE INDEX IF NOT EXISTS rpt_fin_aged_debtors_outstanding_idx
  ON rpt_fin_aged_debtors (school_id, total_outstanding DESC) WHERE total_outstanding > 0;

COMMENT ON TABLE rpt_fin_aged_debtors IS
  'Per-(school, family_account) aged-debtor buckets (current / 30d / 60d / 90d+). FinanceARWorker materialises from Cycle 6 pay_family_accounts + pay_ledger_entries. Soft family_account_id ref per ADR-001/020.';


CREATE TABLE IF NOT EXISTS rpt_report_definitions (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  report_type TEXT NOT NULL,
  template_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_state_report BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_report_definitions_uq
  ON rpt_report_definitions (school_id, name);

CREATE INDEX IF NOT EXISTS rpt_report_definitions_active_idx
  ON rpt_report_definitions (school_id) WHERE is_active = true;

COMMENT ON TABLE rpt_report_definitions IS
  'Configurable report templates. template_config JSONB carries data_source, filters, columns, grouping. ReportRunService renders the report by querying rpt_* tables per the template.';


CREATE TABLE IF NOT EXISTS rpt_report_runs (
  id UUID PRIMARY KEY,
  report_definition_id UUID NOT NULL REFERENCES rpt_report_definitions(id) ON DELETE CASCADE,
  run_by UUID,
  status TEXT NOT NULL DEFAULT 'PENDING',
  output_format TEXT NOT NULL DEFAULT 'CSV',
  output_s3_key TEXT,
  row_count INT,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_at TIMESTAMPTZ,
  CONSTRAINT rpt_report_runs_status_chk CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETE', 'FAILED')),
  CONSTRAINT rpt_report_runs_format_chk CHECK (output_format IN ('CSV', 'PDF', 'XLSX')),
  CONSTRAINT rpt_report_runs_row_count_chk CHECK (row_count IS NULL OR row_count >= 0)
);

CREATE INDEX IF NOT EXISTS rpt_report_runs_definition_idx
  ON rpt_report_runs (report_definition_id, started_at DESC);

CREATE INDEX IF NOT EXISTS rpt_report_runs_status_idx
  ON rpt_report_runs (status, started_at DESC) WHERE status IN ('PENDING', 'RUNNING');

COMMENT ON TABLE rpt_report_runs IS
  'Per-execution record. PENDING -> RUNNING -> COMPLETE/FAILED state machine. CASCADE on parent definition because a run without its template is unaddressable. output_s3_key is the presigned-download target.';


CREATE TABLE IF NOT EXISTS rpt_state_report_templates (
  id UUID PRIMARY KEY,
  state_code TEXT NOT NULL,
  report_type TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  template_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_state_report_templates_uq
  ON rpt_state_report_templates (state_code, report_type, schema_version);

CREATE INDEX IF NOT EXISTS rpt_state_report_templates_state_idx
  ON rpt_state_report_templates (state_code) WHERE is_active = true;

COMMENT ON TABLE rpt_state_report_templates IS
  'Platform-seeded state compliance report templates. schema_version tracks state DOE format revisions. StateReportService renders these per school.';


CREATE TABLE IF NOT EXISTS rpt_scheduled_reports (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  report_name TEXT NOT NULL,
  template_name TEXT NOT NULL,
  report_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  schedule_cron TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  delivery_channel TEXT NOT NULL DEFAULT 'EMAIL',
  recipient_ids UUID[] NOT NULL DEFAULT ARRAY[]::uuid[],
  output_format TEXT NOT NULL DEFAULT 'CSV',
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  last_run_status TEXT,
  next_run_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_scheduled_channel_chk CHECK (delivery_channel IN ('EMAIL', 'IN_APP', 'BOTH')),
  CONSTRAINT rpt_scheduled_format_chk CHECK (output_format IN ('CSV', 'PDF', 'XLSX')),
  CONSTRAINT rpt_scheduled_status_chk CHECK (last_run_status IS NULL OR last_run_status IN ('SUCCESS', 'FAILED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_scheduled_reports_uq
  ON rpt_scheduled_reports (school_id, report_name);

CREATE INDEX IF NOT EXISTS rpt_scheduled_reports_next_run_idx
  ON rpt_scheduled_reports (next_run_at) WHERE is_active = true;

COMMENT ON TABLE rpt_scheduled_reports IS
  'Cron-driven scheduled report delivery. ScheduledReportWorker polls WHERE next_run_at <= now() AND is_active=true — for each, runs the report via ReportRunService, computes next_run_at from schedule_cron, delivers via Cycle 14 NotificationConsumer. First cron-driven worker in CampusOS.';

COMMENT ON COLUMN rpt_scheduled_reports.schedule_cron IS
  'Standard 5-field cron expression. timezone column drives the cron evaluation (cron-parser library handles TZ math).';

COMMENT ON COLUMN rpt_scheduled_reports.recipient_ids IS
  'Array of platform_users.id soft refs. Cycle 14 NotificationQueueService.enqueue is called per recipient on successful run.';
