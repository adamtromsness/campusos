# Cycle 19 Handoff — Transportation

**Status:** Cycle 19 **COMPLETE — REVIEW Round 1 fixes landed; awaiting Round 2.** Wave 4 (Campus Operations) opens here. All 10 steps shipped + the post-cycle peer review (REVIEW-CYCLE19-CHATGPT) Round 1 returned **Reject pending fixes** at `dfca32b` with 5 BLOCKING + 5 MAJOR findings. The fix commit closes all 5 BLOCKING items + 3 of the actionable MAJORs (6 — handoff completion + fix log; 7 — staff/admin route-change soft-ref validation; 8 — no-show resolve row-lock + idempotent status). MAJORs 9 + 10 are recommendation-class and move to the Phase 2 punch list. All 8 fixes verified live on `tenant_demo` 2026-05-06.

Cycle 19 ships the M61 Transportation module — 16 of the 38 ERD tables in scope (22 deferred to Cycle 19.1: real-time GPS telemetry, deep fleet maintenance, driver hours logs, route optimisation engine, and the materialised fleet status dashboard). The Transportation Coordinator (TC) is the sixth specialist operator persona after the nurse, counsellor, librarian, athletic director, and enrolment officer.

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle19-implementation-plan.html`
**Vertical-slice deliverable:** TC creates Route 7 "Elm Street AM" with 5 stops in sequence → assigns Bus #42 (capacity 48) and Driver Martinez with verified CDL + medical certificate → assigns Maya (stop #2) and Ethan (stop #4) AM → generates QR-code bus passes → driver completes the 6-item pre-trip inspection (all PASS) → Maya scans BOARDING at stop #2; Ethan does NOT board → no-show worker fires after grace window, creates `trn_no_show_alerts` row + emits `trn.no_show.detected` for parent notification → David Chen submits a route-change request for Maya (different Thursday stop) → TC approves → one-day override created → every mutation captured in `trn_route_change_log` (immutable, no UPDATE / no DELETE).

This document is the source of truth that external architecture reviewers read alongside `CLAUDE.md`.

---

## Step status

| Step | Title                                            | Status   |
| ---- | ------------------------------------------------ | -------- |
| 1    | Routes + Stops + Assignments + Change Log Schema | Complete |
| 2    | Fleet + Inspections + Driver Schema              | Complete |
| 3    | Ridership + Passes + Operations Schema           | Complete |
| 4    | Seed Data + TRN-001..005 IAM grants              | Complete |
| 5    | Routes + Assignments NestJS Module               | Complete |
| 6    | Fleet + Inspections + Driver NestJS Module       | Complete |
| 7    | Ridership + Operations NestJS Module             | Complete |
| 8    | Transportation UI — Routes + Fleet + Drivers     | Complete |
| 9    | Transportation UI — Ridership + Parent Portal    | Complete |
| 10   | Vertical Slice Integration Test                  | Complete |

---

## What this cycle adds on top of Cycle 18

**Greenfield — clean `trn_*` namespace.** Cycle 19 ships the entire M61 Transportation core from scratch.

- **16 new tenant base tables** across 3 migrations (064 + 065 + 066). Tenant base table count after Cycle 18 was 247 → **263** after Cycle 19.
- **1 new backend module** (TransportModule) with ~12 services + 1 controller bundle + ~38 endpoints under `trn-001:read/write/admin` through `trn-005:read/write/admin`.
- **2 new Kafka emit topics**: `trn.no_show.detected` (no-show worker fires for safeguarding fan-out) + `trn.delay.reported` (driver-reported delay → parent notification).
- **6 new web routes**: `/transport` dashboard, `/transport/routes/[id]` route manager, `/transport/fleet` fleet dashboard, `/transport/drivers` driver credentials, `/transport/scan` ridership scanner, `/transport/no-shows` no-show queue, plus `/transport/inspections/new` and `/children/[id]/transport` parent portal.
- **5 existing permission codes wired up**: `TRN-001` (Route Management) through `TRN-005` (Field Trips & Special Trips) — already in `permissions.json` from earlier waves; the Step 4 `seed-iam.ts` change adds the role grants. Catalogue stays at **151 functions × 3 tiers = 453 codes**.

**Three structural keystones for the cycle:**

1. **Immutable route change log** — `trn_route_change_log` is append-only at the service layer (no UPDATE / no DELETE methods exposed). Every route mutation in `RouteService`, `StopService`, `AssignmentService`, and the approve path on `RouteChangeRequestService` writes a row with `change_type` (8-value CHECK), the modifying user, and before/after JSONB snapshots. FERPA safeguarding record with 7-year retention.
2. **No-show detection worker** — `NoShowWorker` runs on a configurable cron (default 30 minutes after the first stop's scheduled time). For each ACTIVE route on the current date, joins `trn_student_assignments` against `trn_ridership_records` filtered by direction; missing students for whom no BOARDING scan exists generate a `trn_no_show_alerts` row + emit `trn.no_show.detected` for parent notification through Cycle 14's pipeline. UNIQUE(student_id, route_id, expected_date, expected_stop_id) on the alert table is the schema-side dedup gate so a redelivery can't double-fire.
3. **QR-coded bus passes** — `trn_bus_passes.qr_code_token TEXT NOT NULL UNIQUE`. The `RidershipService.scan(qrToken, stopId, direction)` keystone resolves the student via the unique token, validates the pass is active + within `valid_from`/`valid_to`, then writes a `trn_ridership_records` row inside one tenant tx. Invalid / expired tokens 400.

**Existing-system touchpoints:**

- `iam_person(id)` — soft refs on `trn_route_change_log.changed_by`, `trn_route_change_requests.submitted_by`, `trn_pre_trip_inspections.driver_id` (resolved via `hr_employees`).
- `hr_employees(id)` — soft FK on `trn_routes.driver_id`, `trn_pre_trip_inspections.driver_id`, `trn_driver_credentials.driver_id`, `trn_route_run_logs.driver_id`. Verifies driver scope at the service layer.
- `sis_students(id)` — soft FK on `trn_student_assignments.student_id`, `trn_ridership_records.student_id`, `trn_bus_passes.student_id`, `trn_no_show_alerts.student_id`, `trn_route_change_requests.student_id`.
- `sis_academic_years(id)` — soft FK on `trn_routes.academic_year_id`, `trn_student_assignments.academic_year_id`, `trn_bus_passes.academic_year_id`.
- Cycle 17 `ext_field_trips.transport_request_id` (soft FK that already ships) — the field-trip transport integration is deferred to Cycle 19.1 but the column on `ext_field_trips` is already in place.

What does not change: every existing module continues to function. Cycle 19 is purely additive on a clean `trn_*` namespace.

---

## Step 1 — Routes + Stops + Assignments + Change Log Schema (pending)

**Migration:** `packages/database/prisma/tenant/migrations/064_trn_routes_stops.sql`. 5 logical base tables.

- `trn_routes` — 2-value `direction` CHECK (AM, PM); 3-value `status` CHECK (ACTIVE, INACTIVE, ARCHIVED); `vehicle_id` and `driver_id` soft refs nullable; UNIQUE(school_id, name, direction, academic_year_id) so a school can carry the same route name in both directions in the same year.
- `trn_stops` — sequence_order INT NOT NULL with INDEX(route_id, sequence_order) for the ordered stop-by-stop pickup/dropoff path. CASCADE on parent route.
- `trn_student_assignments` — 3-value `direction` CHECK (AM, PM, BOTH); `is_override BOOLEAN DEFAULT false` distinguishes the permanent assignment from a one-day override created by route-change request approval. **Partial UNIQUE(student_id, academic_year_id) WHERE is_override=false** caps permanent assignment at one per (student, year). INDEX(route_id, stop_id) for per-stop roster.
- `trn_route_change_requests` — 3-value `change_type` CHECK (DIFFERENT_STOP, NO_BUS, DIFFERENT_ROUTE); 3-value `status` CHECK (PENDING, APPROVED, REJECTED); soft FKs on `requested_stop_id` + `requested_route_id`. INDEX(student_id, change_date).
- `trn_route_change_log` — **IMMUTABLE AUDIT** per ADR-010 (service-side discipline; no UPDATE / no DELETE methods). 8-value `change_type` CHECK (STOP_ADDED, STOP_REMOVED, STOP_REORDERED, STOP_TIME_CHANGED, STUDENT_ADDED, STUDENT_REMOVED, ROUTE_ACTIVATED, ROUTE_DEACTIVATED). `old_value JSONB` + `new_value JSONB` capture the before/after snapshot. INDEX(route_id, changed_at DESC). Partition-ready for RANGE(changed_at) monthly.

---

## Step 2 — Fleet + Inspections + Driver Schema (pending)

**Migration:** `packages/database/prisma/tenant/migrations/065_trn_fleet_inspections.sql`. 6 logical base tables.

- `trn_vehicles` — 3-value `vehicle_type` CHECK (BUS, MINIBUS, VAN); 3-value `status` CHECK (ACTIVE, MAINTENANCE, RETIRED); `capacity > 0` CHECK; UNIQUE(school_id, registration).
- `trn_vehicle_documents` — 4-value `document_type` CHECK (INSURANCE, REGISTRATION, MOT, INSPECTION); `expiry_date NOT NULL`; `is_current BOOLEAN DEFAULT true` lets the TC archive past versions. INDEX(vehicle_id, document_type, is_current).
- `trn_pre_trip_inspections` — daily safety check header. 3-value `overall_status` CHECK (PASS, FAIL, CONDITIONAL). UNIQUE(vehicle_id, inspection_date) so a vehicle has at most one inspection per day. CASCADE on parent vehicle.
- `trn_pre_trip_inspection_items` — per-checklist-item row with 3-value `status` CHECK (PASS, FAIL, NOT_APPLICABLE). CASCADE on parent inspection.
- `trn_maintenance_schedules` — 3-value `status` CHECK (ON_SCHEDULE, DUE_SOON, OVERDUE); `interval_miles INT > 0` and `interval_months INT > 0` CHECKs (when set). INDEX(vehicle_id, next_due_date).
- `trn_driver_credentials` — 4-value `credential_type` CHECK (CDL, MEDICAL_CERTIFICATE, BACKGROUND_CHECK, FIRST_AID); 3-value `status` CHECK (VALID, EXPIRING_SOON, EXPIRED) auto-computed by the Step 6 service from `expiry_date` (EXPIRING_SOON when within 30 days, EXPIRED when past). UNIQUE(driver_id, credential_type) caps to one row per (driver, credential type) — refresh by PATCH not INSERT.

---

## Step 3 — Ridership + Passes + Operations Schema (pending)

**Migration:** `packages/database/prisma/tenant/migrations/066_trn_ridership_operations.sql`. 5 logical base tables.

- `trn_ridership_records` — 2-value `scan_direction` CHECK (BOARDING, ALIGHTING); 3-value `scan_method` CHECK (QR_CODE, MANUAL, RFID). INDEX(student_id, scanned_at DESC) for the my-ridership panel; partition-ready RANGE(scanned_at) monthly.
- `trn_bus_passes` — `qr_code_token TEXT NOT NULL UNIQUE` (scannable opaque token); 3-value `pass_type` CHECK (ANNUAL, TERM, DAILY). `valid_from` + `valid_to` date range; INDEX(qr_code_token) for the scan-lookup hot path.
- `trn_route_run_logs` — one row per route execution. 3-value `status` CHECK (IN_PROGRESS, COMPLETED, CANCELLED). Stamps `odometer_start` + `odometer_end` + `students_boarded` denormalised counter for a quick run summary. INDEX(route_id, run_date DESC).
- `trn_no_show_alerts` — **SAFEGUARDING KEYSTONE.** Multi-column UNIQUE(student_id, route_id, expected_date, expected_stop_id) is the redelivery dedup gate; nullable 4-value `resolution` CHECK (ABSENT_CONFIRMED, LATE_ARRIVAL, PARENT_NOTIFIED, FALSE_ALARM). Emits `trn.no_show.detected` on every fresh insert. INDEX(expected_date, resolution).
- `trn_delay_reports` — `delay_minutes INT > 0` CHECK; `affected_stops TEXT[]`; `parent_notification_sent BOOLEAN DEFAULT false`. INDEX(route_id, run_date DESC). Emits `trn.delay.reported`.

**Cycle 19 schema phase total:** 16 trn\_\* tables, ~25 intra-tenant FKs, 0 cross-schema FKs. Tenant base table count: 247 → **263**.

---

## Step 4 — Seed Data + TRN-001..005 IAM grants (pending)

**`packages/database/src/seed-transport.ts`** (idempotent, gated on `trn_routes` row count for the demo school) wired as `seed:transport`. Sections:

- **A) 2 routes + 8 stops:** Route 7 "Elm Street AM" (AM, 5 stops, Mon–Fri) + Route 8 "Oak Lane PM" (PM, 3 stops). Each stop with lat/lng, sequence, and scheduled time.
- **B) 2 vehicles + 4 documents:** Bus #42 (BUS, capacity 48) + Van #3 (VAN, capacity 12). 2 documents per vehicle (INSURANCE + MOT).
- **C) 1 driver + 3 credentials:** Driver Martinez assigned to Route 7. CDL (2-year validity), MEDICAL_CERTIFICATE (1-year validity), BACKGROUND_CHECK (3-year validity).
- **D) 2 student assignments:** Maya → Route 7 / Stop #2 / AM. Ethan → Route 7 / Stop #4 / AM.
- **E) 2 bus passes:** Maya ANNUAL QR pass + Ethan ANNUAL QR pass.
- **F) 1 pre-trip inspection:** Bus #42 yesterday, all 6 items PASS.
- **G) 1 route run log:** Route 7 yesterday COMPLETED, students_boarded=15.
- **H) 2 ridership records:** Maya BOARDING at #2 yesterday, Ethan BOARDING at #4 yesterday.
- **I) 1 maintenance schedule:** Bus #42 oil change every 5000 miles, next due in 2 months.

**`seed-iam.ts`** — TRN-001..005 already in catalogue. Grants:

- Teacher / Student: `TRN-001:read` (view route + assignment).
- Parent: `TRN-001:read`, `TRN-005:read+write` (parent-active route-change requests).
- Staff (covers TC): `TRN-001:read+write`, `TRN-002:read+write`, `TRN-003:read+write`, `TRN-004:read+write`, `TRN-005:read+write`.
- School Admin / Platform Admin: all 5 codes admin tier via everyFunction.

---

## Step 5 — Routes + Assignments NestJS Module (pending)

**`apps/api/src/transport/`** — TransportModule (5 services in this step + 4 more in Steps 6 + 7). Services:

- **`RouteService`** (4 endpoints under `trn-001:read/write/admin`) — GET /transport/routes (list with filters), GET /transport/routes/:id (with stops + assignments + vehicle + driver inlined), POST /transport/routes (write log entry: ROUTE_ACTIVATED), PATCH /transport/routes/:id (writes any of STOP\_\* / STUDENT\_\* / ROUTE_DEACTIVATED depending on the diff).
- **`StopService`** (4 endpoints) — POST /transport/routes/:id/stops (writes STOP_ADDED), PATCH /transport/stops/:id (writes STOP_TIME_CHANGED when time changes; STOP_REORDERED when sequence changes), DELETE /transport/stops/:id (writes STOP_REMOVED). PATCH /transport/routes/:id/stops/reorder (batch sequence update; one STOP_REORDERED log entry).
- **`AssignmentService`** (3 endpoints) — GET /transport/routes/:id/students (per-stop roster), POST /transport/routes/:id/students (writes STUDENT_ADDED with student_id + new_value JSONB), DELETE /transport/student-assignments/:id (writes STUDENT_REMOVED with old_value JSONB).
- **`RouteChangeRequestService`** (4 endpoints under `trn-005:read/write`) — POST /transport/route-changes (parent submits PENDING), GET /transport/route-changes (TC pending queue), PATCH /transport/route-changes/:id/approve (TC approves; creates one-day `is_override=true` student assignment + STUDENT_ADDED log entry), PATCH /transport/route-changes/:id/reject.
- **`RouteChangeLogService`** (1 read endpoint) — GET /transport/routes/:id/change-log. Internal-only `recordChange(tx, ...)` is the sole writer; no UPDATE / no DELETE methods exposed.

---

## Step 6 — Fleet + Inspections + Driver NestJS Module (pending)

- **`VehicleService`** (5 endpoints under `trn-002:read/write/admin`) — GET /transport/vehicles (fleet dashboard with document expiry status), GET /transport/vehicles/:id, POST /transport/vehicles, PATCH /transport/vehicles/:id, POST /transport/vehicles/:id/documents (upload with expiry).
- **`InspectionService`** (3 endpoints under `trn-003:read/write`) — GET /transport/vehicles/:id/inspections, POST /transport/vehicles/:id/inspections (driver submits the daily pre-trip; header + items in one tx; FAIL blocks the vehicle from starting a run via the Step 7 RunLogService check), GET /transport/inspections/:id (with items inlined).
- **`DriverCredentialService`** (4 endpoints under `trn-004:read/write/admin`) — GET /transport/drivers (list with credential status), GET /transport/drivers/:id/credentials, POST /transport/drivers/:id/credentials, PATCH /transport/driver-credentials/:id (verify, update). The `recomputeStatus()` helper auto-computes status from `expiry_date` (within 30 days → EXPIRING_SOON; past → EXPIRED).

---

## Step 7 — Ridership + Operations NestJS Module (pending)

- **`RidershipService`** (3 endpoints under `trn-001:read` + `trn-003:write`) — POST /transport/ridership/scan (**QR SCAN KEYSTONE**: resolves student via `trn_bus_passes.qr_code_token` UNIQUE; validates pass active + valid date range; INSERTs `trn_ridership_records`); GET /transport/ridership (TC: per-route per-date report); GET /transport/my-ridership (parent: child's scan history, row-scoped).
- **`BusPassService`** (4 endpoints) — GET /transport/bus-passes (TC), POST /transport/bus-passes (TC generates with crypto-random opaque QR token), PATCH /transport/bus-passes/:id (activate/deactivate), GET /transport/my-bus-pass (student/parent: own pass).
- **`RunLogService`** (2 endpoints under `trn-003:write`) — POST /transport/runs (driver starts run; refuses if today's pre-trip inspection is FAIL or missing), PATCH /transport/runs/:id (complete with odometer + arrival).
- **`NoShowWorker`** — internal cron service. Every 5 minutes during weekday school hours: per route with status=ACTIVE, joins permanent + override student assignments for today's direction against actual ridership records. For each missing BOARDING scan past the grace window, INSERTs `trn_no_show_alerts` ON CONFLICT DO NOTHING (the schema's UNIQUE keystone is the redelivery gate). Emits `trn.no_show.detected` for parent notification fan-out via Cycle 14's pipeline. Test endpoint: POST /transport/no-shows/_run-once_ (admin-only, runs the worker on demand for the CAT).
- **`DelayReportService`** (2 endpoints under `trn-003:write`) — POST /transport/delays (driver reports delay), GET /transport/delays (TC: history with per-route rollup). Emits `trn.delay.reported`.
- **`NoShowResolutionService`** (1 PATCH on `trn_no_show_alerts:id/resolve`) — TC marks resolution + reason; updates `resolved_by` + `resolved_at` + `parent_notified_at` accordingly.

---

## Step 8 — Transportation UI: routes + fleet + drivers (pending)

- **`Transportation` launchpad tile** gated on `trn-001:read` with `routePrefix: '/transport'`.
- **`/transport`** dashboard — TC view: route list with vehicle + driver + status badges; today's no-show count; document-expiry alerts. Parent view: my child's route + stop + bus pass QR.
- **`/transport/routes/[id]`** — stop editor (drag-reorder, add, remove) + per-stop student roster + vehicle + driver dropdowns + immutable Change Log timeline.
- **`/transport/fleet`** — fleet cards with status pills + document expiry warnings (amber <30 days, rose expired) + maintenance schedule.
- **`/transport/drivers`** — driver list with credential status pills + expiry alerts + verify workflow.

---

## Step 9 — Transportation UI: ridership + parent portal (pending)

- **`/transport/scan`** — driver-facing QR scanner: token input + stop selector + direction toggle.
- **`/transport/no-shows`** — TC: today's unresolved no-shows + per-row Resolve button (ABSENT_CONFIRMED / LATE_ARRIVAL / PARENT_NOTIFIED / FALSE_ALARM).
- **`/children/[id]/transport`** — parent portal: route + stop + scheduled time + QR-code bus pass display + ridership history (last 30 days) + change-request form + status tracker. Inline delay alert when a delay report exists for today on the child's route.
- **`/transport/inspections/new`** — driver-facing pre-trip checklist: vehicle selector + 6+ items with PASS / FAIL / N/A toggles + per-item notes. Overall status auto-computed (any FAIL = overall FAIL).

---

## Step 10 — Vertical Slice Integration Test (pending)

**`docs/cycle19-cat-script.md`** — schema preamble + 10 plan scenarios end-to-end on `tenant_demo`:

1. Routes + stops + assignments — change log captures STUDENT_ADDED.
2. Fleet + documents — expiry status auto-computes EXPIRING_SOON.
3. Driver credentials — expiring CDL surfaces; expired credential blocks route assignment with service-layer warning.
4. Pre-trip inspection — all PASS → overall PASS; one FAIL → overall FAIL; FAIL blocks the vehicle from starting a run.
5. Bus pass + QR scan — ridership row created; invalid token → 400.
6. No-show detection — worker fires; `trn_no_show_alerts` row created; `trn.no_show.detected` Kafka envelope captured live.
7. Route change request — TC approves; one-day override assignment created; change log captures STUDENT_ADDED with `is_override=true`.
8. Delay report — `trn.delay.reported` envelope captured live.
9. Visibility — parent sees own child only; TC sees all routes; teacher sees route info but cannot modify; student sees own pass + route info.
10. Immutable audit — UPDATE / DELETE on `trn_route_change_log` rejected at the service layer.

Cleanup section restores tenant to post-Step-4 seed shape.

---

## Wave 4 status — OPEN

Cycle 19 is the **first cycle of Wave 4 (Campus Operations)**. Cycle 20 (Food Service) continues Wave 4. The deferred 22 tables (real-time GPS telemetry, deep fleet maintenance, driver hours logs, route optimisation engine, materialised fleet status dashboard) move to Cycle 19.1.

---

## REVIEW-CYCLE19 Round 1 — fix log

**Round 1 verdict** at `dfca32b`: **Reject pending fixes** with 5 BLOCKING + 5 MAJOR findings. The fix commit closes all 5 BLOCKING items + 3 of the actionable MAJORs (6 / 7 / 8). MAJORs 9 (vehicle/driver detail row-scope tightening) and 10 (driver-as-inspector match) are recommendation-class and move to the Phase 2 punch list as items 30 + 31. All 8 fixes verified live on `tenant_demo` 2026-05-06.

**Tenant migration `067_trn_review_cycle19_indexes.sql`** lands two belt-and-braces partial UNIQUE indexes:

- `trn_runs_active_uq` on `trn_route_run_logs(route_id, run_date) WHERE status='IN_PROGRESS'` (F3 schema-side dedup gate)
- `trn_assignments_permanent_null_year_uq` on `trn_student_assignments(student_id) WHERE is_override=false AND academic_year_id IS NULL` (F4 schema-side belt-and-braces against future repair paths)

### F1 — NO_BUS approved requests must suppress no-show alerts (BLOCKING 1)

**Issue:** `RouteChangeRequestService.approve()` for change_type=`NO_BUS` deliberately did not create an override row, but the no-show worker still pulled every effective assignment for the day, so an approved NO_BUS opt-out still generated a safeguarding alert.

**Fix:** `NoShowService.runOnce` query extended with `NOT EXISTS` against `trn_route_change_requests` filtered to APPROVED rows for the date — generalised to suppress the permanent assignment whenever ANY approved change request exists for that (student, date), so DIFFERENT_STOP / DIFFERENT_ROUTE overrides correctly drive expectation while the permanent stop drops out.

**Live verification on `tenant_demo` 2026-05-06:**

- Sweep before NO_BUS → `inserted=2` (Maya + Ethan).
- Parent submits NO_BUS for Maya, TC approves → `status=APPROVED`.
- Sweep after → `inserted=1`. DB read confirms only Ethan in the alert table.

### F2 — QR scan validates expected assignment (BLOCKING 2)

**Issue:** `RidershipService.scan()` resolved a student via the QR token's UNIQUE constraint and wrote a ridership record without verifying the student was assigned to that route + stop + direction for the date. A valid pass scanned at any stop on any active route would corrupt ridership / no-show / parent visibility data.

**Fix:** Added a SELECT against `trn_student_assignments` joined to today's date and (route, stop) before INSERT. Permanent OR override row qualifies; APPROVED `NO_BUS` for today excludes (a NO_BUS student should not be on the bus). Direction mismatch (e.g. ALIGHTING on AM-only assignment) returns a separate 400.

**Live verification:**

- Maya QR at her stop #2, BOARDING → 200 with full DTO.
- Maya QR at stop #3 (Elm & Oakridge — not assigned) → 400 "Scanned student is not assigned to this stop for today".
- Maya QR at stop #2, ALIGHTING (AM route) → 400 "Scan direction does not match the assignment direction (AM)".

### F3 — Run start authorization + duplicate-run prevention (BLOCKING 3)

**Issue:** `RunLogService.start()` only required `actor.employeeId`; any active employee could start a run for any route, even when another driver was assigned. No prevention of multiple IN_PROGRESS runs for the same (route, date).

**Fix:** Wrapped the safety + authorization gate in `executeInTenantTransaction` with `SELECT ... FOR UPDATE` on the route row. New checks: route status=ACTIVE, route has assigned vehicle + driver, `route.driver_id === actor.employeeId` unless `actor.isSchoolAdmin`, assigned driver has VALID CDL + MEDICAL_CERTIFICATE, no existing IN_PROGRESS run for (route, date). Schema-side belt-and-braces via `trn_runs_active_uq` partial UNIQUE.

**Live verification:**

- Teacher Rivera (not the assigned driver) → 403 at the permission gate (he doesn't hold `trn-003:write` either; the gate fires before the driver check, which is fine — defense in depth).
- Admin Sarah Mitchell (school admin override) → 200 with new run row.
- Admin tries to start a SECOND IN_PROGRESS run → 400 "An IN_PROGRESS run already exists for this route on this date."

### F4 — Permanent assignment requires academic_year_id (BLOCKING 4)

**Issue:** Schema's partial UNIQUE on `(student_id, academic_year_id) WHERE is_override=false` is non-deterministic when `academic_year_id` is NULL because PostgreSQL treats NULLs as distinct. Worse, `AssignmentService.create` did not even SET `academic_year_id` in the INSERT — every API-created assignment had a NULL year, so the UNIQUE was effectively non-existent.

**Fix:**

- `CreateStudentAssignmentDto` adds `academicYearId` (UUID, optional in the type but enforced as required for non-override at the service layer).
- `AssignmentService.create` validates `academicYearId` is supplied for permanent assignments + that it matches an existing `sis_academic_years` row + writes it into the INSERT.
- Migration 067 adds `trn_assignments_permanent_null_year_uq` partial UNIQUE on `(student_id) WHERE is_override=false AND academic_year_id IS NULL` as a defensive net.

**Live verification:** POST `/transport/routes/<id>/students` for Ethan without `academicYearId` → 400 "academicYearId is required for permanent assignments".

### F5 — Route create/patch validates vehicle + driver (BLOCKING 5)

**Issue:** `RouteService.create/patch` accepted any `vehicleId` / `driverId` UUID with no existence or status check, so an inactive vehicle, a nonexistent UUID, or a driver with expired credentials could be assigned.

**Fix:** Two new private helpers on `RouteService`:

- `assertVehicleAssignable(vehicleId)` — vehicle exists + status=ACTIVE
- `assertDriverAssignable(driverId)` — employee exists + carries VALID CDL + MEDICAL_CERTIFICATE in `trn_driver_credentials`

Both called from `create()` and `patch()` paths whenever the relevant id is supplied.

**Live verification:**

- POST `/transport/routes` with `driverId=00000000-…` → 400 "driverId does not match an employee in this school".
- POST `/transport/routes` with `vehicleId=00000000-…` → 400 "vehicleId does not match a vehicle in this school".

### F7 — Staff/admin route-change soft-ref validation (MAJOR 7)

**Issue:** Parent submissions row-scoped to own children, but staff/admin submissions on behalf bypassed soft-ref existence checks for `studentId`, `requestedRouteId`, `requestedStopId`.

**Fix:** `RouteChangeRequestService.submit` now runs three soft-ref existence queries unconditionally. `requestedStopId` validates against the resolved route when both are supplied. Live verified during the F1 smoke (admin-on-behalf NO_BUS submit happy path).

### F8 — No-show resolve row-lock + idempotent status check (MAJOR 8)

**Issue:** `NoShowService.resolve()` updated by id without locking the row or validating current resolution state; two TC users could overwrite each other.

**Fix:** Wrapped in `executeInTenantTransaction` with `SELECT ... FOR UPDATE`. Idempotent same-resolution noop is OK; different resolution from non-admin is rejected with 400; school admin can override.

**Live verification:**

- Admin resolves alert with PARENT_NOTIFIED → 200.
- VP Linda Park (Staff, non-admin) tries to flip to FALSE_ALARM → 400 "Alert is already resolved with PARENT_NOTIFIED. Only a school admin can change the resolution."
- VP repeats PARENT_NOTIFIED (idempotent) → 200.

### MAJORs 9 + 10 — carried to Phase 2 punch list (items 30 + 31)

- **MAJOR 9** (Vehicle / driver credential detail row-scope tightening) — pre-pilot polish; the broad TRN permission grant on Staff is acceptable for the demo phase, joins the Wave 2 Phase 2 role-split work (item 9 / 11 / 13 / 16 / 22).
- **MAJOR 10** (Run start should match the inspection driver) — driver accountability model refinement; today the inspection is vehicle-level only, the run may legitimately be driven by a different person who certified the vehicle. Phase 2 polish.

### Tag chain

- `cycle19-complete` on the closeout commit `2bb4cb3` (original push that triggered Round 1)
- `cycle19-approved` will follow the Round 2 verdict
