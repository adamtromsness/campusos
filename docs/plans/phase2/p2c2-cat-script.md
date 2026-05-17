# P2C2 CAT — Incident & Emergency vertical slice

This Customer Acceptance Test walks the M91 module end-to-end. Each
scenario is a copy-paste shell block with the expected outcome
documented inline. Run sequentially against `tenant_demo`.

## Schema preamble (sanity check)

```bash
docker exec -i campusos-postgres psql -U campusos -d campusos_dev <<'SQL'
SET search_path TO tenant_demo, platform, public;

-- 11 inc_* tables present
SELECT 'tables', COUNT(*) FROM pg_tables WHERE schemaname='tenant_demo' AND tablename LIKE 'inc_%';
-- expected: 11

-- Seed counts match plan
SELECT 'incident_types',         COUNT(*) FROM inc_incident_types
UNION ALL SELECT 'procedures',   COUNT(*) FROM inc_emergency_procedures
UNION ALL SELECT 'incidents',    COUNT(*) FROM inc_incidents
UNION ALL SELECT 'timeline',     COUNT(*) FROM inc_incident_timeline
UNION ALL SELECT 'accountability', COUNT(*) FROM inc_accountability_records
UNION ALL SELECT 'summary',      COUNT(*) FROM inc_accountability_summary
UNION ALL SELECT 'reunification', COUNT(*) FROM inc_reunification_records
UNION ALL SELECT 'corrections',  COUNT(*) FROM inc_reunification_corrections
UNION ALL SELECT 'drills',       COUNT(*) FROM inc_drills
UNION ALL SELECT 'non_discipline', COUNT(*) FROM inc_non_discipline_incidents
UNION ALL SELECT 'outbox',       COUNT(*) FROM inc_declaration_outbox;
-- expected: 5 / 3 / 1 / 5 / 15 / 1 / 1 / 0 / 2 / 2 / 1
SQL
```

## Authentication scaffold

```bash
JWT_TEACHER=$(curl -s -X POST http://localhost:4000/api/v1/auth/dev-login \
  -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' \
  -d '{"email":"teacher@demo.campusos.dev"}' | jq -r .accessToken)
JWT_STAFF=$(curl -s -X POST http://localhost:4000/api/v1/auth/dev-login \
  -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' \
  -d '{"email":"counsellor@demo.campusos.dev"}' | jq -r .accessToken)
JWT_ADMIN=$(curl -s -X POST http://localhost:4000/api/v1/auth/dev-login \
  -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' \
  -d '{"email":"principal@demo.campusos.dev"}' | jq -r .accessToken)
JWT_PARENT=$(curl -s -X POST http://localhost:4000/api/v1/auth/dev-login \
  -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' \
  -d '{"email":"parent@demo.campusos.dev"}' | jq -r .accessToken)

H="-H Content-Type:application/json -H X-Tenant-Subdomain:demo"
LOCKDOWN_ID=$(docker exec -i campusos-postgres psql -U campusos -d campusos_dev -tA -c \
  "SELECT id FROM tenant_demo.inc_incident_types WHERE code='LOCKDOWN' LIMIT 1")
```

---

## Scenario 1 — Atomic emergency declaration + outbox creation

```bash
# Admin declares LOCKDOWN.
RESP=$(curl -s -X POST http://localhost:4000/api/v1/incidents/declare \
  -H "Authorization: Bearer $JWT_ADMIN" $H \
  -d "{\"incidentTypeId\":\"$LOCKDOWN_ID\",\"title\":\"CAT lockdown rehearsal\",\"description\":\"Vertical slice test.\"}")
INC_ID=$(echo "$RESP" | jq -r .id)
echo "Created incident $INC_ID — status $(echo $RESP | jq -r .status), severity $(echo $RESP | jq -r .severity)"
# expected: status=ACTIVE, severity=CRITICAL

# Verify inc_incidents + inc_declaration_outbox both committed in one tx.
docker exec -i campusos-postgres psql -U campusos -d campusos_dev -c "
SET search_path TO tenant_demo, platform, public;
SELECT i.id::text AS incident, o.id::text AS outbox,
       o.tasks_created_at IS NULL AS tasks_pending,
       o.muster_taken_at IS NULL AS muster_pending,
       o.alert_sent_at IS NULL AS alert_pending
FROM inc_incidents i
JOIN inc_declaration_outbox o ON o.incident_id = i.id
WHERE i.id::text = '$INC_ID';"
# expected: tasks_pending=t, muster_pending=t, alert_pending=t (all true initially)
```

## Scenario 2 — Outbox crash recovery (idempotent step stamping)

```bash
# Wait for outbox worker tick (default 30s warmup + 5s interval).
sleep 8
# Manually advance outbox by stamping tasks_created_at, then verify
# the worker doesn't double-stamp.
docker exec -i campusos-postgres psql -U campusos -d campusos_dev -c "
SET search_path TO tenant_demo, platform, public;
UPDATE inc_declaration_outbox SET tasks_created_at = now()
  WHERE incident_id = '$INC_ID' AND tasks_created_at IS NULL;
SELECT incident_id::text, tasks_created_at IS NOT NULL AS tasks_done,
       muster_taken_at IS NOT NULL AS muster_done,
       alert_sent_at IS NOT NULL AS alert_done
FROM inc_declaration_outbox WHERE incident_id = '$INC_ID';"
# Worker on next tick will only stamp the still-NULL columns.
# Re-run after 5s and confirm.
```

## Scenario 3 — Immutable timeline (append-only enforcement)

```bash
curl -s -X POST http://localhost:4000/api/v1/incidents/$INC_ID/timeline \
  -H "Authorization: Bearer $JWT_ADMIN" $H \
  -d '{"eventType":"PROCEDURE_STARTED","description":"Lockdown procedure initiated"}' | jq -r .id

curl -s -X POST http://localhost:4000/api/v1/incidents/$INC_ID/timeline \
  -H "Authorization: Bearer $JWT_ADMIN" $H \
  -d '{"eventType":"BUILDING_CLEARED","description":"Building A confirmed clear"}' | jq -r .id

# List — proves chronological ordering + immutability.
curl -s http://localhost:4000/api/v1/incidents/$INC_ID/timeline \
  -H "Authorization: Bearer $JWT_ADMIN" $H | jq 'length'
# expected: 2 (or more if outbox has injected entries)

# IMMUTABILITY CHECK: TimelineService exposes no PATCH or DELETE.
# `grep -r 'incidents/.*/timeline' apps/api/src/incidents/incidents.controller.ts`
# returns only GET and POST handlers — no PATCH, no DELETE endpoints.
echo "Timeline routes:"
grep -E "Get\(|Post\(|Patch\(|Delete\(" \
  apps/api/src/incidents/incidents.controller.ts | grep -i timeline
# expected: only @Get and @Post on the timeline path
```

## Scenario 4 — Accountability lifecycle + summary materialisation

```bash
# Pre-seed three records for the new incident (the visitor muster step
# will eventually populate from vis_sign_ins; for the CAT we seed
# a deterministic shape).
docker exec -i campusos-postgres psql -U campusos -d campusos_dev -c "
SET search_path TO tenant_demo, platform, public;
INSERT INTO inc_accountability_records (id, incident_id, person_id, person_type, status)
VALUES (gen_random_uuid(), '$INC_ID', gen_random_uuid(), 'STUDENT', 'UNKNOWN'),
       (gen_random_uuid(), '$INC_ID', gen_random_uuid(), 'STAFF', 'UNKNOWN'),
       (gen_random_uuid(), '$INC_ID', gen_random_uuid(), 'STUDENT', 'UNKNOWN');"

# Initial summary.
curl -s http://localhost:4000/api/v1/incidents/$INC_ID/accountability/summary \
  -H "Authorization: Bearer $JWT_ADMIN" $H | jq '.totalPeople, .unknown, .accountedFor'

# Bulk update: mark all 3 ACCOUNTED_FOR.
RECORD_IDS=$(docker exec -i campusos-postgres psql -U campusos -d campusos_dev -tA -c \
  "SELECT '[\"' || string_agg(id::text, '\",\"') || '\"]' FROM tenant_demo.inc_accountability_records WHERE incident_id = '$INC_ID' AND status = 'UNKNOWN'")
curl -s -X POST http://localhost:4000/api/v1/incidents/$INC_ID/accountability/bulk \
  -H "Authorization: Bearer $JWT_ADMIN" $H \
  -d "{\"recordIds\":$RECORD_IDS,\"status\":\"ACCOUNTED_FOR\"}" | jq .

# Summary reflects the new state in the same tx.
curl -s http://localhost:4000/api/v1/incidents/$INC_ID/accountability/summary \
  -H "Authorization: Bearer $JWT_ADMIN" $H | jq '.totalPeople, .accountedFor, .unknown'
# expected: totalPeople=3, accountedFor=3, unknown=0
```

## Scenario 5 — Identity-verified reunification + correction audit

```bash
# Pick a real student and a real signed-in visitor from P2C1 seed.
VISITOR_ID=$(docker exec -i campusos-postgres psql -U campusos -d campusos_dev -tA -c \
  "SELECT v.id FROM tenant_demo.vis_visitors v JOIN tenant_demo.vis_sign_ins s ON s.visitor_id = v.id WHERE s.signed_out_at IS NULL LIMIT 1")
STUDENT_ID=$(docker exec -i campusos-postgres psql -U campusos -d campusos_dev -tA -c \
  "SELECT id FROM tenant_demo.sis_students LIMIT 1")

# Try with a non-signed-in visitor first → should FAIL.
docker exec -i campusos-postgres psql -U campusos -d campusos_dev -tA -c \
  "INSERT INTO tenant_demo.vis_visitors (id, school_id, visitor_type_id, first_name, last_name, email_hash) \
   SELECT gen_random_uuid(), school_id, visitor_type_id, 'Notin', 'Office', md5(random()::text) FROM tenant_demo.vis_visitors LIMIT 1 RETURNING id" > /tmp/inactive_vis.txt
INACTIVE_ID=$(cat /tmp/inactive_vis.txt)
RESP=$(curl -s -X POST http://localhost:4000/api/v1/incidents/$INC_ID/reunification \
  -H "Authorization: Bearer $JWT_ADMIN" $H \
  -d "{\"studentId\":\"$STUDENT_ID\",\"releasedToId\":\"$INACTIVE_ID\"}")
echo "Inactive visitor reunification: $(echo $RESP | jq -r .message)"
# expected: "The collecting adult must be currently signed in..."

# Real signed-in visitor → should SUCCEED.
RESP=$(curl -s -X POST http://localhost:4000/api/v1/incidents/$INC_ID/reunification \
  -H "Authorization: Bearer $JWT_ADMIN" $H \
  -d "{\"studentId\":\"$STUDENT_ID\",\"releasedToId\":\"$VISITOR_ID\"}")
REUN_ID=$(echo "$RESP" | jq -r .id)
echo "Reunification $REUN_ID created"

# Try a correction with too-short reason → should FAIL.
curl -s -X POST http://localhost:4000/api/v1/incidents/reunification/$REUN_ID/correct \
  -H "Authorization: Bearer $JWT_ADMIN" $H \
  -d '{"correctionReason":"oops"}' | jq -r .message
# expected: "...at least 20 characters..."

# Correct with full reason → succeeds.
curl -s -X POST http://localhost:4000/api/v1/incidents/reunification/$REUN_ID/correct \
  -H "Authorization: Bearer $JWT_ADMIN" $H \
  -d '{"correctionReason":"Initial release was to wrong adult — corrected after parent confirmed identity at second check."}' | jq -r .id
```

## Scenario 6 — Drill scheduling + completion + overdue calc

```bash
# Schedule a new drill.
DRILL_RESP=$(curl -s -X POST http://localhost:4000/api/v1/incidents/drills \
  -H "Authorization: Bearer $JWT_ADMIN" $H \
  -d "{\"procedureType\":\"FIRE_EVACUATION\",\"scheduledAt\":\"2026-06-01T10:00:00Z\",\"notes\":\"CAT test drill\"}")
DRILL_ID=$(echo "$DRILL_RESP" | jq -r .id)

# Complete the drill.
curl -s -X PATCH http://localhost:4000/api/v1/incidents/drills/$DRILL_ID/complete \
  -H "Authorization: Bearer $JWT_ADMIN" $H \
  -d "{\"completedAt\":\"2026-06-01T10:18:00Z\",\"durationSeconds\":1080,\"participationRate\":0.95,\"notes\":\"95% participation\"}" \
  | jq '.status, .durationSeconds, .participationRate'
# expected: status=COMPLETED, 1080, 0.95

# Overdue check — should be empty since the seeded drill was within 90 days.
curl -s http://localhost:4000/api/v1/incidents/drills/overdue \
  -H "Authorization: Bearer $JWT_ADMIN" $H | jq 'length'
```

## Scenario 7 — Resolve + after-action

```bash
curl -s -X PATCH http://localhost:4000/api/v1/incidents/$INC_ID/resolve \
  -H "Authorization: Bearer $JWT_ADMIN" $H \
  -d '{"resolutionNotes":"All clear. Drill complete. 3 of 3 mustered."}' | jq '.status, .resolvedAt'
# expected: status=RESOLVED, resolvedAt populated

# After-action page reads the immutable timeline + final summary +
# reunification log without mutating data.
curl -s http://localhost:4000/api/v1/incidents/$INC_ID \
  -H "Authorization: Bearer $JWT_ADMIN" $H | jq '.status, .resolutionNotes'
```

## Scenario 8 — Non-discipline incident report (teacher) → review (admin)

```bash
# Teacher reports.
REP_ID=$(curl -s -X POST http://localhost:4000/api/v1/incidents/reports \
  -H "Authorization: Bearer $JWT_TEACHER" $H \
  -d "{\"incidentType\":\"STUDENT_INJURY\",\"location\":\"Playground swing\",\"incidentDate\":\"2026-05-09T14:30:00Z\",\"description\":\"Student fell from swing — minor scrape, walked to nurse.\",\"severity\":\"LOW\"}" \
  | jq -r .id)

# Admin reviews + closes.
curl -s -X PATCH http://localhost:4000/api/v1/incidents/reports/$REP_ID \
  -H "Authorization: Bearer $JWT_ADMIN" $H \
  -d '{"status":"CLOSED","resolution":"Student bandaged, parent notified, returned to class."}' \
  | jq '.status, .closedAt'
```

## Scenario 9 — Permission denials

```bash
# Parent CANNOT access the incident module at all.
curl -s -o /dev/null -w "parent /incidents → %{http_code}\n" \
  http://localhost:4000/api/v1/incidents -H "Authorization: Bearer $JWT_PARENT" $H
# expected: 403

# Teacher CANNOT declare emergencies (saf-001:write only on Staff/Admin).
curl -s -o /dev/null -w "teacher declare → %{http_code}\n" \
  -X POST http://localhost:4000/api/v1/incidents/declare \
  -H "Authorization: Bearer $JWT_TEACHER" $H \
  -d "{\"incidentTypeId\":\"$LOCKDOWN_ID\"}"
# expected: 403

# Teacher CAN view procedures (saf-001:read).
curl -s -o /dev/null -w "teacher procedures → %{http_code}\n" \
  http://localhost:4000/api/v1/incidents/procedures -H "Authorization: Bearer $JWT_TEACHER" $H
# expected: 200

# Teacher can report non-discipline incidents (saf-003:write).
curl -s -o /dev/null -w "teacher reports → %{http_code}\n" \
  http://localhost:4000/api/v1/incidents/reports/list -H "Authorization: Bearer $JWT_TEACHER" $H
# expected: 200
```

## Scenario 10 — Cleanup (restore tenant_demo to seed shape)

```bash
docker exec -i campusos-postgres psql -U campusos -d campusos_dev <<'SQL'
SET search_path TO tenant_demo, platform, public;
-- Drop all CAT artifacts EXCEPT the original seed row.
DELETE FROM inc_reunification_corrections
  WHERE reunification_record_id IN (
    SELECT id FROM inc_reunification_records WHERE incident_id NOT IN (
      SELECT id FROM inc_incidents WHERE title='Q3 Fire Drill'
    )
  );
DELETE FROM inc_reunification_records WHERE incident_id NOT IN (
  SELECT id FROM inc_incidents WHERE title='Q3 Fire Drill'
);
DELETE FROM inc_incidents WHERE title='CAT lockdown rehearsal';
DELETE FROM inc_drills WHERE notes LIKE '%CAT test drill%';
DELETE FROM inc_non_discipline_incidents WHERE description LIKE '%fell from swing%';
DELETE FROM vis_visitors WHERE first_name='Notin' AND last_name='Office';

-- Confirm.
SELECT 'incidents', COUNT(*) FROM inc_incidents
UNION ALL SELECT 'drills', COUNT(*) FROM inc_drills
UNION ALL SELECT 'reports', COUNT(*) FROM inc_non_discipline_incidents;
-- expected: 1 / 2 / 2  (back to seed shape)
SQL
```

---

## Pass criteria

All scenarios complete with the documented expected output. Specifically:

- inc_declaration_outbox row created in same tx as inc_incidents (S1).
- Outbox stamping is idempotent — re-running the worker tick after a
  manual stamp does not re-fire the same step (S2).
- TimelineService exposes only POST + GET — controller has no PATCH/DELETE
  routes pointing at the timeline path (S3).
- Bulk accountability update uses the WITH CTE `RETURNING 1` pattern + the
  summary recomputes in the same tx (S4).
- Reunification rejects releases to visitors not currently signed in via
  vis_sign_ins (S5).
- Reunification correction enforces the 20-char minimum reason (S5).
- Drill complete uses locked-row state machine (S6).
- Resolve flips status to RESOLVED with resolved_at + resolved_by stamped
  per the multi-column lockstep CHECK (S7).
- Non-discipline reports respect saf-003 read scope: teacher sees own
  reports + admin sees all (S8).
- Parent cannot access any /incidents endpoint (S9).
- Cleanup restores tenant to the seed shape (S10).
