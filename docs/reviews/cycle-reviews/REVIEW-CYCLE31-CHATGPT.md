# REVIEW-CYCLE31-CHATGPT

**Cycle:** 31 — Performance & Observability (Wave 8 opening). The first
ops cycle in CampusOS — **zero new business tables**.
**Round 1 commit:** `cycle31-complete` at `1e2252a`.
**Round 1 verdict:** **Reject pending fixes** — 5 BLOCKING + 5 MAJOR; one MAJOR (#7 `/metrics` deployment ACL) was a follow-up doc note rather than a code fix. All 5 BLOCKING + 1 actionable MAJOR (#9 circuit breaker scope claim) addressed in the closeout commit.
**Round 2 commit:** `e0d0435` on `main` (closeout fix commit).
**Round 2 verdict:** **Approved.** Cycle 31 ships clean. Reviewer's only Round 2 cleanup item was a stale `101_partition_activation.sql` reference in the Step 5 narrative of `HANDOFF-CYCLE31.md` — addressed in the doc-cleanup commit. **Tagging `cycle31-approved`** at the doc-cleanup commit. **Wave 8 (Hardening) opens with this approval.**
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

## Triage table — Round 1

| #   | Severity | Item                                                        | Verdict | Fix commit / Disposition                                         |
| --- | -------- | ----------------------------------------------------------- | ------- | ---------------------------------------------------------------- |
| 1   | BLOCKING | Kafka `correlation_id` ≠ HTTP `trace_id`                    | VALID   | `trace-id.middleware.ts` — `correlationId = traceId`             |
| 2   | BLOCKING | Platform Admin routes still tenant-dependent                | VALID   | `@PlatformScoped()` decorator + middleware exemption + guards    |
| 3   | BLOCKING | DLQ replay can mark resolved when broker down               | VALID   | `emitRaw()` throws `KafkaProducerNotConnectedError`              |
| 4   | BLOCKING | DLQ replay/discard not row-locked / status-safe             | VALID   | Conditional `UPDATE … WHERE resolved_at IS NULL` two-phase       |
| 5   | BLOCKING | Partition migration is destructive (`DROP TABLE … CASCADE`) | VALID   | Migration deleted; runbook is authoritative deployment-time path |
| 6   | BLOCKING | Envelope validation helper not enforced in shared consumer  | VALID   | `KafkaConsumerService.subscribe()` validates by default          |
| 7   | MAJOR    | `/metrics` is public and includes tenant labels             | DOC     | Deployment-time ACL note added to runbook                        |
| 8   | MAJOR    | IAM Redis invalidation Phase 2                              | KNOWN   | Documented; the role-change consumer is already on punch list    |
| 9   | MAJOR    | Circuit breaker library shipped, integration partial        | DOC     | Handoff scope claim narrowed to "library + DLQ replay path"      |
| 10  | MAJOR    | Kafka producer remains best-effort                          | KNOWN   | Phase 2 outbox; explicitly out of Cycle 31 scope                 |

## Round 1 fix verification trail

**BLOCKING 1 — correlation_id == trace_id.** Single-line change in `apps/api/src/observability/trace-id.middleware.ts`: `const correlationId = traceId;`. The downstream `envelopeFromOptions()` already prefers `getTraceContext()?.correlationId`, so HTTP-originated emits now carry the same correlation_id as the response `X-Trace-Id`. Worker-originated emits (no request context) generate their own correlation_id at emit time as before — `eventEnvelope.ts` falls back to a fresh UUIDv7 when the trace context is empty.

**BLOCKING 2 — `@PlatformScoped()` decorator.** New `apps/api/src/auth/platform-scoped.decorator.ts` exports `PlatformScoped()` + `PLATFORM_SCOPED_KEY`. Three integration points:

- `apps/api/src/tenant/tenant-resolver.middleware.ts` exempts `/api/v1/admin/platform` and `/api/v1/admin/dlq` from tenant resolution. Callers do not need `X-Tenant-Subdomain`.
- `apps/api/src/tenant/tenant.guard.ts` short-circuits when `@PlatformScoped()` is set so frozen-tenant + tenant-context checks don't apply.
- `apps/api/src/auth/permission.guard.ts` resolves only the PLATFORM IAM scope (via new `PermissionCheckService.resolvePlatformScope()`) for platform-scoped routes. A school admin with `sys-001:admin` at SCHOOL scope cannot reach `/admin/platform` via the school → platform chain.
- `DlqController` and `PlatformAdminController` carry `@PlatformScoped()` at the controller level.

**BLOCKING 3 — `emitRaw()` throws on disconnected broker.** `apps/api/src/kafka/kafka-producer.service.ts` exports `KafkaProducerNotConnectedError` and `emitRaw()` now throws it (rather than logging and returning) when the producer is not connected. The best-effort `emit()` path is unchanged.

**BLOCKING 4 — DLQ replay/discard atomic two-phase.** `DlqService.replay()` now runs a three-phase pattern: (1) atomic claim via `UPDATE … SET resolution = 'REPLAYING' WHERE id = $1 AND resolved_at IS NULL` — exactly one of N concurrent admins wins; loser sees `BadRequestException`. (2) `emitRaw()`. If it throws, revert the row to PENDING. `KafkaProducerNotConnectedError` is translated to HTTP 503 so the operator can retry. (3) Finalise REPLAYED only after confirmed send. `discard()` uses the same conditional-UPDATE pattern in a single statement.

**BLOCKING 5 — partition migration removed.** `packages/database/prisma/tenant/migrations/101_partition_activation.sql` has been deleted. The runbook at `infra/partition-activation-runbook.md` is now the authoritative deployment-time procedure with a non-destructive rename → create → copy → row-count verify → drop pattern wrapped in `BEGIN; ... COMMIT;` so a failure rolls back. Demo and test tenants already converted via the prior provision retain the partitioned shape; fresh provisions use the original Cycle 19 schema and convert via the runbook only.

**BLOCKING 6 — central envelope validation.** `apps/api/src/kafka/kafka-consumer.service.ts` now calls `assertValidEnvelope()` on every consumed message before dispatching to the handler. Default ON via `validateEnvelope?: boolean` option (defaults to true). Failures park to DLQ with `error_class=EnvelopeValidationError`. Every existing consumer registered via `subscribe()` gets the validation for free; no per-consumer retrofit required.

**MAJOR 7 — `/metrics` ACL note.** `infra/runbooks/oncall.md` updated to call out the deployment-time ACL requirement. The endpoint is intentionally public + tenant-exempt for Prometheus scraping; production deployments must restrict network access to the scraper itself.

**MAJOR 9 — circuit breaker scope claim narrowed.** `HANDOFF-CYCLE31.md` clarified that Cycle 31 ships the circuit-breaker library + integration into the DLQ replay path; integration into Redis / Kafka producer / Stripe / external dependency call sites is per-cycle work as those domains evolve. The Step 8 alert rule (`CircuitBreakerOpen` PAGE) is forward-compatible.

**MAJORs 8 + 10** — already on the broader Phase 2 punch list. No code change.

---

## Open follow-ups

These are the deferred items the reviewer raised that intentionally stay carried as Phase 2 backlog:

- IAM Redis invalidation consumer (`iam.role_assignment.changed`) — Phase 2; today the 5-minute TTL is the staleness window.
- Circuit-breaker integration into Redis / Kafka producer / Stripe / external dependency call sites — per-cycle work.
- Kafka producer transactional outbox — Cycle 32 (Multi-Region & DR).
- `/metrics` deployment ACL — runbook clarification only; ops responsibility.
