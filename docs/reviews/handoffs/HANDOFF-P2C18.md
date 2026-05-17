# P2-18 Facilities Advanced — Handoff

**Status:** COMPLETE + APPROVED at the closeout commit (REVIEW-P2C18-CHATGPT — final verdict, 2026-05-12). Round 1 verdict against `c739ad8` + `e1307e6` was FAIL with 6 BLOCKING + 2 MAJOR; Round 2 verdict against `c99ea93` is PASS. Tagged `p2c18-complete` at `c99ea93` and `p2c18-approved` at the closeout commit. **Wave D (Module Completion) opens with this approval.**

Two non-blocking carry-overs to Phase 2 / pre-pilot per the Round 2 reviewer's gate decision: Facilities Manager role split (FAC-001..005 currently granted to generic Staff; joins the broader role-split chain) and TicketsModule-owned cleaning-issue consumer move (the cross-module write is defended end-to-end by the Round 1 guards; moving the code into Tickets is recommendation-class polish).

## REVIEW-P2C18 Round 1 fix log (2026-05-12)

Round 1 against `c739ad8` + `e1307e6` returned **FAIL** with 6 BLOCKING
items and 2 MAJOR items. The Round 1 fix commit lands all 6 BLOCKING
plus 17 new regression tests in
`apps/api/src/facilities/facilities-p2c18-review.spec.ts`. MAJORs (FM
role split, TicketsModule-owned consumer move) carried as Phase 2 /
pre-pilot punch list items per the reviewer's gate decision.

### BLOCKING 1 — Durable outbox for 3 facilities emits

All three facilities emits flipped from best-effort
`KafkaProducerService.emit()` to durable
`OutboxService.enqueueInTx(tx, ...)` INSIDE the triggering tenant tx:

- `fac.route_stop.issue_noted` — `CleaningRouteService.patchStopCompletion`.
  The outbox row commits with the stop_completion UPDATE so a broker
  outage no longer drops the downstream ticket materialisation.
  Deterministic event_id from
  `deterministicRouteStopIssueNotedEventId(stopCompletionId)`.
- `fac.work_order.created` — `ZoneInspectionService.create` on FAIL
  inspections. The outbox row commits with the work order + inspection
  INSERT pair. New helper
  `deterministicWorkOrderCreatedEventId(workOrderId)` keys on the work
  order id so retries land the same envelope.
- `fac.fire_drill.overdue` — `FireDrillService.compliance`. The
  dashboard scan now runs inside `executeInTenantTransaction` and
  enqueues a per-overdue-building row inside the same tx. Deterministic
  event_id from
  `deterministicFireDrillOverdueEventId(buildingId, today_iso)` so two
  scans on the same day land the same envelope; a fresh-day scan emits
  a fresh envelope so the alert can repeat each day until a drill is
  logged.

Constructor signatures on `CleaningRouteService`, `ZoneInspectionService`,
and `FireDrillService` swap `KafkaProducerService` → `OutboxService`.

### BLOCKING 2 — CleaningIssueTicketConsumer cross-module hardening

The consumer stays in `apps/api/src/facilities/` for this cycle —
moving the materialisation into a Tickets-owned consumer is the
correct long-term shape but the refactor is a Phase 2 architectural
change. The class-level comment now documents the cross-module write
as a **formal exception** with three Round 1 guards:

1. **Envelope-vs-payload tenant validation** in `handle()` — drops the
   event when `payload.schoolId !== event.tenant.schoolId` with a WARN
   log and claims the idempotency record so the bad envelope can't
   loop forever on redelivery.
2. **School-scoped category lookup** — `SELECT id FROM tkt_categories
WHERE school_id = $1::uuid AND is_active = true AND name ILIKE
'%facilit%' OR '%custodial%' OR ...` — the envelope tenant id is
   the first parameter so only categories in the right tenant match.
3. **School-scoped requester fallback** — the school admin lookup
   JOINs `iam_scope sc + iam_scope_type st` requiring
   `st.code = 'SCHOOL'` AND `sc.entity_id = $envelopeSchoolId`.
   PLATFORM-scope admins are intentionally excluded — they're not the
   right requester for an auto-ticket scoped to a single school.

The ticket INSERT uses `envelopeSchoolId` (the authoritative source)
as the `school_id` binding, not the potentially-attacker-controlled
`payload.schoolId`.

### BLOCKING 3 — Cleaning route helpers school-scoped

- `getRouteById(id)` adds `AND r.school_id = $2::uuid`.
- `patchRoute(id, ...)` UPDATE adds `AND school_id = $N::uuid` with
  `RETURNING id` — zero-row RETURNING is the 404 signal.
- `listStops(routeId)` JOINs `fac_cleaning_routes r` filtered on
  `r.school_id`.
- `replaceStops(routeId, ...)` route-row lock now adds
  `AND school_id = $2::uuid FOR UPDATE`.
- `listStopCompletions(completionId)` JOINs the parent completion +
  route filtered on `r.school_id`.

A School A actor with a School B route/completion UUID now collapses
to 404 or empty-list, rather than reading or mutating the foreign-
school row.

### BLOCKING 4 — Zone inspection `getById` school-scoped

`ZoneInspectionService.getById` JOIN clause adds `AND z.school_id =
$2::uuid` so a School A reader with a School B inspection UUID
collapses to 404 don't-leak-existence.

### BLOCKING 5 — Asset `spaceId` validated through current-school building

- `AssetService.createAsset` validates the supplied `spaceId` via
  `fac_spaces s JOIN fac_buildings b ON b.id = s.building_id WHERE
s.id = $1 AND b.school_id = $2 AND b.id = $3` (asset's building) so
  cross-school spaces are refused with a 400 before INSERT.
- `AssetService.patchAsset` reads the asset's existing `building_id`
  inside the patch, then runs the same JOIN against the new `spaceId`
  before performing the UPDATE.

### BLOCKING 6 — Energy reading `getReading` school-scoped

`EnergyService.getReading` JOINs `fac_utility_meters m ON m.id =
r.meter_id` filtered on `m.school_id = $2::uuid` so a School A reader
with a School B reading UUID collapses to 404 don't-leak-existence.

### Test coverage

vitest 848 → **865 passing across 41 spec files**:

- 17 new regression tests in
  `apps/api/src/facilities/facilities-p2c18-review.spec.ts` across 6
  REVIEW-P2C18 ROUND 1 describe blocks (R-B1a–d for the outbox emits +
  deterministic event_ids + on-PASS-doesn't-emit; R-B2a–d for the
  CleaningIssueTicketConsumer envelope/category/admin/INSERT guards;
  R-B3a–d for the four cleaning-route helpers; R-B4 zone inspection
  JOIN; R-B5a–b asset spaceId on create + patch; R-B6 energy reading
  JOIN).
- Existing `facilities-advanced.spec.ts` + `facilities-assets.spec.ts`
  test stubs extended with a unified `kafka` stub exposing both `emit`
  (legacy) and `enqueueInTx` (current) so the existing assertions on
  the keystone topics keep matching after the outbox migration.

### CI parity at the Round 1 closeout

- `pnpm format:check` clean.
- `pnpm lint:logs` clean (829 files).
- `pnpm --filter @campusos/api build` clean.
- `pnpm --filter @campusos/web build` clean (265 routes).
- `pnpm --filter @campusos/api test` — **865/865 passing across 41
  spec files**.

No schema migrations in Round 1 — every fix is service-layer +
consumer-layer + the new `deterministicWorkOrderCreatedEventId`
helper added to `apps/api/src/facilities/event-ids.ts`.

### Carried to Phase 2 / pre-pilot punch list

- **Facilities Manager role split** — FAC-001..005 currently granted
  to generic Staff role; joins the broader Counsellor / Nurse / FSM /
  Librarian / AD role-split work before pilot.
- **TicketsModule-owned cleaning-issue consumer** — the cross-module
  write is now defended end-to-end by the Round 1 guards, but the
  correct long-term architectural shape is a Tickets-owned consumer
  (or a `tsk_auto_task_rules` row driving the Cycle 7 TaskWorker with
  a Tickets-owned action). Recommendation-class polish.

---

**Plan:** `docs/campusos-p2c18-facilities-advanced.html`
**Review scaffold:** `P2C18-REVIEW-NOTES.md`
**Sub-cycles:** P2-18a (commit `c739ad8`) + P2-18b (this commit).

## Summary

P2-18 closes the M65 Facilities Management module begun in Cycle 21. It
ships 21 new tenant `fac_*` base tables across 2 migrations (151 + 152),
~46 endpoints across 5 new services + 1 new controller per sub-cycle
(9 services + 2 controllers total for P2-18), 2 new Kafka emit topics
(`fac.route_stop.issue_noted` + `fac.fire_drill.overdue`), and 1 new
Kafka consumer (`CleaningIssueTicketConsumer`).

Tenant logical base table count after P2-18b: **666 → 676** (the live
count differs depending on prior counted base tables but the delta is
+10 from P2-18b; cumulative P2-18 delta is +21 across both
sub-cycles). 0 cross-schema FKs across the whole cycle.

## P2-18a — Cleaning Routes + Supply Audit + Work Order Depth

**Schema (migration 151):** 11 base tables —
`fac_cleaning_routes`, `fac_cleaning_route_stops`,
`fac_cleaning_route_assignments`, `fac_cleaning_route_completions`,
`fac_cleaning_route_stop_completions`, `fac_zone_inspections`,
`fac_supply_transactions`, `fac_supply_stocktakes`,
`fac_supply_stocktake_items`, `fac_work_order_attachments`,
`fac_work_order_parts`.

**Services (4):** `CleaningRouteService`, `ZoneInspectionService`,
`SupplyAuditService`, `WorkOrderDepthService`.

**Controller (1):** `FacilitiesAdvancedController` (~24 endpoints under
`fac-001:read/write` and `fac-003:read/write/admin`).

**Kafka:**

- Emit `fac.route_stop.issue_noted` from
  `CleaningRouteService.patchStopCompletion` on
  `issues_noted IS NOT NULL`, with deterministic v5-shape event_id from
  `deterministicRouteStopIssueNotedEventId(stopCompletionId)`.
- Consume `fac.route_stop.issue_noted` →
  `CleaningIssueTicketConsumer` materialises a `tkt_tickets` row per
  event so the helpdesk queue picks up the maintenance follow-up.
- Re-use of Cycle 21 emit `fac.work_order.created` from
  `ZoneInspectionService.create` on FAIL inspections — same tenant tx
  as the inspection insert.

**Three structural keystones in P2-18a:**

1. **Cleaning route stop completion → auto-ticket.** When a custodian
   submits a per-stop completion with `issues_noted` populated, the
   service emits `fac.route_stop.issue_noted`. The downstream
   `CleaningIssueTicketConsumer` creates a `tkt_tickets` row in the
   helpdesk queue so the FM team can follow up on every issue logged
   by the custodian.

2. **Zone inspection FAIL → auto-work-order.** When a supervisor
   submits a zone inspection with `overall_rating='FAIL'`, the service
   creates a follow-up `fac_work_orders` row inside the same tenant
   tx as the inspection insert and back-fills
   `follow_up_work_order_id` on the inspection. The work order lands
   as `priority=HIGH` `work_order_type=DEEP_CLEAN` `status=OPEN` with
   a description threaded from the inspection notes.

3. **Stocktake completion → ADJUSTMENT fan-out.** When an FM marks a
   stocktake COMPLETED, the service walks every item where
   `actual_quantity != expected_quantity`, creates an ADJUSTMENT
   `fac_supply_transactions` row per discrepancy, and updates the
   matching `fac_supply_inventory.current_quantity` to the actual
   figure — all inside one tenant tx. Rolling inventory + transaction
   log stay consistent.

**Seed (`seed-facilities-advanced-a.ts`):** 2 cleaning routes (one
6-stop EVENING, one 3-stop MORNING) + 9 stops + 2 assignments (one
recurring weekday + one one-off) + 2 completions (one COMPLETED with 6
COMPLETED stops + one PARTIAL with 1 SKIPPED + 1 COMPLETED with
`issues_noted` driving the keystone) + 2 zone inspections (1 PASS + 1
FAIL with auto-linked follow-up WO) + 10 supply transactions + 1
COMPLETED stocktake with 8 items (2 discrepancies materialised as
ADJUSTMENT transactions) + 3 work order attachments + 4 work order
parts.

## P2-18b — Fire Drills + Assets + Energy + Space Utilisation + Sustainability

**Schema (migration 152):** 10 base tables —
`fac_fire_drills`, `fac_asset_categories`, `fac_assets`,
`fac_asset_maintenance_records`, `fac_asset_disposals`,
`fac_utility_meters`, `fac_energy_readings`, `fac_energy_targets`,
`fac_space_utilization_records`, `fac_sustainability_initiatives`.

**Services (5):** `FireDrillService`, `AssetService`, `EnergyService`,
`SpaceUtilisationService`, `SustainabilityService`.

**Controller (1):** `FacilitiesAssetsController` (~22 endpoints under
`fac-004:read/write` and `fac-005:read/write`).

**Kafka:** Emit `fac.fire_drill.overdue` from
`FireDrillService.compliance` per overdue building, with deterministic
v5-shape event_id from
`deterministicFireDrillOverdueEventId(buildingId, computedAtIsoDate)`
so multiple scans on the same day produce the same envelope (downstream
consumer idempotency catches redelivery cleanly).

**Three structural keystones in P2-18b:**

1. **Asset disposal SAFETY KEYSTONE — DECOMMISSIONED required.**
   `AssetService.dispose` locks the parent `fac_assets` row FOR UPDATE
   inside one tenant tx, validates `status='DECOMMISSIONED'`, then
   INSERTs `fac_asset_disposals`. The schema cannot encode the
   cross-row invariant (a CHECK can't reach another table), so the
   service layer is the authoritative gate (matching the Cycle 6
   invoice cancel-and-refund pattern). Schema-side belt-and-braces:
   `UNIQUE(asset_id)` on `fac_asset_disposals` catches double-dispose
   under concurrent admin actions and `RESTRICT` on asset delete
   preserves the disposal audit. Verified by spec S4 (refuses
   non-DECOMMISSIONED) and S6 (UNIQUE 23505 → 409).

2. **Energy reading consumption auto-compute.**
   `EnergyService.recordReading` locks the parent meter row FOR UPDATE
   inside one tenant tx, reads the most-recent earlier reading on the
   same meter, computes `consumption = current - prior`, and INSERTs
   the new row with consumption pre-materialised. NULL on the first
   reading per meter. Refuses readings that drop below the prior value
   (meters only count up). `UNIQUE(meter_id, reading_date)` catches
   duplicate-day inserts and translates to friendly 409. Verified by
   spec S8a (auto-compute), S8b (NULL first reading), S9 (rollback
   refusal), S10 (UNIQUE 23505 → 409).

3. **Fire drill 90-day compliance.**
   `FireDrillService.compliance` LEFT JOINs every `fac_buildings` row
   against the most-recent drill, flags rows where the most-recent
   drill is missing or older than 90 days, and emits
   `fac.fire_drill.overdue` per overdue building (deterministic
   event_id per (buildingId, today_iso) so multiple scans on the same
   day produce the same envelope). Compliance endpoint also returns
   the full per-building status so the dashboard can render the rose-
   tinted overdue cards. Verified by spec S3.

**Cross-row invariants:**

- `fac_assets.decom_chk` keeps `decommissioned_at` and
  `decommissioned_by` in lockstep with `status='DECOMMISSIONED'`.
  `AssetService.decommission` stamps both in the same UPDATE so the
  multi-column CHECK never fires mid-flight. Verified by spec S7.
- `fac_energy_readings.UNIQUE(meter_id, reading_date)` caps one
  reading per meter per day — re-reads go through admin correction.
- `fac_energy_targets` uses the COALESCE-sentinel UNIQUE pattern from
  Cycle 5 sch_periods + Cycle 6 enr_intake_capacities + Cycle 12
  lib_reading_lists so a NULL-academic_year baseline row coexists with
  named-year overrides.
- `fac_space_utilization_records` materialises `utilisation_rate` at
  insert time as `occupancy_count / capacity` (NULL when capacity is
  zero) so the underused-spaces dashboard filters without
  division-by-zero juggling. Service refuses `occupancyCount >
capacity`. Verified by spec S11a (rate materialisation) and S11b
  (over-capacity refusal).

**Seed (`seed-facilities-advanced-b.ts`):** 2 fire drills (1 met
target + 1 overrun with `issues_noted`) + 3 asset categories (HVAC
15yr 6mo, Electrical 20yr 12mo, Elevator 25yr 6mo) + 8 assets (5
ACTIVE, 2 UNDER_MAINTENANCE, 1 DECOMMISSIONED) + 5 maintenance records
(1 with overdue next_maintenance_date) + 1 disposal
(DECOMMISSIONED elevator → SCRAP $350 value recovered) + 3 utility
meters + 12 energy readings (3 first readings carry NULL consumption +
9 auto-computed) + 2 energy targets (MONTHLY electricity + ANNUAL gas)

- 10 space utilisation records (Room 104 consistently underused at
  ~37%) + 2 sustainability initiatives (LED Retrofit + Water Audit).

## Cumulative P2-18 surface

- **21 new tenant base tables** across 2 migrations (151 + 152).
- **~46 new endpoints** across 2 controllers
  (FacilitiesAdvancedController + FacilitiesAssetsController).
- **2 new Kafka emit topics** (`fac.route_stop.issue_noted` from
  P2-18a + `fac.fire_drill.overdue` from P2-18b).
- **1 new Kafka consumer** (`CleaningIssueTicketConsumer` from P2-18a).
- **Re-use of Cycle 21 emit** `fac.work_order.created` from
  ZoneInspectionService.

## Cross-cycle dependencies

- Cycle 21 `fac_buildings` + `fac_spaces` + `fac_zones` +
  `fac_supply_inventory` + `fac_work_orders` — referenced by P2-18a
  and P2-18b via DB-enforced FKs.
- Cycle 8 `tkt_tickets` — `CleaningIssueTicketConsumer` materialises
  rows here.
- Cycle 5 `sch_periods` — `fac_space_utilization_records.period_id`
  is a DB-enforced FK (SET NULL on period delete).

## Permission code distribution

P2-18 uses the existing FAC-001..005 codes from the catalogue:

| Code    | Name                         | P2-18 surface                                                                |
| ------- | ---------------------------- | ---------------------------------------------------------------------------- |
| FAC-001 | Maintenance Tickets          | Work order attachments + parts                                               |
| FAC-002 | Preventive Maintenance       | (not used in P2-18)                                                          |
| FAC-003 | Custodial Management         | Cleaning routes + zone inspections + supply transactions + stocktakes        |
| FAC-004 | Building Safety & Compliance | Fire drills + assets + maintenance + disposal + dashboards                   |
| FAC-005 | Energy & Sustainability      | Meters + readings + targets + space utilisation + sustainability initiatives |

`FAC-001..005:admin` granted to School Admin + Platform Admin via
`everyFunction`. Staff grants follow the Cycle 21 spec —
`FAC-001..005:read+write` on the FM stand-in.

## CI parity

- Format: clean (`pnpm format:check`).
- Lint: clean (`pnpm lint:logs` — 828 files).
- API build: clean (`pnpm --filter @campusos/api build`).
- Web build: clean (`pnpm --filter @campusos/web build` — 265 routes).
- Vitest: **848 passing** across 40 spec files (P2-18a +20 in
  `facilities-advanced.spec.ts`, P2-18b +18 in
  `facilities-assets.spec.ts`).
- Live tenant provision: clean on both `tenant_demo` and
  `tenant_test`. Migration 152 splitter audit clean on first attempt.
- Live seed: idempotent — re-run logs "fac_asset_categories already
  populated for demo school. Skipping." with no INSERTs.

## Phase 2 / pre-pilot punch list

- **Cycle 14 NotificationConsumer wiring for `fac.fire_drill.overdue`**
  — the emit lands cleanly with deterministic event_id; an admin
  notification (rose-tinted IN_APP) should land in `notif:inapp:*`
  Redis ZSETs per overdue building.
- **Cycle 7 TaskWorker rule for `fac.route_stop.issue_noted`** — the
  current consumer creates `tkt_tickets` directly; an alternate path
  could materialise a personal task on the FM's task list.
- **Maintenance partition strategy for fac_asset_maintenance_records**
  — the table is a hot growth path; once volume hits, RANGE-partition
  on `performed_date` (annual leaves) per the Cycle 19
  `trn_vehicle_positions` precedent.
- **Energy reading bulk upload** — the API ships per-row POST today.
  Schools that read meters monthly off paper logs would benefit from
  a bulk upload endpoint that runs the auto-compute chain across many
  readings in one tenant tx.
- **Sustainability initiative outcome tracking** — `outcome_notes` is
  free-form text. A future cycle could add a structured
  `fac_sustainability_outcomes` child table with per-quarter measured
  values vs the `target_reduction_percent`.
- **Asset photo + document attachments** — schools want photo +
  warranty document storage per asset. Add
  `fac_asset_attachments` (mirrors `fac_work_order_attachments`).
- **Facilities Manager role split** — generic Staff currently grants
  all FAC-001..005 codes. Joins the broader role-split punch list
  before pilot for a dedicated FM role.

## Smoke runbook

```bash
# Reset + re-seed P2-18b (assumes seed-facilities-advanced-a already ran)
docker exec campusos-postgres psql -U campusos -d campusos_dev <<'SQL'
SET search_path TO tenant_demo, platform, public;
TRUNCATE fac_fire_drills, fac_asset_disposals, fac_asset_maintenance_records,
         fac_assets, fac_asset_categories, fac_energy_readings, fac_energy_targets,
         fac_utility_meters, fac_space_utilization_records,
         fac_sustainability_initiatives RESTART IDENTITY CASCADE;
SQL
pnpm --filter @campusos/database seed:facilities-advanced-b

# Verify keystones
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "\
SET search_path TO tenant_demo, platform, public; \
SELECT (SELECT count(*) FROM fac_fire_drills) AS fire_drills, \
       (SELECT count(*) FROM fac_assets) AS assets, \
       (SELECT count(*) FROM fac_assets WHERE status='DECOMMISSIONED') AS decom, \
       (SELECT count(*) FROM fac_asset_disposals) AS disposals, \
       (SELECT count(*) FROM fac_asset_maintenance_records \
         WHERE next_maintenance_date < CURRENT_DATE) AS overdue_maint, \
       (SELECT count(*) FROM fac_energy_readings \
         WHERE consumption IS NOT NULL) AS readings_with_consumption, \
       (SELECT count(*) FROM fac_sustainability_initiatives \
         WHERE status='ACTIVE') AS active_initiatives;"
```

Expected: 2 fire drills, 8 assets (1 DECOMMISSIONED), 1 disposal,
1 overdue maintenance, 9 readings with consumption, 2 active
initiatives.

## What ships in this cycle

Two new files for P2-18b at the schema + seed layer:

- `packages/database/prisma/tenant/migrations/152_fac_assets_energy.sql`
- `packages/database/src/seed-facilities-advanced-b.ts`

Nine new files for P2-18b at the API layer:

- `apps/api/src/facilities/fire-drill.service.ts`
- `apps/api/src/facilities/asset.service.ts`
- `apps/api/src/facilities/energy.service.ts`
- `apps/api/src/facilities/space-utilisation.service.ts`
- `apps/api/src/facilities/sustainability.service.ts`
- `apps/api/src/facilities/facilities-assets.controller.ts`
- `apps/api/src/facilities/facilities-assets.spec.ts`
- Extensions to `apps/api/src/facilities/event-ids.ts` and
  `apps/api/src/facilities/dto/facilities.dto.ts`.
- Wiring in `apps/api/src/facilities/facilities.module.ts`.

Plus the seed-pipeline + package.json wiring:

- `packages/database/src/seed-all.ts`
- `packages/database/package.json`

**Wave D opens with the close of P2-18.** See `P2C18-REVIEW-NOTES.md`
for the review scaffold.
