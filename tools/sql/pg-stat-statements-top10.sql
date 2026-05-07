-- Cycle 31 Step 4 — pg_stat_statements top-10 slowest queries.
--
-- Run on the production read replica AFTER capturing 1+ hour of
-- production-like load. Output feeds the targeted index-addition
-- pull request that closes Step 4.
--
-- Prereqs:
--   ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';
--   ALTER SYSTEM SET pg_stat_statements.track = 'all';
--   pg_ctl restart
--   CREATE EXTENSION pg_stat_statements;

-- Top 10 by total time (cumulative impact).
SELECT
  substring(query, 1, 200) AS query_excerpt,
  calls,
  ROUND((total_exec_time / 1000)::numeric, 2) AS total_seconds,
  ROUND(mean_exec_time::numeric, 2) AS mean_ms,
  ROUND((100 * total_exec_time / SUM(total_exec_time) OVER ())::numeric, 2) AS pct_of_total
FROM pg_stat_statements
WHERE query NOT ILIKE 'EXPLAIN%'
  AND query NOT ILIKE 'SELECT pg_stat_%'
  AND query NOT ILIKE 'COMMIT%'
  AND query NOT ILIKE 'BEGIN%'
ORDER BY total_exec_time DESC
LIMIT 10;

-- Top 10 by mean time (per-call latency).
SELECT
  substring(query, 1, 200) AS query_excerpt,
  calls,
  ROUND(mean_exec_time::numeric, 2) AS mean_ms,
  ROUND(stddev_exec_time::numeric, 2) AS stddev_ms,
  ROUND((100.0 * shared_blks_hit / NULLIF(shared_blks_hit + shared_blks_read, 0))::numeric, 2) AS cache_hit_pct
FROM pg_stat_statements
WHERE calls > 100
  AND query NOT ILIKE 'EXPLAIN%'
ORDER BY mean_exec_time DESC
LIMIT 10;

-- Top tables by sequential scans (missing-index suspects).
SELECT
  schemaname,
  relname AS table_name,
  seq_scan,
  seq_tup_read,
  idx_scan,
  ROUND(100.0 * seq_scan / NULLIF(seq_scan + idx_scan, 0), 2) AS seq_scan_pct
FROM pg_stat_user_tables
WHERE seq_scan > 1000
ORDER BY seq_tup_read DESC
LIMIT 10;
