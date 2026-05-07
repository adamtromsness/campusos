# Runbook: Circuit Breaker Open

**Alert:** `CircuitBreakerOpen` (PAGE)
**Owner:** campusos-platform on-call

## What it means

A `CircuitBreaker` (see `apps/api/src/observability/circuit-breaker.ts`) tripped to `OPEN` and stayed open for at least 1 minute. While OPEN, the protected dependency call is short-circuited and `CircuitBreakerOpenError` propagates to callers.

State encoding (Prometheus gauge `circuit_breaker_state`):

- `0` = CLOSED (normal)
- `1` = OPEN (failing)
- `2` = HALF_OPEN (probing recovery)

## Triage steps

1. Identify the dependency from the alert label (`dependency`).
2. Look at recent error logs filtered to `error_class=CircuitBreakerOpenError` to confirm the breaker is the cause of user-facing 5xx, not a symptom.
3. Hit the dependency directly to confirm whether it is in fact down (e.g. `redis-cli ping`, `psql -c 'SELECT 1'`, hit Stripe `/v1/charges` from a worker pod).
4. If the dependency is down → fix it. The breaker will probe on its own and recover (HALF_OPEN → CLOSED) once the dependency stabilises.

## Common dependencies

- `redis` — IAM access cache + ledger balance cache + notification inbox
- `pgbouncer` — primary DB pool
- `kafka-producer` — broker connectivity
- `stripe` — payment intents + refunds
- `ai-gateway` — Cycle 23 grading + summarisation (future cycles)

## Resolution

The breaker auto-recovers; do not manually flap it. If the dependency cannot be restored quickly, the affected feature degrades per its documented fall-back path:

- Redis OPEN → IAM falls back to `iam_effective_access_cache` direct read (slower but correct)
- Stripe OPEN → CARD payments return 503; admins can record CASH/CHEQUE manually
- Kafka producer OPEN → emits drop on the floor (best-effort by design); consumer-side state stays consistent

## Escalation

Page wakes on-call. If a CRITICAL-tier dependency stays OPEN for more than 10 minutes, escalate to architecture + the dependency owner.
