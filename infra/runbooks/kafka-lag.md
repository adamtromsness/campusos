# Runbook: Kafka Consumer Lag

**Alert:** `KafkaConsumerLagWarning` (WARNING) / `KafkaConsumerLagPage` (PAGE)
**Owner:** campusos-platform on-call

## What it means

A consumer group is lagging more than 1,000 messages (WARNING) or 2,000 (PAGE) on a single partition for 1–2 minutes.

## Triage steps

1. Identify the lagging group from the alert label (`consumer_group`).
2. Check the consumer's logs for unhandled exceptions.
3. Check the DLQ — sustained lag plus a growing DLQ usually means a poison message is choking the worker; failing fast and parking is healthier than blocking.
4. Verify the consumer process is actually running: `kubectl get pods -l app=campusos-api -o wide`.
5. Check the partitioned-table backlog: if a worker writes to a tenant table that just rolled into a new partition, the auto-vacuum can spike CPU.

## Common causes

- Worker died and the deployment hasn't rescheduled it
- Poison message — the `processWithIdempotency` rethrow path leaves the offset un-claimed; the retry loop re-fires; the DLQ park kicks in after 5 attempts
- Downstream dependency slow (Redis, GL posting service) — check circuit breaker state
- Recent deploy changed the consumer group id and partition assignment is rebalancing

## Resolution

- If the worker is healthy but slow → scale replicas, or accept the catch-up time and downgrade the alert to WARNING manually.
- If the worker is failing → roll back to last known good build.
- If a poison message blocks the partition → the DLQ park-after-N-attempts pattern resolves automatically; verify the message arrived in DLQ via `/admin/dlq`.

## Escalation

PAGE rule wakes on-call after 2-minute sustained lag > 2,000.
