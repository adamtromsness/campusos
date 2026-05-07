# Partition Activation Runbook

**Cycle 31 Step 5 — deployment-time partition conversion procedure.**

This runbook is the authoritative source for partition activation.
**REVIEW-CYCLE31 BLOCKING 5 — partition activation is RUNBOOK-ONLY in
Cycle 31.** The earlier `101_partition_activation.sql` migration was
removed because it ran a destructive `DROP TABLE IF EXISTS … CASCADE`
on `trn_ridership_records` and could drop seeded data + dependent
objects in any environment that wasn't completely empty. The
non-destructive replacement is the deployment-time procedure
documented below.

The seven candidate tables (1 worked example + 6 deferred) all carry
either seeded demo rows that need preserving or schema shapes that
benefit from `pg_partman` automation. None of them are converted as
part of the standard tenant provisioning path; ops applies this
runbook in production with the data-preserving rename → create →
copy → drop pattern.

## Tables to convert

| Table                        | Strategy                    | Notes                                            |
| ---------------------------- | --------------------------- | ------------------------------------------------ |
| trn_ridership_records        | RANGE(scanned_at) monthly   | Worked example below; ~3.6M rows/year per school |
| fds_meal_transactions        | RANGE(served_at) monthly    | Cycle 20 schema; uses `items JSONB` shape        |
| fds_temperature_logs         | RANGE(logged_at) monthly    | Empty in demo                                    |
| tech_credential_access_log   | RANGE(accessed_at) monthly  | Empty in demo; SECURITY KEYSTONE                 |
| rpt_daily_attendance_summary | RANGE(summary_date) monthly | 30 demo rows — preserve via partition_data_proc  |
| rpt_student_academic_summary | RANGE(generated_at) monthly | 15 demo rows — preserve                          |
| platform.platform_audit_log  | RANGE(created_at) monthly   | Cross-schema; FERPA 7-year retention path        |

## Worked example: `trn_ridership_records`

The non-destructive conversion procedure for `trn_ridership_records`
in production. Run inside a maintenance window with writes paused.

```sql
BEGIN;

-- 1. Rename the existing table out of the way. CHECK / FK constraints
--    follow the rename; indexes do not need to be touched.
ALTER TABLE trn_ridership_records RENAME TO trn_ridership_records_pre_partition;

-- 2. Recreate as a partitioned parent with the same shape.
CREATE TABLE trn_ridership_records (
  id              UUID NOT NULL,
  student_id      UUID NOT NULL,
  route_id        UUID NOT NULL,
  stop_id         UUID NOT NULL,
  scan_direction  TEXT NOT NULL,
  scanned_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  scanned_by      UUID,
  scan_method     TEXT NOT NULL DEFAULT 'QR_CODE',
  bus_pass_id     UUID,
  notes           TEXT,
  PRIMARY KEY (id, scanned_at),
  CONSTRAINT trn_ridership_direction_chk CHECK (scan_direction IN ('BOARDING', 'ALIGHTING')),
  CONSTRAINT trn_ridership_method_chk CHECK (scan_method IN ('QR_CODE', 'MANUAL', 'RFID')),
  CONSTRAINT trn_ridership_route_fk FOREIGN KEY (route_id) REFERENCES trn_routes(id) ON DELETE CASCADE,
  CONSTRAINT trn_ridership_stop_fk FOREIGN KEY (stop_id) REFERENCES trn_stops(id) ON DELETE CASCADE
) PARTITION BY RANGE (scanned_at);

-- 3. Create monthly partition leaves covering the historical span +
--    24 months forward. pg_partman handles ongoing creation post-
--    conversion (see step 6 below).
CREATE TABLE trn_ridership_records_2025_08 PARTITION OF trn_ridership_records
  FOR VALUES FROM ('2025-08-01') TO ('2025-09-01');
-- … one CREATE per month through the 24-month forward window …
CREATE TABLE trn_ridership_records_2027_07 PARTITION OF trn_ridership_records
  FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');

-- 4. Copy data from the snapshot. INSERT into the partitioned parent
--    routes each row to its month's leaf via the partition key.
INSERT INTO trn_ridership_records
SELECT * FROM trn_ridership_records_pre_partition;

-- 5. Recreate indexes on the parent (cascades to leaves).
CREATE INDEX trn_ridership_route_at_idx     ON trn_ridership_records (route_id, scanned_at DESC);
CREATE INDEX trn_ridership_student_at_idx   ON trn_ridership_records (student_id, scanned_at DESC);
CREATE INDEX trn_ridership_today_idx        ON trn_ridership_records (route_id, scan_direction, scanned_at);

-- 6. Validate row count parity before dropping the snapshot.
DO $$
DECLARE
  before_count BIGINT;
  after_count  BIGINT;
BEGIN
  SELECT count(*) INTO before_count FROM trn_ridership_records_pre_partition;
  SELECT count(*) INTO after_count  FROM trn_ridership_records;
  IF before_count <> after_count THEN
    RAISE EXCEPTION 'Row count mismatch: before=% after=%', before_count, after_count;
  END IF;
END $$;

-- 7. Drop the snapshot.
DROP TABLE trn_ridership_records_pre_partition;

COMMIT;

-- 8. Configure pg_partman auto-maintenance for ongoing partition
--    creation. Runs daily; creates the next month's leaf 30 days out.
SELECT partman.create_parent(
  p_parent_table => 'tenant_<id>.trn_ridership_records',
  p_control      => 'scanned_at',
  p_type         => 'native',
  p_interval     => 'monthly',
  p_premake      => 24
);
```

The `BEGIN; ... COMMIT;` envelope means a row-count mismatch on step 6
rolls back the entire conversion — the snapshot is preserved and the
original table can be reverted via the rollback procedure below.

## Production conversion procedure

For every target table, the deployment-time procedure is:

1. **Verify pg_partman is installed:**

   ```sql
   CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;
   ```

2. **Capture the current shape:**

   ```bash
   pg_dump --schema-only --table=<schema>.<table> -d campusos > /tmp/<table>.before.sql
   ```

3. **Take a logical snapshot** to a side-table (only if the original is
   non-empty):

   ```sql
   CREATE TABLE <table>_pre_partition AS SELECT * FROM <table>;
   ```

4. **Drop the original**, recreate as partitioned, then **load the
   snapshot** back:

   ```sql
   BEGIN;
   DROP TABLE <table>;
   CREATE TABLE <table> (...) PARTITION BY RANGE (<partition_col>);
   -- Create initial leaves covering the historical span:
   SELECT partman.create_parent(
     p_parent_table => '<schema>.<table>',
     p_control      => '<partition_col>',
     p_type         => 'native',
     p_interval     => 'monthly',
     p_premake      => 24
   );
   INSERT INTO <table> SELECT * FROM <table>_pre_partition;
   COMMIT;
   ```

5. **Verify partition routing:**

   ```sql
   SELECT count(*) FROM <table>;             -- total
   SELECT count(*) FROM ONLY <table>;        -- 0 (parent has no rows)
   SELECT count(*) FROM ONLY <table>_<partition_name>;  -- routed correctly
   ```

6. **Configure auto-maintenance:**

   ```sql
   UPDATE partman.part_config
      SET retention = '<retention_period>',
          retention_keep_table = false,
          infinite_time_partitions = true
    WHERE parent_table = '<schema>.<table>';
   ```

7. **Drop the snapshot:**
   ```sql
   DROP TABLE <table>_pre_partition;
   ```

## Cross-schema (`platform.platform_audit_log`)

The audit log requires a maintenance window because it is shared
across all tenants. Procedure:

1. Drain in-flight writes (read-only mode briefly).
2. Apply the conversion in a single transaction.
3. Re-enable writes.

Retention tier: T1 12 months hot, T2 7 years cold (S3 Parquet via
deferred archiver), T3 immutable WORM bucket per FERPA.

## Online-migration alternative (zero downtime)

For tables that cannot tolerate a maintenance window:

1. Create a sibling partitioned table (`<table>_v2`).
2. Set up logical replication from old → new.
3. Wait for replication catch-up.
4. Atomic rename: `<table>` → `<table>_v1_archive`, `<table>_v2` → `<table>`.
5. Repoint sequences + rebuild views.
6. Drop the archive after retention window.

## Rollback

If conversion fails mid-flight:

```sql
BEGIN;
DROP TABLE <table>;
CREATE TABLE <table> AS SELECT * FROM <table>_pre_partition;
ALTER TABLE <table> ADD PRIMARY KEY (id);
-- Re-add CHECKs / FKs / indexes from /tmp/<table>.before.sql
COMMIT;
```

## Verification (post-deploy)

For each converted table, confirm in a sample 1-hour window:

- pg_partman next-partition creation succeeded.
- Recent reads use partition pruning (`EXPLAIN ANALYZE` shows scan of
  one or two leaves rather than the whole table).
- `pg_stat_user_tables.seq_scan` count on the parent stays low.
- Write throughput unchanged from pre-conversion baseline.
