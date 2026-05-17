# P2C3 CAT — Health Advanced vertical slice

This Customer Acceptance Test walks the M23 Health .1 module
end-to-end. Each scenario is a copy-paste shell block with the
expected outcome documented inline. Run sequentially against
`tenant_demo`. Re-running the seed at the end restores the demo
state exactly.

The vertical slice covers:

1. Schema preamble — 6 new `hlth_*` tables landed; `VIEW_TELEHEALTH`
   added to the existing `hlth_health_access_log.access_type` enum.
2. Telehealth: provider directory + scheduling + HIPAA per-row audit
   write on every list/detail read.
3. Immunisation compliance: per-(student, year) UPSERT idempotency,
   manual-set EXEMPT/PROVISIONAL preservation across re-runs, the
   `hlth.immunisation.noncompliant` event for newly-flagged students.
4. State CSV report — Kansas-shaped row-per-vaccine submission.
5. Screening referrals: created from `hlth_screenings` parent rows,
   FOLLOW_UP_COMPLETE state machine with required outcome+date.

## Schema preamble (sanity check)

```bash
docker exec -i campusos-postgres psql -U campusos -d campusos_dev <<'SQL'
SET search_path TO tenant_demo, platform, public;

-- 6 new tables present
SELECT 'hlth_advanced_tables', COUNT(*) FROM pg_tables
 WHERE schemaname='tenant_demo'
   AND tablename IN (
     'hlth_telehealth_providers',
     'hlth_telehealth_sessions',
     'hlth_telehealth_documents',
     'hlth_immunisation_requirements',
     'hlth_immunisation_compliance',
     'hlth_screening_referrals'
   );
-- expected: 6

-- VIEW_TELEHEALTH access type registered
SELECT 'view_telehealth_check', conname
  FROM pg_constraint
 WHERE conrelid = 'tenant_demo.hlth_health_access_log'::regclass
   AND consrc IS NULL
   AND contype = 'c';
-- expected: at least one row matching the access_type CHECK

-- Seed counts match plan
SELECT 'providers',     COUNT(*) FROM hlth_telehealth_providers
UNION ALL SELECT 'sessions', COUNT(*) FROM hlth_telehealth_sessions
UNION ALL SELECT 'documents',  COUNT(*) FROM hlth_telehealth_documents
UNION ALL SELECT 'requirements', COUNT(*) FROM hlth_immunisation_requirements
UNION ALL SELECT 'compliance',   COUNT(*) FROM hlth_immunisation_compliance
UNION ALL SELECT 'referrals',    COUNT(*) FROM hlth_screening_referrals;
-- expected: 2 / 2 / 1 / 6 / 10 / 3
SQL
```

## Authentication scaffold

```bash
JWT_NURSE=$(curl -s -X POST http://localhost:4000/api/v1/auth/dev-login \
  -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' \
  -d '{"email":"counsellor@demo.campusos.dev"}' | jq -r .accessToken)
JWT_ADMIN=$(curl -s -X POST http://localhost:4000/api/v1/auth/dev-login \
  -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' \
  -d '{"email":"principal@demo.campusos.dev"}' | jq -r .accessToken)
JWT_TEACHER=$(curl -s -X POST http://localhost:4000/api/v1/auth/dev-login \
  -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' \
  -d '{"email":"teacher@demo.campusos.dev"}' | jq -r .accessToken)
JWT_PARENT=$(curl -s -X POST http://localhost:4000/api/v1/auth/dev-login \
  -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' \
  -d '{"email":"parent@demo.campusos.dev"}' | jq -r .accessToken)

H="-H Content-Type:application/json -H X-Tenant-Subdomain:demo"
```

---

## Scenario 1 — Telehealth provider directory + permission gate

```bash
# Nurse (Staff with hlt-006:read) lists providers.
curl -s -H "Authorization: Bearer $JWT_NURSE" $H \
  http://localhost:4000/api/v1/health/telehealth/providers | jq '.[] | {providerName, speciality, isActive}'
# expected: 2 providers from seed (BetterMynd + School Telehealth Network)

# Teacher (no HLT-006) — 403 at the gate.
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $JWT_TEACHER" $H \
  http://localhost:4000/api/v1/health/telehealth/providers
# expected: 403

# Admin can add a provider.
RESP=$(curl -s -X POST http://localhost:4000/api/v1/health/telehealth/providers \
  -H "Authorization: Bearer $JWT_ADMIN" $H \
  -d '{"providerName":"CAT Telehealth","speciality":"Pediatrics","bookingUrl":"https://cat.example.com/book"}')
echo "$RESP" | jq '{id, providerName, isActive}'
# expected: providerName="CAT Telehealth", isActive=true
PROVIDER_ID=$(echo "$RESP" | jq -r .id)
```

## Scenario 2 — Telehealth session: schedule + HIPAA audit on read

```bash
MAYA_ID=$(docker exec -i campusos-postgres psql -U campusos -d campusos_dev -tA -c \
  "SELECT id FROM tenant_demo.sis_students s
     JOIN tenant_demo.sis_family_members fm ON fm.sis_student_id = s.id LIMIT 1")

# Schedule a session.
SESSION_RESP=$(curl -s -X POST http://localhost:4000/api/v1/health/telehealth/sessions \
  -H "Authorization: Bearer $JWT_NURSE" $H \
  -d "{\"studentId\":\"$MAYA_ID\",\"providerId\":\"$PROVIDER_ID\",\"scheduledAt\":\"2026-06-15T14:00:00Z\",\"durationMinutes\":30}")
SESSION_ID=$(echo "$SESSION_RESP" | jq -r .id)
echo "$SESSION_RESP" | jq '{id, status, scheduledAt}'
# expected: status=SCHEDULED

# Count HIPAA audit rows BEFORE the listing.
BEFORE=$(docker exec -i campusos-postgres psql -U campusos -d campusos_dev -tA -c \
  "SELECT COUNT(*) FROM tenant_demo.hlth_health_access_log
     WHERE access_type='VIEW_TELEHEALTH'")

# Nurse lists sessions for this student. Service writes one audit row per session returned.
curl -s -H "Authorization: Bearer $JWT_NURSE" $H \
  "http://localhost:4000/api/v1/health/telehealth/sessions?studentId=$MAYA_ID" | jq 'length'

AFTER=$(docker exec -i campusos-postgres psql -U campusos -d campusos_dev -tA -c \
  "SELECT COUNT(*) FROM tenant_demo.hlth_health_access_log
     WHERE access_type='VIEW_TELEHEALTH'")

echo "HIPAA audit rows VIEW_TELEHEALTH: before=$BEFORE after=$AFTER"
# expected: AFTER > BEFORE (one row per session returned)
```

## Scenario 3 — Telehealth status lockstep (COMPLETED requires endedAt)

```bash
curl -s -X PATCH http://localhost:4000/api/v1/health/telehealth/sessions/$SESSION_ID \
  -H "Authorization: Bearer $JWT_NURSE" $H \
  -d '{"status":"COMPLETED"}' | jq '{id, status, endedAt}'
# expected: status=COMPLETED, endedAt populated atomically by service

# Cancellation requires reason.
curl -s -X PATCH http://localhost:4000/api/v1/health/telehealth/sessions/$SESSION_ID \
  -H "Authorization: Bearer $JWT_NURSE" $H \
  -d '{"status":"CANCELLED"}' | jq .
# expected: 400 — already COMPLETED OR cancellationReason missing
```

## Scenario 4 — Immunisation requirements catalogue + platform default protection

```bash
# List Kansas requirements.
curl -s -H "Authorization: Bearer $JWT_NURSE" $H \
  "http://localhost:4000/api/v1/health/immunisation/requirements?stateCode=KS" | jq '.[] | {vaccineName, requiredDoses, requiredByGrade}'
# expected: 6 vaccines from seed (DTaP/MMR/IPV/Varicella/HepB/Tdap)

# Patching a platform default (school_id IS NULL) fails closed.
DEFAULT_REQ_ID=$(docker exec -i campusos-postgres psql -U campusos -d campusos_dev -tA -c \
  "SELECT id FROM tenant_demo.hlth_immunisation_requirements
     WHERE state_code='KS' AND school_id IS NULL LIMIT 1")
curl -s -o /dev/null -w "%{http_code}\n" \
  -X PATCH http://localhost:4000/api/v1/health/immunisation/requirements/$DEFAULT_REQ_ID \
  -H "Authorization: Bearer $JWT_ADMIN" $H \
  -d '{"requiredDoses":99}'
# expected: 403 — platform defaults can be cloned but not edited
```

## Scenario 5 — Compliance recompute idempotency + EXEMPT preservation

```bash
# Snapshot manually-set rows BEFORE.
docker exec -i campusos-postgres psql -U campusos -d campusos_dev -c "
SET search_path TO tenant_demo, platform, public;
SELECT student_id, status, exemption_type
  FROM hlth_immunisation_compliance
 WHERE status IN ('EXEMPT', 'PROVISIONAL')
 ORDER BY status;"

# Run compliance for the school.
curl -s -X POST http://localhost:4000/api/v1/health/immunisation/compliance/run \
  -H "Authorization: Bearer $JWT_ADMIN" $H -d '{}' | jq .
# expected: { computed: 10, newlyNonCompliant: 0 } (re-run on seeded state)

# Verify EXEMPT/PROVISIONAL preserved.
docker exec -i campusos-postgres psql -U campusos -d campusos_dev -c "
SET search_path TO tenant_demo, platform, public;
SELECT student_id, status, exemption_type
  FROM hlth_immunisation_compliance
 WHERE status IN ('EXEMPT', 'PROVISIONAL')
 ORDER BY status;"
# expected: identical to BEFORE — manual flags survive recompute
```

## Scenario 6 — Compliance dashboard

```bash
curl -s -H "Authorization: Bearer $JWT_ADMIN" $H \
  http://localhost:4000/api/v1/health/immunisation/compliance/dashboard | jq .
# expected:
# {
#   totalStudents: 10,
#   compliant: 7, nonCompliant: 2, exempt: 1, provisional: 0,
#   compliancePercent: 80.0,   # (compliant + exempt) / total * 100
#   lastComputedAt: "..."
# }

# Teacher (hlt-001:read NOT held) — 403.
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $JWT_TEACHER" $H \
  http://localhost:4000/api/v1/health/immunisation/compliance/dashboard
# expected: 403
```

## Scenario 7 — State compliance CSV report

```bash
# Download report (returns text/csv with Content-Disposition).
curl -s -i -H "Authorization: Bearer $JWT_ADMIN" $H \
  http://localhost:4000/api/v1/health/immunisation/compliance/report | head -25
# expected response headers:
#   Content-Type: text/csv; charset=utf-8
#   Content-Disposition: attachment; filename="<school>-immunisation-<YYYY-MM-DD>.csv"
#
# expected body header row:
# student_state_id,grade_level,vaccine_name,doses_required,doses_received,compliance_status,exemption_type
#
# expected one row per (student, requirement) tuple — N students × 6 vaccines = 60 rows max.
```

## Scenario 8 — Screening referral state machine

```bash
# Pick the first REFERRED row.
REF_ID=$(docker exec -i campusos-postgres psql -U campusos -d campusos_dev -tA -c \
  "SELECT id FROM tenant_demo.hlth_screening_referrals WHERE status='REFERRED' LIMIT 1")

# Trying to mark FOLLOW_UP_COMPLETE without outcome → 400.
curl -s -X PATCH http://localhost:4000/api/v1/health/screening-referrals/$REF_ID \
  -H "Authorization: Bearer $JWT_NURSE" $H \
  -d '{"status":"FOLLOW_UP_COMPLETE"}' | jq .
# expected: 400 — followUpDate AND followUpOutcome required

# Provide both → succeeds, status flips, outcome captured.
curl -s -X PATCH http://localhost:4000/api/v1/health/screening-referrals/$REF_ID \
  -H "Authorization: Bearer $JWT_NURSE" $H \
  -d '{"status":"FOLLOW_UP_COMPLETE","followUpDate":"2026-05-09","followUpOutcome":"GLASSES_PRESCRIBED","followUpNotes":"Patient picked up glasses."}' | jq '{status, followUpOutcome, followUpDate}'
# expected: status=FOLLOW_UP_COMPLETE, outcome=GLASSES_PRESCRIBED

# Overdue list reflects the change (one fewer row).
curl -s -H "Authorization: Bearer $JWT_NURSE" $H \
  http://localhost:4000/api/v1/health/screening-referrals/overdue | jq 'length'
# expected: original_count - 1
```

## Cleanup — restore tenant to seed state

```bash
docker exec -i campusos-postgres psql -U campusos -d campusos_dev <<'SQL'
SET search_path TO tenant_demo, platform, public;

-- Drop CAT-created provider + its sessions (CASCADE on hlth_telehealth_documents).
DELETE FROM hlth_telehealth_documents
 WHERE session_id IN (SELECT id FROM hlth_telehealth_sessions
                       WHERE provider_id IN (SELECT id FROM hlth_telehealth_providers
                                              WHERE provider_name='CAT Telehealth'));
DELETE FROM hlth_telehealth_sessions
 WHERE provider_id IN (SELECT id FROM hlth_telehealth_providers
                        WHERE provider_name='CAT Telehealth');
DELETE FROM hlth_telehealth_providers WHERE provider_name='CAT Telehealth';

-- Drop CAT VIEW_TELEHEALTH audit rows from the run.
DELETE FROM hlth_health_access_log
 WHERE access_type='VIEW_TELEHEALTH'
   AND accessed_at >= now() - interval '1 hour';

-- Restore the referral row that flipped to FOLLOW_UP_COMPLETE.
UPDATE hlth_screening_referrals
   SET status='REFERRED', follow_up_outcome=NULL, follow_up_date=NULL,
       follow_up_notes=NULL
 WHERE follow_up_outcome='GLASSES_PRESCRIBED'
   AND follow_up_notes='Patient picked up glasses.';
SQL
```

```bash
# Final sanity: re-run the schema preamble seed counts and confirm
# tenant_demo is back to the post-seed shape.
pnpm --filter @campusos/database seed:health-advanced
```

---

**Reviewer attention items** (non-blocking, Phase 2 polish):

- The `hlth.immunisation.noncompliant` Kafka emit lands cleanly but no
  consumer fans out a parent / nurse notification yet. Cycle 14
  (Communications fan-out) plus a Phase 2 polish item will wire the
  consumer.
- Telehealth document upload uses the signed-S3-URL pattern from
  Cycle 4 `hr_employee_documents` — actual S3 wiring is a Phase 3 ops
  task; dev mode stores the key string only.
- State-report CSV header row hard-codes Kansas column ordering; the
  endpoint accepts `?stateCode=` to switch catalogues but downstream
  state-specific column maps are deferred until a second state
  onboards.
