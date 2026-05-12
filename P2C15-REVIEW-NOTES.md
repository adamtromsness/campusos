# REVIEW-P2C15 — Peer Review Scaffold

Scope of review: P2-15 (Analytics Read Models, M110 Analytics .1) — both
sub-cycles. 18 rpt\_\* tables, 15 workers (16 live Kafka consumers + 1
weekly batch + 1 nightly batch), ~18 read endpoints, 2 dashboard hubs.

Commits to review:

- P2-15a Operations Read Models — `2a3e835`
- P2-15b Engagement + Performance + Dashboard + Peer Review Docs — `a669917`
- REVIEW-P2C15 Round 1 fixes — this commit

Plan: `docs/campusos-p2c15-analytics-readmodels.html`
Handoff: `HANDOFF-P2C15.md`

## Round 1 Review Outcome

**Verdict: FAIL → fixes applied → awaiting Round 2.**

Round 1 reviewer surfaced 3 BLOCKING + 3 MAJOR. The Round 1 fix commit
addresses all 3 BLOCKINGs and triages the MAJORs.

| Finding                                              | Status                                                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| BLOCKING 1 — additive UPSERT not idempotent on crash | **FIXED** — `rpt_event_contributions` tenant ledger + in-tx claim helper; every worker uses it.           |
| BLOCKING 2 — batch materialisers cross-school        | **FIXED** — `materialiseKpi` adds `school_id = $2::uuid`; `materialise` JOINs `ath_programmes.school_id`. |
| BLOCKING 3 — payload.schoolId vs envelope unchecked  | **FIXED** — `assertPayloadSchoolMatchesEnvelope` called from every live worker before UPSERT.             |
| MAJOR 4 — source event wiring incomplete             | Carried as Phase 2 punch list (per-topic emit verification chase).                                        |
| MAJOR 5 — read-replica routing comment-only          | Carried — swap to `executeOnReplica` once helper lands (Cycle 32).                                        |
| MAJOR 6 — `rpt-002:read` broad role assignment       | Carried — confirm role distribution before broad enablement.                                              |

### Fix evidence

```bash
# 1. Every read-model worker calls claimReadModelContribution inside a
#    tenant tx — covered by the new regression test
#    "second delivery of the same event_id is a no-op (claim hit)".
grep -c "claimReadModelContribution" apps/api/src/analytics/engagement/engagement-workers.service.ts
# → 9 (one per write-path; Athletics has two: rpt_game_results + rpt_ath_season_summary)
grep -c "claimReadModelContribution" apps/api/src/analytics/operations/operations-workers.service.ts
# → 10 (FoodService has two: rpt_fds_meal_counts + rpt_fds_nslp_summary; Facilities has two)

# 2. Batch materialisers school-scoped.
grep -A1 "FROM fac_work_orders" apps/api/src/analytics/operations/operations-workers.service.ts
# → WHERE school_id = $2::uuid AND created_at >= ...
grep "pr.school_id" apps/api/src/analytics/engagement/engagement-workers.service.ts
# → WHERE pr.school_id = $2::uuid

# 3. Envelope/payload validation.
grep -c "assertPayloadSchoolMatchesEnvelope" apps/api/src/analytics/engagement/engagement-workers.service.ts
# → 8 (one per live worker; OfficialsReadModelWorker is weekly batch — schoolId from cron caller)
grep -c "assertPayloadSchoolMatchesEnvelope" apps/api/src/analytics/operations/operations-workers.service.ts
# → 8 (Facilities has two: upsertInspection + upsertWorkOrder)

# 4. Privacy keystone preserved.
docker exec campusos-postgres psql -U campusos -d campusos_dev -t -c "
  SELECT count(*) FROM information_schema.columns
  WHERE table_schema='tenant_demo' AND table_name='rpt_wellbeing_domain_trends'
    AND column_name='student_id';"
# → 0
```

### Round 1 regression tests

5 new pinned tests in `engagement-workers.spec.ts` across three describe blocks:

- **BLOCKING 1** — `redelivery after partial failure`:
  - second delivery of same event_id is a no-op (claim hit) — counters do NOT double
  - first delivery applies UPSERT and writes one contribution row per target table (Athletics writes 2 contributions, one per target)
- **BLOCKING 2** — `batch materialisers school-scoped`:
  - `OfficialsReadModelWorker.materialise()` JOINs through `ath_programmes.school_id`, binds the schoolId arg, uses `AVG(oa.fee)` (not legacy `stipend`)
- **BLOCKING 3** — `payload schoolId must match envelope`:
  - drops Enrolment event when `payload.schoolId` disagrees with envelope
  - drops Wellbeing event when `payload.schoolId` disagrees with envelope

Vitest: 772 → **777 passing across 36 spec files** (+5 R1 regressions).

### Worker idempotency contract (post-fix)

Each P2-15 read-model worker now follows this contract on every event:

1. Unwrap the ADR-057 envelope (`unwrapEnvelope`).
2. Validate payload shape + required fields → drop with WARN on miss.
3. **B3 — envelope/payload validation**: call
   `assertPayloadSchoolMatchesEnvelope(event, payload.schoolId, group, topic, logger)`.
   Mismatch → WARN + drop, no DB writes.
4. Open `executeInTenantTransaction(async (tx) => { … })`.
5. **B1 — contribution claim**: call `claimReadModelContribution(tx, group, eventId, target)`.
   ON CONFLICT DO NOTHING → if 0 rows inserted, the event was already
   applied (crash-after-update redelivery) → return without UPSERT.
6. If claim succeeded → apply the additive `INSERT ... ON CONFLICT DO UPDATE`
   against the read-model target.
7. Commit the tx (both rows together or neither).
8. After tx commits, `processWithIdempotency` records the outer claim in
   `platform.platform_event_consumer_idempotency` (defence-in-depth — most
   Kafka redeliveries are caught here before the handler even runs).

Workers that write to two target tables (AthleticsReadModelWorker writes
both rpt_game_results + rpt_ath_season_summary; FoodServiceReadModelWorker
writes both rpt_fds_meal_counts + rpt_fds_nslp_summary) record one
contribution row per target, so partial application is impossible — if the
tx commits, both targets land; if it aborts, neither does.

---

## Consumer-to-table mapping (single-writer audit)

This is the load-bearing contract for the read-model architecture.

### P2-15a (migration 146)

| Consumer group                  | Topics consumed                                        | Target rpt\_\* tables                         |
| ------------------------------- | ------------------------------------------------------ | --------------------------------------------- |
| `procurement-readmodel-worker`  | `prc.po.issued`, `prc.receipt.completed`               | `rpt_procurement_summary`                     |
| `store-readmodel-worker`        | `str.order.completed`                                  | `rpt_store_sales`                             |
| `food-service-readmodel-worker` | `fds.meal.served`                                      | `rpt_fds_meal_counts`, `rpt_fds_nslp_summary` |
| `transport-readmodel-worker`    | `trn.run.completed`                                    | `rpt_trn_ridership_summary`                   |
| `facilities-readmodel-worker`   | `fac.inspection.completed`, `fac.work_order.completed` | `rpt_facilities_condition`                    |
| `facilities-readmodel-worker`   | (nightly batch via `materialiseKpi()`)                 | `rpt_facilities_kpi`                          |
| `it-readmodel-worker`           | `tech.device.provisioned`, `deprovisioned`, `incident` | `rpt_tech_fleet_status`                       |
| `library-readmodel-worker`      | `lib.checkout.created`, `lib.return.completed`         | `rpt_lib_circulation_summary`                 |

### P2-15b (migration 147)

| Consumer group                  | Topics consumed                                                                                                                 | Target rpt\_\* tables                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `enrolment-readmodel-worker`    | `enr.application.submitted`, `status_changed`, `enr.offer.issued`, `offer.responded`, `enr.student.enrolled`, `enr.tour.booked` | `rpt_enr_funnel_summary`                     |
| `athletics-readmodel-worker`    | `ath.game.completed`                                                                                                            | `rpt_ath_season_summary`, `rpt_game_results` |
| `officials-readmodel-worker`    | (weekly batch via `materialise()`)                                                                                              | `rpt_officials_marketplace`                  |
| `groups-readmodel-worker`       | `grp.post.created`, `grp.member.joined`, `grp.comment.created`                                                                  | `rpt_grp_engagement_summary`                 |
| `publications-readmodel-worker` | `pub.publication.published`                                                                                                     | `rpt_pub_distribution_summary`               |
| `clubs-readmodel-worker`        | `ext.activity.completed`                                                                                                        | `rpt_ext_service_summary`                    |
| `comms-readmodel-worker`        | `msg.message.sent`, `msg.broadcast.sent`                                                                                        | `rpt_msg_communication_metrics`              |
| `wellbeing-readmodel-worker`    | `svc.wellbeing.response.submitted`                                                                                              | `rpt_wellbeing_domain_trends`                |

**Single-writer invariant:** every rpt\_\* table appears in the right
column of exactly one row. `FoodServiceReadModelWorker` and
`AthleticsReadModelWorker` each write to 2 tables — that's allowed
because the single-writer rule is per-table, not per-worker.

**Reviewer audit hint:** `grep -rE "INTO rpt_[a-z_]+" apps/api/src/`
should return at most one consumer-group writing into each table.

## Rebuild procedures

Each rpt\_\* table can be fully rebuilt by:

### Live consumer (15 of 18 tables)

1. `TRUNCATE rpt_<table>`
2. Reset consumer-group offset to `--to-earliest` on the source topic(s)
3. Delete idempotency claims for that consumer group:
   `DELETE FROM platform.platform_event_consumer_idempotency
WHERE consumer_group = '<group>'`
4. Restart the API; the worker resubscribes at offset 0 and UPSERTs
   reconstruct the rpt\_\* row state.

The UPSERT-on-UNIQUE is the load-bearing rebuild guarantee — replaying
the same payload produces the same row. **The rebuild is exhaustive only
if Kafka retention covers the entire history**; for partial retention,
the dashboard shows the rebuilt window forward.

### Nightly batch (rpt_facilities_kpi)

1. `TRUNCATE rpt_facilities_kpi`
2. Re-invoke `materialiseKpi(schoolId, period)` for each historical period.
3. Idempotency: the worker UPSERTs on `(school, period)` so re-runs
   produce the same row.

### Weekly batch (rpt_officials_marketplace)

1. `TRUNCATE rpt_officials_marketplace`
2. Re-invoke `materialise(schoolId, period)` for each historical ISO
   Monday week.
3. Idempotency: same UPSERT pattern.

## Idempotency approach

Two-layer defence:

### Layer 1: Kafka consumer-group idempotency

`processWithIdempotency(consumerGroup, event, ...)` from
`notification-consumer-base` — claim-after-success per REVIEW-CYCLE2
BLOCKING 2. Claims against `platform.platform_event_consumer_idempotency`
keyed on `(consumer_group, event_id)`. Redelivery of the same envelope
short-circuits before invoking the handler.

### Layer 2: DB UNIQUE constraint UPSERT

Every worker runs `INSERT … ON CONFLICT (…unique cols…) DO UPDATE`.
The schema's UNIQUE INDEX is the wire-level backstop for everything
the consumer-group claim might miss (Kafka rebalance during a partial
write, missing claim row after a DB restore, etc.). Replay of the same
payload produces the same row state.

### Tests pinning the two layers

- `engagement-workers.spec.ts` — every worker spec asserts the SQL
  contains `ON CONFLICT (…) DO UPDATE` and the correct target table.
- `operations-workers.spec.ts` (P2-15a) — same pattern.
- `notification-consumer-base.spec.ts` (Cycle 2) — pins the
  claim-after-success contract.

## Batch vs live decisions

Per the plan (Architecture Review §19):

- **`rpt_facilities_kpi` — NIGHTLY BATCH.** Energy cost data lags the
  work-order stream (utility billing arrives monthly, not per-event).
  A nightly roll-up aligns to the cadence of the upstream data without
  unnecessary write churn.
- **`rpt_officials_marketplace` — WEEKLY BATCH.** Officials assignment
  volume is small (typically <30 per week per school), official ratings
  settle a few days after the game, and a weekly cadence aligns to the
  natural sports week. Live consumption would churn the row dozens of
  times across the week with no read-side benefit.
- **Every other rpt\_\* table — LIVE Kafka consumer.** High-frequency
  source events, dashboards demand near-real-time visibility, and the
  UPSERT path is constant-time so write throughput is not a constraint.

## Wellbeing privacy enforcement

The Cycle 11.1 wellbeing module is the most sensitive data source in
the platform. P2-15b's `rpt_wellbeing_domain_trends` is designed
privacy-first:

### Schema-level invariant

`rpt_wellbeing_domain_trends` has NO `student_id` column. The
aggregation grain is exactly `(school_id, period, grade_level, domain)`.

Verification:

```sql
SELECT count(*) FROM information_schema.columns
WHERE table_schema='tenant_demo'
  AND table_name='rpt_wellbeing_domain_trends'
  AND column_name = 'student_id';
-- → 0
```

### Worker-level invariant

`WellbeingReadModelWorker.upsert()` reads `responseId`, `schoolId`,
`gradeLevel`, `domain`, `numericResponse`, `questionType`, `submittedAt`
from the inbound `svc.wellbeing.response.submitted` payload — but
**writes ONLY** `(id, school_id, period, grade_level, domain, avg_score,
response_count, below_threshold_count, generated_at)`. The
`response_id` is intentionally NEVER persisted.

Verification (pinned in `engagement-workers.spec.ts`):

```typescript
expect(capture[0]!.sql).not.toMatch(/student_id/);
expect(capture[0]!.sql).not.toMatch(/response_id/);
```

### Service-level invariant

`EngagementReadService.listWellbeingDomainTrends()` selects only the
aggregate columns and performs no join on read. The endpoint at
`/api/v1/analytics/wellbeing-trends` is gated on `rpt-002:read` (school
admin / school manager tier) — not held by parents, students, or
teachers.

### Below-threshold heuristic

The `below_threshold_count` column flags SAFETY-domain responses with
`numeric_response = 1` on SCALE_1_5 or `≤ 2` on SCALE_1_10. This
surfaces aggregate trend alerts to counsellors WITHOUT exposing
individual responses. The actual flagged-student list is in
`svc_wellbeing_alerts` (Cycle 11.1) and stays in the Counselling app,
not the analytics surface.

## Read replica routing

Per the plan, all rpt\_\* reads should route to the read replica. Today
both `OperationsReadService` (P2-15a) and `EngagementReadService`
(P2-15b) use `TenantPrismaService.executeInTenantContext` which points
at the primary connection pool.

The contract is replica-friendly — every read service is a thin wrapper
around a single Prisma client call. When `executeOnReplica(fn)` lands
(Cycle 32 multi-region work), swapping in is a one-line change per
service:

```typescript
// today
return this.tenantPrisma.executeInTenantContext(async (client) => { … });

// post-replica
return this.tenantPrisma.executeOnReplica(async (client) => { … });
```

The DB-level rules that make this safe:

- rpt\_\* tables have no FKs to mutable tenant tables (no eager joins
  on read).
- rpt\_\* tables are write-once-per-event (no read-modify-write loops
  that depend on read replica freshness).
- The reads use `SELECT … ORDER BY …` with deterministic LIMITs — even
  a slightly-stale replica produces a stable result.

## CI parity (replay)

```bash
pnpm format:check          # All matched files use Prettier code style!
pnpm lint:logs             # log-schema-lint: 796 files clean
pnpm --filter @campusos/api build      # nest build clean
pnpm --filter @campusos/web build      # Next.js static build clean
pnpm --filter @campusos/api test       # 772 / 772 passing
```

### Critical invariants

```bash
# 1. Privacy — no student_id column on rpt_wellbeing_domain_trends
docker exec campusos-postgres psql -U campusos -d campusos_dev -t -c "
SET search_path = tenant_demo, platform, public;
SELECT count(*) FROM information_schema.columns
WHERE table_schema='tenant_demo' AND table_name='rpt_wellbeing_domain_trends'
  AND column_name='student_id';"
# → 0

# 2. OfficialsReadModelWorker is weekly batch (no OnModuleInit)
grep -B1 -A2 "class OfficialsReadModelWorker" \
  apps/api/src/analytics/engagement/engagement-workers.service.ts
# → export class OfficialsReadModelWorker {
#     private static readonly CONSUMER_GROUP = 'officials-readmodel-worker';
# (no `implements OnModuleInit`)

# 3. Single-writer — confirms 1-to-many mapping (consumer-group → rpt_*)
grep -E "CONSUMER_GROUP = '|INTO rpt_" \
  apps/api/src/analytics/engagement/engagement-workers.service.ts
```

## Phase 2 punch list

These are non-blocking follow-ups for ops + future cycles:

1. **Read replica routing** — swap `executeInTenantContext` for
   `executeOnReplica` once the helper lands (Cycle 32).
2. **OfficialsReadModelWorker cron** — production deployment needs a
   weekly cron job that walks every active school and invokes
   `materialise(schoolId, period)` for the previous ISO week.
3. **rpt_facilities_kpi cron** — same shape, monthly cadence.
4. **Domain emit wiring** — most P2-15b source topics (`grp.post.created`,
   `ext.activity.completed`, `pub.publication.published`,
   `svc.wellbeing.response.submitted`, `msg.message.sent`,
   `msg.broadcast.sent`, `ath.game.completed`) need their owning modules
   to actually emit on the wire. Workers + tables ship today; per-module
   emit wiring lands as those domains stabilise.
5. **Cycle 29 `rpt_wellbeing_trends` legacy retirement** — once no
   schools depend on the nightly-batch shape, drop the legacy table
   (after migrating any UI consumers to `rpt_wellbeing_domain_trends`).
6. **Single-writer CI lint** — the plan calls for CI-enforced
   single-writer. Today it's enforced by convention + spec coverage; a
   future CI step could grep every `INSERT INTO rpt_*` callsite and
   refuse any rpt\_\* target that has more than one writing module.

## Review checklist

For the peer review, please confirm:

- [ ] Migration 147 splitter-safe (no `;` inside string literals or block
      comments).
- [ ] Each new rpt\_\* table has a clear `COMMENT ON TABLE` documenting
      its single writer and source topic(s).
- [ ] Each engagement worker subscribes to exactly its documented topic(s)
      under a unique consumer-group id.
- [ ] `AthleticsReadModelWorker.upsert(game.completed)` writes both
      `rpt_game_results` AND `rpt_ath_season_summary` inside the same
      `executeInTenantContext` callback.
- [ ] `OfficialsReadModelWorker` does NOT implement `OnModuleInit` and
      exposes `materialise(schoolId, period)` as the weekly batch entry
      point.
- [ ] `rpt_wellbeing_domain_trends` has no `student_id` column at the
      schema level AND the `WellbeingReadModelWorker.upsert()` SQL does
      not reference `student_id` or `response_id`.
- [ ] Every UPSERT runs `ON CONFLICT (…) DO UPDATE` against the
      documented UNIQUE constraint.
- [ ] `engagement-workers.spec.ts` has at least one pinned regression test
      per worker covering: target table, UNIQUE constraint shape, and
      payload-validation drop path.
- [ ] CI parity green: format:check + lint:logs (796 files) + API build + web build + vitest 772/772.
