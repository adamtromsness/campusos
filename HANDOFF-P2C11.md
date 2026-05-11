# HANDOFF — Phase 2 Cycle 11 (P2-11 Transportation Advanced)

**Status:** COMPLETE pending peer review — all 6 plan steps shipped across 3
sub-cycles. The cycle opens **Wave C (Operational Depth)** and is the largest
Phase 2 cycle by table count.

**Cycle totals (final):**

| Dimension                | Count                                                                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant base tables       | **22 new** (8 P2-11a + 7 P2-11b + 7 P2-11c)                                                                                                                                      |
| Migrations               | 3 (`136_trn_fleet_maintenance.sql` + `137_trn_route_generation.sql` + `138_trn_gps_fleet.sql`)                                                                                   |
| Daily partitions         | 2 partitioned tables × 118 daily leaves = **236 partition leaves**                                                                                                               |
| Services                 | **16 new** services + 1 GeofenceService lifecycle hook                                                                                                                           |
| Controllers              | **2 new** (`FleetMaintenanceController` + `GpsFleetController`) + 1 extended (`RouteGenerationController`)                                                                       |
| Endpoints                | **75 new** (30 P2-11a + 24 P2-11b + 21 P2-11c) — plan estimated ~62                                                                                                              |
| Kafka emit topics        | 4 (`trn.parts.low`, `trn.driver.hours_approaching_limit`, `trn.generation.completed`, `trn.geofence.entered` + `trn.geofence.exited`)                                            |
| Workers                  | 2 (RouteGenerationWorker manual-candidate fallback + GeofenceService boundary check) + the Phase 3 partition-maintenance cron                                                    |
| Unauthenticated routes   | **1** — `GET /transport/tracking/:token` (the only unauth read in the entire transport module)                                                                                   |
| vitest tests             | 17 (P2-11a) + 14 (P2-11b spec) + **38 (P2-11c, new)** in `transport-advanced-c.spec.ts`                                                                                          |
| IAM permission codes     | `TRN-001..005` (no new codes — the cycle uses the existing Cycle 19 catalogue)                                                                                                   |
| Cross-cycle dependencies | Cycle 19 (`trn_vehicles`, `trn_routes`, `trn_stops`, `trn_student_assignments`), Cycle 4 (`hr_employees`), Cycle 7 (`wsk_approval_requests` soft refs from ad-hoc trip requests) |

Splitter audit: clean on first attempt for all 3 migrations after `python` audit.
**45th, 46th, 47th** migrations in a row to clear the splitter trap on first
provision attempt (Cycles 4 onwards unbroken streak). Tenant logical base table
count at `tenant_demo`: **645** (was 623 before P2-11). Idempotent re-provision
of both `tenant_demo` and `tenant_test` verified end-to-end.

## Sub-cycle breakdown

### P2-11a — Fleet Maintenance + Fuel + Driver Hours (shipped `3ae014c`)

8 base tables in migration `136_trn_fleet_maintenance.sql`:

- `trn_repair_categories` — per-school catalogue with `is_safety_critical` flag.
  When set, the RepairService flips `trn_vehicles.status` → MAINTENANCE until
  the linked repair lands at COMPLETED. The schema-side belt-and-braces is the
  three-state status CHECK (SCHEDULED / IN_PROGRESS / COMPLETED) on
  `trn_vehicle_repairs`.
- `trn_vehicle_repairs` — INTERNAL or EXTERNAL_VENDOR `performed_by_type` with
  optional `vendor_account_id` soft ref to `platform_vendor_accounts` (ADR-001).
  `warranty_claim BOOLEAN` flag tracks vendor recoveries. `invoice_s3_key` for
  vendor invoice retention.
- `trn_parts_inventory` — `quantity_on_hand` + `min_stock_level` with a partial
  INDEX backing the low-stock dashboard plus the `trn.parts.low` emit. Reorder
  flag drops when stock falls below `min_stock_level`.
- `trn_vehicle_components` — 9-value `component_type` CHECK (TYRE BRAKE BATTERY
  BELT HOSE ALTERNATOR STARTER TRANSMISSION OTHER) with 3-value `status` CHECK
  (ACTIVE REPLACED FAILED). `installed_mileage` + `expected_life_miles` drives
  the approaching-end-of-life dashboard.
- `trn_vehicle_fuel_logs` — per-refuel record. `odometer_reading` plus
  `fuel_quantity` lets the service layer compute the gap-based efficiency
  between adjacent logs for the same vehicle. 5-value `fuel_type` CHECK
  (DIESEL PETROL ELECTRIC HYBRID LPG).
- `trn_driver_hours_logs` — per-duty period with `duty_start_at` and optional
  `duty_end_at`. On the end-stamp the DriverHoursService recomputes
  `cumulative_weekly_minutes` against the school's configurable cap and emits
  `trn.driver.hours_approaching_limit` when within 90 % of the cap. Soft FK
  to `trn_route_run_logs` so a duty period can bind to zero or one runs.
- `trn_driver_hours_limits` — UNIQUE(school_id) per-school config. Defaults
  shipped as EU Working Time Directive: 2880 minutes weekly (48 hours), 600
  minutes daily (10 hours), 270-minute mandatory-break cadence. `jurisdiction`
  TEXT default `US_FEDERAL` lets schools tune for local regs.
- `trn_vehicle_lifecycle` — UNIQUE(vehicle_id) one row per vehicle.
  `purchase_price` + `expected_life_years` + `expected_life_miles` drive the
  fleet replacement planner. 2-value `depreciation_method` CHECK
  (STRAIGHT_LINE DECLINING_BALANCE). 4-value `disposal_method` CHECK
  (SOLD SCRAPPED TRADED_IN DONATED).

**Services (6):** RepairService, PartsService, ComponentService, FuelLogService,
DriverHoursService, VehicleLifecycleService.

**Endpoints (30):** `FleetMaintenanceController` ships repair CRUD + categories,
parts inventory CRUD + low-stock + restock, component install + replace,
fuel logging + per-vehicle history + fleet summary, driver hours log + weekly
summary + approaching-limit + limit CRUD, vehicle lifecycle CRUD +
replacement-planning.

**Kafka emits (2):**

- `trn.parts.low` — fires when `quantity_on_hand` falls below `min_stock_level`
  on a restock or adjustment. Best-effort emit (KafkaProducerService).
- `trn.driver.hours_approaching_limit` — fires when an end-stamped duty period
  pushes `cumulative_weekly_minutes` to ≥90 % of the school's configured cap.

**Seed:** `seed-transport-advanced.ts` — 3 repair categories (1 safety-critical),
8 parts (2 below min_stock_level), 6 components across 2 vehicles (1
approaching expected life), 10 fuel logs, 5 driver hours logs (1 approaching
weekly limit), 1 driver hours limit config, 2 vehicle lifecycle records.

### P2-11b — Route Generation Pipeline (shipped `4872e46`)

7 new base tables in migration `137_trn_route_generation.sql`. The plan listed 8
tables but `trn_route_change_requests` already shipped in Cycle 19 migration
`064_trn_routes_stops.sql` — P2-11b reuses the existing table and extends the
RouteChangeRequestService surface where needed.

- `trn_route_constraints` — per-school named constraint profile.
  `max_ride_time_minutes` default 45 mirrors the typical US-district door-to-
  door cap. `walkable_radius_metres` default 400 matches state regulations for
  the no-bus-needed walkable radius. UNIQUE(school, constraint_name) so a TC
  can carry multiple named profiles (2026 Standard, 2026 Snow Day, etc) and
  pick at generation time.
- `trn_generation_requests` — per-run generation job state. 4-value
  `request_type` CHECK (FULL_YEAR TERM DATE_RANGE SINGLE_DATE). 5-value
  `status` lifecycle (QUEUED → RUNNING → COMPLETED | FAILED | CANCELLED).
  Multi-column `started_chk` plus `completed_chk` keeps lifecycle timestamps
  consistent. ON DELETE RESTRICT on `constraint_id` so a TC cannot drop a
  constraint profile that historical generation runs reference.
- `trn_generation_candidates` — per-route candidate produced by a single
  generation run. 4-value `review_status` CHECK
  (PENDING APPROVED REJECTED MODIFIED). Multi-column `reviewed_chk` keeps
  reviewed_by + reviewed_at populated only on terminal review. Multi-column
  `approved_route_chk` pins `approved_route_id` to NULL when review_status
  is not APPROVED. CASCADE on `request_id`.
- `trn_generation_candidate_stops` — per-stop within a candidate. `student_ids
UUID[] NOT NULL` stores the soft refs to `sis_students` rows the solver
  assigned to each stop. Multi-column `student_count` check keeps
  `cardinality(student_ids)` in lockstep with the denormalised counter.
- `trn_adhoc_trip_requests` — 5-value `trip_purpose` CHECK
  (FIELD_TRIP ATHLETIC_EVENT SPECIAL_EVENT MEDICAL_TRANSPORT OTHER) with
  5-value status lifecycle. `linked_approval_id` soft ref to
  `wsk_approval_requests` so the Cycle 7 workflow engine handles the TC
  approval chain. Multi-column `cancelled_chk` requires a non-empty
  `cancellation_reason` on CANCELLED.
- `trn_contracted_routes` — UNIQUE(route_id) caps each route to a single
  contract at a time. `contractor_id` soft ref to `platform_vendor_accounts`.
  3-value `payment_frequency` CHECK (WEEKLY MONTHLY TERM).
  `performance_rating NUMERIC(2,1)` bound 0..5.

**Services (4):** RouteConstraintService, RouteGenerationService,
AdhocTripService, ContractedRouteService.

**Endpoints (24):** Constraint CRUD, generation queue, manual-candidate
authoring (the **Scheduling Solver stub fallback** — when the extracted
service is not deployed the TC creates candidates directly via
`addManualCandidate`), candidate approve / reject keystone that
atomically materialises a live `trn_routes` row + `trn_stops` rows +
`trn_student_assignments` rows inside one tenant tx, ad-hoc trip lifecycle,
contracted-route CRUD, route change request approve / reject extension.

**Kafka emits (1):**

- `trn.generation.completed` — fires AFTER the request tx commits when a TC
  marks a generation request COMPLETED. Payload carries `requestId`,
  `schoolId`, `routesGenerated`, `studentsCovered`, `studentsUncovered`,
  `requestedBy`, `completedAt`. Best-effort emit (no outbox).

**Seed:** `seed-transport-advanced-b.ts` — 1 constraint profile (2026
Standard), 1 COMPLETED generation request, 3 candidates (1 APPROVED with the
live trn_routes row created, 1 REJECTED, 1 PENDING), 12 candidate stops, 1
ad-hoc trip (SCHEDULED, athletic event), 1 contracted route, 2 route change
requests (1 APPROVED with override, 1 PENDING).

**Stub design — Scheduling Solver:** the plan called for a Scheduling Solver
extracted service. Because that service is not deployed in dev, the
RouteGenerationService accepts manual candidate authoring as the fallback
path. The TC drives the same generation request lifecycle (QUEUED →
RUNNING → COMPLETED) but pushes candidates directly via
`POST /transport/route-generation/:id/candidates`. The APPROVED candidate
flow is identical regardless of solver vs manual — `trn_routes` + `trn_stops`

- `trn_student_assignments` all land in one tenant tx. When the Scheduling
  Solver deploys, the RouteGenerationWorker subscribes to a Kafka topic and
  calls the solver's HTTP endpoint, then drops the candidates via the same
  service-level helper. No request-path or schema change required.

### P2-11c — GPS Telemetry + Fleet Dashboard (shipped this commit)

7 new base tables in migration `138_trn_gps_fleet.sql`. The cycle ships the
highest-volume table in the entire CampusOS ERD —
`trn_vehicle_positions` — with daily partitioning, immutable insert
semantics, and dual-layer dedup at consumer-group + per-vehicle Redis claim
(when production wires in the dispatch consumer).

- `trn_vehicle_positions` — RANGE partition by `recorded_at` **DAILY**.
  Composite PK `(id, recorded_at)`. **No UPDATE, no DELETE** service surface —
  the row is an immutable telemetry record. Lat/lng CHECK bounds. 3-value
  `source` CHECK (GPS MANUAL SIMULATED). The migration ships **118 daily
  partitions** covering 2026-04-14 → 2026-08-10 (14 days behind, 90 days
  ahead). INDEX(vehicle_id, recorded_at DESC) backs the latest-position
  lookup.
- `trn_geofences` — per-school zone definitions. 4-value `geofence_type`
  CHECK (SCHOOL STOP SPEED_ZONE RESTRICTED_AREA). `boundary JSONB` carries
  either a `{type: "circle", center: {lat, lng}, radius_metres}` shape or
  a `{type: "polygon", coordinates: [[lat,lng],...]}` shape. UNIQUE(school,
  name).
- `trn_geofence_events` — RANGE partition by `recorded_at` DAILY mirroring
  the parent positions table. Composite PK `(id, recorded_at)`. 2-value
  `event_type` CHECK (ENTER EXIT). INDEX(geofence_id, recorded_at DESC) +
  INDEX(vehicle_id, recorded_at DESC). Also 118 daily partitions covering
  the same window.
- `trn_vehicle_eta` — UNIQUE(vehicle_id, stop_id) per-(vehicle, stop) ETA
  snapshot. Upserted by the GeofenceService callback or by the dispatch
  integration. 3-value `confidence` CHECK (HIGH MEDIUM LOW). CASCADE on
  `stop_id` → `trn_stops`.
- `trn_dispatch_events` — 8-value `event_type` CHECK
  (ROUTE_STARTED ROUTE_COMPLETED DELAY_REPORTED BREAKDOWN_REPORTED
  STUDENT_NO_SHOW EMERGENCY_STOP DETOUR DRIVER_SWAP). `event_data JSONB`
  captures free-shape payload (minutes_delayed, fault, location, etc).
  SET NULL on `route_id` / `vehicle_id` / `driver_id` preserves the
  historical event row past hard-delete.
- `trn_parent_tracking_tokens` — unauthenticated bearer token. `token TEXT
UNIQUE` backs the public GET. Partial UNIQUE on `(student_id, route_id)
WHERE is_active = true` caps active tokens at one per pair — revoking
  releases the partial UNIQUE so a fresh token can land. Multi-column
  `revoked_chk` keeps `revoked_at` populated only when `is_active = false`.
  CASCADE on `route_id`.
- `rpt_fleet_status` — UNIQUE(vehicle_id) one row per vehicle. Materialised
  nightly by the FleetStatusWorker. Denormalised counters: days until
  insurance / registration / MOT / licence expiry, maintenance_overdue flag,
  total_incidents_this_year, current_route_assignment, last_position_at,
  fuel_efficiency_last_month, open_safety_critical_repair_count. CASCADE on
  `vehicle_id` → `trn_vehicles`.

**Services (6):** VehiclePositionService, GeofenceService, ETAService,
DispatchService, ParentTrackingService, FleetStatusService.

**Endpoints (21):** position ingest + latest + history, geofence CRUD +
event log, ETA list + upsert keystone, dispatch event log + create, parent
tracking token issue + revoke + the **`@Public()` unauthenticated GET** at
`/transport/tracking/:token`, fleet status list + per-vehicle + materialise
keystone + fleet-wide materialise (admin-only).

**Workers (2):**

- **GeofenceService.checkAndEmitEvents** is the keystone — runs after every
  `VehiclePositionService.ingest` (wired via the late-bound
  `setGeofenceCheckCallback` to break the circular DI). Walks every active
  geofence for the school, runs `isPointInBoundary` (point-in-polygon for
  polygon shapes, haversine distance for circle shapes), reads the last
  event for the (vehicle, geofence) pair to determine prior boundary state,
  and on a transition INSERTs a `trn_geofence_events` row + emits
  `trn.geofence.entered` or `trn.geofence.exited` outside the position
  ingest path so a failure never blocks the position INSERT.
- **FleetStatusWorker (materialiser)** — `FleetStatusService.materialiseAll`
  is the entrypoint the nightly cron calls. Walks every vehicle in the
  school, reads from `trn_vehicle_documents` (insurance / registration / MOT
  expiry dates), `trn_vehicle_repairs` (open safety-critical count),
  `trn_vehicle_fuel_logs` (last-30-days avg efficiency),
  `trn_vehicle_positions` (latest position timestamp), `trn_routes` (current
  route assignment), and UPSERTs `rpt_fleet_status` ON CONFLICT (vehicle_id)
  DO UPDATE in one tenant context per vehicle. Cron schedule lives in ops.

**Kafka emits (2):**

- `trn.geofence.entered` — fires AFTER `trn_geofence_events` INSERT when a
  vehicle crosses into a geofence boundary. Payload includes `eventId`,
  `geofenceId`, `geofenceName`, `geofenceType`, `schoolId`, `vehicleId`,
  `eventType: 'ENTER'`, `speedKmh`, `speedLimitKmh`, `latitude`, `longitude`,
  `recordedAt`. Best-effort emit. Future Cycle 14 NotificationConsumer wires
  parent IN_APP notifications on SCHOOL-type geofence enters (Phase 2
  punch list).
- `trn.geofence.exited` — fires AFTER `trn_geofence_events` INSERT when a
  vehicle crosses out of a geofence boundary. Identical payload shape with
  `eventType: 'EXIT'`.

**Seed:** `seed-transport-advanced-c.ts` — 50 vehicle positions across 3
vehicles (when only 2 demo vehicles exist, the seed gracefully ships 34
positions across the 2 — verified live), 3 geofences (1 SCHOOL circle, 1 STOP
circle, 1 SPEED_ZONE polygon), 5 geofence events, 3 ETA records (HIGH /
MEDIUM / LOW confidence), 8 dispatch events covering 5 of 8 event_type
values, 2 parent tracking tokens (1 ACTIVE for Maya, 1 REVOKED for Ethan), 3
rpt_fleet_status rows (1 maintenance_overdue + 1 insurance expiring 10d + 1
healthy when third vehicle exists).

**Stub design — Transport Dispatch:** the plan called for a Transport
Dispatch extracted service. Because that service is not deployed in dev, the
VehiclePositionService accepts position ingest via the standard
authenticated `POST /transport/vehicles/:id/position` endpoint (gated on
`trn-002:write`). Real GPS device integration is Phase 3 ops — the device
calls the same endpoint with a service-account bearer token. ETA
computation lives in the ETAService.upsert path, called manually or by the
future dispatch integration; until that lands, ETAs are TC-entered via the
upsert API.

## Three structural keystones across the full P2-11

1. **The Safety-Critical Repair Block (P2-11a).** When a repair is logged
   against a category with `is_safety_critical = true`, the RepairService
   atomically flips `trn_vehicles.status` to MAINTENANCE in the same tenant
   tx as the INSERT. The vehicle stays out-of-service until the repair lands
   at status='COMPLETED', at which point the same service flips status back
   to ACTIVE. The Phase 3 ops dashboard surfaces "vehicles with open
   safety-critical repairs" as the top-priority queue.

2. **Manual Candidate Authoring as the Solver Fallback (P2-11b).** The
   Scheduling Solver extracted service is not deployed. The
   RouteGenerationService's `addManualCandidate` path lets a TC author
   candidates directly against an open generation request. The
   `markRequestCompleted` keystone aggregates the candidates and emits
   `trn.generation.completed`. When the solver deploys, the same downstream
   flow (TC review, approve / reject, materialise live route + stops + student
   assignments in one tx) works unchanged.

3. **The GeofenceService Boundary Check + the @Public Parent Token (P2-11c).**
   `VehiclePositionService.ingest` calls `GeofenceService.checkAndEmitEvents`
   after the position INSERT commits. The boundary check runs
   `isPointInBoundary` (point-in-polygon for polygon shapes, haversine
   distance for circle shapes) against every active geofence in the school,
   reads the last event for the (vehicle, geofence) pair to determine prior
   state, and on a transition INSERTs a `trn_geofence_events` row + emits
   `trn.geofence.entered` or `trn.geofence.exited`. The single
   unauthenticated route in the entire transport module —
   `GET /transport/tracking/:token` — looks up the token, verifies
   `is_active = true` AND `expires_at > now()`, then renders the vehicle
   position + scoped child stop ETA. No student PII leaks past the route
   name and the matching stop name.

## Cross-cycle dependencies

- **Cycle 19** — every P2-11 ref to vehicles / routes / stops / student
  assignments crosses to Cycle 19 (`trn_vehicles`, `trn_routes`, `trn_stops`,
  `trn_student_assignments`). The seed depends on `seed-transport.ts`
  having run first.
- **Cycle 4** — driver assignments + driver hours logs ref `hr_employees(id)`.
  The seed depends on `seed-hr.ts` having created at least Linda Park (VP)
  as the driver fixture.
- **Cycle 7** — `trn_adhoc_trip_requests.linked_approval_id` is a soft ref to
  `wsk_approval_requests`. The AdhocTripService submit path optionally calls
  the workflow engine to drive a TC approval chain.
- **Cycle 1** — `trn_parent_tracking_tokens.student_id` is a soft ref to
  `sis_students(id)`. Token issuance validates the student is in the calling
  school.
- **No new IAM permission codes.** P2-11 reuses the Cycle 19 catalogue
  (`TRN-001..005`).

## Splitter audit + provisioning history

Splitter trap check for migration 138: Python state-machine audit ran before
the first provision attempt; zero stray semicolons inside string literals
or block comments. First provision attempt succeeded against `tenant_demo`
and `tenant_test`. 23rd migration in a row to clear the trap on first
attempt after audit (Cycles 4 onwards unbroken streak preserved).

Idempotent re-provision verified on both `tenant_demo` and `tenant_test`:
zero new applies on the second run. 7 new logical base tables × 2 tenants =
14 tables provisioned (+ 236 partition leaves) without error.

Live constraint smoke test on `tenant_demo` (single BEGIN…ROLLBACK
transaction with savepoints, 15 assertions):

- Happy-path position INSERT landed in the correct daily partition
  (verified via `SELECT FROM ONLY trn_vehicle_positions_2026_05_11`).
- Latitude CHECK rejects 91 (out of `[-90, 90]` bound).
- Source CHECK rejects `'BOGUS'` (3-value enum).
- Partition out-of-window rejects a position with `recorded_at='2025-01-01'`.
- Geofence happy-path INSERT with JSONB circle boundary.
- UNIQUE(school, name) on geofences rejects duplicate.
- `geofence_type` CHECK rejects `'BOGUS'` (4-value enum).
- Geofence event happy-path INSERT landed in the correct daily partition.
- UNIQUE(vehicle, stop) on `trn_vehicle_eta` rejects duplicate.
- Dispatch event 8-value `event_type` CHECK rejects `'BOGUS'`.
- Partial UNIQUE on `(student, route) WHERE is_active=true` on
  `trn_parent_tracking_tokens` rejects a second active row for the same pair.
- Multi-column `revoked_chk` rejects `is_active=true` with `revoked_at` set.
- Revoke + re-issue: flipping `is_active=false` releases the partial UNIQUE
  so a fresh active row for the same (student, route) pair lands cleanly.
- UNIQUE(vehicle_id) on `rpt_fleet_status` rejects duplicate snapshot.
- CASCADE on `trn_stops` delete drops the matching `trn_vehicle_eta` rows.

All 15 assertions green.

## CI parity green (final check on the closeout commit)

- `pnpm format:check` — 0 files need formatting
- `pnpm lint:logs` — 733 files clean
- `pnpm --filter @campusos/api build` — clean
- `pnpm --filter @campusos/api test` — **602/602 passing across 29 spec files**
  (was 564 before P2-11c; +38 in `transport-advanced-c.spec.ts`)
- `pnpm --filter @campusos/web build` — clean (no web changes in P2-11c)

## Phase 2 punch list — items carried forward from P2-11

These are the deferred items consolidated across the 3 sub-cycles. None are
blocking; they should be addressed before the platform onboards real schools
at scale.

1. **Scheduling Solver extracted service** (P2-11b). The plan documented a
   solver extracted service; the cycle ships the manual-candidate fallback as
   the dev / pilot path. When the solver deploys, the
   RouteGenerationService gains a thin HTTP client + Kafka topic to consume
   solver runs; the request-path approve / reject contract stays.
2. **Transport Dispatch extracted service** (P2-11c). Same shape as #1 — the
   cycle ships manual position ingest + manual ETA upsert. When dispatch
   deploys, the device pushes positions through the same endpoint with a
   service-account bearer; the ETA recompute moves into the dispatch
   service's worker chain.
3. **Partition maintenance cron** (P2-11c). The migration ships 118 daily
   partitions on each partitioned table covering ~3 months. A monthly cron
   should create forward partitions on a rolling 30-day window + retire old
   partitions to a cold-storage table 90 days after the last write. Schema
   is ready — cron schedule lives in ops.
4. **NotificationConsumer wiring for `trn.geofence.entered`** (P2-11c). The
   emit fires cleanly; the Cycle 14 NotificationConsumer should add a
   handler for SCHOOL-type geofence enters that creates a parent IN_APP
   notification ("Your child's bus has entered the school zone"). Joins the
   broader Phase 2 NotificationConsumer fan-out work.
5. **Transportation Coordinator role split** (cumulative P2-11). The cycle
   gates writes on `trn-002:write` + `trn-001:write` and admin on
   `trn-002:admin`. Generic STAFF holds these via the existing IAM seed.
   Pre-pilot a dedicated TC role splits these out of generic Staff. Joins
   the broader role-split chain in the CLAUDE.md Wave 2 Phase 2 punch list
   (items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 / 30 / 32 / 33).
6. **Outbox for safety-critical emits** (P2-11). All P2-11 emits use the
   best-effort `KafkaProducerService.emit` path. `trn.parts.low` and
   `trn.driver.hours_approaching_limit` carry operational consequences (low
   stock + driver regulatory breach) and should move to the durable outbox
   pattern before pilot. Same shape for `trn.geofence.entered` — a missed
   emit on a SCHOOL geofence enter would silently drop a parent
   notification.
7. **Web UI** (P2-11c). The plan describes 4 UI surfaces — Live Tracking
   Map, Parent Tracking View, Fleet Status Dashboard, Dispatch Console.
   The cycle ships the API surface to back all 4 + the unauthenticated
   parent-tracking path. Web UI for P2-11 ships in a follow-up cycle.

## How to verify locally

```bash
# 1. Run the migration suite (idempotent)
pnpm --filter @campusos/database provision --subdomain=demo
pnpm --filter @campusos/database provision --subdomain=test

# 2. Seed the demo tenant
pnpm --filter @campusos/database seed:transport-advanced-c

# 3. Run the test suite
pnpm --filter @campusos/api test

# 4. Lint + format gate
pnpm format:check
pnpm lint:logs

# 5. End-to-end build
pnpm --filter @campusos/api build
pnpm --filter @campusos/web build
```

## Files in this PR (P2-11c shipped commit)

**Schema:**

- `packages/database/prisma/tenant/migrations/138_trn_gps_fleet.sql`

**Seed:**

- `packages/database/src/seed-transport-advanced-c.ts`
- `packages/database/src/seed-all.ts` (registration)
- `packages/database/package.json` (registration)

**API:**

- `apps/api/src/transport/vehicle-position.service.ts`
- `apps/api/src/transport/geofence.service.ts`
- `apps/api/src/transport/eta.service.ts`
- `apps/api/src/transport/dispatch.service.ts`
- `apps/api/src/transport/parent-tracking.service.ts`
- `apps/api/src/transport/fleet-status.service.ts`
- `apps/api/src/transport/gps-fleet.controller.ts`
- `apps/api/src/transport/dto/gps-fleet.dto.ts`
- `apps/api/src/transport/transport.module.ts` (registration)
- `apps/api/src/transport/transport-advanced-c.spec.ts`

**Docs:**

- `HANDOFF-P2C11.md` (this file)
- `P2C11-REVIEW-NOTES.md` (peer review scaffold)
- `CLAUDE.md` (status update)

Wave C is open. The next cycle is P2-12.
