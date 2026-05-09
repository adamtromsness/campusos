# P2C1 — Visitor Management CAT

**Cycle:** Phase 2 Cycle 1 — M90 Visitor Management.
**Surface:** Tenant schema (`vis_*` × 9 tables) + VisitorsModule
(6 services, ~28 endpoints, 3 Kafka emits) + 8 web routes under
`/visitors/*` + 1 launchpad tile gated on `saf-002:read`.
**Tenant:** `tenant_demo`.
**Run after:** every P2C1 step is committed, the API has been
rebuilt and restarted, and the seed has been re-run from a clean
state (`pnpm --filter @campusos/database seed:visitors`).

This CAT walks the keystone scenarios end-to-end: encrypted PII
returning-visitor lookup, banned-persons HMAC blocking on sign-in,
QR pre-registration scan, safeguarding admin bypass with mandatory
reason, emergency muster snapshot + per-visitor accountability, and
permission gating across personas.

## Schema preamble

```sql
-- 0a 9 vis_* base tables.
SELECT COUNT(*) FROM information_schema.tables
 WHERE table_schema = 'tenant_demo' AND table_name LIKE 'vis_%';
-- expect: 9

-- 0b PII columns present on vis_visitors.
SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'tenant_demo' AND table_name = 'vis_visitors'
   AND column_name IN ('email_encrypted', 'email_hash', 'phone_encrypted', 'phone_hash');
-- expect: 4 rows

-- 0c HMAC blind-index INDEX present.
SELECT indexname FROM pg_indexes
 WHERE schemaname = 'tenant_demo' AND tablename = 'vis_visitors'
   AND indexname IN ('vis_visitor_email_hash_idx', 'vis_visitor_school_email_hash_uq');
-- expect: 2 rows

-- 0d Multi-column bypass_chk on vis_sign_ins.
SELECT conname FROM pg_constraint
 WHERE conrelid = 'tenant_demo.vis_sign_ins'::regclass AND conname = 'vis_si_bypass_chk';
-- expect: 1 row

-- 0e Partial INDEX on banned-persons HMAC lookup.
SELECT indexdef FROM pg_indexes
 WHERE schemaname = 'tenant_demo' AND indexname = 'vis_banned_kiosk_lookup_idx';
-- expect: WHERE (is_active = true)

-- 0f Partial INDEX on currently on-site sign-ins.
SELECT indexdef FROM pg_indexes
 WHERE schemaname = 'tenant_demo' AND indexname = 'vis_si_active_idx';
-- expect: WHERE (signed_out_at IS NULL)

-- 0g Seed counts.
SELECT 'visitor_types' AS tbl, COUNT(*)::text FROM tenant_demo.vis_visitor_types
UNION ALL SELECT 'visitors', COUNT(*)::text FROM tenant_demo.vis_visitors
UNION ALL SELECT 'on-site', COUNT(*)::text FROM tenant_demo.vis_sign_ins WHERE signed_out_at IS NULL
UNION ALL SELECT 'sign_ins', COUNT(*)::text FROM tenant_demo.vis_sign_ins
UNION ALL SELECT 'pre_regs', COUNT(*)::text FROM tenant_demo.vis_pre_registrations
UNION ALL SELECT 'recurring', COUNT(*)::text FROM tenant_demo.vis_recurring_visitors
UNION ALL SELECT 'banned', COUNT(*)::text FROM tenant_demo.vis_banned_persons
UNION ALL SELECT 'musters', COUNT(*)::text FROM tenant_demo.vis_emergency_muster
UNION ALL SELECT 'muster_entries', COUNT(*)::text FROM tenant_demo.vis_muster_entries
UNION ALL SELECT 'settings', COUNT(*)::text FROM tenant_demo.vis_sign_in_settings;
-- expect: 4, 5, 3, 8, 1, 1, 1, 1, 3, 1
```

## Scenarios

### S1 — Visitor type CRUD + UNIQUE(school_id, name)

```bash
TOKEN=$(curl -s -X POST http://localhost:4000/api/v1/auth/dev-login \
  -H "Content-Type: application/json" -H "X-Tenant-Subdomain: demo" \
  -d '{"email":"principal@demo.campusos.dev"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['accessToken'])")

# Create new "Inspector" type — should succeed
curl -s -X POST http://localhost:4000/api/v1/visitors/visitor-types \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"name":"Inspector","requiresSafeguardingCheck":true,"badgeColor":"rose"}'
# expect: 201 with id + name=Inspector

# Re-create same name — should 409
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  http://localhost:4000/api/v1/visitors/visitor-types \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"name":"Inspector","badgeColor":"gray"}'
# expect: 409
```

### S2 — New visitor sign-in writes encrypted PII + HMAC blind index

```bash
PARENT_TYPE_ID=$(curl -s "http://localhost:4000/api/v1/visitors/visitor-types" \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  | python3 -c "import json,sys; ts=json.load(sys.stdin); print([t['id'] for t in ts if t['name']=='Parent'][0])")

curl -s -X POST http://localhost:4000/api/v1/visitors/sign-in \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d "{\"visitorTypeId\":\"$PARENT_TYPE_ID\",\"firstName\":\"Smoke\",\"lastName\":\"Test\",\"email\":\"smoke.cat@example.com\",\"purpose\":\"P2C1 CAT\"}"
# expect: 201 + safeguardingCheckStatus=NOT_REQUIRED

# Verify encryption + HMAC at the schema layer
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "SET search_path TO tenant_demo;
   SELECT first_name, last_name, length(email_encrypted) AS enc_len, length(email_hash) AS hash_len
     FROM vis_visitors WHERE first_name='Smoke';"
# expect: enc_len > 50 (base64 ciphertext), hash_len = 64 (sha256 hex)
```

### S3 — Returning visitor lookup via HMAC blind index

```bash
# Same email as the seeded David Chen visitor row.
curl -s "http://localhost:4000/api/v1/visitors/lookup?email=david.chen.visitor@example.com" \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo"
# expect: { id: <uuid>, firstName: "David", lastName: "Chen", visitorTypeName: "Parent", ... }
# Note: response does NOT include email_encrypted — kiosk never decrypts.

# Different-case email matches the same row (lowercase + trim normalisation).
curl -s "http://localhost:4000/api/v1/visitors/lookup?email=DAVID.Chen.Visitor%40example.com" \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo"
# expect: same id as above
```

### S4 — Pre-registration QR scan keystone

```bash
# Get the seeded pre-reg's QR token.
TOKEN_QR=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tAc \
  "SET search_path TO tenant_demo; SELECT qr_code_token FROM vis_pre_registrations WHERE used_at IS NULL LIMIT 1" | tail -1)
echo "Token: $TOKEN_QR"

# Kiosk scan — auto-creates the sign-in.
curl -s -X POST http://localhost:4000/api/v1/visitors/pre-register/scan \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d "{\"qrCodeToken\":\"$TOKEN_QR\"}"
# expect: 201 with new sign-in DTO + preRegistrationId populated

# Re-scan same token — 410 Gone
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  http://localhost:4000/api/v1/visitors/pre-register/scan \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d "{\"qrCodeToken\":\"$TOKEN_QR\"}"
# expect: 410
```

### S5 — Safeguarding admin bypass with mandatory >10-character reason

```bash
SIGNIN_ID=$(curl -s "http://localhost:4000/api/v1/visitors/on-site" \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['id'])")

# Reason too short — 400
curl -s -o /dev/null -w "%{http_code}\n" -X PATCH \
  "http://localhost:4000/api/v1/visitors/sign-ins/$SIGNIN_ID/bypass" \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" -d '{"reason":"ok"}'
# expect: 400

# Valid reason — 200; verify the multi-column lockstep stamps both columns.
curl -s -X PATCH "http://localhost:4000/api/v1/visitors/sign-ins/$SIGNIN_ID/bypass" \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Pre-vetted at sister school last term — DBS on file."}'
# expect: 200 + safeguardingCheckStatus=BYPASSED_BY_ADMIN + bypassAdminId populated + bypassReason populated
```

### S6 — Banned-persons HMAC keystone — kiosk BLOCK

```bash
# Banned check matches the seeded John Doe (case-insensitive).
curl -s -X POST "http://localhost:4000/api/v1/visitors/banned-persons/check" \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"john","lastName":"DOE","dateOfBirth":"1985-03-12"}'
# expect: { blocked: true, detectedAt: ... }

# Sign-in attempt for the same person — 403 with NEUTRAL message
curl -s -o /tmp/resp -w "%{http_code}\n" -X POST \
  http://localhost:4000/api/v1/visitors/sign-in \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d "{\"visitorTypeId\":\"$PARENT_TYPE_ID\",\"firstName\":\"John\",\"lastName\":\"Doe\",\"email\":\"jdoe.banned@example.com\",\"dateOfBirth\":\"1985-03-12\"}"
cat /tmp/resp
# expect: 403 with body { message: "Please see reception staff", error: "Forbidden" }
# The visitor never learns why.

# Verify vis.banned_person.detected emitted to Kafka.
docker exec campusos-kafka /opt/bitnami/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic dev.vis.banned_person.detected \
  --from-beginning --max-messages 1 --timeout-ms 5000 2>/dev/null
# expect: ADR-057 envelope with source_module="visitors", payload.bannedPersonId populated
```

### S7 — Banned-persons non-match — sign-in proceeds

```bash
curl -s -X POST "http://localhost:4000/api/v1/visitors/banned-persons/check" \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Random","lastName":"Person","dateOfBirth":"1990-01-01"}'
# expect: { blocked: false }
```

### S8 — Emergency muster snapshot + accountability

```bash
# Create snapshot — should batch every currently signed-in visitor into entries.
MUSTER_RESPONSE=$(curl -s -X POST http://localhost:4000/api/v1/visitors/muster \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"drillType":"FIRE_DRILL","description":"P2C1 CAT smoke"}')
MUSTER_ID=$(echo "$MUSTER_RESPONSE" | python3 -c "import json,sys;print(json.load(sys.stdin)['muster']['id'])")
echo "$MUSTER_RESPONSE" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'muster_id={d[\"muster\"][\"id\"]} total={d[\"muster\"][\"totalOnSiteAtSnapshot\"]} entries={len(d[\"entries\"])}')
"
# expect: total >= 3 entries (the 3 seeded active sign-ins + any from earlier scenarios)

# Mark first entry as ACCOUNTED_FOR.
ENTRY_ID=$(curl -s "http://localhost:4000/api/v1/visitors/muster/$MUSTER_ID" \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['entries'][0]['id'])")

curl -s -X PATCH "http://localhost:4000/api/v1/visitors/muster-entries/$ENTRY_ID" \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"status":"ACCOUNTED_FOR"}'
# expect: 200 + status=ACCOUNTED_FOR + markedBy + markedAt populated atomically

# Summary endpoint reflects the change.
curl -s "http://localhost:4000/api/v1/visitors/muster/$MUSTER_ID/summary" \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo"
# expect: { unknown: N-1, accountedFor: 1, ... }

# Verify vis.muster.created envelope on the wire.
docker exec campusos-kafka /opt/bitnami/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic dev.vis.muster.created \
  --from-beginning --max-messages 1 --timeout-ms 5000 2>/dev/null
# expect: ADR-057 envelope with source_module="visitors", payload.musterId
```

### S9 — Sign-out marks visitor off-site

```bash
SIGNIN_ID=$(curl -s "http://localhost:4000/api/v1/visitors/on-site" \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print([s['id'] for s in d if s['visitorName']=='Smoke Test'][0])")

curl -s -X POST "http://localhost:4000/api/v1/visitors/sign-ins/$SIGNIN_ID/sign-out" \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo"
# expect: 200 + signedOutAt populated

# Sign out again — 400.
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "http://localhost:4000/api/v1/visitors/sign-ins/$SIGNIN_ID/sign-out" \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo"
# expect: 400 ("Visitor already signed out")
```

### S10 — Permission matrix per persona

```bash
TEACHER_TOKEN=$(curl -s -X POST http://localhost:4000/api/v1/auth/dev-login \
  -H "Content-Type: application/json" -H "X-Tenant-Subdomain: demo" \
  -d '{"email":"teacher@demo.campusos.dev"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['accessToken'])")
PARENT_TOKEN=$(curl -s -X POST http://localhost:4000/api/v1/auth/dev-login \
  -H "Content-Type: application/json" -H "X-Tenant-Subdomain: demo" \
  -d '{"email":"parent@demo.campusos.dev"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['accessToken'])")

# Teacher GET on-site — 200 (saf-002:read)
curl -s -o /dev/null -w "teacher /on-site = %{http_code}\n" \
  "http://localhost:4000/api/v1/visitors/on-site" \
  -H "Authorization: Bearer $TEACHER_TOKEN" -H "X-Tenant-Subdomain: demo"
# expect: 200

# Teacher POST sign-in — 403 (saf-002:write held only by Staff/Admin)
curl -s -o /dev/null -w "teacher POST /sign-in = %{http_code}\n" -X POST \
  "http://localhost:4000/api/v1/visitors/sign-in" \
  -H "Authorization: Bearer $TEACHER_TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" -d '{"firstName":"x","lastName":"y","email":"z@example.com","visitorTypeId":"00000000-0000-0000-0000-000000000000"}'
# expect: 403

# Teacher GET banned-persons — 403 (safeguarding_ban:read admin-only)
curl -s -o /dev/null -w "teacher /banned-persons = %{http_code}\n" \
  "http://localhost:4000/api/v1/visitors/banned-persons" \
  -H "Authorization: Bearer $TEACHER_TOKEN" -H "X-Tenant-Subdomain: demo"
# expect: 403

# Parent GET on-site — 403 (no SAF-002 grant)
curl -s -o /dev/null -w "parent /on-site = %{http_code}\n" \
  "http://localhost:4000/api/v1/visitors/on-site" \
  -H "Authorization: Bearer $PARENT_TOKEN" -H "X-Tenant-Subdomain: demo"
# expect: 403
```

## Cleanup

```sql
-- Drop smoke residue created by S1, S2, S4, S8, S9.
SET search_path TO tenant_demo;

-- S8 muster + entries (cascade)
DELETE FROM vis_emergency_muster WHERE description = 'P2C1 CAT smoke';

-- S2/S4/S5/S9 sign-ins + visitors created by the kiosk
DELETE FROM vis_muster_entries WHERE visitor_name IN ('Smoke Test', 'Anita Patel') AND muster_id NOT IN (SELECT id FROM vis_emergency_muster);
DELETE FROM vis_sign_ins WHERE visitor_id IN (SELECT id FROM vis_visitors WHERE first_name = 'Smoke');
DELETE FROM vis_visitors WHERE first_name = 'Smoke';

-- S4 pre-reg sign-in (Anita Patel - the new one, not the seeded historical row)
DELETE FROM vis_sign_ins WHERE pre_registration_id IS NOT NULL AND signed_in_at > now() - interval '1 hour';

-- S5 reset the bypass on the seeded sign-in if any test ran against it
UPDATE vis_sign_ins SET safeguarding_check_status = 'PASSED', bypass_admin_id = NULL, bypass_reason = NULL
 WHERE safeguarding_check_status = 'BYPASSED_BY_ADMIN' AND created_at > now() - interval '1 hour';

-- S1 visitor type
DELETE FROM vis_visitor_types WHERE name = 'Inspector';

-- S4 the seeded pre-reg was used; if the smoke ran, restore by clearing used_at so
-- a re-run would re-scan. (In practice the seed re-creates a fresh token.)
UPDATE vis_pre_registrations SET used_at = NULL WHERE expected_at > now() AND used_at > now() - interval '1 hour';

-- Verify clean state
SELECT
  (SELECT COUNT(*) FROM vis_visitor_types) AS types,
  (SELECT COUNT(*) FROM vis_visitors) AS visitors,
  (SELECT COUNT(*) FROM vis_sign_ins) AS sign_ins,
  (SELECT COUNT(*) FROM vis_sign_ins WHERE signed_out_at IS NULL) AS active,
  (SELECT COUNT(*) FROM vis_pre_registrations) AS pre_regs,
  (SELECT COUNT(*) FROM vis_muster_entries) AS entries;
-- expect: 4, 5, 8, 3, 1, 3 (matches seed)
```

## Reviewer attention items (non-blocking, Phase 2 polish)

- **No Cycle 3 NotificationConsumer wiring on `vis.banned_person.detected`** — the
  kafka emit lands cleanly and the safeguarding officer would be paged via a
  consumer, but no consumer subscribes today. Pre-pilot: wire a
  BannedPersonDetectedConsumer that fans out an EMERGENCY notification to every
  `safeguarding_ban:read` holder.
- **Photo capture, badge printer integration, NDA/agreement signing, and
  third-party DBS API integration are deferred** per the plan's "What's
  Deferred" callout. Schema + service layer are ready; the integrations land
  in P2C1.1.
- **Catalogue code drift** — the plan refers to "SAF-001 (Visitor Management)"
  but the existing catalogue has SAF-001 = Emergency Management and SAF-002 =
  Visitor Management. P2C1 uses SAF-002 to honour the existing catalogue.
  Documented in HANDOFF-P2C1.md.
- **`vis.banned_person.detected` envelope payload** intentionally does NOT
  include the entered name + DOB — only the matched `bannedPersonId` so the
  consumer can look up the registry row via `safeguarding_ban:read`. Adversary
  who reads the topic should learn nothing about who tried to sign in.

## Cycle 1 Phase 2 closes the kiosk surface

P2C1 is the first cycle of Phase 2 (Pilot Readiness). The platform now has
a functioning visitor management surface — kiosk sign-in with encrypted PII,
returning-visitor lookup via HMAC blind index, banned-persons screening with
real-time blocking, parent-active QR pre-registration, recurring contractor
schedules, and emergency muster with per-visitor accountability. Next P2.x
cycles continue with M91 Incident Reporting, M92 Drill Scheduling, and the
remaining Phase 2 punch-list items.
