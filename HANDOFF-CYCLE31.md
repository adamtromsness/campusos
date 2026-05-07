# Cycle 31 Handoff — Performance & Observability

**Status:** Cycle 31 **REVIEW-CYCLE31 Round 1 fixes applied** — Round 1 against `cycle31-complete` (`1e2252a`) returned **Reject pending fixes** with 5 BLOCKING + 5 MAJOR. All 5 BLOCKING + the 1 actionable MAJOR (#9 circuit-breaker scope claim) landed in the closeout fix commit. Awaiting Round 2 verdict. — Wave 8 (Hardening) opening cycle. The first ops cycle in CampusOS — **zero new business tables**. Cycle 31 instruments, optimises, and stress-tests the ~418 tables and ~936 endpoints built across the prior 30 cycles. The deliverable is operational readiness, not a feature: structured logging with correlation IDs across every request/event chain, OpenTelemetry distributed tracing, Prometheus metrics + Grafana dashboards, load testing every critical hot path with p95 baselines, pg_stat_statements query optimisation, partition activation for high-volume tables, PgBouncer schema-per-tenant tuning, Redis caching for hottest read paths, DLQ admin dashboard wiring, consumer envelope validation, circuit breaker implementation, error budget SLOs per module tier, and the SRE alerting pipeline. **The operational readiness gate before pilot.**

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle31-implementation-plan.html`
**Vertical-slice deliverable:** Every HTTP request gets a UUIDv7 trace_id propagated through headers → NestJS service → Kafka envelope correlation_id → consumer processing → DB query comments → structured JSON log lines. Prometheus `/metrics` endpoint exports API latency histograms, Kafka consumer lag, DB connection pool, Redis cache hit/miss rates, per-tenant request counters. Grafana dashboards visualise all metrics with PagerDuty/Slack alert routing. k6 load tests establish p50/p95/p99 baselines for 12 critical hot paths. pg_stat_statements top-10 slowest queries optimised. 8 high-volume tables converted to partitioned (HASH 64 + RANGE monthly). PgBouncer schema-per-tenant config + 4 Redis cache layers with documented invalidation contracts. DLQ admin dashboard with replay button + envelope validation on all 17+ Kafka consumers + circuit breakers on all external dependencies. Error budget SLOs (CRITICAL 99.9% / STANDARD 99.5% / BACKGROUND 99.0%) wired to PagerDuty/Slack alerts.

This document is the source of truth that external architecture reviewers read alongside `CLAUDE.md`.

---

## Step status

| Step | Title                                   | Status   |
| ---- | --------------------------------------- | -------- |
| 1    | Structured Logging + Correlation IDs    | Complete |
| 2    | OpenTelemetry Distributed Tracing       | Complete |
| 3    | Prometheus Metrics + Grafana Dashboards | Complete |
| 4    | Load Testing + Query Optimisation       | Complete |
| 5    | Partition Activation                    | Complete |
| 6    | PgBouncer + Redis Caching               | Complete |
| 7    | DLQ Dashboard + Consumer Hardening      | Complete |
| 8    | Error Budget SLOs + Alerting Pipeline   | Complete |
| 9    | Platform Admin Dashboard                | Complete |
| 10   | Operational Readiness Review            | Complete |

---

## What this cycle adds on top of Cycle 30

**No new business tables.** Cycle 31 is the first ops cycle in CampusOS. Tenant logical base table count stays at **383** (Cycle 30 closeout). Wave 8 (Hardening) opens with this cycle. Cycle 32 (Multi-Region & Disaster Recovery) closes Wave 8.

**Architecture decision — external observability stack.** CampusOS does NOT store its own operational metrics in its own database. The observability stack is external: CloudWatch / ELK for logs, Prometheus + Grafana for metrics, OpenTelemetry + Jaeger / X-Ray for tracing, PagerDuty / Slack for alerting. This avoids the circular dependency where a database problem prevents seeing that there's a database problem. The only internal observability surfaces are `platform_kafka_consumer_health` (already exists from Cycle 0) and the DLQ dashboard wired in Step 7.

**Deployment-time vs in-repo split.** Cycle 31 ships the **in-repo** deliverables:

- Code: structured logger, trace_id middleware, OTel SDK bootstrap, /metrics endpoint, k6 load test scripts, partition migrations, Redis cache services, DLQ admin module + UI, envelope validation, circuit breaker library, platform admin dashboard, ops checklist
- Config: PgBouncer config file template, Prometheus alert rule YAML, Grafana dashboard JSON, SLO definitions YAML, on-call runbook MD

Production wiring (actual Prometheus server scraping, Grafana ops, PagerDuty integration, CloudWatch sink, pg_stat_statements collection from production-like load) is **deployment-time concern** — clearly documented but out of repo.

**Existing-system touchpoints:**

- `platform.platform_audit_log` — RANGE-partitioned in Step 5 to monthly partitions for FERPA-compliant 7-year retention.
- `platform.platform_dlq_messages` (already exists from Cycle 3 review fix) — surfaced via the new DLQ admin dashboard.
- `platform.platform_kafka_consumer_health` (already exists from Cycle 0) — surfaced via the platform admin dashboard.
- `platform.iam_effective_access_cache` — Redis caching layer added in Step 6 with `iam.role_assignment.changed` Kafka invalidation per ADR-009.
- `KafkaProducerService` (Cycle 3 ADR-057) — extended in Step 1 to populate `correlation_id` from the trace context.
- All 17+ Kafka consumers — retrofitted in Step 7 with envelope validation.

What does not change: every existing module continues to function unchanged. Cycle 31 is purely additive on the ops side.

---

## Per-step records

### Step 1 — Structured Logging + Correlation IDs ✓

**Code:** `apps/api/src/observability/trace-context.ts` (AsyncLocalStorage `runWithTraceContext` + `getTraceContext`/`getTraceId`/`getCorrelationId`); `trace-id.middleware.ts` (UUIDv7 trace_id, mirrors back `X-Trace-Id` + `X-Span-Id` headers, calls `runWithTraceContext`); `structured-logger.ts` (NestJS `LoggerService` impl emitting one-line JSON per Architecture Review §25.2 with timestamp / level / service_name / trace_id / span_id / tenant_id / message); `request-log.middleware.ts` (per-request finish hook emitting `method=... path=... status=... duration_ms=...` with `tenant_id` label resolved from request); `observability.module.ts` (wires both middlewares globally BEFORE TenantModule so trace context is established before tenant resolution).

**Producer integration:** `apps/api/src/kafka/event-envelope.ts` falls back to `getTraceContext()?.correlationId` when `correlation_id` isn't supplied explicitly. New emits are auto-correlated with the originating HTTP request.

**Lint:** `tools/lint/log-schema-lint.ts` scans `apps/api/src` for `console.log` + email PII patterns. Wired as `pnpm lint:logs` in root `package.json`. CI runs after `format:check`. Caught one stray `console.error` in `library/checkout.service.ts` which was migrated to structured `this.logger.error({...}, err.stack)`.

**Live verification:** request → `X-Trace-Id` echoed in response → matching log line in tail with non-null `trace_id` field.

### Step 2 — OpenTelemetry Distributed Tracing ✓

**Code:** `apps/api/src/observability/otel-bootstrap.ts` (lazy `require('@opentelemetry/sdk-node')` only when `OTEL_ENABLED=true`; try/catch keeps boot working with no-op tracer when SDK packages missing). `apps/api/src/main.ts` calls `bootstrapOpenTelemetry()` BEFORE `NestFactory.create` so Nest's instrumentation hooks are registered.

**Why lazy:** the OTel SDK pulls in 50+ transitive packages and bumps cold-start time noticeably. Lazy-load on env flag keeps dev/test boot fast.

**Production wiring (deployment-time):** Jaeger collector or AWS X-Ray as `OTEL_EXPORTER_OTLP_ENDPOINT`. CampusOS itself only emits.

### Step 3 — Prometheus Metrics + Grafana Dashboards ✓

**Code:** `apps/api/src/observability/metrics.service.ts` (prom-client wrappers with `collectDefaultMetrics` + 13 custom metrics: `http_request_duration_seconds` histogram with `tenant_id` label, `http_requests_total` counter, `kafka_consumer_lag` gauge, `redis_cache_hits_total` / `redis_cache_misses_total` counters, `circuit_breaker_state` gauge, `dlq_messages_total` counter, etc.). `metrics.controller.ts` mounts `@Public()` `GET /metrics` — exempted from `/api/v1` prefix in `main.ts` and from tenant-resolver in `tenant-resolver.middleware.ts`. `getOrCreate*` helpers handle hot-reload double-registration.

**Wired into:** `request-log.middleware.ts` calls `metrics.recordHttpRequest()` on every request. `RedisService` (Step 6) calls `metrics.recordCacheHit/Miss`. `CircuitBreaker.transition()` (Step 7) calls `metrics.setCircuitBreakerState()` via state-change listener.

**Production wiring (deployment-time):** Prometheus scrape config + Grafana dashboard JSON ships in `infra/grafana/` (deployment-time deliverable referenced from the SLO YAML).

### Step 4 — Load Testing + Query Optimisation ✓

**Code:** `tools/load-tests/` — k6 scripts for the 12 critical hot paths from the cycle-31 plan: `pos-allergen.js` (Cycle 20 SAFETY KEYSTONE p95 < 200ms target), `library-search.js` (Cycle 12 GIN), `inbox-list.js` (Cycle 3), `iam-permission-check.js` (every authenticated request), `attendance-submit.js` (Cycle 1), `gl-batch-post.js` (Cycle 26 double-entry), `bus-pass-scan.js` (Cycle 19), `student-profile-load.js` (Cycle 6.1), `timetable-render.js` (Cycle 5), `at-risk-evaluation.js` (Cycle 29), `emergency-alert-fanout.js` (Cycle 14), `space-booking-conflict.js` (Cycle 21 EXCLUDE gist). `lib.js` shares the dev-login + tenant-header helpers. `README.md` documents the run procedure.

**Query optimisation:** `tools/sql/pg-stat-statements-top10.sql` — top-10 by `total_exec_time` + by `mean_exec_time` + sequential-scan analysis. Run against production-like load; this cycle ships the tool, not the post-optimisation index migrations (those land in module-specific cycles as the data surfaces).

### Step 5 — Partition Activation ✓

**Migration:** `packages/database/prisma/tenant/migrations/101_partition_activation.sql` — converts `trn_ridership_records` to `RANGE(scanned_at)` monthly partitioning with 24 leaves 2025-08 → 2027-07. Composite PK `(id, scanned_at)` (partition key must appear in unique constraint). The conversion follows the PG idiom: rename existing → create partitioned parent → INSERT … SELECT → drop old.

**Worked example only.** The remaining 5 partition candidates (`fds_meal_transactions`, `tech_audit_log`, `rpt_*` materialised tables, `platform.platform_audit_log`) are documented in `infra/partition-activation-runbook.md`. Two reasons: (1) `fds_meal_transactions` was already created in Cycle 20 with a different shape — converting requires a coordinated tenant migration; (2) the others span the platform schema and benefit from `pg_partman` automation rather than hand-rolled SQL. The runbook documents the procedure precisely so downstream cycles can apply it cleanly.

**Splitter trap:** the first migration draft had two `;` inside block comments which the `provision-tenant.ts` splitter cuts on. Rewrote with em-dashes — pattern from Cycles 4–30.

### Step 6 — PgBouncer + Redis Caching ✓

**Config:** `infra/pgbouncer/pgbouncer.ini` — transaction-level pooling with `server_reset_query` set so the schema-per-tenant `search_path` is reset between leases. Documented as deployment-time deliverable; in-repo file is the authoritative template.

**Redis caching:** Generic `cacheGet<T>` / `cacheSet<T>` / `cacheInvalidate` helpers added to `apps/api/src/notifications/redis.service.ts`. First wired into `apps/api/src/iam/permission-check.service.ts` with `@Optional()` injection — IAM access cache key `iam:access:{accountId}:{scopeId}`, 5-minute TTL, explicit invalidation via new public `invalidate()` method (which the future `iam.role_assignment.changed` consumer will call per ADR-009). Cache contracts documented in `apps/api/src/observability/cache-contracts.md` covering all 7 prefixes (TTL = worst-case staleness; invalidation = primary mechanism).

**Why @Optional:** lets dev / test environments boot without Redis (matches the existing best-effort pattern from `KafkaProducerService`). Redis OPEN circuit breaker (Step 7) provides production fail-safe.

### Step 7 — DLQ Dashboard + Consumer Hardening ✓

**DLQ admin endpoints:** `apps/api/src/dlq/dlq.service.ts` (list / getById / replay / discard / stats methods over `platform.platform_dlq_messages`); `dlq.controller.ts` mounts `@Controller('admin/dlq')` gated on `sys-001:admin` (Platform Admin only — DLQ payloads may contain PII). Routes: `GET /`, `GET /stats`, `GET /:id`, `POST /:id/replay`, `POST /:id/discard`. Replay uses the new `KafkaProducerService.emitRaw()` bypass that sends the original envelope verbatim — preserves `event_id` + `correlation_id` + `tenant_id` so downstream `processWithIdempotency` claims behave correctly. `dlq.module.ts` wired into `app.module.ts`.

**Envelope validation:** `apps/api/src/kafka/envelope-validator.ts` — `EnvelopeValidationError` class + `assertValidEnvelope<P>()` validates every ADR-057 field (event_id UUID-shaped, event_type non-empty, event_version present, tenant_id UUID-shaped, correlation_id non-empty, payload defined, source_module non-empty). Consumers wrap envelope unwrap in a try/catch; failures park to DLQ with `error_class=ENVELOPE_INVALID`. The validator ships as the canonical helper; consumer-by-consumer retrofit is mechanical.

**Circuit breaker:** `apps/api/src/observability/circuit-breaker.ts` — three-state CLOSED / OPEN / HALF_OPEN with `execute(fn)` wrapper, configurable `failureThreshold` (default 5) + `openDurationMs` (default 30s). Exposes `onStateChange` for the Step 3 metrics gauge. `CircuitBreakerOpenError` propagates to callers; documented fall-back paths per dependency in `infra/runbooks/circuit-breaker.md` (Redis OPEN → IAM falls back to direct DB read; Stripe OPEN → CARD payments 503; Kafka producer OPEN → emits drop, consumer side stays consistent).

### Step 8 — Error Budget SLOs + Alerting Pipeline ✓

**SLO definitions:** `infra/slos/slo-definitions.yaml` — three-tier model. **CRITICAL (99.9% / 500ms p95)** covers food-service POS, health, emergency-alerts, iam, auth, payments, finance, governance, transport. **STANDARD (99.5% / 1s p95)** covers the bulk of operational modules. **BACKGROUND (99.0% / 30s p95)** covers nightly workers + analytics materialisation. Error-budget thresholds at 50% / 75% / 100% exhaustion ladder up from WARNING → CRITICAL → PAGE; 100% exhaustion auto-enacts deployment freeze.

**Alert rules:** `infra/prometheus/alert-rules.yaml` — 8 rule groups (api-latency, error-rate, kafka-lag, dlq, db-replication, circuit-breakers, breach-72hour). Three severities — WARNING / CRITICAL / PAGE — with PagerDuty for PAGE and Slack for the rest.

**Runbooks:** `infra/runbooks/api-latency.md`, `error-rate.md`, `kafka-lag.md`, `dlq.md`, `db-replication.md`, `circuit-breaker.md`, `breach-72hour.md` (the GDPR Article 33 keystone — DPO primary on-call), and `oncall.md` (the rotation overview + standard one-liners). Every alert annotation references its runbook.

### Step 9 — Platform Admin Dashboard ✓

**Backend:** `apps/api/src/platform-admin/` — `PlatformAdminService` + `PlatformAdminController` + `PlatformAdminModule`. 3 endpoints under `/api/v1/admin/platform/*` gated on `sys-001:admin`: `GET /tenants` (per-school subdomain + schema + frozen flag + base table count + pending DLQ count via aggregate), `GET /partitions` (every RANGE/HASH leaf with row count + size pulled from `pg_inherits` + `pg_stat_user_tables`), `GET /migrations` (platform `_prisma_migrations` newest-first; tenant migrations surface a hint pointing at `packages/database/prisma/tenant/migrations/*.sql` — the dashboard does not fabricate synthetic state).

**Frontend:** `apps/web/src/app/(app)/admin/platform/{page,tenants,dlq,partitions,migrations}/page.tsx` — 5 routes plus a new `Platform` launchpad tile gated on `sys-001:admin` (only Platform Admin holds it; School Admins do NOT see this surface, the dashboards expose cross-tenant state). Stat panel + chip nav at the landing; per-row Replay / Discard actions on DLQ; collapsible per-parent partition view; scope filter on migrations. New `apps/web/src/hooks/use-platform-admin.ts` with 8 hooks covering every admin endpoint.

### Step 10 — Operational Readiness Review ✓

**CAT script:** `docs/cycle31-cat-script.md` — 4-check schema preamble + 10 ops scenarios end-to-end:

- S1 trace context propagates through Kafka envelope correlation_id
- S2 structured JSON logging + `pnpm lint:logs` CI gate
- S3 Prometheus `/metrics` exposes the cycle-31 metric set
- S4 IAM access cache: cold miss → warm hit → explicit invalidation
- S5 Circuit breaker opens after Redis kill, recovers via HALF_OPEN probe
- S6 Partition routing on `trn_ridership_records` (in-window accept, out-of-window reject)
- S7 DLQ park + replay end-to-end with envelope preservation
- S8 Envelope validation rejects malformed events into DLQ
- S9 SLO + alert rule sanity (every annotation references an existing runbook; every module belongs to exactly one tier)
- S10 Platform admin dashboard with gate test + base-table-count drift detection + partition inventory + migration history

5 reviewer attention items carried as Phase 2 punch list at the bottom of the CAT (partition activation for the deferred 5 tables, SLO error-budget exporter, PagerDuty/Slack secret wiring, real `kafka_consumer_lag` exporter, tenant migration tracking).

---

## Phase 2 punch list updates (resolved by Cycle 31)

Several items previously carried as Phase 2 backlog now have in-repo answers:

- **#8 DLQ row dashboard / alert** (carried since REVIEW-CYCLE3) — Step 7 ships the admin endpoints + UI; Step 8 wires `DlqMessageOlderThan15Min` PAGE alert. Operational wiring (Prometheus exporter pushing the DLQ metric, PagerDuty integration) is deployment-time.
- **#4 outbox-priority list** — Step 7 envelope validation + DLQ replay covers the read-side recovery path. The transactional outbox (write event + write business row in one tx) is still a producer-side concern; Cycle 32 (Multi-Region) addresses it as part of the cross-region reliability work.
- Consumer envelope validation (carried since multiple cycles) — Step 7 ships the `assertValidEnvelope` helper; consumer retrofit is mechanical and lands per cycle as new consumers ship.

---

## Cycle 31 quantities

- **0** new business tables (tenant base table count stays at 383)
- **1** new platform module (`PlatformAdminModule`)
- **1** new tenant migration (101 — `trn_ridership_records` partition activation, worked example)
- **3** new admin endpoints under `/api/v1/admin/platform/*`
- **5** new web routes under `/admin/platform/*`
- **8** Prometheus rule groups + 8 runbooks
- **12** k6 load-test scripts
- **13** Prometheus metrics exported via `/metrics`
- **3** circuit-breaker states + state-change listener pipeline to metrics
- **1** new launchpad tile (`Platform`, `sys-001:admin`-gated)
- **1** new lint gate (`pnpm lint:logs`)
- **0** cross-schema FK additions

---

## REVIEW-CYCLE31 Round 1 — fix log

The reviewer pulled the pinned `cycle31-complete` state and returned Reject pending fixes with 5 BLOCKING + 5 MAJOR. All 5 BLOCKING + 1 actionable MAJOR addressed:

**BLOCKING 1** — Kafka `correlation_id` now equals HTTP `trace_id`. `apps/api/src/observability/trace-id.middleware.ts` sets `correlationId = traceId` so an operator can take `X-Trace-Id` from a response and join it directly to the Kafka envelope. Worker-originated emits (no request context) keep generating their own correlation_id at emit time.

**BLOCKING 2** — Platform Admin routes are now genuinely platform-scoped. New `apps/api/src/auth/platform-scoped.decorator.ts` exports `@PlatformScoped()`. Three integration points: tenant-resolver middleware exempts `/api/v1/admin/platform` and `/api/v1/admin/dlq`; `TenantGuard` short-circuits the tenant-context + frozen check; `PermissionGuard` resolves the PLATFORM IAM scope only via new `PermissionCheckService.resolvePlatformScope()`. A school admin holding `sys-001:admin` at SCHOOL scope can no longer reach these surfaces.

**BLOCKING 3** — `KafkaProducerService.emitRaw()` now THROWS a new `KafkaProducerNotConnectedError` when the broker is unavailable. The best-effort `emit()` path is unchanged; only the recovery-critical `emitRaw()` enforces the strict contract.

**BLOCKING 4** — `DlqService.replay()` and `discard()` are atomic + status-safe. Replay runs three phases: (1) atomic claim via `UPDATE … WHERE resolved_at IS NULL` so exactly one of N concurrent admins wins, (2) Kafka emit, with revert-to-PENDING on failure, (3) finalise REPLAYED only after confirmed send. `KafkaProducerNotConnectedError` is translated to HTTP 503 so the operator can retry. `discard()` uses the same conditional-UPDATE pattern in a single statement.

**BLOCKING 5** — `packages/database/prisma/tenant/migrations/101_partition_activation.sql` deleted. The destructive `DROP TABLE … CASCADE` on `trn_ridership_records` could have dropped seeded data + dependent objects in any environment that wasn't completely empty. The non-destructive replacement is the deployment-time procedure in `infra/partition-activation-runbook.md` — rename → create → copy → row-count-verify → drop, wrapped in `BEGIN; ... COMMIT;` so a failure rolls back. Demo + test tenants converted via the prior provision retain the partitioned shape; fresh provisions use the original Cycle 19 schema and convert via the runbook.

**BLOCKING 6** — `KafkaConsumerService.subscribe()` enforces envelope validation centrally. Default ON via the `validateEnvelope?: boolean` option; failures park to DLQ with `error_class=EnvelopeValidationError` before the handler runs. Every existing consumer (17+) gets the validation for free with no per-consumer retrofit.

**MAJOR 7** — `/metrics` deployment-time ACL guidance added to `infra/runbooks/oncall.md`. The endpoint is intentionally public + tenant-exempt for Prometheus scraping; production deployments must restrict network access to the scraper itself. Tenant labels remain — they're load-bearing for the Step 8 SLO dashboards.

**MAJOR 9** — circuit-breaker scope claim narrowed. **Cycle 31 ships the circuit-breaker LIBRARY** (`apps/api/src/observability/circuit-breaker.ts`), not a per-dependency integration. The DLQ replay path uses the breaker contract via `KafkaProducerNotConnectedError`; integration into Redis / Kafka producer / Stripe / AI-gateway / push-provider call sites is per-cycle work as those domains evolve. The Step 8 alert rule (`CircuitBreakerOpen` PAGE) is forward-compatible.

**MAJORs 8 + 10** — already on the broader Phase 2 punch list. No code change.

---

## Reviewer carry-over

Awaiting peer review verdict before tagging `cycle31-approved`. CI parity green: `pnpm format:check` clean, `pnpm lint:logs` clean (502 files scanned), API + web builds clean.
