# Runbook: DB Replication Lag

**Alert:** `DbReplicationLagWarning` (WARNING) / `DbReplicationLagCritical` (CRITICAL)
**Owner:** campusos-platform on-call

## What it means

Read replica is more than 5 seconds (WARNING) or 30 seconds (CRITICAL) behind the primary. Read paths routed to the replica may serve stale data.

## Triage steps

1. Confirm the lag from the source: connect to the replica and run
   ```sql
   SELECT now() - pg_last_xact_replay_timestamp() AS lag;
   ```
2. Check the primary for long-running transactions (the replica can't apply newer WAL while a long tx holds an older snapshot):
   ```sql
   SELECT pid, age(now(), xact_start) AS xact_age, query
     FROM pg_stat_activity
     WHERE state = 'active' AND xact_start IS NOT NULL
     ORDER BY xact_start ASC LIMIT 10;
   ```
3. Check for vacuum / index-build storms — partition-leaf creation jobs (cycle-31 step 5) auto-vacuum a freshly-attached partition.

## Resolution

- WARNING: monitor; usually recovers without intervention.
- CRITICAL: route reads back to primary by setting `READ_REPLICA_DISABLED=true` in the API's runtime config, deploy. Replica catches up at its own pace; re-enable when lag < 1s.

## Escalation

CRITICAL wakes on-call. If the underlying cause is hardware (disk full, network split) escalate to infra.
