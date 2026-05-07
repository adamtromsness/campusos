# Cycle 31 — Operational Readiness CAT

**Cycle:** 31 — Performance & Observability (Wave 8 opening)
**Surface:** Cross-cutting; touches every prior cycle's request + worker paths.
**Tenant:** `tenant_demo` unless noted.
**Run after:** every Cycle 31 step is committed and the API has been rebuilt + restarted.

This CAT differs from prior cycle CATs in that there are no new business
tables; the verification scenarios cover instrumentation, partitioning,
caching contracts, DLQ flows, envelope validation, circuit-breaker
behaviour, SLOs/alerts, and the platform admin dashboard. Each
scenario lists the artifact under test, the verification command, and
the expected observation.

## Schema preamble

```sql
-- 0a tenant base table count unchanged from Cycle 30 (data-governance
--    closeout) — Cycle 31 ships zero new business tables.
SELECT COUNT(*) FROM information_schema.tables
 WHERE table_schema = 'tenant_demo'
   AND table_type = 'BASE TABLE'
   AND table_name NOT LIKE '\_prisma\_%';
-- expect: 383

-- 0b platform DLQ table exists (created in REVIEW-CYCLE3 BLOCKING 1).
SELECT 1 FROM information_schema.tables
 WHERE table_schema = 'platform'
   AND table_name = 'platform_dlq_messages';
-- expect: 1 row

-- 0c partition activation is RUNBOOK-ONLY in Cycle 31 (REVIEW-CYCLE31
--    BLOCKING 5). The earlier destructive 101_partition_activation.sql
--    migration was removed. Tenants previously provisioned with that
--    migration retain the partitioned shape; fresh provisions use the
--    Cycle 19 non-partitioned schema and convert via
--    infra/partition-activation-runbook.md only.
SELECT relkind FROM pg_class
 WHERE relnamespace = 'tenant_demo'::regnamespace
   AND relname = 'trn_ridership_records';
-- 'p' if previously converted; 'r' on a fresh provision.
```

---

## S1 — Trace context propagates through Kafka envelope

**What:** Every API request gets a `trace_id` (UUIDv7); the trace_id
seeds the Kafka envelope's `correlation_id` so a downstream consumer
log line is joinable to the originating HTTP request.

**Verify:**

```bash
curl -i -H "Authorization: Bearer $TEACHER_TOKEN" \
        -H "X-Tenant-Subdomain: demo" \
        http://localhost:4000/api/v1/classes/my
```

Expect `X-Trace-Id` and `X-Span-Id` headers in the response. Tail the
API log for the matching request:

```bash
kubectl logs -l app=campusos-api -f \
  | jq 'select(.trace_id == "<id from header>")'
```

Expect a request-log line with `method=GET path=/api/v1/classes/my
status=200 duration_ms=...`.

If the request fires a Kafka emit (e.g. PATCH `/api/v1/governance/breaches`),
the envelope's `correlation_id` matches the request's `trace_id`.

---

## S2 — Structured JSON logging

**What:** Every log line per `apps/api/src/observability/structured-logger.ts`
emits one-line JSON with required fields per Architecture Review §25.2.

**Verify:**

```bash
kubectl logs -l app=campusos-api --tail=20 | jq '.timestamp, .level, .service_name, .trace_id'
```

Expect every line to be valid JSON with non-null `timestamp`,
`level`, `service_name='campusos-api'`. `trace_id` is populated on
request-path lines and null on boot-time lines (no request context yet).

CI gate: `pnpm lint:logs` scans `apps/api/src` for `console.log` +
email PII patterns and exits non-zero on violation. Re-run:

```bash
pnpm lint:logs
```

Expect exit code 0.

---

## S3 — Prometheus /metrics

**What:** `/metrics` exposes the Cycle 31 metric set.

**Verify:**

```bash
curl -s http://localhost:4000/metrics | grep -E '^(http_request_duration_seconds|kafka_consumer_lag|circuit_breaker_state|redis_cache_hits)' | head
```

Expect:

- `http_request_duration_seconds_bucket` histogram entries with
  `tenant_id` label.
- `kafka_consumer_lag` gauge entries (one per consumer group, may be
  zero if all caught up).
- `circuit_breaker_state` gauge entries (one per dependency,
  `0` = CLOSED).
- `redis_cache_hits_total` and `redis_cache_misses_total` counters.

The `/metrics` endpoint is publicly scrapeable by Prometheus and
exempt from `/api/v1` prefixing + tenant-resolver gating.

---

## S4 — IAM access cache (Redis-backed)

**What:** `PermissionCheckService` caches per-(account, scope)
permission codes in Redis with a 5-minute TTL. Cache invalidation is
the contract — TTL is the safety net.

**Verify:**

Step 4a — cold read:

```bash
redis-cli -h localhost FLUSHALL
curl -i -H "Authorization: Bearer $TEACHER_TOKEN" \
        -H "X-Tenant-Subdomain: demo" \
        http://localhost:4000/api/v1/classes/my
# Tail metrics:
curl -s http://localhost:4000/metrics | grep redis_cache_misses_total
```

Expect a `redis_cache_misses_total{...prefix="iam:access"...}` increment.

Step 4b — warm read:

```bash
curl -i -H "Authorization: Bearer $TEACHER_TOKEN" \
        -H "X-Tenant-Subdomain: demo" \
        http://localhost:4000/api/v1/classes/my
curl -s http://localhost:4000/metrics | grep redis_cache_hits_total
```

Expect a `redis_cache_hits_total{...prefix="iam:access"...}` increment.

Step 4c — explicit invalidation: trigger a `RolePermissionService`
mutation, then re-read; expect a fresh miss for the affected account.

The TTL safety-net behaviour is documented in
`apps/api/src/observability/cache-contracts.md`.

---

## S5 — Circuit breaker opens + recovers

**What:** `apps/api/src/observability/circuit-breaker.ts` trips a
breaker after N consecutive failures and recovers via HALF_OPEN probe.

**Verify in dev:** kill the Redis container with `docker stop campusos-redis`,
then send N requests that hit the IAM access cache:

```bash
for i in 1 2 3 4 5 6; do
  curl -s -H "Authorization: Bearer $TEACHER_TOKEN" \
          -H "X-Tenant-Subdomain: demo" \
          http://localhost:4000/api/v1/classes/my > /dev/null
done
```

Tail the API log: expect 5 lines `[CircuitBreaker:redis] state CLOSED → OPEN`,
then subsequent calls fail-fast with `CircuitBreakerOpenError` (the
service falls back to direct DB read; user-visible behaviour is
unchanged).

Inspect Prometheus:

```bash
curl -s http://localhost:4000/metrics | grep 'circuit_breaker_state{dependency="redis"}'
```

Expect `1` (OPEN). Restart Redis, wait ~30s for the probe window:

```bash
docker start campusos-redis
sleep 35
curl -s http://localhost:4000/metrics | grep 'circuit_breaker_state{dependency="redis"}'
```

Expect `0` (CLOSED).

The Step 8 alert rule `CircuitBreakerOpen` PAGE-fires after 1m
sustained OPEN — see `infra/runbooks/circuit-breaker.md`.

---

## S6 — Partition routing on `trn_ridership_records`

**What:** Cycle 31 documents the partition activation procedure in
`infra/partition-activation-runbook.md` (REVIEW-CYCLE31 BLOCKING 5 —
the executable migration was removed; the runbook is the authoritative
deployment-time path). Tenants converted via prior provisions retain
the partitioned shape; on those tenants, inserts route to the matching
month's leaf and out-of-window inserts fail loudly.

**Verify on `tenant_demo`** (skip if `0c` shows `'r'` — fresh provisions
need the runbook applied first):

```sql
-- Cleanly inserts into the 2026-05 leaf.
INSERT INTO trn_ridership_records (id, school_id, route_id, scanned_at, scan_type, scanned_by)
VALUES ('019dff45-aaaa-7000-8000-000000000001'::uuid,
        (SELECT id FROM platform.schools WHERE name = 'Lincoln Elementary'),
        (SELECT id FROM trn_routes LIMIT 1),
        '2026-05-15T08:00:00Z',
        'BOARDING',
        (SELECT id FROM hr_employees LIMIT 1));

-- Confirm the row landed in the 2026-05 partition leaf:
SELECT COUNT(*) FROM ONLY trn_ridership_records_2026_05;
-- expect: at least 1

-- Out-of-window insert is rejected.
INSERT INTO trn_ridership_records (id, school_id, route_id, scanned_at, scan_type, scanned_by)
VALUES ('019dff45-aaaa-7000-8000-000000000002'::uuid,
        (SELECT id FROM platform.schools WHERE name = 'Lincoln Elementary'),
        (SELECT id FROM trn_routes LIMIT 1),
        '2024-07-15T08:00:00Z',  -- before the 2025-08 floor
        'BOARDING',
        (SELECT id FROM hr_employees LIMIT 1));
-- expect: ERROR — no partition of relation "trn_ridership_records" found for row
```

Cleanup:

```sql
DELETE FROM trn_ridership_records WHERE id::text LIKE '019dff45-aaaa-%';
```

The conversion runbook for `trn_ridership_records` + the 6 deferred
tables (fds\_\*, tech\_\*, rpt\_\*, audit_log) lives in
`infra/partition-activation-runbook.md`.

---

## S7 — DLQ park + replay end-to-end

**What:** A poison Kafka message lands in
`platform.platform_dlq_messages` after N retries. Replay re-emits via
`KafkaProducerService.emitRaw()` preserving `event_id` +
`correlation_id` + `tenant_id`.

**Verify:**

Step 7a — produce a poison message manually with kafka-console-producer:

```bash
echo '{"event_id":"019dff45-bbbb-7000-8000-000000000001","event_type":"cls.grade.published","event_version":1,"tenant_id":"<demo-school-id>","source_module":"classroom","correlation_id":"smoke","occurred_at":"2026-05-07T08:00:00Z","published_at":"2026-05-07T08:00:00Z","payload":{"intentionally":"broken — missing studentId"}}' \
  | kafka-console-producer --broker-list localhost:9092 --topic dev.cls.grade.published
```

Wait ~30s for the consumer to retry and park.

Step 7b — confirm the DLQ row landed:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "X-Tenant-Subdomain: demo" \
     http://localhost:4000/api/v1/admin/dlq?resolved=false
```

Expect a row with `errorClass=MAX_RETRIES_EXCEEDED` (or
`ENVELOPE_INVALID` if the envelope retrofit is in place — Step 7
covered this).

Step 7c — fix the producer, then replay:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
              -H "X-Tenant-Subdomain: demo" \
              http://localhost:4000/api/v1/admin/dlq/<id>/replay
```

Expect 204. Tail the consumer log: the original `event_id`
re-appears, the consumer claims the idempotency key on success
(REVIEW-CYCLE2 BLOCKING 2 contract).

Step 7d — discard path: produce a second poison message, then
`POST /api/v1/admin/dlq/<id>/discard {"reason":"..."}`. Row stays for
audit but is excluded from the active `?resolved=false` view.

The Step 8 alert rule `DlqMessageOlderThan15Min` PAGE-fires on
unresolved rows older than 15 minutes — see `infra/runbooks/dlq.md`.

---

## S8 — Envelope validation rejects malformed events

**What:** Step 7's `assertValidEnvelope` retrofit means every consumer
validates the ADR-057 envelope before processing. Failures park to DLQ
with `errorClass=ENVELOPE_INVALID`.

**Verify:** produce an envelope missing `event_id`:

```bash
echo '{"event_type":"cls.grade.published","event_version":1,"tenant_id":"<demo-school-id>","source_module":"classroom","correlation_id":"smoke","occurred_at":"2026-05-07T08:00:00Z","published_at":"2026-05-07T08:00:00Z","payload":{}}' \
  | kafka-console-producer --broker-list localhost:9092 --topic dev.cls.grade.published
```

After ~30s expect a DLQ row with `errorClass=ENVELOPE_INVALID` and
`errorMessage` containing `Invalid event_id`. The envelope was
unparseable so `event_id` and `tenant_id` on the DLQ row may be NULL —
the original payload is preserved in `payload`.

Discard with reason `"Bogus envelope from cycle-XX producer; producer
fix landed in commit ...".`

---

## S9 — SLO + alert rule sanity

**What:** SLO definitions live in `infra/slos/slo-definitions.yaml`;
alert rules live in `infra/prometheus/alert-rules.yaml`; runbooks live
in `infra/runbooks/`.

**Verify:**

Step 9a — every alert in `alert-rules.yaml` references a runbook that
exists:

```bash
for f in $(grep -oP 'runbook: "infra/runbooks/[a-z0-9-]+\.md"' \
                infra/prometheus/alert-rules.yaml \
              | cut -d'"' -f2 | sort -u); do
  test -f "$f" && echo "OK $f" || echo "MISSING $f"
done
```

Expect every line to start with `OK`.

Step 9b — SLO tier modules cover every cycle 1-30 module without
duplication:

```bash
yq '.tiers | to_entries | .[].value.modules' infra/slos/slo-definitions.yaml \
  | sort | uniq -c | sort -rn | head
```

Expect every count to be `1` (no module assigned to two tiers).

Step 9c — error-budget computation contract is documented (the
worker that exports `dpo_breach_hours_remaining_to_72` is a Phase 2
deliverable; the alert rule references it forward-compatibly).

---

## S10 — Platform admin dashboard

**What:** `/admin/platform/*` surfaces tenant ops, DLQ, partitions,
and migration history to Platform Admin only (`sys-001:admin`).

**Verify:**

```bash
# 10a — gate
curl -i -H "Authorization: Bearer $SCHOOL_ADMIN_TOKEN" \
        -H "X-Tenant-Subdomain: demo" \
        http://localhost:4000/api/v1/admin/platform/tenants
# expect: 403

curl -i -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN" \
        -H "X-Tenant-Subdomain: demo" \
        http://localhost:4000/api/v1/admin/platform/tenants
# expect: 200, JSON array of tenants

# 10b — base table count drift detection
# tenant_demo should report baseTableCount=383 (Cycle 30 closeout figure).
# A row with a different count means a tenant has drifted (manual
# migration or failed provision).
curl -s -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN" \
        -H "X-Tenant-Subdomain: demo" \
        http://localhost:4000/api/v1/admin/platform/tenants \
  | jq '.[] | {subdomain, baseTableCount}'

# 10c — partition inventory includes the 24 leaves of trn_ridership_records.
curl -s -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN" \
        -H "X-Tenant-Subdomain: demo" \
        "http://localhost:4000/api/v1/admin/platform/partitions?parentTable=trn_ridership_records" \
  | jq 'length'
# expect: 24

# 10d — migration history: most recent platform migration includes the
# Cycle 3 platform_dlq_messages addition.
curl -s -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN" \
        -H "X-Tenant-Subdomain: demo" \
        "http://localhost:4000/api/v1/admin/platform/migrations?scope=platform" \
  | jq '.[] | .migrationName' | head
```

Web side: open `http://localhost:3000/admin/platform` as Platform
Admin. Expect the 4-card stat panel + chip nav. Click into each of
Tenants / DLQ / Partitions / Migrations and confirm the lists render.

---

## Cleanup

Cycle 31 ships no new tenant data. The S6 partition smoke INSERT and
S7/S8 DLQ rows can be dropped:

```sql
DELETE FROM trn_ridership_records WHERE id::text LIKE '019dff45-aaaa-%';
```

```bash
# Discard any cycle-31 smoke DLQ rows.
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
        -H "X-Tenant-Subdomain: demo" \
        http://localhost:4000/api/v1/admin/dlq?resolved=false \
  | jq -r '.[] | select(.eventId | startswith("019dff45-bbbb")) | .id' \
  | while read id; do
      curl -s -X POST \
        -H "Authorization: Bearer $ADMIN_TOKEN" \
        -H "X-Tenant-Subdomain: demo" \
        -H "Content-Type: application/json" \
        -d '{"reason":"cycle-31 CAT smoke residue"}' \
        http://localhost:4000/api/v1/admin/dlq/$id/discard
    done
```

After cleanup, the tenant base-table count is unchanged from the
preamble (383). The `trn_ridership_records` parent and its 24 leaves
remain — partitioning is the durable cycle-31 deliverable.

---

## Reviewer attention items (Phase 2 punch list)

These are deferred follow-ups; they do not block the cycle-31 review:

1. Partition activation for the remaining 5 deferred tables —
   `infra/partition-activation-runbook.md` documents the procedure;
   the cycle ships only `trn_ridership_records` as the worked example.
2. SLO error-budget tracking worker — the alert rules reference the
   metrics but the exporter that computes monthly budget remaining is
   Phase 2 work.
3. PagerDuty + Slack webhook secrets — `infra/slos/slo-definitions.yaml`
   references them as `secret://...` placeholders.
4. Real `kafka_consumer_lag` exporter — Cycle 31 wires the gauge;
   populating it from KafkaJS group offsets is a downstream worker job.
5. Tenant migration tracking — the dashboard surfaces a hint
   pointing at `packages/database/prisma/tenant/migrations/*.sql` rather
   than fabricate synthetic state. A future migration-tracker (one row
   per (tenant_schema, migration_filename, applied_at)) lands in a
   later cycle.

These all join the broader Phase 2 punch list documented in
`CLAUDE.md` and are safe to accept as review deviations.
