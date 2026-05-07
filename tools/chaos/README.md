# Cycle 32 Step 9 — Chaos Engineering Programme

Six staging-only experiments that prove the platform behaves
correctly when its dependencies misbehave. Each experiment is a
short YAML manifest the AWS Fault Injection Simulator (FIS) consumes

- a runbook explaining the expected outcome and the metric to watch.

## Experiments

| File                        | Target                  | Expected behaviour                                                      |
| --------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| `01-instance-kills.yaml`    | ECS API tasks (staging) | Service scheduler replaces within 2 min; no user-visible errors         |
| `02-az-failure.yaml`        | One AZ in staging       | Multi-AZ RDS fails over; ECS redistributes; <30s downtime               |
| `03-network-partition.yaml` | App ↔ DB latency        | Circuit breakers open; requests fail fast; recover when partition heals |
| `04-db-failover-drill.yaml` | RDS in staging          | PgBouncer reconnects; consumers pause + resume; no orphaned tx          |
| `05-kafka-broker-kill.yaml` | One MSK broker          | Producers + consumers continue with remaining brokers                   |
| `06-redis-eviction.yaml`    | Redis cache             | Eviction policy works; cache misses fall back to DB                     |

## Schedule

- Manual: triggered on-demand from the staging ops console.
- Automated: monthly run alongside the Step 8 synthetic failover
  test (different week, second Sunday at 02:00 UTC, staging only).
- Production: experiments 01 and 06 run quarterly with the on-call
  watching live. The destructive experiments (02, 03, 04, 05) stay
  in staging.

## Output

Every experiment writes a structured result to
`/tmp/chaos-results/<experiment>-<timestamp>.json` with:

- `experiment` — file name
- `started_at` / `ended_at`
- `target` — ARN of the affected resource
- `injection_duration_seconds`
- `recovery_seconds` — time from injection-end to all-green
- `pass` — boolean
- `metrics` — cycle-31 Prometheus metrics captured during the run
- `notes` — operator observations

Quarterly tabletop exercises review the previous 12 chaos runs to
identify recurring weaknesses and prioritise remediation.

## Production safety

The `target_environment` tag on every experiment gates execution to
`staging`. The FIS template in
`tools/chaos/00-fis-template-staging-only.yaml` is hard-coded to
staging account ids; ops applies it via Terraform with explicit
account-id pinning.
