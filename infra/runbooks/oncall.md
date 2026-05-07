# On-Call Rotation & Escalation

This document lives next to the runbooks so an engineer paged at 3am can find both the alert detail and the human chain in one place.

## Rotations

- **Primary platform** (`campusos-oncall-primary` PagerDuty escalation policy)
  - Pages on every PAGE-severity rule in `infra/prometheus/alert-rules.yaml`.
  - Weekly rotation Monday 09:00 UTC handover.

- **Architecture secondary** (`campusos-architecture-secondary`)
  - Receives second-tier escalation if primary is unreachable for 15 minutes on a CRITICAL-tier alert.

- **DPO on-call** (`campusos-dpo-primary`)
  - Pages exclusively on `BreachNotificationDeadlineWithin2Hours`.
  - This is the regulatory keystone — see `infra/runbooks/breach-72hour.md`.

## SLO error-budget enforcement

The `error_budget` block in `infra/slos/slo-definitions.yaml` defines a three-step ladder:

- **50% exhausted** → WARNING — review the recent deploy, identify the regression.
- **75% exhausted** → CRITICAL — pre-deployment freeze recommended; only critical safety / regulatory deploys proceed.
- **100% exhausted** → PAGE — automated deploy freeze enacted; on-call engineer is paged with a freeze notification.

Tracking is monthly. The freeze auto-clears at the start of the next calendar month; manual override requires sign-off from the architecture lead.

## Standard severities

| Severity | Channel   | Action SLA                         |
| -------- | --------- | ---------------------------------- |
| WARNING  | Slack     | Investigate within 1 business hour |
| CRITICAL | Slack     | Investigate within 15 minutes      |
| PAGE     | PagerDuty | Page on-call (any time)            |

## Useful one-liners

Tail structured logs filtered to errors:

```
kubectl logs -l app=campusos-api -f | jq 'select(.level=="error")'
```

Confirm Prometheus is scraping `/metrics`:

```
curl -s http://localhost:4000/metrics | head -20
```

DLQ stats (admin token + tenant header):

```
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "X-Tenant-Subdomain: demo" \
     http://localhost:4000/api/v1/admin/dlq/stats
```

Top 10 slowest queries:

```
psql -d campusos_dev -f tools/sql/pg-stat-statements-top10.sql
```
