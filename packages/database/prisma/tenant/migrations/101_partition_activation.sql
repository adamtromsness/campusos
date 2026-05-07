/*
  Cycle 31 Step 5 — Partition Activation (worked example).

  Converts trn_ridership_records from a regular table to RANGE
  partitioning by scanned_at, monthly. The conversion preserves
  every column, CHECK, index, and FK constraint from the original.

  Volume rationale: trn_ridership_records is the single highest-volume
  scan-path table in CampusOS — every QR bus pass scan writes one row,
  so a 5,000-pupil district produces ~10,000 rows/day, ~3.6M rows/year.
  Without partitioning, queries on the recent-30-days window would
  scan the whole table once it crosses ~10M rows.

  This migration is splitter-safe (no DO blocks, no semicolons inside
  string literals or block comments) and idempotent via DROP TABLE
  IF EXISTS — the target table is empty in tenant_demo and tenant_test
  today, so the drop-and-recreate pattern is safe.

  Other tables on the cycle-31 plan list (fds_meal_transactions,
  fds_temperature_logs, tech_credential_access_log,
  rpt_daily_attendance_summary, rpt_student_academic_summary,
  platform.platform_audit_log) follow the same conversion pattern —
  see infra/partition-activation-runbook.md for the deployment-time
  procedure with pg_partman_partition_data_proc for non-empty tables.

  Already-partitioned (skipped) — msg_threads HASH 64 (Cycle 3),
  msg_messages / msg_moderation_log / msg_notification_log RANGE
  monthly (Cycle 3), sis_attendance_records composite (Cycle 1),
  pay_ledger_entries RANGE annual (Cycle 6), tsk_tasks RANGE monthly
  (Cycle 7).
*/

DROP TABLE IF EXISTS trn_ridership_records CASCADE;

CREATE TABLE trn_ridership_records (
  id UUID NOT NULL,
  student_id UUID NOT NULL,
  route_id UUID NOT NULL,
  stop_id UUID NOT NULL,
  scan_direction TEXT NOT NULL,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  scanned_by UUID,
  scan_method TEXT NOT NULL DEFAULT 'QR_CODE',
  bus_pass_id UUID,
  notes TEXT,
  PRIMARY KEY (id, scanned_at),
  CONSTRAINT trn_ridership_direction_chk CHECK (scan_direction IN ('BOARDING', 'ALIGHTING')),
  CONSTRAINT trn_ridership_method_chk CHECK (scan_method IN ('QR_CODE', 'MANUAL', 'RFID')),
  CONSTRAINT trn_ridership_route_fk FOREIGN KEY (route_id) REFERENCES trn_routes(id) ON DELETE CASCADE,
  CONSTRAINT trn_ridership_stop_fk FOREIGN KEY (stop_id) REFERENCES trn_stops(id) ON DELETE CASCADE
) PARTITION BY RANGE (scanned_at);

CREATE TABLE trn_ridership_records_2025_08 PARTITION OF trn_ridership_records FOR VALUES FROM ('2025-08-01') TO ('2025-09-01');
CREATE TABLE trn_ridership_records_2025_09 PARTITION OF trn_ridership_records FOR VALUES FROM ('2025-09-01') TO ('2025-10-01');
CREATE TABLE trn_ridership_records_2025_10 PARTITION OF trn_ridership_records FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');
CREATE TABLE trn_ridership_records_2025_11 PARTITION OF trn_ridership_records FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE trn_ridership_records_2025_12 PARTITION OF trn_ridership_records FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');
CREATE TABLE trn_ridership_records_2026_01 PARTITION OF trn_ridership_records FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE trn_ridership_records_2026_02 PARTITION OF trn_ridership_records FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE trn_ridership_records_2026_03 PARTITION OF trn_ridership_records FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE trn_ridership_records_2026_04 PARTITION OF trn_ridership_records FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE trn_ridership_records_2026_05 PARTITION OF trn_ridership_records FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE trn_ridership_records_2026_06 PARTITION OF trn_ridership_records FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE trn_ridership_records_2026_07 PARTITION OF trn_ridership_records FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE trn_ridership_records_2026_08 PARTITION OF trn_ridership_records FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE trn_ridership_records_2026_09 PARTITION OF trn_ridership_records FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE trn_ridership_records_2026_10 PARTITION OF trn_ridership_records FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE trn_ridership_records_2026_11 PARTITION OF trn_ridership_records FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE trn_ridership_records_2026_12 PARTITION OF trn_ridership_records FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE trn_ridership_records_2027_01 PARTITION OF trn_ridership_records FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE trn_ridership_records_2027_02 PARTITION OF trn_ridership_records FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE trn_ridership_records_2027_03 PARTITION OF trn_ridership_records FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE trn_ridership_records_2027_04 PARTITION OF trn_ridership_records FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE trn_ridership_records_2027_05 PARTITION OF trn_ridership_records FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE trn_ridership_records_2027_06 PARTITION OF trn_ridership_records FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE trn_ridership_records_2027_07 PARTITION OF trn_ridership_records FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');

CREATE INDEX IF NOT EXISTS trn_ridership_route_at_idx ON trn_ridership_records (route_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS trn_ridership_student_at_idx ON trn_ridership_records (student_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS trn_ridership_today_idx ON trn_ridership_records (route_id, scan_direction, scanned_at);

COMMENT ON TABLE trn_ridership_records IS 'Cycle 31 — RANGE-partitioned by scanned_at, monthly. pg_partman creates future partitions in production.';
