# Cycle 15 Customer Acceptance Test (CAT) — Meetings & Conferences

**Audience:** Architecture reviewers + future maintainers.
**Reference:** `docs/campusos-cycle15-implementation-plan.html`, `HANDOFF-CYCLE15.md`.
**Tagged commit:** `cycle15-complete` (after CI green).

This document is the reproducible end-to-end vertical slice test for Cycle 15 (Meetings & Conferences). Cycle 15 builds the M41 Meetings module — 11 of the 13 ERD tables. The two AI-deferred tables (`mtg_transcription_jobs`, `mtg_ai_minutes_jobs`) ship in Cycle 15.1 once an external transcription / inference service is integrated.

The two product keystones are:

1. **Parent self-service slot booking.** `mtg_meeting_slots` plus `PATCH /meeting-slots/:id/book` use `SELECT FOR UPDATE` on the slot row inside `executeInTenantTransaction` so concurrent attempts serialise. The booking auto-creates a participant row.
2. **Two-layer parent-visibility on meeting notes.** `mtg_meeting_notes.is_parent_visible` AND `mtg_meeting_notes.is_approved` must both be true before a parent sees the notes. Parents see `parent_visible_summary` if provided, otherwise full `notes_text`.

---

## Schema preamble (5 checks)

Run against `tenant_demo` after `pnpm seed:meetings` has landed.

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
SELECT
  (SELECT COUNT(*) FROM information_schema.tables
    WHERE table_schema='tenant_demo' AND table_name LIKE 'mtg\_%') AS mtg_tables,
  (SELECT COUNT(*) FROM pg_constraint c
    WHERE c.connamespace='tenant_demo'::regnamespace AND c.contype='f'
    AND c.conname LIKE 'mtg\_%fkey') AS mtg_intra_fks;
"
```

Expected: **mtg_tables=11, mtg_intra_fks=11** (4 from migration 053 + 7 from 054).

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
SET search_path TO tenant_demo;
SELECT
  (SELECT COUNT(*) FROM mtg_meeting_types) AS types,
  (SELECT COUNT(*) FROM mtg_conference_events) AS conferences,
  (SELECT COUNT(*) FROM mtg_meetings) AS meetings,
  (SELECT COUNT(*) FROM mtg_meeting_slots) AS slots,
  (SELECT COUNT(*) FROM mtg_meeting_slots WHERE is_booked=true) AS booked_slots,
  (SELECT COUNT(*) FROM mtg_meeting_notes WHERE is_parent_visible=true AND is_approved=true) AS parent_visible_notes,
  (SELECT COUNT(*) FROM mtg_action_items) AS action_items,
  (SELECT COUNT(*) FROM mtg_iep_meeting_records) AS iep_records;
"
```

Expected: **types=4, conferences=1, meetings=2, slots=6, booked_slots=1, parent_visible_notes=1, action_items=3, iep_records=1**.

IAM audit — MTG-001 + MTG-002 distribution:

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
SELECT pu.email, ARRAY(SELECT unnest(permission_codes) WHERE unnest LIKE 'mtg-%' ORDER BY 1) AS mtg_codes
FROM platform.iam_effective_access_cache eac
JOIN platform.platform_users pu ON pu.id = eac.account_id
WHERE pu.email LIKE '%@demo.campusos.dev'
ORDER BY pu.email;
"
```

Expected: every persona except admin@/principal@ holds at least `mtg-001:read` and `mtg-002:read`. Teacher additionally holds `mtg-001:write` + `mtg-002:write`. Staff additionally holds `mtg-001:write`. Parent + Student hold reads only.

---

## Plan scenarios

Variables — set these once at the top of your shell:

```bash
export API="http://localhost:4000/api/v1"
export TENANT_HEADER="X-Tenant-Subdomain: demo"
ADMIN_TOKEN=$(curl -sX POST "$API/auth/dev-login" -H "$TENANT_HEADER" -H 'Content-Type: application/json' -d '{"email":"principal@demo.campusos.dev"}' | jq -r .accessToken)
TEACHER_TOKEN=$(curl -sX POST "$API/auth/dev-login" -H "$TENANT_HEADER" -H 'Content-Type: application/json' -d '{"email":"teacher@demo.campusos.dev"}' | jq -r .accessToken)
PARENT_TOKEN=$(curl -sX POST "$API/auth/dev-login" -H "$TENANT_HEADER" -H 'Content-Type: application/json' -d '{"email":"parent@demo.campusos.dev"}' | jq -r .accessToken)
STUDENT_TOKEN=$(curl -sX POST "$API/auth/dev-login" -H "$TENANT_HEADER" -H 'Content-Type: application/json' -d '{"email":"student@demo.campusos.dev"}' | jq -r .accessToken)
COUNSELLOR_TOKEN=$(curl -sX POST "$API/auth/dev-login" -H "$TENANT_HEADER" -H 'Content-Type: application/json' -d '{"email":"counsellor@demo.campusos.dev"}' | jq -r .accessToken)
```

### S1 — Conference creation + slot grid

```bash
curl -s "$API/meetings/conferences" -H "Authorization: Bearer $ADMIN_TOKEN" -H "$TENANT_HEADER" | jq '.[].title'
# Expected: "Spring Parent-Teacher Conferences 2026"

PTC_CONF_ID=$(curl -s "$API/meetings/conferences" -H "Authorization: Bearer $ADMIN_TOKEN" -H "$TENANT_HEADER" | jq -r '.[0].id')
PTC_MEETING_ID=$(curl -s "$API/meetings?conferenceEventId=$PTC_CONF_ID" -H "Authorization: Bearer $ADMIN_TOKEN" -H "$TENANT_HEADER" | jq -r '.[0].id')

curl -s "$API/meetings/$PTC_MEETING_ID/slots" -H "Authorization: Bearer $TEACHER_TOKEN" -H "$TENANT_HEADER" | jq '. | length'
# Expected: 6
```

### S2 — Parent booking keystone

```bash
# David Chen books an available slot (slot 2 — slot 1 already booked in seed)
SLOT_ID=$(curl -s "$API/meetings/$PTC_MEETING_ID/slots" -H "Authorization: Bearer $PARENT_TOKEN" -H "$TENANT_HEADER" | jq -r '.[] | select(.isBooked==false) | .id' | head -1)

curl -sX PATCH "$API/meeting-slots/$SLOT_ID/book" -H "Authorization: Bearer $PARENT_TOKEN" -H "$TENANT_HEADER" | jq '{isBooked, bookedByName}'
# Expected: { "isBooked": true, "bookedByName": "David Chen" }

# Same slot, second attempt — should 400
curl -sX PATCH "$API/meeting-slots/$SLOT_ID/book" -H "Authorization: Bearer $PARENT_TOKEN" -H "$TENANT_HEADER" -w '\nstatus=%{http_code}\n' | tail -3
# Expected: 400 with "Slot is already booked"
```

### S3 — Parent-visibility keystone

```bash
PTC_NOTES_MEETING_ID=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA -c "
  SET search_path TO tenant_demo;
  SELECT id FROM mtg_meetings WHERE title = 'Mr. Rivera — PTC slots' LIMIT 1;
")

# Parent reads notes — should see parent_visible_summary
curl -s "$API/meetings/$PTC_NOTES_MEETING_ID/notes" -H "Authorization: Bearer $PARENT_TOKEN" -H "$TENANT_HEADER" | jq '{isApproved, isParentVisible, parentVisibleSummary, notesText}'
# Expected: parent sees parentVisibleSummary populated, notesText null

# Staff reads same notes — sees full notes_text
curl -s "$API/meetings/$PTC_NOTES_MEETING_ID/notes" -H "Authorization: Bearer $TEACHER_TOKEN" -H "$TENANT_HEADER" | jq '{notesText}'
# Expected: notesText populated with the staff version

# Student gets null
curl -s "$API/meetings/$PTC_NOTES_MEETING_ID/notes" -H "Authorization: Bearer $STUDENT_TOKEN" -H "$TENANT_HEADER" -w '\nstatus=%{http_code}\n'
# Expected: null body or 404 (depending on participation)
```

### S4 — IEP meeting record (Cycle 10 + Cycle 11 cross-cycle integration)

```bash
IEP_MEETING_ID=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA -c "
  SET search_path TO tenant_demo;
  SELECT id FROM mtg_meetings WHERE title = 'IEP Review — Maya Chen' LIMIT 1;
")

curl -s "$API/meetings/$IEP_MEETING_ID/iep-record" -H "Authorization: Bearer $COUNSELLOR_TOKEN" -H "$TENANT_HEADER" | jq '{studentName, iepPlanType, iepPlanStatus, attendeeRoles}'
# Expected: studentName='Maya Chen', iepPlanType='504' or 'IEP', attendeeRoles is the JSONB array
```

### S5 — IEP visibility gate

```bash
# Teacher (no hlt-001:read) is denied
curl -s "$API/meetings/$IEP_MEETING_ID/iep-record" -H "Authorization: Bearer $TEACHER_TOKEN" -H "$TENANT_HEADER" -w '\nstatus=%{http_code}\n' | tail -3
# Expected: 403 with "IEP meeting records require hlt-001:read"
```

### S6 — Action items (cross-persona assignees)

```bash
# David Chen (parent) sees own action items
curl -s "$API/meeting-action-items?status=OPEN" -H "Authorization: Bearer $PARENT_TOKEN" -H "$TENANT_HEADER" | jq '.[].description'
# Expected: includes "Practice multiplication tables with Maya at home (15 min daily)"

DAVID_ACTION_ID=$(curl -s "$API/meeting-action-items?status=OPEN" -H "Authorization: Bearer $PARENT_TOKEN" -H "$TENANT_HEADER" | jq -r '.[0].id')

# David marks his action item DONE
curl -sX PATCH "$API/meeting-action-items/$DAVID_ACTION_ID" -H "Authorization: Bearer $PARENT_TOKEN" -H "$TENANT_HEADER" -H 'Content-Type: application/json' -d '{"status":"DONE"}' | jq '{status, completedAt}'
# Expected: status=DONE, completedAt populated
```

### S7 — Recording consent flow

```bash
# Admin creates a recording placeholder for the IEP meeting
RECORDING=$(curl -sX POST "$API/meetings/$IEP_MEETING_ID/recording" -H "Authorization: Bearer $COUNSELLOR_TOKEN" -H "$TENANT_HEADER" -H 'Content-Type: application/json' -d '{}')
RECORDING_ID=$(echo "$RECORDING" | jq -r '.id')
echo "$RECORDING" | jq '{status, consentConfirmed}'
# Expected: status=PROCESSING, consentConfirmed=false

# Hayes consents (he's a participant)
curl -sX POST "$API/meeting-recordings/$RECORDING_ID/consent" -H "Authorization: Bearer $COUNSELLOR_TOKEN" -H "$TENANT_HEADER" -H 'Content-Type: application/json' -d '{"consentGiven":true}' | jq '{consentGiven}'

# Admin (Mitchell) consents
curl -sX POST "$API/meeting-recordings/$RECORDING_ID/consent" -H "Authorization: Bearer $ADMIN_TOKEN" -H "$TENANT_HEADER" -H 'Content-Type: application/json' -d '{"consentGiven":true}' | jq '{consentGiven}'

# After both participants consent, consent_confirmed flips true
curl -s "$API/meetings/$IEP_MEETING_ID/recording" -H "Authorization: Bearer $COUNSELLOR_TOKEN" -H "$TENANT_HEADER" | jq '{consentConfirmed, signedUrl}'
# Expected: consentConfirmed=true; signedUrl populated only when s3_key is set (placeholder this cycle)

# Cleanup — remove recording before next CAT run
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
  SET search_path TO tenant_demo;
  DELETE FROM mtg_recordings WHERE meeting_id = (SELECT id FROM mtg_meetings WHERE title = 'IEP Review — Maya Chen');
"
```

### S8 — Permission denials

```bash
# Student tries to create a meeting — 403
curl -sX POST "$API/meetings" -H "Authorization: Bearer $STUDENT_TOKEN" -H "$TENANT_HEADER" -H 'Content-Type: application/json' -d '{"meetingTypeId":"00000000-0000-0000-0000-000000000000","title":"x","scheduledAt":"2030-01-01T00:00:00Z","durationMinutes":15}' -w '\nstatus=%{http_code}\n' | tail -3
# Expected: 403 with INSUFFICIENT_PERMISSIONS (mtg-001:write not held)

# Parent tries to create a conference — 403 (mtg-002:admin)
curl -sX POST "$API/meetings/conferences" -H "Authorization: Bearer $PARENT_TOKEN" -H "$TENANT_HEADER" -H 'Content-Type: application/json' -d '{"title":"x","conferenceType":"PARENT_TEACHER","startDate":"2030-01-01","endDate":"2030-01-02"}' -w '\nstatus=%{http_code}\n' | tail -3
# Expected: 403

# Parent tries to add slots to a meeting — 403 (mtg-002:write)
curl -sX POST "$API/meetings/$PTC_MEETING_ID/slots" -H "Authorization: Bearer $PARENT_TOKEN" -H "$TENANT_HEADER" -H 'Content-Type: application/json' -d '{"slots":[]}' -w '\nstatus=%{http_code}\n' | tail -3
# Expected: 403
```

### S9 — `mtg.meeting.scheduled` Kafka emit verification

```bash
# Admin creates a fresh meeting — wire the consumer beforehand to capture
docker exec campusos-kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --topic dev.mtg.meeting.scheduled \
  --from-beginning --max-messages 1 --timeout-ms 10000 &

curl -sX POST "$API/meetings" -H "Authorization: Bearer $TEACHER_TOKEN" -H "$TENANT_HEADER" -H 'Content-Type: application/json' \
  -d '{"meetingTypeId":"<staff_meeting_type_id>","title":"S9 CAT — smoke","scheduledAt":"2030-06-01T18:00:00Z","durationMinutes":30}'

# Wire envelope shape: { event_type:'mtg.meeting.scheduled', source_module:'meetings', payload:{ meetingId, schoolId, meetingTypeId, title, scheduledAt, organiserId, sourceRefId } }
```

### S10 — Cleanup

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
SET search_path TO tenant_demo;
DELETE FROM mtg_meetings WHERE title = 'S9 CAT — smoke';
-- Restore Slot 2 (David's CAT booking) back to available
UPDATE mtg_meeting_slots
SET is_booked = false, booked_by = NULL, booked_at = NULL
WHERE meeting_id = (SELECT id FROM mtg_meetings WHERE title = 'Mr. Rivera — PTC slots')
  AND start_time = '2026-05-20 15:15:00+00';
DELETE FROM mtg_meeting_participants p
USING mtg_meetings m
WHERE p.meeting_id = m.id AND m.title = 'Mr. Rivera — PTC slots'
  AND p.participant_id = (SELECT id FROM platform.platform_users WHERE email = 'parent@demo.campusos.dev')
  AND p.role = 'ATTENDEE'
  AND NOT EXISTS (SELECT 1 FROM mtg_meeting_slots WHERE meeting_id = m.id AND booked_by = p.participant_id);
-- Restore David's seeded action item
UPDATE mtg_action_items
SET status = 'OPEN', completed_at = NULL
WHERE description = 'Practice multiplication tables with Maya at home (15 min daily)';
"
```

After cleanup, re-running the schema preamble counts should match the post-`seed:meetings` baseline.

---

**Cycle 15 ships clean to the post-cycle architecture review.**
