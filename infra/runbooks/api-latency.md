# Runbook: API Latency High

**Alert:** `ApiP95LatencyHigh` (WARNING) / `ApiP95LatencyCritical` (CRITICAL)
**Owner:** campusos-platform on-call

## What it means

The 5-minute p95 on `http_request_duration_seconds` for the affected route exceeded the SLO target (CRITICAL = 500ms, STANDARD = 1s).

## Triage steps

1. Open Grafana → API → "p95 by route" panel. Confirm which routes are slow.
2. Check `pg_stat_statements` for queries running on those routes:
   ```sql
   SELECT * FROM pg_stat_statements
   ORDER BY mean_exec_time DESC LIMIT 10;
   ```
3. Check Redis cache hit ratio for `iam:access:*` and `ledger:balance:*` (`redis_cache_hit_ratio`).
4. Check Kafka consumer lag — a slow worker can cascade into request-path waits.
5. Check `kafka_consumer_lag` and `circuit_breaker_state` Prometheus metrics.

## Common causes

- N+1 query regression after recent deploy → revert
- Redis breaker OPEN → `iam:access` cache misses cascade to `iam_effective_access_cache` reads
- Read-replica lag → reads falling back to primary → primary CPU bound
- Tenant-specific hot row contention (look at `tenant_id` label on the histogram)

## Escalation

If unresolved within 30 minutes (WARNING) or 10 minutes (CRITICAL), escalate to the architecture owner via PagerDuty `campusos-architecture-secondary`.
