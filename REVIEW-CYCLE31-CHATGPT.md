# REVIEW-CYCLE31-CHATGPT

**Cycle:** 31 — Performance & Observability (Wave 8 opening). The first
ops cycle in CampusOS — **zero new business tables**.
**Round 1 commit:** to be filled in after the closeout commit lands.
**Round 1 verdict:** _pending_.
**Live verification reference:** `tenant_demo` 2026-05-07.

---

## Reviewer brief

Cycle 31 instruments, optimises, and stress-tests the prior 30 cycles'
~418 tables and ~936 endpoints. The deliverable is operational
readiness: structured logging with correlation IDs, OpenTelemetry
distributed tracing, Prometheus metrics + Grafana alert rules + 8
runbooks, k6 load testing for 12 critical hot paths, query
optimisation tooling, partition activation (worked example +
runbook), Redis cache contracts with circuit-breaker fail-soft, DLQ
admin dashboard with replay/discard, ADR-057 envelope validation
helper for the 17+ Kafka consumer retrofit, three-state circuit
breaker library, three-tier SLO model, and a Platform Admin dashboard
gated on `sys-001:admin`.

The cycle's ten structural deliverables, in priority order:

1. **Trace context propagation** through every request → service →
   Kafka envelope `correlation_id` → consumer log line. AsyncLocalStorage
   context separate from existing tenant context.
2. **Structured JSON logging** per Architecture Review §25.2 with
   required fields (timestamp / level / service_name / trace_id /
   span_id / tenant_id / message). `pnpm lint:logs` CI gate scans for
   `console.log` + email PII.
3. **Prometheus `/metrics`** exposing 13 metrics with `tenant_id`
   labels. Public + tenant-resolver-exempt endpoint.
4. **k6 load tests** for 12 hot paths from the cycle plan
   (POS allergen, library GIN, IAM perm check, attendance,
   GL batch, bus-pass scan, etc.). p95 thresholds documented inline.
5. **Partition activation** worked example on
   `trn_ridership_records` (RANGE/scanned_at, monthly, 24 leaves).
   Runbook in `infra/partition-activation-runbook.md` for the
   remaining 5 candidates using `pg_partman`.
6. **Redis cache contracts** documented in
   `apps/api/src/observability/cache-contracts.md` for all 7 prefixes;
   IAM access cache wired with `@Optional()` injection + 5-min TTL +
   explicit `invalidate()` for the future
   `iam.role_assignment.changed` consumer.
7. **DLQ admin endpoints + UI** with replay (preserves event_id +
   correlation_id + tenant_id via new `KafkaProducerService.emitRaw()`)
   - discard with reason. Envelope validation helper +
     three-state circuit breaker landed alongside.
8. **Three-tier SLO model** (CRITICAL 99.9% / STANDARD 99.5% /
   BACKGROUND 99.0%) with error-budget exhaustion ladder; 8
   Prometheus rule groups; 8 runbooks each referenced by alert
   annotation.
9. **Platform Admin dashboard** gated on `sys-001:admin` (Platform
   Admin only — School Admins do NOT see this surface). 5 web routes:
   landing + tenants + DLQ + partitions + migrations. Reads
   cross-tenant state.
10. **Operational readiness CAT** at `docs/cycle31-cat-script.md`
    walks 10 ops scenarios end-to-end.

**Note on the in-repo / deployment-time split.** Cycle 31 ships every
code + config artifact in repo; production wiring (real Prometheus
scrape, Grafana ops, PagerDuty integration, CloudWatch / Jaeger sinks)
is deployment-time. The cycle plan was explicit about this split and
the handoff calls it out.

---

## Verification surface

### Trace propagation

```
curl -i -H "Authorization: Bearer $TEACHER_TOKEN" \
        -H "X-Tenant-Subdomain: demo" \
        http://localhost:4000/api/v1/classes/my
# Expect: X-Trace-Id and X-Span-Id headers
```

Then tail the API log filtered to that trace_id; expect a
request-log line with `method=GET path=/api/v1/classes/my status=200
duration_ms=...`. Trigger a write that emits Kafka and expect the
envelope's `correlation_id` to match.

### Prometheus metrics

```
curl -s http://localhost:4000/metrics | grep -E '^(http_request_duration_seconds|kafka_consumer_lag|circuit_breaker_state|redis_cache_hits)' | head
# Expect: histograms + gauges + counters with tenant_id label
```

### DLQ admin

```
# Gate test:
curl -i -H "Authorization: Bearer $SCHOOL_ADMIN_TOKEN" \
        -H "X-Tenant-Subdomain: demo" \
        http://localhost:4000/api/v1/admin/dlq/stats
# Expect: 403

# Platform Admin path:
curl -i -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN" \
        -H "X-Tenant-Subdomain: demo" \
        http://localhost:4000/api/v1/admin/dlq/stats
# Expect: 200 + JSON
```

### Platform admin dashboard

```
# Gate test (school admin must not see this):
curl -i -H "Authorization: Bearer $SCHOOL_ADMIN_TOKEN" \
        -H "X-Tenant-Subdomain: demo" \
        http://localhost:4000/api/v1/admin/platform/tenants
# Expect: 403
```

### Partition routing

```sql
INSERT INTO trn_ridership_records (id, school_id, route_id, scanned_at, scan_type, scanned_by)
VALUES (gen_random_uuid(),
        (SELECT id FROM platform.schools LIMIT 1),
        (SELECT id FROM trn_routes LIMIT 1),
        '2024-07-15T08:00:00Z',  -- before the 2025-08 floor
        'BOARDING',
        (SELECT id FROM hr_employees LIMIT 1));
-- Expect: ERROR — no partition of relation "trn_ridership_records" found for row
```

### Lint gate

```
pnpm lint:logs
# Expect: log-schema-lint: ✓ N files clean (exit 0)
```

### Build gate

```
pnpm --filter @campusos/api build && pnpm --filter @campusos/web build
# Expect: both clean
```

---

## Triage table

| #   | Severity | Item | Status |
| --- | -------- | ---- | ------ |
|     |          |      |        |

(Filled in by the reviewer.)

---

## Round 2 verification trail

(Appended after closeout commit.)
