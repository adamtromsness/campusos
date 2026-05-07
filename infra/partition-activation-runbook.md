# Partition Activation Runbook

**Cycle 31 Step 5 — deployment-time partition conversion procedure.**

Migration `101_partition_activation.sql` ships in-repo and converts
`trn_ridership_records` end-to-end as the worked example. Six other
high-volume tables follow the same pattern but are deferred to
deployment time because they either (a) hold seeded demo rows that
need preserving, or (b) carry shapes that diverge from the current
schema enough that the production ops team should re-validate before
applying. This runbook describes that procedure.

## Tables to convert

| Table                        | Strategy                    | Notes                                           |
| ---------------------------- | --------------------------- | ----------------------------------------------- |
| fds_meal_transactions        | RANGE(served_at) monthly    | Cycle 20 schema; uses `items JSONB` shape       |
| fds_temperature_logs         | RANGE(logged_at) monthly    | Empty in demo                                   |
| tech_credential_access_log   | RANGE(accessed_at) monthly  | Empty in demo; SECURITY KEYSTONE                |
| rpt_daily_attendance_summary | RANGE(summary_date) monthly | 30 demo rows — preserve via partition_data_proc |
| rpt_student_academic_summary | RANGE(generated_at) monthly | 15 demo rows — preserve                         |
| platform.platform_audit_log  | RANGE(created_at) monthly   | Cross-schema; FERPA 7-year retention path       |

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
