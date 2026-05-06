# REVIEW-CYCLE19-CHATGPT

**Round 1 verdict:** _pending_ (against `cycle19-complete` at `<commit-after-tag>`).

This file is the scaffold for the Cycle 19 (Transportation) post-cycle architecture review. It will fill in once the review is run. The shape mirrors `REVIEW-CYCLE18-CHATGPT.md` — a triage table per finding (severity / file / claim / triage / resolution), a Round 2 verdict block, and a tag chain.

Tag chain:

- `cycle19-complete` on the closeout commit (Wave 4 opens here)
- `cycle19-approved` (after Round 2 verdict)

---

## What the reviewer should look at

Cycle 19 ships M61 Transportation core (16 of 38 ERD tables; 22 deferred to Cycle 19.1). Transportation is the first module in Wave 4 (Campus Operations) and the first module that operates beyond the school building (routes, vehicles, stops with lat/lng). The cycle has three structural keystones the reviewer should verify in code:

1. **Immutable route change log.** `RouteChangeLogService.recordChange` is the sole writer to `trn_route_change_log` (FERPA-style audit, append-only at the service layer). No UPDATE / no DELETE methods are exposed; reviewer cache-busts the file to confirm. Every route mutation across `RouteService.create`/`patch`, `StopService.create`/`patch`/`remove`/`reorder`, `AssignmentService.create`/`remove`/`createOverrideInTx`, and `RouteChangeRequestService.approve` writes a row inside the same tenant tx that performed the mutation. Verify the 8-value `change_type` CHECK is exhaustively covered, that `old_value` / `new_value` JSONB snapshots capture meaningful before/after state, and that there is no service code path that mutates or deletes a log row.

2. **No-show detection worker.** `NoShowService.runOnce()` walks the union of permanent + override student assignments effective today against `RidershipService.hasBoardingScan(student, route, today)` and inserts `trn_no_show_alerts` ON CONFLICT DO NOTHING. The schema-side `UNIQUE(student_id, route_id, expected_date, expected_stop_id)` is the redelivery dedup gate so a worker re-run cannot double-fire. After insert, the service emits `trn.no_show.detected` per fresh row for parent notification fan-out via Cycle 14's pipeline. Verify (a) the date filter on the ACTIVE assignments query, (b) that a worker re-run on the same date does not duplicate alerts, and (c) that the Kafka emit happens after the INSERT (not before — the partial-failure path otherwise pages parents for an alert that was never written).

3. **QR-coded bus passes.** `trn_bus_passes.qr_code_token TEXT NOT NULL UNIQUE`. `RidershipService.scan(qrToken, stopId, direction)` calls `BusPassService.resolveToken` to validate the pass is active + `valid_from <= today <= valid_to`, then writes a `trn_ridership_records` row in one tenant tx. Invalid / expired / inactive tokens return 400. Verify the deterministic resolution + the validity window check happen before the INSERT and that no scan path bypasses `resolveToken`.

## Pre-trip safety gate

`RunLogService.start` calls `InspectionService.assertVehicleInspectedAndPassing(vehicleId, runDate)` before stamping the run row. Missing inspection → 400 "No pre-trip inspection on file…"; FAIL → 400 "Pre-trip inspection FAILED…". Verify there is no run-start path that bypasses the gate, and that `UNIQUE(vehicle_id, inspection_date)` correctly caps to one inspection per (vehicle, day) so a back-dated PASS can't override a same-day FAIL.

## Surface to review

- **Schema:** `packages/database/prisma/tenant/migrations/064_trn_routes_stops.sql` + `065_trn_fleet_inspections.sql` + `066_trn_ridership_operations.sql`. 16 tables. Verify the multi-column CHECKs (`reviewed_chk`, `resolved_chk`, `dates_chk` patterns), the partial UNIQUE on `trn_student_assignments(student_id, academic_year_id) WHERE is_override=false`, and the 8-value CHECK on `trn_route_change_log.change_type`. Tenant base table count 247 → 263.

- **Backend:** `apps/api/src/transport/`. 13 services + 1 controller + DTO module + ~38 endpoints. Manager scope on routes/stops/assignments = school admin OR `personType === 'STAFF'` (covers the Transportation Coordinator role; documented in the Phase 2 punch list as part of the broader role-split work before pilot). Two Kafka emit topics (`trn.no_show.detected`, `trn.delay.reported`) wrapped in the standard ADR-057 envelope.

- **Permissions:** TRN-001..005 already in `permissions.json` (151 × 3 = 453, unchanged). IAM grants: Teacher TRN-001:read; Parent TRN-001:read + TRN-005:read+write; Student TRN-001:read; Staff TRN-001..005:read+write; School Admin / Platform Admin admin-tier via everyFunction.

- **Web:** `Transportation` launchpad tile gated on `trn-001:read` + 8 routes (`/transport`, `/transport/routes/[id]`, `/transport/fleet`, `/transport/drivers`, `/transport/scan`, `/transport/no-shows`, `/transport/inspections/new`, `/children/[id]/transport`).

- **CAT:** `docs/cycle19-cat-script.md`. 10 plan scenarios end-to-end on `tenant_demo` with the 3 keystones verified live (immutable change log, no-show worker, QR scan).

## Open follow-ups (non-blocking — Phase 2 polish)

1. **Scheduled NoShowWorker cron.** `NoShowService.runOnce` is exposed via `POST /transport/no-shows/run-once` (admin-only) for the CAT and ops triage. A scheduled per-tenant cron is deferred to Cycle 19.1 ops wiring per the plan's "configurable schedule" note (default 30 minutes after first stop scheduled_time).
2. **Notification fan-out on `trn.no_show.detected` + `trn.delay.reported`.** Both topics emit cleanly but no Cycle 3 NotificationQueueService consumer fans them out to parent inboxes yet. Phase 2 wiring — joins the existing notification fan-out backlog.
3. **Driver / Transportation Coordinator role split.** Staff currently holds `TRN-001..005:read+write` (covers the TC). Joins the Wave 2 Phase 2 punch list role-split work — a dedicated TC role should hold the TRN-\* codes alone before pilot.
4. **GPS telemetry.** `trn_vehicle_positions` and the rest of the real-time fleet tracking surface deferred to Cycle 19.1 (requires a Transport Dispatch extracted service per the ERD note).
5. **Field-trip transport request integration.** Cycle 17's `ext_field_trips.transport_request_id` is a soft FK already in place; the actual request lifecycle wires up in Cycle 19.1.
6. **`trn_route_change_log` partitioning.** Partition-ready RANGE(changed_at) monthly per the plan; not partitioned yet because volume is light. Add when 7-year retention pressure builds.
7. **Outbox pattern.** `trn.no_show.detected` and `trn.delay.reported` are best-effort emits. Joins Phase 2 punch list item 4 (outbox priority list) for safeguarding-class topics.

---

## Triage table

| #   | Severity | File | Reviewer claim | Triage | Resolution |
| --- | -------- | ---- | -------------- | ------ | ---------- |
|     |          |      |                |        |            |

(Empty — fill in after Round 1.)

---

## Round 2 verdict

(Fill in after the fix commit + reviewer Round 2.)
