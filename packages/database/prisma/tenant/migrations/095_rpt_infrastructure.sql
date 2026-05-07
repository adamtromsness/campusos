/*
  Cycle 29 Step 1 — Analytics Infrastructure Schema (M110 Analytics, ADR-008 / ADR-049)

  Three foundation tables for the read-model layer:

  - rpt_analytics_worker_checkpoints — Kafka offset positions per consumer
    group, topic, partition. Tracks committed_offset + log_end_offset + lag.
    Worker recovery uses these offsets, never timestamps (timestamps drift
    on replay).

  - rpt_at_risk_configurations — per-school configurable at-risk thresholds.
    trigger_conditions JSONB carries schema-flexible rules (attendance,
    grade, missed assignments, behaviour incidents). AtRiskEvaluationWorker
    walks these against rpt_student_academic_summary nightly.

  - rpt_rebuild_snapshots — frozen aggregate state per (read_model, school,
    snapshot_date) plus per-topic-partition Kafka offsets at snapshot time.
    Enables FROM_SNAPSHOT rebuild — start from snapshot then replay events
    from the recorded offsets. SLA for FROM_SNAPSHOT rebuild is under 10
    minutes vs hours for full replay.

  No cross-schema FKs. school_id is a soft ref to platform.schools per
  ADR-001/020. Idempotent: CREATE TABLE IF NOT EXISTS throughout.
*/

CREATE TABLE IF NOT EXISTS rpt_analytics_worker_checkpoints (
  id UUID PRIMARY KEY,
  consumer_group TEXT NOT NULL,
  topic TEXT NOT NULL,
  partition INT NOT NULL,
  committed_offset BIGINT NOT NULL,
  log_end_offset BIGINT,
  lag BIGINT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_checkpoints_partition_chk CHECK (partition >= 0),
  CONSTRAINT rpt_checkpoints_offset_chk CHECK (committed_offset >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_checkpoints_uq
  ON rpt_analytics_worker_checkpoints (consumer_group, topic, partition);

CREATE INDEX IF NOT EXISTS rpt_checkpoints_recorded_idx
  ON rpt_analytics_worker_checkpoints (recorded_at DESC);

COMMENT ON TABLE rpt_analytics_worker_checkpoints IS
  'Kafka offset checkpoints per analytics worker consumer group. Authoritative position is committed_offset, never timestamp. UNIQUE(consumer_group, topic, partition).';

COMMENT ON COLUMN rpt_analytics_worker_checkpoints.lag IS
  'log_end_offset - committed_offset, denormalised for monitoring queries.';


CREATE TABLE IF NOT EXISTS rpt_at_risk_configurations (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  trigger_conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
  alert_recipients UUID[] NOT NULL DEFAULT ARRAY[]::uuid[],
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_at_risk_config_school_name_uq
  ON rpt_at_risk_configurations (school_id, name);

CREATE INDEX IF NOT EXISTS rpt_at_risk_config_school_active_idx
  ON rpt_at_risk_configurations (school_id) WHERE is_active = true;

COMMENT ON TABLE rpt_at_risk_configurations IS
  'Per-school configurable at-risk thresholds. trigger_conditions JSONB carries the rule set (attendance_threshold, grade_threshold, etc.). AtRiskEvaluationWorker evaluates active configs nightly.';

COMMENT ON COLUMN rpt_at_risk_configurations.trigger_conditions IS
  'JSONB: {attendance_threshold, grade_threshold, missed_assignments_threshold, behaviour_incident_threshold} — all optional. Worker evaluates as AND of populated fields.';

COMMENT ON COLUMN rpt_at_risk_configurations.alert_recipients IS
  'Array of platform_users.id soft refs per ADR-001/020. Cycle 14 NotificationConsumer fans out rpt.at_risk.flagged to these recipients.';


CREATE TABLE IF NOT EXISTS rpt_rebuild_snapshots (
  id UUID PRIMARY KEY,
  read_model_name TEXT NOT NULL,
  school_id UUID,
  snapshot_date DATE NOT NULL,
  snapshot_data JSONB NOT NULL,
  kafka_offsets JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_count INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_rebuild_snapshots_uq
  ON rpt_rebuild_snapshots (read_model_name, COALESCE(school_id, '00000000-0000-0000-0000-000000000000'::uuid), snapshot_date);

CREATE INDEX IF NOT EXISTS rpt_rebuild_snapshots_school_idx
  ON rpt_rebuild_snapshots (school_id, snapshot_date DESC) WHERE school_id IS NOT NULL;

COMMENT ON TABLE rpt_rebuild_snapshots IS
  'ADR-049 incremental rebuild snapshots. snapshot_data JSONB stores frozen aggregate state. kafka_offsets JSONB stores per-topic-partition offsets at snapshot time. FROM_SNAPSHOT rebuild = restore snapshot + replay events from the recorded offsets. SLA under 10 minutes.';

COMMENT ON COLUMN rpt_rebuild_snapshots.school_id IS
  'NULL for cross-school read models like rpt_district_summary. The COALESCE-sentinel UNIQUE keeps a NULL-school row + a specific-school row coexisting on the same (read_model, snapshot_date).';
