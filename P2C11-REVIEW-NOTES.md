# P2C11-REVIEW-NOTES — Phase 2 Cycle 11 (Transportation Advanced)

This file is the peer-review scaffold for P2-11 — the 22-table cycle that opens
Wave C (Operational Depth). Use it to triage findings and record verification
trail per fix.

**Scope of review:** all 3 sub-cycles — P2-11a (`136_trn_fleet_maintenance.sql`
plus 30 endpoints), P2-11b (`137_trn_route_generation.sql` + 24 endpoints),
P2-11c (`138_trn_gps_fleet.sql` + 21 endpoints). Total 75 new endpoints across
the transport module surface.

**Critical focus areas** — each documented in detail below.

---

## 1. Partition strategy for `trn_vehicle_positions` (DAILY)

**The design.** `trn_vehicle_positions` is the highest-volume table in the
entire CampusOS ERD — per-vehicle insert cadence runs from 10 to 30 seconds.
A typical school with 8 buses on a 7-hour operational day produces ~5,000 to
~17,000 position rows per day. RANGE partition by `recorded_at` DAILY keeps
each partition small enough that the partition pruner walks one daily leaf for
every recent-position lookup. Composite PK `(id, recorded_at)` because the
partition column must appear in the unique constraint.

**Why daily instead of monthly?** Monthly partitions would mean ~150,000 to
~500,000 rows per partition, defeating the pruner's purpose for the common
read shape ("last hour of positions for this vehicle"). The latest-position
query is a partition-pruned index scan on `(vehicle_id, recorded_at DESC)`
against today's partition — O(log n) on a small table.

**Why no UPDATE / no DELETE service surface?** Telemetry is an immutable
record. Corrections happen by inserting a new position with the corrected
lat/lng — the prior reading stays on the audit trail. The 7-day hot
retention + 90-day cold retention is enforced by the Phase 3 partition-
maintenance worker (not yet shipped — schema-only this cycle).

**Question for reviewers:** is the 14-days-behind / 90-days-ahead static
partition window the right call? Alternatives — generate every partition
on-the-fly via a BEFORE INSERT trigger (rejected because triggers complicate
the splitter audit), or generate via `pg_partman` extension (rejected
because the dev environment doesn't ship with the extension).

**Verification trail in the migration:**

```sql
-- Partition routing test (verified during smoke):
INSERT INTO trn_vehicle_positions (...)
VALUES (..., '2026-05-11T08:00:00+00', ...);
-- Lands in trn_vehicle_positions_2026_05_11
SELECT COUNT(*) FROM ONLY trn_vehicle_positions_2026_05_11;
-- Returns 1
```

---

## 2. GPS volume handling — dual-layer dedup

**The design.** When the Transport Dispatch extracted service deploys, a real
GPS device pushes positions via the same authenticated endpoint that the
manual ingest uses today (`POST /transport/vehicles/:id/position`). For
production at-least-once delivery semantics, the deferred consumer should
dedup on two layers:

- **Per-event consumer-group claim** via `platform_event_consumer_idempotency`.
  Same pattern as Cycle 31 OutboxPublisherWorker. Claim-after-success per
  REVIEW-CYCLE2 BLOCKING 2 — a Kafka redelivery of the same event row is a
  no-op once the consumer-group already claimed it.
- **Per-vehicle Redis claim** at `gps:vehicle:{vehicleId}:{recordedAt}` with
  a 10-minute TTL. Stops the same GPS device from re-pushing the same
  timestamp twice during network retry.

**Today's posture:** the manual ingest path runs through the
authenticated REST endpoint. Idempotency at the HTTP layer is the caller's
responsibility (a dispatch service would send a UUIDv7 event_id; a duplicate
ingest would land 2 rows because the partition table allows it). This is
acceptable for the demo + pilot phase where positions arrive at low volume
from TC manual entry.

**Phase 2 pre-pilot:** wire the deferred dispatch consumer with the two-layer
dedup as the high-volume path lands.

---

## 3. Geofence computation approach — point-in-polygon + haversine

**The design.** `GeofenceService.isPointInBoundary` is the keystone function.
Two implementations live in the same file:

- **`haversineMetres(lat1, lng1, lat2, lng2)`** — great-circle distance on the
  WGS-84 spheroid. Returns metres. For circle-type geofences,
  `isPointInBoundary` calls haversine + compares against
  `boundary.radius_metres`.
- **`pointInPolygon(lat, lng, coordinates)`** — classic ray-casting algorithm
  in O(n) over the polygon vertex list. For polygon-type geofences,
  `isPointInBoundary` walks the polygon's `coordinates` array of `[lat, lng]`
  pairs and counts edge crossings on a horizontal ray.

**Why not PostGIS?** PostGIS is not enabled on the dev / pilot Postgres
deployment. The Cycle 31 platform foundation does not ship the extension. The
JS-side computation is fast enough for the per-position fan-out (the
geofence list is small per school — typically 5 to 50 active geofences) and
keeps the schema portable.

**Why ray-casting?** Simplest correct algorithm. The polygon's `coordinates`
array carries `[lat, lng]` pairs in any order — the ray-casting algorithm
handles concave and convex polygons. The implementation is in
`apps/api/src/transport/geofence.service.ts` lines ~88-105 and is verified
end-to-end by the 6 tests under `describe('GeofenceService math')` in
`transport-advanced-c.spec.ts`.

**Verification trail:**

```typescript
// Square polygon, point inside
expect(
  pointInPolygon(5, 5, [
    [0, 0],
    [0, 10],
    [10, 10],
    [10, 0],
  ]),
).toBe(true);
// Point outside
expect(
  pointInPolygon(15, 5, [
    [0, 0],
    [0, 10],
    [10, 10],
    [10, 0],
  ]),
).toBe(false);

// Circle, point at centre + within radius + outside radius
const circle = { type: 'circle', center: { lat: 39.7, lng: -89.6 }, radius_metres: 200 };
expect(isPointInBoundary(39.7, -89.6, circle)).toBe(true); // centre
expect(isPointInBoundary(39.70091, -89.6, circle)).toBe(true); // ~100m away
expect(isPointInBoundary(39.7045, -89.6, circle)).toBe(false); // ~500m away
```

**Question for reviewers:** is the ray-casting algorithm acceptable for the
production case where polygon geofences may carry hundreds of vertices? The
worst case today is a few dozen vertices for a school campus boundary; the
typical case is a 4-vertex rectangle. If a school onboards with a 1000-vertex
polygon, the per-position computation cost rises linearly. The mitigation
is a bounding-box pre-filter (compute min/max lat/lng once at INSERT time +
cache; skip the full ray-casting when the point is outside the bbox) — not
yet implemented because the typical geofence has < 10 vertices.

---

## 4. ETA confidence levels (HIGH / MEDIUM / LOW)

**The design.** `trn_vehicle_eta.confidence` is a 3-value CHECK
(HIGH MEDIUM LOW). The ETA recompute path (today: ETAService.upsert called
manually or by the future dispatch integration) sets confidence based on
the upstream data quality:

- **HIGH** — latest position is < 60 seconds old AND the vehicle is moving
  along the route in the expected direction. The dispatch service computes
  this from the route geometry + the current heading.
- **MEDIUM** — latest position is 60 to 5 minutes old, OR the vehicle is
  stopped (likely traffic light, picking up students at a stop).
- **LOW** — latest position is > 5 minutes old, OR the vehicle is off the
  expected route geometry. Surfaces in the parent UI as "Approximate ETA".

**Today's posture:** the ETAService accepts any of the three confidence
values via the upsert API. The dispatch service drives the level when it
deploys; until then, the TC manually marks the level via the upsert form.

**Question for reviewers:** is the 3-level granularity appropriate, or
should the schema carry an integer confidence (0..100) instead? Real schools
likely render the level as a pill colour (HIGH green / MEDIUM amber /
LOW gray) so the 3-level matches the UI shape.

---

## 5. Driver hours regulatory compliance (configurable)

**The design.** `trn_driver_hours_limits` is UNIQUE(school_id) — one config
per school. Defaults ship as EU Working Time Directive:

- `weekly_driving_limit_minutes` default **2880** (48 hours)
- `daily_driving_limit_minutes` default **600** (10 hours)
- `mandatory_break_after_minutes` default **270** (4.5 hours → 45-minute break)
- `jurisdiction TEXT` default `US_FEDERAL`

The DriverHoursService recomputes `cumulative_weekly_minutes` on every
end-stamped duty period (via the duty_end_at PATCH) and emits
`trn.driver.hours_approaching_limit` when a driver reaches ≥90 % of the
weekly cap. The approaching-limit dashboard surfaces every driver within the
threshold so the TC can rotate substitutes before a regulatory breach.

**Why configurable per school?** US Federal Hours of Service rules differ
from EU Working Time Directive. US schools typically run on the 11-hour /
14-hour / 70-hour cycle for commercial drivers. UK + EU schools run on the
48-hour weekly cap. Pre-pilot, each school operator tunes the config based on
local regs.

**Question for reviewers:** the 90 % threshold for the
`trn.driver.hours_approaching_limit` emit is hard-coded. Should it be a
configurable column on `trn_driver_hours_limits`? Pre-pilot polish item.

---

## 6. Route generation stub design (Scheduling Solver not deployed)

**The design.** The Scheduling Solver extracted service is the Phase 3
operational deployment. Until it lands, the RouteGenerationService accepts
manual candidate authoring as the fallback. The TC drives the same
generation request lifecycle (QUEUED → RUNNING → COMPLETED) but pushes
candidates directly via `POST /transport/route-generation/:id/candidates`.

The APPROVED candidate flow is identical regardless of solver vs manual —
`trn_routes` + `trn_stops` + `trn_student_assignments` all land in one
tenant tx (the `approveCandidate` keystone). When the Scheduling Solver
deploys, the RouteGenerationWorker subscribes to a Kafka topic and calls
the solver's HTTP endpoint, then drops the candidates via the same
service-level helper. No request-path or schema change required.

**Question for reviewers:** is the manual-candidate fallback's UX
acceptable for pilot? A TC may have to author 10-20 candidate routes by
hand. Mitigation: the solver typically deploys at the same time as the
first real-school onboarding, and the pilot phase uses a smaller fleet
(< 5 vehicles, < 100 students) where manual authoring is tractable.

---

## 7. Safety-critical repair blocking (vehicle → MAINTENANCE)

**The design.** `trn_repair_categories.is_safety_critical` flags categories
where a logged repair blocks vehicle dispatch. The RepairService.create flow:

1. INSERT `trn_vehicle_repairs` with `status='SCHEDULED'` or `'IN_PROGRESS'`.
2. If the parent category's `is_safety_critical` flag is true AND no other
   open safety-critical repair exists for this vehicle, atomically flip
   `trn_vehicles.status` to `MAINTENANCE` inside the same tenant tx.
3. When the repair flips to `status='COMPLETED'`, the service walks every
   open safety-critical repair for the vehicle; if none remain, flip
   `trn_vehicles.status` back to `ACTIVE`.

The vehicle stays out of service until every safety-critical repair lands.
Today's posture: the `is_safety_critical` schema-side flag is the gate;
service-side discipline is the actual write enforcement.

**Question for reviewers:** should the schema enforce the linkage with a
database-level trigger? The Phase 2 punch list has a "vehicle dispatch
gating" item that would add a CHECK constraint on `trn_routes` / dispatch
operations that refuses scheduling when the matching vehicle has open
safety-critical repairs. Pre-pilot work.

---

## 8. Parent tracking token — unauthenticated GET + scope

**The design.** `GET /transport/tracking/:token` is the **only**
unauthenticated route in the entire transport module. It is scoped to a
single (student, route) pair — the parent sees the bus position + ETA for
their child's stop and nothing else. The DTO response (`ParentTrackingViewDto`)
deliberately excludes `studentId`, `studentName`, and any other student PII;
the only student-adjacent data point is the matching stop name.

**Token shape.** 64-hex (32 random bytes from `crypto.randomBytes(32)`).
High entropy, URL-safe, matches the Cycle 24 portfolio share token pattern.

**Token lifecycle.**

- Issuance: TC calls `POST /transport/tracking/tokens` with the student id +
  route id + optional `expiresInDays` (default 30, cap 365). Service
  auto-revokes any prior active token for the same (student, route) pair
  inside one tenant tx so the partial UNIQUE on
  `(student_id, route_id) WHERE is_active=true` releases.
- Revoke: TC calls `PATCH /transport/tracking/tokens/:id/revoke`. Flips
  `is_active=false` + stamps `revoked_at`. The multi-column `revoked_chk`
  schema invariant enforces the lockstep.
- Read: `GET /transport/tracking/:token` looks up the token, verifies
  `is_active=true` AND `expires_at > now()`. Revoked → 403. Expired → 403.
  Unknown → 404. Surface for the parent UI is a single page with the bus
  on a map + the ETA countdown to their child's stop.

**Question for reviewers:** is the 32-byte token + 30-day expiry the right
default? Alternative: shorter token (16 bytes / 32-hex) with a 7-day expiry.
The trade-off: shorter expiry forces parents to re-request every week (more
secure but more friction); longer expiry reduces friction but extends the
window if a token leaks. Pre-pilot decision — locked decision pending
school operator feedback.

**Verification trail in tests:**

```typescript
// Active token returns full view, no student PII
const view = await svc.viewByToken('active-token-x');
expect(view.routeName).toBe('Route 7 — Elm Street AM');
expect(view.vehicle?.registration).toBe('BUS-42');
expect(view.stopEta?.stopName).toBe('Elm Street Stop 1');
expect((view as any).studentId).toBeUndefined(); // No PII
expect((view as any).studentName).toBeUndefined();

// Revoked token → 403
expect(svc.viewByToken('revoked-token')).rejects.toBeInstanceOf(ForbiddenException);

// Expired token → 403
expect(svc.viewByToken('expired-token')).rejects.toBeInstanceOf(ForbiddenException);
```

---

## Triage table — populate during review

| ID  | Severity | Sub-cycle | File / area | Finding | Status  |
| --- | -------- | --------- | ----------- | ------- | ------- |
| 1   |          |           |             |         | PENDING |
| 2   |          |           |             |         | PENDING |
| 3   |          |           |             |         | PENDING |

**Severity:** BLOCKING (must fix before merge) / MAJOR (must fix before pilot)
/ MINOR (nice to have).

## Reviewer attention items (non-blocking)

These are recommendation-class items the cycle authors flag for the
reviewer's attention. None block merge.

1. Partition window — 14 days behind + 90 days ahead is hard-coded in the
   migration. Phase 3 ops needs a cron to extend the window.
2. Geofence enter/exit Kafka emits are best-effort. Phase 2 hardening moves
   `trn.geofence.entered` to the durable outbox pattern since parent
   notifications fan out from this topic.
3. ETA confidence levels are 3-value enum. Schools may want a per-vehicle
   override (manual SET LOW until the dispatch integration deploys).
4. The fleet status materialiser is exposed as both an admin-only POST and
   the per-vehicle TC POST. The nightly cron is ops work — no cron schedule
   in this commit.
5. Parent tracking token revoke is currently TC-only. Real schools may want
   parent-self-revoke ("I don't want this anymore, kill the share link").
   Pre-pilot polish.
6. The GeofenceService boundary check runs O(active_geofences) per position
   update. At-scale (a school with 50 geofences + 10 buses pushing every 10
   seconds = 5 boundary checks per second) this is fine; at extreme scale a
   bounding-box pre-filter is the optimisation lever.
7. The `trn.geofence.entered` event includes `speedKmh` + `speedLimitKmh`
   so the future SpeedAlertConsumer can fire a separate event when a
   vehicle enters a SPEED_ZONE geofence above the cap. The schema is wired;
   the consumer is Phase 2 punch list.

## Cross-cycle checks

- [x] Migration 138 splitter-audit clean before first provision attempt.
- [x] Both `tenant_demo` and `tenant_test` provisioned cleanly on first apply.
- [x] Idempotent re-provision verified (zero new applies on second run).
- [x] All 38 new vitest tests pass.
- [x] Pre-existing 564 tests still pass — no regressions.
- [x] `pnpm format:check` clean.
- [x] `pnpm lint:logs` clean across 733 files.
- [x] API + web builds clean.
- [x] Seed idempotency verified end-to-end.

## Final verdict format

When the review completes, append the verdict line at the bottom of this file
in the standard format:

```
**Round 1 verdict (date):** APPROVED | REJECT pending fixes | Approved with major follow-ups
```

If REJECT pending fixes, list every BLOCKING + MAJOR finding in the triage
table above. The fix commit lands with a header comment pointing back at
this file.
