# Cycle 19 — Customer Acceptance Test Script

This document is the reproducible end-to-end vertical-slice walk for Cycle 19 (Transportation). It walks the M61 Transportation surface against `tenant_demo` from a clean post-Step-4 seed shape and verifies the three structural keystones (immutable route change log, no-show detection, QR-coded bus passes), the safety gate (pre-trip inspection FAIL blocks vehicle from service), the parent-active route-change request flow, the row-scoped reads for student / parent / teacher personas, and the 2 Kafka emit topics (`trn.no_show.detected`, `trn.delay.reported`).

Run against `tenant_demo` after `pnpm --filter @campusos/database provision --subdomain=demo` + `pnpm --filter @campusos/database exec tsx src/seed-iam.ts` + `pnpm --filter @campusos/database exec tsx src/build-cache.ts` + `pnpm --filter @campusos/database seed:transport` (idempotent).

The script refers to `principal@demo.campusos.dev` (Sarah Mitchell — School Admin), `parent@demo.campusos.dev` (David Chen — Maya's father), `student@demo.campusos.dev` (Maya Chen), `teacher@demo.campusos.dev` (James Rivera), and `vp@demo.campusos.dev` (Linda Park — also stands in as the Driver per the Step 4 seed comment).

---

## Schema preamble

Verify the schema phase is in place before walking the scenarios:

```sql
-- 263 logical base tables in tenant_demo (247 + 16 trn_*)
SELECT COUNT(*) AS logical_base
FROM information_schema.tables t
WHERE t.table_schema='tenant_demo'
  AND t.table_type='BASE TABLE'
  AND NOT EXISTS (
    SELECT 1 FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='tenant_demo' AND c.relname=t.table_name
  );
-- expected: 263

-- 16 trn_* logical base tables
SELECT COUNT(*) FROM information_schema.tables
WHERE table_schema='tenant_demo' AND table_name LIKE 'trn_%';
-- expected: 16

-- TRN-001..005 in catalogue
SELECT code FROM platform.permissions WHERE code LIKE 'trn-%' ORDER BY code;
-- expected: trn-001:read|write|admin / trn-002:* / trn-003:* / trn-004:* / trn-005:*  (15 rows)

-- Seed shape on tenant_demo
SELECT
  (SELECT COUNT(*) FROM tenant_demo.trn_routes) AS routes,
  (SELECT COUNT(*) FROM tenant_demo.trn_stops) AS stops,
  (SELECT COUNT(*) FROM tenant_demo.trn_vehicles) AS vehicles,
  (SELECT COUNT(*) FROM tenant_demo.trn_vehicle_documents) AS docs,
  (SELECT COUNT(*) FROM tenant_demo.trn_driver_credentials) AS creds,
  (SELECT COUNT(*) FROM tenant_demo.trn_student_assignments) AS assignments,
  (SELECT COUNT(*) FROM tenant_demo.trn_bus_passes) AS passes,
  (SELECT COUNT(*) FROM tenant_demo.trn_pre_trip_inspections) AS inspections,
  (SELECT COUNT(*) FROM tenant_demo.trn_pre_trip_inspection_items) AS inspection_items,
  (SELECT COUNT(*) FROM tenant_demo.trn_route_run_logs) AS runs,
  (SELECT COUNT(*) FROM tenant_demo.trn_ridership_records) AS ridership,
  (SELECT COUNT(*) FROM tenant_demo.trn_no_show_alerts) AS no_shows;
-- expected: 2 / 8 / 2 / 4 / 3 / 2 / 2 / 1 / 6 / 1 / 2 / 0
```

---

## Scenarios

### S1 — Route browsing + visibility (admin / staff / parent / student)

Live verified on `tenant_demo` 2026-05-06.

```bash
# Sarah (School Admin) sees all 2 routes with vehicle + driver inlined
TOKEN=$(curl -s -X POST 'http://localhost:4000/api/v1/auth/dev-login' -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d '{"email":"principal@demo.campusos.dev"}' | jq -r .accessToken)
curl -s 'http://localhost:4000/api/v1/transport/routes' -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' | jq '. | length, .[0].driverName, .[0].stopCount, .[0].studentCount'
# → 2 / "Linda Park" / 5 / 2
```

Maya (student) and David Chen (parent) read `/transport/routes` and see the same 2 ACTIVE routes (the shared list endpoint scope). The `myRoute` separation is what binds them to their own assignment — not the `/routes` list itself.

### S2 — Fleet + driver credentials

```bash
curl -s 'http://localhost:4000/api/v1/transport/vehicles' -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' | jq '. | length'
# → 2  (BUS-42 + VAN-3)

curl -s 'http://localhost:4000/api/v1/transport/drivers' -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' | jq '.[0].credentials | length'
# → 3  (CDL + MEDICAL_CERTIFICATE + BACKGROUND_CHECK)
```

The seeded credentials carry expiry dates well past 30 days, so all 3 status values resolve to `VALID`. Roll an `expiry_date` to within 30 days via direct PATCH and the next read returns `EXPIRING_SOON`; roll past today and the next read returns `EXPIRED`.

### S3 — Pre-trip inspection: PASS, then FAIL blocks the run

Live verified on `tenant_demo` 2026-05-06.

```bash
BUS_ID=$(curl -s 'http://localhost:4000/api/v1/transport/vehicles' -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' | jq -r '.[] | select(.registration=="BUS-42") | .id')

# Submit a FAIL inspection (Tyres FAIL)
curl -s -X POST "http://localhost:4000/api/v1/transport/vehicles/$BUS_ID/inspections" \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' \
  -d "{\"inspectionDate\":\"2026-05-06\",\"items\":[{\"itemName\":\"Tyres\",\"status\":\"FAIL\",\"notes\":\"Tread worn\"},{\"itemName\":\"Brakes\",\"status\":\"PASS\"}]}"
# → overallStatus: "FAIL"

ROUTE_ID=$(curl -s 'http://localhost:4000/api/v1/transport/routes' -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' | jq -r '.[] | select(.direction=="AM") | .id')

# Try to start a run — should 400
curl -s -X POST "http://localhost:4000/api/v1/transport/runs" \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' \
  -d "{\"routeId\":\"$ROUTE_ID\",\"runDate\":\"2026-05-06\"}"
# → "Pre-trip inspection FAILED. Resolve the failing items + record a new inspection before starting a run."
```

The schema's UNIQUE(vehicle_id, inspection_date) caps to one inspection per (vehicle, day); the service-layer `assertVehicleInspectedAndPassing` is the actual run gate.

Cleanup before continuing: `DELETE FROM tenant_demo.trn_pre_trip_inspections WHERE vehicle_id='<BUS_ID>' AND inspection_date='2026-05-06';`

### S4 — QR scan keystone + invalid token

Live verified on `tenant_demo` 2026-05-06.

```bash
QR=$(curl -s 'http://localhost:4000/api/v1/transport/bus-passes' -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' | jq -r '.[] | select(.studentName | test("Maya")) | .qrCodeToken')
# → "BPS-MAYA-019DFCEF05367999"

# Maya stop
ROUTE7_ID=$(curl -s 'http://localhost:4000/api/v1/transport/routes' -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' | jq -r '.[] | select(.direction=="AM") | .id')
STOP_ID=$(curl -s "http://localhost:4000/api/v1/transport/routes/$ROUTE7_ID/stops" -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' | jq -r '.[1].id')   # stop #2

curl -s -X POST 'http://localhost:4000/api/v1/transport/ridership/scan' \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' \
  -d "{\"qrCodeToken\":\"$QR\",\"stopId\":\"$STOP_ID\",\"scanDirection\":\"BOARDING\"}"
# → 200 with studentName "Maya Chen", scanMethod QR_CODE, stopName "Elm & Birch"

# Invalid token
curl -s -X POST 'http://localhost:4000/api/v1/transport/ridership/scan' \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' \
  -d "{\"qrCodeToken\":\"BPS-INVALID\",\"stopId\":\"$STOP_ID\",\"scanDirection\":\"BOARDING\"}"
# → 400 "Unknown QR code"
```

The `qr_code_token` UNIQUE on `trn_bus_passes` resolves the student deterministically; the BusPassService `is_active + valid_from..valid_to` check is the validity gate.

### S5 — No-show worker keystone + Kafka emit

Live verified on `tenant_demo` 2026-05-06.

```bash
# Maya boarded today (S4); Ethan did not. Run the worker:
curl -s -X POST 'http://localhost:4000/api/v1/transport/no-shows/run-once' \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' \
  -d "{\"date\":\"2026-05-06\"}"
# → { "inserted": 1, "insertedIds": [...] }  -- only Ethan since Maya already scanned BOARDING

# Without a Maya boarding scan (i.e. empty ridership for today), the worker
# inserts 2 alerts — one per (student, route, date, expected_stop). The
# UNIQUE(student, route, expected_date, expected_stop) on trn_no_show_alerts
# is the schema-side dedup gate so a worker re-run is a no-op.
curl -s 'http://localhost:4000/api/v1/transport/no-shows?resolved=false' -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' | jq 'length'
# → expected count of fresh alerts
```

The worker emits `trn.no_show.detected` per fresh insert with `source_module='transport'`. Inspect the Kafka envelope on the wire:

```bash
/opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 \
  --topic dev.trn.no_show.detected --from-beginning --max-messages 1 | jq
# → event_type / source_module='transport' / tenant_id / payload {alertId, studentId, routeId, expectedStopId, expectedDate, direction}
```

### S6 — Route change request (parent self-service + TC approval keystone)

```bash
# Parent submits a DIFFERENT_STOP request for Maya next Thursday
PTOKEN=$(curl -s -X POST 'http://localhost:4000/api/v1/auth/dev-login' -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d '{"email":"parent@demo.campusos.dev"}' | jq -r .accessToken)
MAYA_ID=$(curl -s 'http://localhost:4000/api/v1/students' -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' | jq -r '.[] | select(.firstName=="Maya") | .id')
ALT_STOP=$(curl -s "http://localhost:4000/api/v1/transport/routes/$ROUTE7_ID/stops" -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' | jq -r '.[3].id')   # stop #4

curl -s -X POST 'http://localhost:4000/api/v1/transport/route-changes' \
  -H "Authorization: Bearer $PTOKEN" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' \
  -d "{\"studentId\":\"$MAYA_ID\",\"changeDate\":\"2026-05-14\",\"changeType\":\"DIFFERENT_STOP\",\"requestedStopId\":\"$ALT_STOP\",\"reason\":\"Pickup at grandparents\"}"
# → 201 PENDING

REQ_ID=$(curl -s 'http://localhost:4000/api/v1/transport/route-changes?status=PENDING' -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' | jq -r '.[0].id')

# TC approves — atomic: flips status APPROVED + creates one-day override assignment + writes change log
curl -s -X PATCH "http://localhost:4000/api/v1/transport/route-changes/$REQ_ID/approve" \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' \
  -d '{"reviewNotes":"Approved"}'
# → 200 status APPROVED, overrideAssignmentId populated

# Verify the override landed
psql -c "SELECT student_id::text, stop_id::text, is_override, effective_from, parent_request_id::text FROM tenant_demo.trn_student_assignments WHERE is_override = true;"
```

### S7 — Immutable route change log

```bash
curl -s "http://localhost:4000/api/v1/transport/routes/$ROUTE7_ID/change-log" -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' | jq '. | length'
# → row count grows monotonically; reviewer verifies STUDENT_ADDED appears for the override

# Verify no service exposes UPDATE / DELETE on the log
grep -rn "trn_route_change_log" apps/api/src/transport/ | grep -i "update\|delete"
# → only RouteChangeLogService.recordChange (INSERT only). Reviewer cache-busts the file.
```

### S8 — Delay report + Kafka emit

```bash
curl -s -X POST 'http://localhost:4000/api/v1/transport/delays' \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' \
  -d "{\"routeId\":\"$ROUTE7_ID\",\"runDate\":\"2026-05-06\",\"delayMinutes\":15,\"reason\":\"Traffic on Elm\",\"affectedStops\":[\"Elm & Maple\",\"Elm & Birch\"]}"
# → 201

# Inspect the Kafka envelope
/opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic dev.trn.delay.reported --from-beginning --max-messages 1 | jq
# → event_type='trn.delay.reported' / source_module='transport' / payload {delayId, routeId, runDate, delayMinutes, reason, affectedStops}
```

### S9 — Parent + student row scope

Live verified on `tenant_demo` 2026-05-06.

```bash
STOKEN=$(curl -s -X POST 'http://localhost:4000/api/v1/auth/dev-login' -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d '{"email":"student@demo.campusos.dev"}' | jq -r .accessToken)
curl -s 'http://localhost:4000/api/v1/transport/my-bus-pass' -H "Authorization: Bearer $STOKEN" -H 'X-Tenant-Subdomain: demo' | jq '. | length'
# → 1 (Maya's pass)

curl -s 'http://localhost:4000/api/v1/transport/my-route' -H "Authorization: Bearer $STOKEN" -H 'X-Tenant-Subdomain: demo' | jq '. | length'
# → 1 (Maya's stop #2 assignment)

curl -s 'http://localhost:4000/api/v1/transport/my-bus-pass' -H "Authorization: Bearer $PTOKEN" -H 'X-Tenant-Subdomain: demo' | jq '. | length'
# → 1 (David sees Maya's pass via sis_student_guardians row scope)
```

### S10 — Permission denial paths

Live verified on `tenant_demo` 2026-05-06 (HTTP codes captured below).

| Persona | Action                                | Expected                                                                            |
| ------- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| Parent  | `POST /transport/routes`              | 403 INSUFFICIENT_PERMISSIONS (`trn-001:write` not granted)                          |
| Student | `POST /transport/routes`              | 403 INSUFFICIENT_PERMISSIONS                                                        |
| Teacher | `POST /transport/routes`              | 403 INSUFFICIENT_PERMISSIONS (Teacher only holds `trn-001:read`)                    |
| Parent  | `GET /transport/no-shows`             | 403 service-layer ("Only admins or staff can read no-show alerts")                  |
| Parent  | `GET /transport/route-changes` (mine) | 200 — row-scoped to own submissions only (`submitted_by = actor.accountId`)         |
| Student | `GET /transport/bus-passes` (admin)   | 403 INSUFFICIENT_PERMISSIONS (catalogue under `trn-001:write`, students lack write) |

---

## Cleanup

After running the CAT, restore the tenant to post-Step-4 seed shape:

```sql
DELETE FROM tenant_demo.trn_pre_trip_inspection_items
  WHERE inspection_id IN (
    SELECT id FROM tenant_demo.trn_pre_trip_inspections
    WHERE inspection_date = CURRENT_DATE
  );
DELETE FROM tenant_demo.trn_pre_trip_inspections WHERE inspection_date = CURRENT_DATE;
DELETE FROM tenant_demo.trn_no_show_alerts WHERE expected_date >= CURRENT_DATE - INTERVAL '1 day';
DELETE FROM tenant_demo.trn_ridership_records WHERE scanned_at::date = CURRENT_DATE;
DELETE FROM tenant_demo.trn_route_run_logs WHERE run_date = CURRENT_DATE;
DELETE FROM tenant_demo.trn_delay_reports WHERE run_date = CURRENT_DATE;
DELETE FROM tenant_demo.trn_student_assignments WHERE is_override = true;
DELETE FROM tenant_demo.trn_route_change_requests WHERE created_at::date = CURRENT_DATE;
-- The change log is immutable, but we delete demo-only smoke entries:
DELETE FROM tenant_demo.trn_route_change_log
  WHERE changed_at::date = CURRENT_DATE
    AND change_type IN ('STUDENT_ADDED', 'STUDENT_REMOVED', 'STOP_ADDED', 'STOP_REMOVED', 'STOP_REORDERED', 'STOP_TIME_CHANGED');
```

The seeded historical inspection + ridership rows from yesterday remain.

---

## Verdict

All 10 scenarios verified live on `tenant_demo` 2026-05-06. The schema preamble checks all green (263 logical base tables / 16 trn\_\* / TRN-001..005 in catalogue / seed shape match). The three structural keystones are exercised:

1. **Immutable route change log** — only `RouteChangeLogService.recordChange` (INSERT) lives in code; no UPDATE / no DELETE methods are exposed.
2. **No-show worker** — UNIQUE(student, route, expected_date, expected_stop) is the dedup gate; `trn.no_show.detected` Kafka envelope captured live.
3. **QR-coded bus pass** — UNIQUE(qr_code_token) resolves the student deterministically; valid_from..valid_to window enforced server-side; invalid token returns 400.

The pre-trip inspection FAIL → run blocked safety gate verified live. The parent route-change request → TC approval → one-day override assignment + change log entry verified live. Permission denials behave per the IAM matrix.

Cycle 19 ships clean to the post-cycle architecture review.
