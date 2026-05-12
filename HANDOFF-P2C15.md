# HANDOFF — Phase 2 Cycle 15 (Analytics Read Models)

**Scope.** P2-15 ships M110 Analytics .1 — 18 domain-specific materialised
read models wired to live Kafka consumers, replacing the nightly batch
materialisation from Cycle 29 for every operational + engagement domain.
Single-writer architecture per ADR-008 CQRS-lite + Architecture Review
§19 Read Model Ownership.

**Pre-split into 2 sub-cycles.** Both shipped in this PR cycle:

- **P2-15a — Operations Read Models** at commit `2a3e835`. 9 tables
  (`rpt_procurement_summary`, `rpt_store_sales`, `rpt_fds_meal_counts`,
  `rpt_fds_nslp_summary`, `rpt_trn_ridership_summary`,
  `rpt_facilities_condition`, `rpt_facilities_kpi`,
  `rpt_tech_fleet_status`, `rpt_lib_circulation_summary`), 7 workers
  (9 Kafka consumers), ~9 read endpoints. Migration `146`.
- **P2-15b — Engagement + Performance Read Models** at the current
  commit. 9 tables (`rpt_enr_funnel_summary`, `rpt_ath_season_summary`,
  `rpt_officials_marketplace`, `rpt_game_results`,
  `rpt_grp_engagement_summary`, `rpt_pub_distribution_summary`,
  `rpt_ext_service_summary`, `rpt_msg_communication_metrics`,
  `rpt_wellbeing_domain_trends`), 8 workers (7 live + 1 weekly batch),
  ~9 read endpoints, analytics dashboard hub. Migration `147`.

**Cumulative P2-15.** 18 rpt\_\* tables, 15 workers (16 live consumers +
1 weekly batch + 1 nightly batch — `rpt_facilities_kpi` from P2-15a is
the second batch worker alongside `rpt_officials_marketplace`),
~18 read endpoints under `/api/v1/analytics/*`, 2 dashboard hub routes.

## Naming Decisions

### `rpt_wellbeing_trends` → `rpt_wellbeing_domain_trends`

The P2-15b plan named the wellbeing read model `rpt_wellbeing_trends`.
Cycle 29 had already shipped a table at that name with a different
grain — `(school_id, grade_level, period_start, period_end)` and
columns `avg_wellbeing_score`, `wants_to_talk_count`, `flagged_count`.

CampusOS migration convention is **additive only — no DROP TABLE / DROP
COLUMN / DROP UNIQUE INDEX**. The simplest path that honours both the
plan's per-domain grain AND the additive rule is to create a new table
`rpt_wellbeing_domain_trends` with the planned columns
`(school_id, period, grade_level, domain, avg_score, response_count,
below_threshold_count)`, and leave the Cycle 29 `rpt_wellbeing_trends`
alone. Both tables are privacy-safe — neither carries `student_id`.

The Cycle 29 `WellbeingTrendsWorker.materialise()` nightly batch
continues to write to the legacy table (invoked from the manual
worker-run controller); the new P2-15b `WellbeingReadModelWorker`
live-consumes `svc.wellbeing.response.submitted` and writes to the
new domain-grained table. The single-writer rule is per-table; both
writers are well-defined.

The public `/api/v1/analytics/wellbeing-trends` endpoint shipped in
P2-15b reads from `rpt_wellbeing_domain_trends` (the new aggregate).
The legacy Cycle 29 grade-grain endpoint at `/api/v1/analytics/wellbeing`
continues to read from `rpt_wellbeing_trends`.

## Schema

### Migration 146 (P2-15a Operations)

9 tables under `rpt_*` prefix. Tenant logical base table count after
146: previous baseline + 9.

| Table                         | Grain                                | Source topics                                          | Owner                      |
| ----------------------------- | ------------------------------------ | ------------------------------------------------------ | -------------------------- |
| `rpt_procurement_summary`     | (school, period, department, vendor) | `prc.po.issued`, `prc.receipt.completed`               | ProcurementReadModelWorker |
| `rpt_store_sales`             | (school, period, product)            | `str.order.completed`                                  | StoreReadModelWorker       |
| `rpt_fds_meal_counts`         | (school, service_date, meal_type)    | `fds.meal.served`                                      | FoodServiceReadModelWorker |
| `rpt_fds_nslp_summary`        | (school, month_year)                 | `fds.meal.served`                                      | FoodServiceReadModelWorker |
| `rpt_trn_ridership_summary`   | (school, route, period)              | `trn.run.completed`                                    | TransportReadModelWorker   |
| `rpt_facilities_condition`    | (school, building, space)            | `fac.inspection.completed`, `fac.work_order.completed` | FacilitiesReadModelWorker  |
| `rpt_facilities_kpi`          | (school, period)                     | `fac.work_order.*`, `fac.energy.*` (**NIGHTLY BATCH**) | FacilitiesReadModelWorker  |
| `rpt_tech_fleet_status`       | (school, device_type)                | `tech.device.provisioned`, `deprovisioned`, `incident` | ITReadModelWorker          |
| `rpt_lib_circulation_summary` | (school, period)                     | `lib.checkout.created`, `lib.return.completed`         | LibraryReadModelWorker     |

`FoodServiceReadModelWorker` writes to BOTH `rpt_fds_meal_counts`
(daily grain) and `rpt_fds_nslp_summary` (monthly federal grain).
Same worker, two target tables — still single-writer per table.

### Migration 147 (P2-15b Engagement)

9 tables under `rpt_*` prefix.

| Table                           | Grain                                 | Source topics                                                  | Owner                       |
| ------------------------------- | ------------------------------------- | -------------------------------------------------------------- | --------------------------- |
| `rpt_enr_funnel_summary`        | (school, academic_year)               | `enr.application.*`, `enr.offer.*`, `enr.tour.booked`          | EnrolmentReadModelWorker    |
| `rpt_ath_season_summary`        | (school, season, programme)           | `ath.game.completed`                                           | AthleticsReadModelWorker    |
| `rpt_officials_marketplace`     | (school, period) — ISO Monday week    | `ath_official_assignments` (**WEEKLY BATCH**)                  | OfficialsReadModelWorker    |
| `rpt_game_results`              | (school, game)                        | `ath.game.completed`                                           | AthleticsReadModelWorker    |
| `rpt_grp_engagement_summary`    | (school, group, period)               | `grp.post.created`, `grp.member.joined`, `grp.comment.created` | GroupsReadModelWorker       |
| `rpt_pub_distribution_summary`  | (school, period)                      | `pub.publication.published`                                    | PublicationsReadModelWorker |
| `rpt_ext_service_summary`       | (school, academic_year, club)         | `ext.activity.completed`                                       | ClubsReadModelWorker        |
| `rpt_msg_communication_metrics` | (school, period)                      | `msg.message.sent`, `msg.broadcast.sent`                       | CommsReadModelWorker        |
| `rpt_wellbeing_domain_trends`   | (school, period, grade_level, domain) | `svc.wellbeing.response.submitted`                             | WellbeingReadModelWorker    |

`AthleticsReadModelWorker` writes to BOTH `rpt_game_results` (per-game
grain) and `rpt_ath_season_summary` (per-season rollup). Same worker,
two tables — still single-writer per table.

**Privacy invariant on `rpt_wellbeing_domain_trends`.** Schema has NO
`student_id` column. Aggregation grain is exactly
`(school, period, grade_level, domain)`. The worker UPSERTs against
the `(school_id, period, grade_level, domain)` UNIQUE constraint and
the SQL does not reference `student_id` or `response_id` at any point.
A pinned regression test in `engagement-workers.spec.ts` asserts the
SQL does not match `/student_id/` or `/response_id/`.

### Constraint smoke

`docker exec campusos-postgres psql -t -c` against `tenant_demo`:

```
9 rpt_engagement tables present
0 student_id columns on rpt_wellbeing_domain_trends
9 P2-15b tables seeded:
  - rpt_enr_funnel_summary: 1
  - rpt_ath_season_summary: 2
  - rpt_officials_marketplace: 2
  - rpt_game_results: 4
  - rpt_grp_engagement_summary: 3
  - rpt_pub_distribution_summary: 2
  - rpt_ext_service_summary: 2
  - rpt_msg_communication_metrics: 3
  - rpt_wellbeing_domain_trends: 5
```

## Backend

### Module wiring

`apps/api/src/analytics/analytics.module.ts` registers 8 new workers +
1 new read service + 1 new controller for P2-15b on top of the P2-15a
providers. AnalyticsModule imports `TenantModule`, `IamModule`,
`KafkaModule`.

### Endpoints (P2-15b)

All gated on `rpt-001:read` or `rpt-002:read`. All routes route through
`EngagementReadService.executeInTenantContext` (replica-friendly).

```
GET /api/v1/analytics/enrolment-funnel       rpt-001:read
GET /api/v1/analytics/athletics-season       rpt-001:read
GET /api/v1/analytics/officials              rpt-002:read   (weekly batch)
GET /api/v1/analytics/game-results           rpt-001:read
GET /api/v1/analytics/groups-engagement      rpt-001:read
GET /api/v1/analytics/publications           rpt-001:read
GET /api/v1/analytics/clubs                  rpt-001:read
GET /api/v1/analytics/communications         rpt-001:read
GET /api/v1/analytics/wellbeing-trends       rpt-002:read   (aggregate only)
```

### Workers (P2-15b)

| Worker                        | Type         | Consumer group                  | Topics consumed                                                                                                                                     |
| ----------------------------- | ------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EnrolmentReadModelWorker`    | Live (Kafka) | `enrolment-readmodel-worker`    | `enr.application.submitted`, `enr.application.status_changed`, `enr.offer.issued`, `enr.offer.responded`, `enr.student.enrolled`, `enr.tour.booked` |
| `AthleticsReadModelWorker`    | Live (Kafka) | `athletics-readmodel-worker`    | `ath.game.completed`                                                                                                                                |
| `OfficialsReadModelWorker`    | Weekly batch | `officials-readmodel-worker`    | n/a — `materialise(schoolId, period)` invoked from cron / ops worker                                                                                |
| `GroupsReadModelWorker`       | Live (Kafka) | `groups-readmodel-worker`       | `grp.post.created`, `grp.member.joined`, `grp.comment.created`                                                                                      |
| `PublicationsReadModelWorker` | Live (Kafka) | `publications-readmodel-worker` | `pub.publication.published`                                                                                                                         |
| `ClubsReadModelWorker`        | Live (Kafka) | `clubs-readmodel-worker`        | `ext.activity.completed`                                                                                                                            |
| `CommsReadModelWorker`        | Live (Kafka) | `comms-readmodel-worker`        | `msg.message.sent`, `msg.broadcast.sent`                                                                                                            |
| `WellbeingReadModelWorker`    | Live (Kafka) | `wellbeing-readmodel-worker`    | `svc.wellbeing.response.submitted`                                                                                                                  |

Every live worker uses the standard P2-15a pattern (`dispatchOperationsEvent`

- `processWithIdempotency`, claim-after-success per REVIEW-CYCLE2
  BLOCKING 2). Each worker:

1. Subscribes to its topic(s) under a unique consumer group.
2. Unwraps the ADR-057 envelope.
3. Runs the handler inside `processWithIdempotency` so Kafka redelivery
   doesn't double-write.
4. UPSERTs against the rpt\_\* UNIQUE constraint.
5. Records the committed Kafka offset to `rpt_analytics_worker_checkpoints`.

`OfficialsReadModelWorker` is a plain `@Injectable()` with NO
`OnModuleInit` hook — confirmed by `engagement-workers.spec.ts`. The
batch entry point is `materialise(schoolId, period)` which aggregates
from `ath_official_assignments` and UPSERTs the row.

### Idempotency

- **Kafka-side**: `processWithIdempotency` claims after success against
  `platform.platform_event_consumer_idempotency` keyed on
  `(consumer_group, event_id)`. Redelivery of the same envelope is a
  no-op.
- **DB-side**: every UPSERT runs `INSERT ON CONFLICT (…unique cols…)
DO UPDATE`. Replaying the same payload yields the same row.
- **Both layers together**: the database UNIQUE constraint is the
  belt-and-braces backstop for the consumer-group idempotency claim.

### Rebuild procedure

Any rpt\_\* table can be fully rebuilt from Kafka:

```bash
# 1. Truncate the target rpt_* table
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "SET search_path = tenant_demo, platform, public; TRUNCATE rpt_enr_funnel_summary;"

# 2. Reset the consumer-group offset to 0
docker exec campusos-kafka kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --group enrolment-readmodel-worker --topic 'dev.enr.*' --reset-offsets --to-earliest --execute

# 3. Reset the idempotency claims for the group
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "DELETE FROM platform.platform_event_consumer_idempotency
   WHERE consumer_group = 'enrolment-readmodel-worker';"

# 4. Restart the API — the worker resubscribes at the new offset and
#    replays every envelope. UPSERTs reconstruct the rpt_* row.
pnpm --filter @campusos/api dev
```

The weekly batch path is different — `OfficialsReadModelWorker.materialise(schoolId, period)`
is called from the cron / ops worker. To rebuild, truncate the row(s)
and invoke `materialise()` for each `(school, period)` pair you want.

## Seed

`seed-analytics-engagement.ts` (idempotent — gated on whether
`rpt_enr_funnel_summary` already has at least one row for the demo
school). Wired as `seed:analytics-engagement` in `package.json` and
into `seed-all.ts` between `seed-analytics-operations.ts` and
`seed-dpo.ts`.

Sample state on `tenant_demo`:

- 1 enrolment funnel row (2026-2027 with 142 apps → 82 enrolled = 57.75% conversion)
- 2 athletics season rows (BASKETBALL 12-5-1 + SOCCER 9-6-1)
- 2 officials marketplace weeks
- 4 game results (2 BASKETBALL + 2 SOCCER)
- 3 groups engagement rows
- 2 publications distribution months
- 2 clubs service rows
- 3 communications metrics months
- 5 wellbeing domain trends (5 domains × Grade 5 × April)

## Web

### Dashboard hub

`/analytics` updated — replaces the inline P2-15a + P2-15b nav-chip
strips with two prominent module cards:

- **Operations (P2-15a)** → `/analytics/operations` consolidated view
- **Engagement & performance (P2-15b)** → `/analytics/engagement` consolidated view

### `/analytics/operations` (P2-15a hub)

9-card grid. Each card shows the headline KPI for its module:
procurement spend + POs + avg lead, store revenue + units, meal counts,
NSLP (manager only), ridership (manager only), facilities condition

- KPI (manager only), tech fleet (manager only), library circulation.

### `/analytics/engagement` (P2-15b hub)

9-card grid. Headline KPIs per module: enrolment funnel applications

- enrolled + conversion, athletics season record + win rate, officials
  fill rate (manager only, weekly badge), recent games list, groups
  engagement, publications, clubs, communications delivery + read rates,
  and wellbeing trends (manager only, **violet "Aggregate only" badge**
- privacy notice).

### Hooks

`apps/web/src/hooks/use-analytics-readmodels.ts` exports 18 React Query
hooks — one per endpoint across P2-15a + P2-15b. Each hook gates on
an `enabled` boolean so persona gating doesn't fire 403 requests.

## Tests

### `engagement-workers.spec.ts` — 13 vitest cases

- `EnrolmentReadModelWorker.upsert(application.submitted)` UPSERTs on
  `(school, academic_year)`.
- `EnrolmentReadModelWorker.upsert(student.enrolled)` increments enrolled.
- `AthleticsReadModelWorker.upsert(game.completed)` writes BOTH
  `rpt_game_results` AND `rpt_ath_season_summary`.
- `OfficialsReadModelWorker` does NOT implement `OnModuleInit` — weekly
  batch only.
- `OfficialsReadModelWorker.materialise(school, period)` UPSERTs on
  `(school, period)`.
- `GroupsReadModelWorker.upsert(post.created)` increments `posts_count`
  on `(school, group, period)`.
- `PublicationsReadModelWorker.upsert(publication.published)` UPSERTs
  on `(school, period)`.
- `ClubsReadModelWorker.upsert(activity.completed)` UPSERTs on
  `(school, academic_year, club)`.
- `CommsReadModelWorker.upsert(message.sent)` bumps `messages_sent` and
  `(msg.broadcast.sent)` bumps `broadcasts_sent` (not messages_sent).
- **PRIVACY KEYSTONE — WellbeingReadModelWorker SQL does NOT reference
  `student_id` or `response_id` columns.**
- `WellbeingReadModelWorker` flags SAFETY SCALE_1_5=1 responses as
  `below_threshold`.
- `WellbeingReadModelWorker` drops payloads missing required fields.

Cycle 15 total vitest: 772 passing (was 759 pre-P2-15b — `+13`).

## CI Parity

```
✓ pnpm format:check    — All matched files use Prettier code style!
✓ pnpm lint:logs       — log-schema-lint: 796 files clean
✓ pnpm --filter @campusos/api build    — nest build clean
✓ pnpm --filter @campusos/web build    — Next.js static build clean
✓ pnpm --filter @campusos/api test     — 772 / 772 passing
```

### Critical parity invariants

```bash
# 1. rpt_wellbeing_domain_trends has no student_id column
docker exec campusos-postgres psql -U campusos -d campusos_dev -t -c "
SELECT count(*) FROM information_schema.columns
WHERE table_schema='tenant_demo' AND table_name='rpt_wellbeing_domain_trends' AND column_name='student_id';"
# → 0

# 2. OfficialsReadModelWorker is weekly batch (no OnModuleInit)
grep -A1 "class OfficialsReadModelWorker" apps/api/src/analytics/engagement/engagement-workers.service.ts
# → export class OfficialsReadModelWorker {
#     private static readonly CONSUMER_GROUP = 'officials-readmodel-worker';

# 3. Single-writer — each rpt_* table written by exactly one consumer-group
grep -E "CONSUMER_GROUP = '|INTO rpt_" apps/api/src/analytics/engagement/engagement-workers.service.ts
# → confirms 1-to-many mapping: each consumer-group maps to its own rpt_* targets,
#   AthleticsReadModelWorker writes to BOTH rpt_ath_season_summary AND rpt_game_results
#   (single writer, two target tables).
```

## Carry-forward items for peer review

1. **Read replica routing.** `EngagementReadService` + `OperationsReadService`
   both use `tenantPrisma.executeInTenantContext` which currently points
   at the primary. Production deployment swaps in `executeOnReplica`
   when that helper lands (P2-15 plan + Cycle 32 multi-region work).
2. **`rpt_wellbeing_trends` (Cycle 29) coexists with
   `rpt_wellbeing_domain_trends` (P2-15b).** Documented under "Naming
   Decisions" above. Both are privacy-safe; the legacy table can be
   retired in a future cleanup cycle when no schools still depend on
   the nightly-batch shape.
3. **OfficialsReadModelWorker cron wiring.** The worker exposes
   `materialise(schoolId, period)` but no cron job invokes it yet.
   First production deployment needs a weekly cron that walks every
   active school via `platform.schools` and invokes the worker per
   `(school, ISO Monday of last week)` pair.
4. **`rpt_facilities_kpi` nightly cron wiring.** Same shape as #3 — the
   worker exposes `materialiseKpi(schoolId, period)` but no cron yet
   invokes it.
5. **Real domain events on the wire.** Many of the source topics
   (`grp.post.created`, `ext.activity.completed`, `pub.publication.published`,
   etc.) need to be emitted by their owning modules to feed the live
   consumers. The workers + tables ship today; emit wiring lands per-module
   as those domains stabilise.
