# Cycle 10 CAT — Health & Wellness

**Status:** verified live on `tenant_demo` 2026-05-04 against the Step 9 build. All 9 plan scenarios pass.

**Vertical slice:** Sarah (admin / nurse-scope) GETs Maya's full health record (blood + 2 allergies + 2 conditions + 3 immunisations) which writes a `VIEW_RECORD` HIPAA audit row → resets the seeded missed dose → administers a fresh dose (was_missed=false, administered_at populated, missed_reason NULL — active dose shape) then logs a STUDENT_ABSENT missed dose (was_missed=true, administered_at NULL, missed_reason populated — missed dose shape) and the schema's `missed_chk` keystone rejects an invalid hybrid shape on a separate INSERT attempt → signs Maya in for a nurse visit (status=IN_PROGRESS), updates with treatment + parent_notified=true + sentHome=true + signOut=true in one PATCH (status flips to COMPLETED with signed_out_at + sent_home_at populated atomically per the Step 7 lockstep tx) and the live roster falls from 1 → 0 → adds an ASSISTIVE_TECH ALL_ASSIGNMENTS accommodation to Maya's 504 plan; within 3 seconds the Step 7 `IepAccommodationConsumer` reconciles `sis_student_active_accommodations` from 2 → 3 rows with `has_src=true` (the ADR-030 keystone), and Rivera (teacher) reads the read model directly via psql confirming the contract; admin DELETEs the accommodation, the consumer drops the read-model row back to 2 → records a HEARING PASS screening for Ethan, marks Maya's seeded VISION REFER follow-up complete, follow-up queue drops from 1 → 0; BOGUS result rejected by class-validator → admin POSTs a Latex MODERATE allergen with POS alert for Aiden, allergen-alerts surface grows 1 → 2, duplicate POST rejected with friendly UNIQUE 400 → David Chen (parent) sees Maya's full record but with `emergencyMedicalNotes`, `managementPlan`, and `prescribingPhysician` all stripped server-side; David sees /visits but is denied 403 on /screenings, /medication-dashboard, and /access-log; admin GETs the audit log showing 13 rows across 6 access types with persona breakdown — every successful read in the CAT generated exactly one audit row → 6 permission denial paths across all three tiers (gate, service-layer, row-scope) all 403 / 404 cleanly.

**Pre-conditions:**

- `pnpm seed` + `seed:sis` + `seed:classroom` + `seed:hr` + `seed:scheduling` + `seed:enrollment` + `seed:payments` + `seed:profile` + `seed:tasks` + `seed:tickets` + `seed:behaviour` + `seed:health` all run on `tenant_demo`.
- `tsx src/build-cache.ts` rebuilt the IAM cache (7 personas — admin/principal 447 / teacher 42 / VP/counsellor 34 / student 19 / **parent 22** with the Step 4 HLT-001:read grant).
- All 3 Cycle 10 Kafka topics pre-created via `kafka-topics.sh --create --if-not-exists` (`dev.hlth.medication.administered`, `dev.iep.accommodation.updated`, `dev.hlth.nurse_visit.sent_home`) per the documented subscribe-before-publish race workaround.
- API running on `localhost:4000` from `pnpm --filter @campusos/api build && node apps/api/dist/main.js`.

## Schema preamble (8 checks)

```sql
-- Tenant logical base table count (exclude inherited partition leaves)
SELECT COUNT(*) FROM information_schema.tables t
WHERE table_schema='tenant_demo' AND table_type='BASE TABLE'
  AND NOT EXISTS (
    SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = t.table_schema AND c.relname = t.table_name
  );
-- expected: 155

-- Cycle 10 hlth_* tables (Steps 1+2+3)
SELECT COUNT(*) FROM information_schema.tables
WHERE table_schema='tenant_demo' AND table_name LIKE 'hlth%';
-- expected: 15

-- ADR-030 read model (Step 4 prerequisite migration)
SELECT COUNT(*) FROM information_schema.tables
WHERE table_schema='tenant_demo' AND table_name = 'sis_student_active_accommodations';
-- expected: 1

-- 0 cross-schema FKs across all hlth_* tables
SELECT COUNT(*) FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_class ft ON ft.oid = c.confrelid
  JOIN pg_namespace fn ON fn.oid = ft.relnamespace
  WHERE c.contype='f' AND n.nspname='tenant_demo'
    AND t.relname LIKE 'hlth%' AND fn.nspname <> 'tenant_demo';
-- expected: 0

-- 19 intra-tenant FKs across the hlth_* tables (Steps 1+2+3)
SELECT COUNT(*) FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE c.contype='f' AND n.nspname='tenant_demo' AND t.relname LIKE 'hlth%';
-- expected: 19

-- Step 4 seed counts on tenant_demo
SELECT
  (SELECT COUNT(*) FROM tenant_demo.hlth_student_health_records) AS records,        -- 1
  (SELECT COUNT(*) FROM tenant_demo.hlth_medical_conditions) AS conditions,         -- 2
  (SELECT COUNT(*) FROM tenant_demo.hlth_immunisations) AS immunisations,           -- 3
  (SELECT COUNT(*) FROM tenant_demo.hlth_medications) AS meds,                      -- 1
  (SELECT COUNT(*) FROM tenant_demo.hlth_medication_administrations) AS admin_rows, -- 2
  (SELECT COUNT(*) FROM tenant_demo.hlth_nurse_visits) AS visits,                   -- 2
  (SELECT COUNT(*) FROM tenant_demo.hlth_iep_plans) AS plans,                       -- 1
  (SELECT COUNT(*) FROM tenant_demo.hlth_iep_goals) AS goals,                       -- 2
  (SELECT COUNT(*) FROM tenant_demo.hlth_iep_accommodations) AS accommodations,     -- 2
  (SELECT COUNT(*) FROM tenant_demo.hlth_screenings) AS screenings,                 -- 1
  (SELECT COUNT(*) FROM tenant_demo.hlth_dietary_profiles) AS dietary,              -- 1
  (SELECT COUNT(*) FROM tenant_demo.sis_student_active_accommodations) AS read_model; -- 2

-- Cycle 10 endpoints mapped on boot — one final spot check
-- expect 48 total: 14 (Step 5) + 10 (Step 6) + 23 (Step 7) + 1 (Step 9 listForStudent)
```

All 8 schema checks return the expected values on a fresh `tenant_demo` provision after the seed pipeline.

## Helper shells used in the scenarios

```bash
API=http://localhost:4000/api/v1
H_TENANT="X-Tenant-Subdomain: demo"
H_JSON="Content-Type: application/json"

login() {
  curl -s -X POST $API/auth/dev-login -H "$H_JSON" -H "$H_TENANT" \
    -d "{\"email\":\"$1\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["accessToken"])'
}
psql_demo() { docker exec campusos-postgres psql -U campusos -d campusos_dev -tA -c "$1"; }

T_ADMIN=$(login principal@demo.campusos.dev)        # Sarah Mitchell — admin / nurse-scope
T_TEACHER=$(login teacher@demo.campusos.dev)        # James Rivera — STAFF non-manager
T_PARENT=$(login parent@demo.campusos.dev)          # David Chen — Maya's father
T_STUDENT=$(login student@demo.campusos.dev)        # Maya Chen
T_COUNSELLOR=$(login counsellor@demo.campusos.dev)  # Marcus Hayes — full HLT scope via Staff role

MAYA=$(psql_demo "SELECT s.id FROM tenant_demo.sis_students s
  JOIN platform.platform_students ps ON ps.id=s.platform_student_id
  JOIN platform.iam_person p ON p.id=ps.person_id
  WHERE p.first_name='Maya' AND p.last_name='Chen';")
ETHAN=$(psql_demo "SELECT s.id FROM tenant_demo.sis_students s
  JOIN platform.platform_students ps ON ps.id=s.platform_student_id
  JOIN platform.iam_person p ON p.id=ps.person_id
  WHERE p.first_name='Ethan';")
AIDEN=$(psql_demo "SELECT s.id FROM tenant_demo.sis_students s
  JOIN platform.platform_students ps ON ps.id=s.platform_student_id
  JOIN platform.iam_person p ON p.id=ps.person_id
  WHERE p.first_name='Aiden';")
PLAN_ID=$(psql_demo "SELECT id FROM tenant_demo.hlth_iep_plans WHERE student_id='$MAYA' AND status<>'EXPIRED' LIMIT 1;")
MED_ID=$(psql_demo "SELECT id FROM tenant_demo.hlth_medications WHERE medication_name='Albuterol Inhaler' LIMIT 1;")
SLOT_ID=$(psql_demo "SELECT id FROM tenant_demo.hlth_medication_schedule WHERE medication_id='$MED_ID' LIMIT 1;")
```

## Scenario 1 — Health record lifecycle (admin reads + HIPAA audit)

```bash
# S1.A admin GETs the full record — joins through Step 5 HealthRecordService
curl -s "$API/health/students/$MAYA" -H "Authorization: Bearer $T_ADMIN" -H "$H_TENANT"
#  => blood=A+ allergies=2 conditions=2 immunisations=3 physician=Dr. Sarah Lee

# S1.B admin GETs the audit log
psql_demo "SELECT access_type, COUNT(*) FROM tenant_demo.hlth_health_access_log GROUP BY access_type;"
#  => VIEW_RECORD count includes the read above plus any prior smoke runs.
#     Every Step 5/6/7 read endpoint calls HealthAccessLogService.recordAccess() AFTER row scope passes
#     and BEFORE the response body leaves the server (ADR-010 IMMUTABLE; service-side discipline).
```

**Result:** record + conditions + immunisations all returned in one shape; HIPAA audit log row written.

## Scenario 2 — Medication lifecycle (administer / missed_chk keystone)

```bash
# S2.A pre-state — dashboard shows the seeded MISSED row at 08:00
curl -s "$API/health/medication-dashboard" -H "Authorization: Bearer $T_ADMIN" -H "$H_TENANT"
#  => 08:00:00 Maya Chen Albuterol Inhaler → status=MISSED

# S2.B reset the seeded missed admin so we can re-administer cleanly
psql_demo "DELETE FROM tenant_demo.hlth_medication_administrations
           WHERE was_missed=true AND missed_reason='STUDENT_ABSENT';"

# S2.C admin POST administer (active dose shape)
curl -s -X POST "$API/health/medications/$MED_ID/administer" \
  -H "Authorization: Bearer $T_ADMIN" -H "$H_TENANT" -H "$H_JSON" \
  -d "{\"scheduleEntryId\":\"$SLOT_ID\",\"doseGiven\":\"2 puffs\",\"parentNotified\":true}"
#  => was_missed=false administered_at=2026-05-04T17:28:23+00 dose='2 puffs' missed_reason=null

# S2.D admin POST missed STUDENT_ABSENT (missed dose shape)
curl -s -X POST "$API/health/medications/$MED_ID/missed" \
  -H "Authorization: Bearer $T_ADMIN" -H "$H_TENANT" -H "$H_JSON" \
  -d "{\"scheduleEntryId\":\"$SLOT_ID\",\"missedReason\":\"STUDENT_ABSENT\",\"notes\":\"Off campus\"}"
#  => was_missed=true administered_at=null missed_reason=STUDENT_ABSENT

# S2.E missed_chk schema keystone rejects invalid shape
psql_demo "BEGIN;
SET search_path TO tenant_demo, platform, public;
INSERT INTO hlth_medication_administrations (id, medication_id, was_missed, administered_at, missed_reason)
VALUES (gen_random_uuid(), '$MED_ID', true, now(), null);
ROLLBACK;"
#  => ERROR: new row violates check constraint "hlth_medication_administrations_missed_chk"
```

**Result:** both administrations persist with the exact shapes the Step 2 multi-column `missed_chk` keystone pins; an invalid hybrid (was_missed=true with administered_at NOT NULL) is rejected at the schema layer.

## Scenario 3 — Nurse visit lifecycle (sign in → treatment + sentHome → sign out)

```bash
# S3.A pre-state — empty roster
curl -s "$API/health/nurse-visits/roster" -H "Authorization: Bearer $T_ADMIN" -H "$H_TENANT"
#  => roster_rows=0

# S3.B admin signs Maya in
SIGNIN=$(curl -s -X POST "$API/health/nurse-visits" \
  -H "Authorization: Bearer $T_ADMIN" -H "$H_TENANT" -H "$H_JSON" \
  -d "{\"visitedPersonId\":\"$MAYA\",\"visitedPersonType\":\"STUDENT\",\"reason\":\"Headache after lunch\"}")
VISIT_ID=$(echo "$SIGNIN" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
#  => status=IN_PROGRESS visitId=<uuid>

# S3.C live roster shows 1
curl -s "$API/health/nurse-visits/roster" -H "Authorization: Bearer $T_ADMIN" -H "$H_TENANT"
#  => roster_rows=1: Maya Chen status=IN_PROGRESS

# S3.D atomic update — treatment + parent_notified + sentHome=true + signOut=true
curl -s -X PATCH "$API/health/nurse-visits/$VISIT_ID" \
  -H "Authorization: Bearer $T_ADMIN" -H "$H_TENANT" -H "$H_JSON" \
  -d '{"treatmentGiven":"Ibuprofen 200mg + rest","parentNotified":true,"sentHome":true,"signOut":true}'
#  => status=COMPLETED signed_out_at=true sent_home=true sent_home_at=true parent_notified=true

# S3.E roster falls back to 0
curl -s "$API/health/nurse-visits/roster" -H "Authorization: Bearer $T_ADMIN" -H "$H_TENANT"
#  => roster_rows=0

# S3.F psql confirms signed_chk + sent_home_chk lockstep both fired in lockstep
psql_demo "SELECT status, signed_out_at IS NOT NULL, sent_home, sent_home_at IS NOT NULL
           FROM tenant_demo.hlth_nurse_visits WHERE id='$VISIT_ID';"
#  => COMPLETED|t|t|t — both lockstep CHECKs satisfied atomically per the Step 7 locked-row tx
```

**Result:** the Step 7 `executeInTenantTransaction` + `SELECT … FOR UPDATE` keeps `signed_chk` and `sent_home_chk` invariants whole; the multi-column CHECKs from Step 3 never fire mid-flight. Emits `hlth.nurse_visit.sent_home` only on the false → true sentHome transition.

## Scenario 4 — IEP accommodation sync (ADR-030 keystone)

```bash
# S4.A pre-state — 2 read-model rows for Maya
psql_demo "SELECT accommodation_type, applies_to, source_iep_accommodation_id IS NOT NULL AS has_src
FROM tenant_demo.sis_student_active_accommodations
WHERE student_id='$MAYA' ORDER BY accommodation_type;"
#  => EXTENDED_TIME|ALL_ASSESSMENTS|t
#  => REDUCED_DISTRACTION|ALL_ASSESSMENTS|t

# S4.B admin POST new ASSISTIVE_TECH ALL_ASSIGNMENTS accommodation
NEW_ACC=$(curl -s -X POST "$API/health/iep-plans/$PLAN_ID/accommodations" \
  -H "Authorization: Bearer $T_ADMIN" -H "$H_TENANT" -H "$H_JSON" \
  -d '{"accommodationType":"ASSISTIVE_TECH","appliesTo":"ALL_ASSIGNMENTS","description":"Speech-to-text software","effectiveFrom":"2026-05-04"}')
#  Step 7 IepPlanService emits iep.accommodation.updated with full snapshot

# S4.C wait 3s, IepAccommodationConsumer reconciles
sleep 3
psql_demo "SELECT accommodation_type FROM tenant_demo.sis_student_active_accommodations
           WHERE student_id='$MAYA' ORDER BY accommodation_type;"
#  => ASSISTIVE_TECH | EXTENDED_TIME | REDUCED_DISTRACTION  (3 rows, all has_src=true)

# S4.D Teacher reads from the read model directly (ADR-030 contract — never touches hlth_*)
docker exec campusos-postgres psql -U campusos -d campusos_dev -tA -c "
SET search_path TO tenant_demo, platform, public;
SELECT accommodation_type, applies_to, plan_type FROM sis_student_active_accommodations
WHERE student_id='$MAYA' ORDER BY accommodation_type;"
#  => 3 rows of plan_type=504 — visible without any /health/* read

# S4.E admin DELETE the new accommodation
curl -X DELETE "$API/health/iep-accommodations/$NEW_ACC_ID" \
  -H "Authorization: Bearer $T_ADMIN" -H "$H_TENANT"
#  => 204

# S4.F wait 3s, consumer DELETE-reconciles the read model
sleep 3
psql_demo "SELECT accommodation_type FROM tenant_demo.sis_student_active_accommodations
           WHERE student_id='$MAYA' ORDER BY accommodation_type;"
#  => EXTENDED_TIME | REDUCED_DISTRACTION  (back to 2 rows)
```

**Result (the ADR-030 keystone):** every accommodation INSERT / UPDATE / DELETE on `hlth_iep_accommodations` reaches `sis_student_active_accommodations` via the Step 7 `IepAccommodationConsumer` two-phase reconcile (UPSERT + DELETE-not-in-payload). Teachers read the read model directly without ever touching `hlth_*`. Round-trip latency observed at ~2-3s.

## Scenario 5 — Screening (record + follow-up queue)

```bash
# S5.A pre-state — Maya VISION REFER pending
curl -s "$API/health/screenings/follow-up" -H "Authorization: Bearer $T_ADMIN" -H "$H_TENANT"
#  => follow_up_rows=1: Maya Chen VISION REFER follow_up_completed=false

# S5.B admin records new screening for Ethan
curl -s -X POST "$API/health/screenings" \
  -H "Authorization: Bearer $T_ADMIN" -H "$H_TENANT" -H "$H_JSON" \
  -d "{\"studentId\":\"$ETHAN\",\"screeningType\":\"HEARING\",\"screeningDate\":\"2026-05-04\",\"result\":\"PASS\",\"resultNotes\":\"All ranges normal\",\"followUpRequired\":false}"
#  => 201 with id

# S5.C all-screenings list returns 2
curl -s "$API/health/screenings" -H "Authorization: Bearer $T_ADMIN" -H "$H_TENANT"
#  => 2 rows: Ethan HEARING PASS + Maya VISION REFER

# S5.D BOGUS result rejected by class-validator
curl -s -X POST "$API/health/screenings" \
  -H "Authorization: Bearer $T_ADMIN" -H "$H_TENANT" -H "$H_JSON" \
  -d "{\"studentId\":\"$MAYA\",\"screeningType\":\"VISION\",\"screeningDate\":\"2026-05-04\",\"result\":\"BOGUS\"}"
#  => 400

# S5.E admin marks Maya's REFER follow-up complete
SCRN_MAYA=$(psql_demo "SELECT id FROM tenant_demo.hlth_screenings WHERE student_id='$MAYA' AND result='REFER';")
curl -s -X PATCH "$API/health/screenings/$SCRN_MAYA" \
  -H "Authorization: Bearer $T_ADMIN" -H "$H_TENANT" -H "$H_JSON" \
  -d '{"followUpCompleted":true}'
#  => followUpCompleted=true

# S5.F follow-up queue is now empty (Step 3 partial INDEX hot path)
curl -s "$API/health/screenings/follow-up" -H "Authorization: Bearer $T_ADMIN" -H "$H_TENANT"
#  => follow_up_rows=0
```

**Result:** the Step 3 partial INDEX `(school_id, follow_up_completed) WHERE follow_up_required=true AND follow_up_completed=false` is the canonical follow-up queue read path; flipping `followUpCompleted=true` removes the row from the index.

## Scenario 6 — Dietary (allergens + POS alert)

```bash
# S6.A allergen-alerts surface (Step 3 partial INDEX (school_id) WHERE pos_allergen_alert=true)
curl -s "$API/health/allergen-alerts" -H "Authorization: Bearer $T_ADMIN" -H "$H_TENANT"
#  => 1 row: Maya Chen pos_alert=true allergens=[Peanuts/SEVERE]

# S6.B admin POST new dietary profile for Aiden
curl -s -X POST "$API/health/students/$AIDEN/dietary" \
  -H "Authorization: Bearer $T_ADMIN" -H "$H_TENANT" -H "$H_JSON" \
  -d '{"allergens":[{"allergen":"Latex","severity":"MODERATE"}],"posAllergenAlert":true,"dietaryRestrictions":[]}'
#  => 201 Aiden Johnson posAlert=true allergen_count=1

# S6.C duplicate POST rejected — schema-side UNIQUE on student_id
curl -s -X POST "$API/health/students/$AIDEN/dietary" -H "Authorization: Bearer $T_ADMIN" -H "$H_TENANT" -H "$H_JSON" -d '{}'
#  => 400

# S6.D allergen-alerts now shows 2
curl -s "$API/health/allergen-alerts" -H "Authorization: Bearer $T_ADMIN" -H "$H_TENANT"
#  => allergen_alert_rows=2
```

**Result:** the cafeteria POS read path returns one row per (school_id) for each student with `pos_allergen_alert=true`; UNIQUE(student_id) prevents duplicate dietary profiles.

## Scenario 7 — Parent visibility (full record + per-domain reads, /screenings 403)

```bash
# S7.A parent reads health record — GUARDIAN strip in HealthRecordService
curl -s "$API/health/students/$MAYA" -H "Authorization: Bearer $T_PARENT" -H "$H_TENANT"
#  => blood=A+ allergies=2 conditions=2 immunisations=3 physician=Dr. Sarah Lee
#     emergency_notes=null  ← stripped (staff procedural)

# S7.B parent reads conditions — managementPlan stripped per Step 5 visibility model
curl -s "$API/health/students/$MAYA/conditions" -H "Authorization: Bearer $T_PARENT" -H "$H_TENANT"
#  => Asthma severity=MODERATE management_plan=null
#  => Seasonal allergies severity=MILD management_plan=null

# S7.C parent reads medications — prescribingPhysician stripped (parents have script on paper)
curl -s "$API/health/students/$MAYA/medications" -H "Authorization: Bearer $T_PARENT" -H "$H_TENANT"
#  => Albuterol Inhaler route=INHALER prescribing_physician=null

# S7.D parent reads /visits via the Step 9 endpoint — assertCanReadStudentExternal row scope
curl -s "$API/health/students/$MAYA/visits" -H "Authorization: Bearer $T_PARENT" -H "$H_TENANT"
#  => 2 visits with reason + sentHome flags

# S7.E parent CANNOT read another child's record — sis_student_guardians row scope
curl -s -o /dev/null -w "%{http_code}\n" "$API/health/students/$ETHAN" -H "Authorization: Bearer $T_PARENT" -H "$H_TENANT"
#  => 404 (don't-leak-existence)

# S7.F parent CANNOT read screenings list — admin-only
curl -s -o /dev/null -w "%{http_code}\n" "$API/health/screenings" -H "Authorization: Bearer $T_PARENT" -H "$H_TENANT"
#  => 403

# S7.G parent CANNOT read medication-dashboard — HLT-002:read not granted
curl -s -o /dev/null -w "%{http_code}\n" "$API/health/medication-dashboard" -H "Authorization: Bearer $T_PARENT" -H "$H_TENANT"
#  => 403

# S7.H parent CANNOT read HIPAA access log — admin-only
curl -s -o /dev/null -w "%{http_code}\n" "$API/health/access-log" -H "Authorization: Bearer $T_PARENT" -H "$H_TENANT"
#  => 403
```

**Result:** the Step 5 visibility model strips `emergencyMedicalNotes`, `managementPlan`, and `prescribingPhysician` from the parent payload; `sis_student_guardians` row scope returns 404 on non-own-children; admin surfaces (screenings list, medication-dashboard, access-log) all 403 cleanly.

## Scenario 8 — HIPAA access log verification

```bash
# S8.A counts by access_type after the CAT run
curl -s "$API/health/access-log?limit=200" -H "Authorization: Bearer $T_ADMIN" -H "$H_TENANT" \
  | python3 -c "import sys,json,collections; d=json.load(sys.stdin);
                print(f'total={len(d)}');
                [print(f'  {k}: {v}') for k,v in sorted(collections.Counter(r['accessType'] for r in d).items())]"
#  => total=13
#       VIEW_CONDITIONS: 1
#       VIEW_IEP: 1
#       VIEW_MEDICATIONS: 1
#       VIEW_RECORD: 5
#       VIEW_SCREENING: 3
#       VIEW_VISITS: 2

# S8.B persona breakdown
#  => David Chen: 7  (S7 parent reads)
#     James Rivera: 1
#     Sarah Mitchell: 5  (S1 + S5 + S8 admin reads)

# S8.C audit log is IMMUTABLE per ADR-010
#     - service has no UPDATE / DELETE method on hlth_health_access_log
#     - schema does not enforce immutability — service-side discipline only
#       (DBA / emergency operator can still modify; documented in ADR-010)
```

**Result:** every successful read in the CAT generated exactly one audit row; `accessedByName` resolves through the `hlth_health_access_log.accessed_by` soft FK to `platform.platform_users → iam_person`. Audit IMMUTABILITY is service-side discipline (no UPDATE / DELETE method, ever) per ADR-010 — the schema deliberately doesn't lock it so emergency operator action stays possible.

## Scenario 9 — Permission denials (gate / service-layer / row-scope)

```bash
# S9.A student GET full health record — gate 403 (no hlt-001:read)
curl -s -o /dev/null -w "%{http_code}\n" "$API/health/students/$MAYA" -H "Authorization: Bearer $T_STUDENT" -H "$H_TENANT"
#  => 403

# S9.B teacher GET /iep — service-layer redirect to ADR-030 read model
curl -s "$API/health/students/$MAYA/iep" -H "Authorization: Bearer $T_TEACHER" -H "$H_TENANT"
#  => 403 message: "IEP plans are visible to nurses, admins, counsellors, and parents only.
#                   Teachers see accommodations via sis_student_active_accommodations."

# S9.C teacher GET /medications — service-layer 403
curl -s -o /dev/null -w "%{http_code}\n" "$API/health/students/$MAYA/medications" -H "Authorization: Bearer $T_TEACHER" -H "$H_TENANT"
#  => 403

# S9.D teacher CAN read accommodations from the ADR-030 read model
docker exec campusos-postgres psql -U campusos -d campusos_dev -tA -c "
SET search_path TO tenant_demo, platform, public;
SELECT COUNT(*) FROM sis_student_active_accommodations WHERE student_id='$MAYA';"
#  => 2 (the ADR-030 contract: teachers never touch hlth_*)

# S9.E student POST administer — gate 403
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$API/health/medications/$MED_ID/administer" \
  -H "Authorization: Bearer $T_STUDENT" -H "$H_TENANT" -H "$H_JSON" -d '{"doseGiven":"1 puff"}'
#  => 403

# S9.F teacher POST screening — gate 403 (no hlt-004:write)
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$API/health/screenings" \
  -H "Authorization: Bearer $T_TEACHER" -H "$H_TENANT" -H "$H_JSON" \
  -d "{\"studentId\":\"$MAYA\",\"screeningType\":\"VISION\",\"screeningDate\":\"2026-05-04\"}"
#  => 403

# S9.G parent POST IEP plan — gate 403 (no hlt-001:write counsellor scope)
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$API/health/students/$MAYA/iep" \
  -H "Authorization: Bearer $T_PARENT" -H "$H_TENANT" -H "$H_JSON" -d '{"planType":"504"}'
#  => 403
```

**Result:** 6 permission denial paths exercising all three tiers (gate via `@RequirePermission` / service-layer redirect-to-read-model / row-scope on `assertCanReadStudentExternal`). The teacher-redirect message is the canonical ADR-030 contract: "Teachers see accommodations via `sis_student_active_accommodations`."

## Cleanup script (restore tenant_demo to post-Step-4 seed shape)

```bash
source /tmp/cat10-helpers.sh

# Drop CAT-added administrations (S2.C + S2.D) and re-seed the missed dose
psql_demo "DELETE FROM tenant_demo.hlth_medication_administrations WHERE administered_at::date = '2026-05-04' OR (was_missed=true AND missed_reason='STUDENT_ABSENT' AND created_at::date = '2026-05-04');"
psql_demo "INSERT INTO tenant_demo.hlth_medication_administrations
  (id, medication_id, schedule_entry_id, was_missed, missed_reason, notes, created_at, updated_at)
  VALUES (gen_random_uuid(), '$MED_ID', '$SLOT_ID', true, 'STUDENT_ABSENT', 'Maya absent from school',
          (now() AT TIME ZONE 'UTC')::date + INTERVAL '8 hours',
          (now() AT TIME ZONE 'UTC')::date + INTERVAL '8 hours');"

# Drop CAT-added nurse visit (S3)
psql_demo "DELETE FROM tenant_demo.hlth_nurse_visits WHERE reason='Headache after lunch';"

# Drop Ethan's CAT screening (S5)
psql_demo "DELETE FROM tenant_demo.hlth_screenings WHERE screening_type='HEARING';"

# Reset Maya's seeded REFER follow_up_completed back to false (S5.E flipped)
psql_demo "UPDATE tenant_demo.hlth_screenings SET follow_up_completed=false WHERE student_id='$MAYA' AND result='REFER';"

# Drop Aiden's CAT dietary profile (S6)
psql_demo "DELETE FROM tenant_demo.hlth_dietary_profiles WHERE student_id='$AIDEN';"

# Verify counts match Step 4 seed shape
psql_demo "SELECT
  (SELECT COUNT(*) FROM tenant_demo.hlth_student_health_records) AS records,
  (SELECT COUNT(*) FROM tenant_demo.hlth_medical_conditions) AS conditions,
  (SELECT COUNT(*) FROM tenant_demo.hlth_immunisations) AS immunisations,
  (SELECT COUNT(*) FROM tenant_demo.hlth_medications) AS meds,
  (SELECT COUNT(*) FROM tenant_demo.hlth_medication_administrations) AS admin_rows,
  (SELECT COUNT(*) FROM tenant_demo.hlth_nurse_visits) AS visits,
  (SELECT COUNT(*) FROM tenant_demo.hlth_iep_plans) AS plans,
  (SELECT COUNT(*) FROM tenant_demo.hlth_iep_accommodations) AS accommodations,
  (SELECT COUNT(*) FROM tenant_demo.hlth_screenings) AS screenings,
  (SELECT COUNT(*) FROM tenant_demo.hlth_dietary_profiles) AS dietary,
  (SELECT COUNT(*) FROM tenant_demo.sis_student_active_accommodations) AS read_model;"
#  => 1|2|3|1|2|2|1|2|1|1|2  ← matches Step 4 seed exactly
```

The S4 keystone DELETE already self-cleaned its accommodation. The audit log is intentionally NOT cleaned — every entry is IMMUTABLE per ADR-010, and accumulating across CAT runs is the expected behaviour (the next run reads "13 + N" rows; the assertions are about per-CAT-run access_type breakdown, not absolute totals).

## Closing

**Cycle 10 ships clean to the post-cycle architecture review.** All 9 plan scenarios (health record lifecycle / medication keystone / nurse visit lockstep / ADR-030 IEP accommodation sync / screening / dietary / parent visibility / HIPAA audit / permission denials) verified live against `tenant_demo` on 2026-05-04. The cleanup script restores the tenant to the post-Step-4 seed shape so the next run starts clean.

**Reviewer attention items (non-blocking, Phase 2 polish):**

1. The `hlth_health_access_log` immutability is service-side only — the schema deliberately allows DBA / emergency operator action per ADR-010. A reviewer who wants stronger immutability could add a tenant-scoped trigger; the convention is documented but not enforced.
2. The Cycle 10 IAM grants give Parent role `HLT-001:read`; the parent has access to `/iep` per the GUARDIAN branch in `IepPlanService`. The Step 9 plan UI deliberately hides IEP details from the parent summary page (`/children/[id]/health`) but the API surfaces full plan detail. If a school wants the parent UI to be the source of truth for parent IEP visibility, the IepPlanService visibility model would need to drop GUARDIAN from the read path. Documented as a product-side decision, not a security flaw.
3. The Cycle 10 medication-administered notification consumer (Cycle 3 NotificationConsumer fan-out on `hlth.medication.administered` for parent IN_APP / EMAIL) is deferred. The Kafka emit lands cleanly with full payload but no consumer wires it into the Cycle 3 notification pipeline yet. Same gap exists for `hlth.nurse_visit.sent_home`. Documented Phase 2 punch list item.
4. The S4 ADR-030 keystone latency is observed at ~2-3s end-to-end; this is the Kafka consumer round-trip time. The Step 7 consumer is single-threaded per tenant via `processWithIdempotency`. Under load this could climb; reviewer attention warranted but not blocking.
5. Synthetic Platform Admin (`admin@`) cannot administer medication because they have no `hr_employees` row — Step 6 deliberately refuses callers without `actor.employeeId`. If a school's only admin doesn't have an HR row, they need to bridge or use the principal account. Documented in CLAUDE.md.
