# Runbook: API 5xx Error Rate High

**Alert:** `ApiErrorRateHigh` (WARNING) / `ApiErrorRateCritical` (PAGE)
**Owner:** campusos-platform on-call

## What it means

5xx error rate exceeded 1% (WARNING) or 5% (PAGE) over the last 5 minutes.

## Triage steps

1. Tail the structured log stream for `level=error` lines: `kubectl logs -l app=campusos-api -f | jq 'select(.level=="error")'`
2. Group by `error_class` and `route` — find the top offender.
3. Check the DLQ — a Kafka consumer failure cascade can push 500s on the request path that triggers the emit:
   ```
   curl -H "Authorization: Bearer $ADMIN_TOKEN" \
        -H "X-Tenant-Subdomain: demo" \
        https://api.campusos.dev/api/v1/admin/dlq/stats
   ```
4. Check circuit breaker state for `redis`, `pgbouncer`, `kafka-producer` — an OPEN breaker turns request-path calls into 503s.

## Common causes

- New deploy → check the rollback button is at hand
- Database connection pool exhausted (look at `pgbouncer` metrics)
- Tenant-specific bug (look at the `tenant_id` label distribution)
- Upstream IdP outage on `/auth/refresh`

## Escalation

Page on `>5%` sustained 2 minutes. Roll back the most recent deploy if the start of the spike correlates with a deploy.
