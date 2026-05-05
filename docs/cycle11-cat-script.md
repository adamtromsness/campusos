# Cycle 11 CAT — Counselling & Student Support

**Status:** verified live on `tenant_demo` 2026-05-05 against the Step 9 build (commit at HEAD of `main`). All 10 plan scenarios pass. Both ADR-057 wire envelopes captured live.

**Vertical slice:** Rivera (teacher) submits a Social/Emotional referral for Maya → `svc.referral.created` envelope captured live → Hayes (counsellor) triages and accepts (writing 4 audit rows to `svc_referral_activity` for the SUBMITTED → TRIAGED → ACCEPTED lifecycle) → Maya's caseload (Hayes primary, SOCIAL_EMOTIONAL concern) is verified linked to her **Cycle 9 BIP via the Step 4 `caseload_id` backfill** (the cross-cycle integration keystone) and a 2nd primary keystone INSERT is rejected with the conflicting caseload id in a friendly 400 → Hayes logs a fresh INDIVIDUAL session and writes a FERPA-protected note with `goalsAddressed` array; FERPA gate distribution verified across 5 personas (counsellor + admin 200; teacher / parent / student 403) → Hayes locks the note (irreversible — `locked_chk` schema invariant satisfied atomically with all 3 columns in lockstep); subsequent PATCH returns 400 "Note is locked and immutable. Create a follow-up session for additional observations." and the double-lock attempt also rejects → Hayes assigns Maya to TIER_2 SOCIAL_EMOTIONAL and `svc.tier.changed` envelope captured live with `reason=CREATED, oldTier=null`; partial UNIQUE keystone rejects a 2nd ACTIVE SOCIAL_EMOTIONAL tier with the conflicting tier id; new Social Skills Group SOCIAL_EMOTIONAL_LEARNING intervention added; progress data point logged (score=2.00, benchmark=1.00) → Hayes writes a coordinated-care note about Maya's health-anxiety; intersection gate distribution verified (counsellor + admin 200; teacher / parent / student 403 because none hold cou-007:read) → Rivera files a SUSPECTED_NEGLECT mandatory report for Ethan; admin updates `cps_response` + `status=CPS_CONTACTED` cleanly; admin attempt to PATCH `description` (immutable core field) → 400 "property description should not exist" (DTO whitelist enforces it before the service-side defence-in-depth fires) → teacher visibility verified (sees own referral status ACCEPTED + Maya's caseload assignment with notes stripped; 403 on session notes, coordinated care; sees only own filed mandatory reports) → parent visibility verified (sees Maya's caseload counsellor name only; 403 on referrals, session notes, coordinated care, MTSS tiers, mandatory reports — all 5 secondary surfaces locked).

**Pre-conditions:**

- `pnpm seed` + `seed:sis` + `seed:classroom` + `seed:hr` + `seed:scheduling` + `seed:enrollment` + `seed:payments` + `seed:profile` + `seed:tasks` + `seed:tickets` + `seed:behaviour` + `seed:health` + `seed:counselling` all run on `tenant_demo`.
- `tsx src/build-cache.ts` rebuilt the IAM cache. 7 personas:
  - admin / principal: 450 perms (every code × every tier via everyFunction)
  - teacher: 46 perms (incl. cou-001:read + cou-002:read+write + cou-005:read + cou-006:write — but NOT cou-007:read, NOT cou-003:\* anything, NOT student_counseling_record:read)
  - parent: 23 perms (cou-001:read only across the COU codes)
  - student: 19 perms (no COU codes at all)
  - vp / counsellor: 47 perms (covers Staff role — full COU-001..003/005..007 read+write + student_counseling_record:read)
- Both Cycle 11 Kafka topics pre-created via `kafka-topics.sh --create --if-not-exists` (`dev.svc.referral.created`, `dev.svc.tier.changed`).
- API running on `localhost:4000` from `pnpm --filter @campusos/api build && node apps/api/dist/main.js`.

## Schema preamble (8 checks)

```sql
-- 1. Tenant logical base table count after Cycle 11 (3 schema migrations)
SELECT COUNT(*) FROM information_schema.tables t
WHERE table_schema='tenant_demo' AND table_type='BASE TABLE'
  AND NOT EXISTS (
    SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = t.table_schema AND c.relname = t.table_name
  );
-- expected: 169

-- 2. Cycle 11 svc_* tables (4 from Step 1 + 8 from Step 2 + 2 from Step 3 = 14)
--    Plus the 3 from Cycle 9 = 17 total svc_* tables.
SELECT COUNT(*) FROM information_schema.tables
WHERE table_schema='tenant_demo' AND table_name LIKE 'svc%';
-- expected: 17

-- 3. Cycle 9 BIP caseload_id FK backfill — should now be a real DB FK with SET NULL
SELECT confrelid::regclass::text AS target,
       CASE confdeltype WHEN 'n' THEN 'SET NULL' END AS on_delete
FROM pg_constraint c
JOIN pg_namespace n ON n.oid = c.connamespace
WHERE n.nspname='tenant_demo' AND conname='svc_behavior_plans_caseload_id_fkey';
-- expected: target=tenant_demo.svc_caseloads, on_delete=SET NULL

-- 4. 32 intra-tenant FKs across Cycle 11 svc_* tables (8 Step 1 + 21 Step 2 + 3 Step 3)
SELECT COUNT(*) FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE c.contype='f' AND n.nspname='tenant_demo'
  AND t.relname IN (
    'svc_caseloads','svc_referral_types','svc_referrals','svc_referral_activity',
    'svc_sessions','svc_session_participants','svc_session_notes',
    'svc_mtss_tiers','svc_interventions','svc_intervention_progress',
    'svc_mtss_team_meetings','svc_mtss_team_meeting_students',
    'svc_coordinated_care_notes','svc_mandatory_reports'
  );
-- expected: 32

-- 5. 0 cross-schema FKs across all Cycle 11 svc_* tables
SELECT COUNT(*) FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_class ft ON ft.oid = c.confrelid
JOIN pg_namespace fn ON fn.oid = ft.relnamespace
WHERE c.contype='f' AND n.nspname='tenant_demo'
  AND t.relname LIKE 'svc%' AND fn.nspname <> 'tenant_demo';
-- expected: 0

-- 6. IAM catalogue — 450 permissions (149 functions × 3 tiers + 1 student_counseling_record × 3 tiers).
SELECT COUNT(*) FROM platform.permissions;
-- expected: 450

-- 7. FERPA gate distribution — exactly 4 of 7 personas hold student_counseling_record:read.
SELECT COUNT(*) FROM platform.iam_effective_access_cache eac
WHERE 'student_counseling_record:read' = ANY(eac.permission_codes);
-- expected: 4 (admin, principal, vp, counsellor)

-- 8. Step 4 seed counts on tenant_demo — exactly the post-seed shape.
SELECT
  (SELECT COUNT(*) FROM tenant_demo.svc_referral_types)         AS types,        -- 2
  (SELECT COUNT(*) FROM tenant_demo.svc_caseloads)              AS caseloads,    -- 1
  (SELECT COUNT(*) FROM tenant_demo.svc_behavior_plans
    WHERE caseload_id IS NOT NULL)                              AS bip_linked,   -- 1
  (SELECT COUNT(*) FROM tenant_demo.svc_referrals)              AS referrals,    -- 1
  (SELECT COUNT(*) FROM tenant_demo.svc_referral_activity)      AS activity,     -- 1
  (SELECT COUNT(*) FROM tenant_demo.svc_sessions)               AS sessions,     -- 2
  (SELECT COUNT(*) FROM tenant_demo.svc_session_notes)          AS notes,        -- 2 (both is_locked=false)
  (SELECT COUNT(*) FROM tenant_demo.svc_mtss_tiers)             AS tiers,        -- 1
  (SELECT COUNT(*) FROM tenant_demo.svc_interventions)          AS interventions,-- 1
  (SELECT COUNT(*) FROM tenant_demo.svc_intervention_progress)  AS progress,     -- 1
  (SELECT COUNT(*) FROM tenant_demo.svc_coordinated_care_notes) AS care_notes,   -- 1
  (SELECT COUNT(*) FROM tenant_demo.svc_mandatory_reports)      AS reports;      -- 0
```

All 8 schema checks return the expected values on a fresh `tenant_demo` provision after the seed pipeline.

## Helper shells used in the scenarios

```bash
API=http://localhost:4000/api/v1
H="X-Tenant-Subdomain: demo"
CT="Content-Type: application/json"
login() {
  curl -s -X POST $API/auth/dev-login -H "$CT" -H "$H" \
    -d "{\"email\":\"$1\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["accessToken"])'
}
q() { docker exec campusos-postgres psql -U campusos -d campusos_dev -t -A -c "SET search_path=tenant_demo; $1" | tail -1; }

ADMIN=$(login admin@demo.campusos.dev)         # Platform Admin (synthetic, no hr_employees)
PRINCIPAL=$(login principal@demo.campusos.dev) # Sarah Mitchell — admin
COUNS=$(login counsellor@demo.campusos.dev)    # Marcus Hayes — Staff (counsellor)
TEACHER=$(login teacher@demo.campusos.dev)     # James Rivera
PARENT=$(login parent@demo.campusos.dev)       # David Chen — Maya's father
STUDENT=$(login student@demo.campusos.dev)     # Maya Chen

MAYA=$(q "SELECT s.id FROM sis_students s JOIN platform.platform_students ps ON ps.id=s.platform_student_id JOIN platform.iam_person ip ON ip.id=ps.person_id WHERE ip.first_name='Maya'")
ETHAN=$(q "SELECT s.id FROM sis_students s JOIN platform.platform_students ps ON ps.id=s.platform_student_id JOIN platform.iam_person ip ON ip.id=ps.person_id WHERE ip.first_name='Ethan'")
HAYES=$(q "SELECT he.id FROM hr_employees he JOIN platform.iam_person p ON p.id=he.person_id JOIN platform.platform_users pu ON pu.person_id=p.id WHERE pu.email='counsellor@demo.campusos.dev'")
RIVERA=$(q "SELECT he.id FROM hr_employees he JOIN platform.iam_person p ON p.id=he.person_id JOIN platform.platform_users pu ON pu.person_id=p.id WHERE pu.email='teacher@demo.campusos.dev'")
AY=$(q "SELECT id FROM sis_academic_years WHERE name='2025-2026'")
SOC_TYPE=$(q "SELECT id FROM svc_referral_types WHERE name='Social/Emotional'")
CASELOAD=$(q "SELECT id FROM svc_caseloads WHERE student_id='$MAYA' AND status='ACTIVE'")
```

---

## Scenario 1 — Rivera submits referral; `svc.referral.created` envelope fires

```bash
RESP=$(curl -s -X POST -H "Authorization: Bearer $TEACHER" -H "$H" -H "$CT" \
  -d "{\"studentId\":\"$MAYA\",\"referralTypeId\":\"$SOC_TYPE\",\"reason\":\"S1 CAT — Maya struggling with peer relationships and declining grades. Recommending counsellor assessment.\"}" \
  $API/counselling/referrals)
S1_REF=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin);print('  status='+d['status']+' priority='+d['priority']+' reportedBy='+d['referredByName']+' parentNotify='+str(d['requiresParentNotification']))"
# Output:
#   status=SUBMITTED priority=MEDIUM reportedBy=James Rivera parentNotify=True

# Initial STATUS_CHANGE activity row written inside the same tenant tx as the INSERT
q "SELECT 'activity_count='||count(*) FROM svc_referral_activity WHERE referral_id='$S1_REF'"
# activity_count=1

# Rivera's own-submitted view includes the new row (row-scope on referred_by=me)
curl -s -H "Authorization: Bearer $TEACHER" -H "$H" $API/counselling/referrals \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('  rivera_sees='+str(any(x['id']=='$S1_REF' for x in d))+' total='+str(len(d)))"
#   rivera_sees=True total=2
```

**`svc.referral.created` envelope captured live** on `dev.svc.referral.created` with full ADR-057 shape:

```json
{
  "event_id": "019df754-d5ee-7cce-87f6-3f56088c6b03",
  "event_type": "svc.referral.created",
  "event_version": 1,
  "occurred_at": "2026-05-05T08:50:25.390Z",
  "published_at": "2026-05-05T08:50:25.390Z",
  "tenant_id": "019dc92b-ea59-7bb7-aa7f-929729562010",
  "source_module": "counselling",
  "correlation_id": "019df754-d5ee-7cce-87f6-43dfd66b3f30",
  "payload": {
    "referralId": "019df754-d5de-7cce-87f6-2f8cffddbb33",
    "sourceRefId": "019df754-d5de-7cce-87f6-2f8cffddbb33",
    "schoolId": "019dc92b-ea59-7bb7-aa7f-929729562010",
    "studentId": "019dd544-7e06-777b-94e8-2e3304310985",
    "studentName": "Maya Chen",
    "referralTypeId": "019df48a-1d3d-7ffd-bad5-3b88675c28be",
    "referralTypeName": "Social/Emotional",
    "priority": "MEDIUM",
    "requiresParentNotification": true,
    "referredById": "019dd544-85e6-7997-b89d-099bf973ba2b",
    "referredByName": "James Rivera",
    "referredByAccountId": "019dc92d-0882-7442-abf5-e33e03046357",
    "reason": "S1 CAT — Maya struggling with peer relationships and declining grades. Recommending counsellor assessment.",
    "status": "SUBMITTED"
  }
}
```

---

## Scenario 2 — Hayes triages + accepts; activity timeline grows to 4 rows

```bash
# Triage (assigns self): SUBMITTED → TRIAGED with assigned_counselor stamped
curl -s -X PATCH -H "Authorization: Bearer $COUNS" -H "$H" -H "$CT" \
  -d "{\"assignedCounselorId\":\"$HAYES\",\"notes\":\"S2 CAT — picking this up.\"}" \
  $API/counselling/referrals/$S1_REF/triage \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('  status='+d['status']+' assignedTo='+d['assignedCounselorName'])"
#   status=TRIAGED assignedTo=Marcus Hayes

# Accept: TRIAGED → ACCEPTED
curl -s -X PATCH -H "Authorization: Bearer $COUNS" -H "$H" -H "$CT" \
  -d '{"notes":"S2 CAT — accepting; will follow up via 1:1."}' \
  $API/counselling/referrals/$S1_REF/accept \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('  status='+d['status'])"
#   status=ACCEPTED

# 4 activity rows for the lifecycle (all chained inside their parent state-machine txs)
q "SELECT activity_type, notes FROM svc_referral_activity WHERE referral_id='$S1_REF' ORDER BY created_at"
# STATUS_CHANGE     | Submitted.
# ASSIGNMENT_CHANGE | Triaged and assigned to counsellor.
# STATUS_CHANGE     | S2 CAT — picking this up.
# STATUS_CHANGE     | S2 CAT — accepting; will follow up via 1:1.
```

---

## Scenario 3 — Caseload: Cycle 9 BIP linkage + partial UNIQUE keystone

```bash
# Maya's caseload (admin getById) — surfaces the inlined sessionCount + linkedBipId
curl -s -H "Authorization: Bearer $ADMIN" -H "$H" $API/counselling/caseloads/$CASELOAD \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('  '+d['counselorName']+' / '+d['primaryConcern']+' / status='+d['status']+' / isPrimary='+str(d['isPrimaryCounselor']))"
#   Marcus Hayes / SOCIAL_EMOTIONAL / status=ACTIVE / isPrimary=True

curl -s -H "Authorization: Bearer $ADMIN" -H "$H" $API/counselling/caseloads/$CASELOAD \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('  sessionCount='+str(d.get('sessionCount'))+' lastSession='+str(d.get('lastSessionDate'))+' linkedBipId='+str(d.get('linkedBipId')))"
#   sessionCount=2 lastSession=2026-04-27 linkedBipId=019df0f5-c5d9-7ffa-8a4e-7e990d5b86ac
#                                          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
#   Cycle 9 BIP — visible via the Step 4 caseload_id backfill (Step 3 FK enforces it)

# Partial UNIQUE keystone: 2nd primary caseload for Maya in same year → 400 with conflict id
curl -s -X POST -H "Authorization: Bearer $COUNS" -H "$H" -H "$CT" \
  -d "{\"counselorId\":\"$HAYES\",\"studentId\":\"$MAYA\",\"academicYearId\":\"$AY\",\"primaryConcern\":\"GENERAL\",\"openedAt\":\"2026-05-05\"}" \
  $API/counselling/caseloads
# {"message": "Student already has a primary counsellor for this academic year (caseload 019df48a-1d44-7ffd-bad5-4bfec87db1de). Close that caseload before opening a new primary, or set is_primary_counselor=false to open as a consultant.", "error": "Bad Request", "statusCode": 400}
```

---

## Scenario 4 — INDIVIDUAL session + FERPA gate distribution across 5 personas

```bash
# Hayes logs new INDIVIDUAL COMPLETED session
SESS_RESP=$(curl -s -X POST -H "Authorization: Bearer $COUNS" -H "$H" -H "$CT" \
  -d "{\"counselorId\":\"$HAYES\",\"sessionDate\":\"2026-05-05\",\"durationMinutes\":40,\"sessionType\":\"INDIVIDUAL\",\"primaryCaseloadId\":\"$CASELOAD\",\"status\":\"COMPLETED\",\"notes\":\"S4 CAT logistics — office, between periods 3 and 4.\"}" \
  $API/counselling/sessions)
S4_SESS=$(echo "$SESS_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
# sessionId=019df755-9c74-7cce-87f6-b79913d126ca type=INDIVIDUAL status=COMPLETED student=Maya Chen

# Hayes adds FERPA-protected note with goalsAddressed array
NOTE_RESP=$(curl -s -X POST -H "Authorization: Bearer $COUNS" -H "$H" -H "$CT" \
  -d "{\"studentId\":\"$MAYA\",\"notesText\":\"S4 CAT FERPA note — discussed peer relationship strategies. Maya open and engaged. Will check in next week.\",\"goalsAddressed\":[\"Peer relationship building\",\"Emotional regulation\"],\"followUpRequired\":true}" \
  $API/counselling/sessions/$S4_SESS/notes)
S4_NOTE=$(echo "$NOTE_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
# noteId=019df755-9d1c-7cce-87f6-bf755e852b43 is_locked=False goals_count=2 followUp=True

# FERPA gate distribution on /sessions/:id/notes — only counsellor + admin pass
curl -s -o /dev/null -w "  counsellor: %{http_code}\n" -H "Authorization: Bearer $COUNS"   -H "$H" $API/counselling/sessions/$S4_SESS/notes
curl -s -o /dev/null -w "  admin:      %{http_code}\n" -H "Authorization: Bearer $ADMIN"   -H "$H" $API/counselling/sessions/$S4_SESS/notes
curl -s -o /dev/null -w "  teacher:    %{http_code}\n" -H "Authorization: Bearer $TEACHER" -H "$H" $API/counselling/sessions/$S4_SESS/notes
curl -s -o /dev/null -w "  parent:     %{http_code}\n" -H "Authorization: Bearer $PARENT"  -H "$H" $API/counselling/sessions/$S4_SESS/notes
curl -s -o /dev/null -w "  student:    %{http_code}\n" -H "Authorization: Bearer $STUDENT" -H "$H" $API/counselling/sessions/$S4_SESS/notes
# counsellor: 200
# admin:      200
# teacher:    403
# parent:     403
# student:    403
```

---

## Scenario 5 — Lock keystone (irreversible immutability)

```bash
# Hayes locks the S4 note. Stamps is_locked + locked_at + locked_by atomically per the
# multi-column locked_chk schema invariant.
curl -s -X PATCH -H "Authorization: Bearer $COUNS" -H "$H" $API/counselling/session-notes/$S4_NOTE/lock \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('  is_locked='+str(d['isLocked'])+' lockedBy='+d['lockedByName']+' lockedAt='+d['lockedAt'])"
#   is_locked=True lockedBy=Marcus Hayes lockedAt=2026-05-05T08:52:59+00

# PATCH after lock → 400 (the keystone immutability — no unlock endpoint by design).
curl -s -X PATCH -H "Authorization: Bearer $COUNS" -H "$H" -H "$CT" \
  -d '{"notesText":"Try to override locked note."}' \
  $API/counselling/session-notes/$S4_NOTE
# {"message": "Note is locked and immutable. Create a follow-up session for additional observations.", "error": "Bad Request", "statusCode": 400}

# Double-lock → 400.
curl -s -X PATCH -H "Authorization: Bearer $COUNS" -H "$H" $API/counselling/session-notes/$S4_NOTE/lock
# {"message": "Note is already locked", "error": "Bad Request", "statusCode": 400}

# psql verifies the multi-column locked_chk all 3 columns are in lockstep.
q "SELECT 'is_locked='||is_locked||' has_at='||(locked_at IS NOT NULL)||' has_by='||(locked_by IS NOT NULL) FROM svc_session_notes WHERE id='$S4_NOTE'"
# is_locked=true has_at=true has_by=true
```

---

## Scenario 6 — MTSS tier assignment + `svc.tier.changed` envelope + intervention + progress

```bash
# Hayes assigns Maya to TIER_2 SOCIAL_EMOTIONAL (a domain different from the seeded
# BEHAVIORAL tier so the partial UNIQUE on (student, year, domain) WHERE status='ACTIVE'
# accepts the row).
TIER_RESP=$(curl -s -X POST -H "Authorization: Bearer $COUNS" -H "$H" -H "$CT" \
  -d "{\"studentId\":\"$MAYA\",\"academicYearId\":\"$AY\",\"tier\":\"TIER_2\",\"domain\":\"SOCIAL_EMOTIONAL\",\"assignedAt\":\"2026-05-05\",\"reviewDate\":\"2026-08-05\",\"notes\":\"S6 CAT — referral acceptance triggered tier assessment.\"}" \
  $API/counselling/mtss/tiers)
S6_TIER=$(echo "$TIER_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
# tierId=019df757-30bc-7cce-87f6-e78b6a471bd4 TIER_2 SOCIAL_EMOTIONAL ACTIVE

# Partial UNIQUE keystone: 2nd ACTIVE SOCIAL_EMOTIONAL tier same (student, year) → 400.
curl -s -X POST -H "Authorization: Bearer $COUNS" -H "$H" -H "$CT" \
  -d "{\"studentId\":\"$MAYA\",\"academicYearId\":\"$AY\",\"tier\":\"TIER_3\",\"domain\":\"SOCIAL_EMOTIONAL\",\"assignedAt\":\"2026-05-05\",\"reviewDate\":\"2026-08-05\"}" \
  $API/counselling/mtss/tiers
# {"message":"Student already has an ACTIVE SOCIAL_EMOTIONAL tier (TIER_2, id 019df757-30bc-7cce-87f6-e78b6a471bd4) for this academic year. Exit / promote / demote that tier first.","error":"Bad Request","statusCode":400}

# Intervention + progress
INT_RESP=$(curl -s -X POST -H "Authorization: Bearer $COUNS" -H "$H" -H "$CT" \
  -d '{"interventionName":"Social Skills Group (S6 CAT)","interventionType":"SOCIAL_EMOTIONAL_LEARNING","frequency":"2x per week, 30 minutes","startDate":"2026-05-05","description":"Targeted SEL group for peer relationship building."}' \
  $API/counselling/mtss/tiers/$S6_TIER/interventions)
S6_INT=$(echo "$INT_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
# interventionId=019df757-39d6-7cce-87f6-fcff8a706ea7 SOCIAL_EMOTIONAL_LEARNING ACTIVE

curl -s -X POST -H "Authorization: Bearer $COUNS" -H "$H" -H "$CT" \
  -d '{"recordedDate":"2026-05-05","measureType":"Office Referrals per Week","score":2.00,"benchmark":1.00,"notes":"S6 CAT — baseline."}' \
  $API/counselling/mtss/interventions/$S6_INT/progress
# recorded=2026-05-05 score=2 benchmark=1
```

**`svc.tier.changed` envelope captured live** on `dev.svc.tier.changed` with `reason=CREATED, oldTier=null`:

```json
{
  "event_id": "019df757-30e4-7cce-87f6-ec68a5a58617",
  "event_type": "svc.tier.changed",
  "event_version": 1,
  "occurred_at": "2026-05-05T08:52:59.748Z",
  "published_at": "2026-05-05T08:52:59.748Z",
  "tenant_id": "019dc92b-ea59-7bb7-aa7f-929729562010",
  "source_module": "counselling",
  "correlation_id": "019df757-30e4-7cce-87f6-f2abf7d485f0",
  "payload": {
    "tierId": "019df757-30bc-7cce-87f6-e78b6a471bd4",
    "sourceRefId": "019df757-30bc-7cce-87f6-e78b6a471bd4",
    "schoolId": "019dc92b-ea59-7bb7-aa7f-929729562010",
    "studentId": "019dd544-7e06-777b-94e8-2e3304310985",
    "studentName": "Maya Chen",
    "academicYearId": "019dd544-7ddd-777b-94e7-5df7c8ad10ce",
    "tier": "TIER_2",
    "domain": "SOCIAL_EMOTIONAL",
    "status": "ACTIVE",
    "oldTier": null,
    "reason": "CREATED",
    "assignedById": "019dd544-85e9-7997-b89d-1b56f5c648a7",
    "assignedByName": "Marcus Hayes",
    "assignedAt": "2026-05-05",
    "reviewDate": "2026-08-05"
  }
}
```

---

## Scenario 7 — Coordinated care intersection gate

```bash
# Hayes posts a COUNSELLOR-role note (the role-vs-perm validator runs server-side; Hayes
# holds cou-001:write so COUNSELLOR is accepted).
curl -s -X POST -H "Authorization: Bearer $COUNS" -H "$H" -H "$CT" \
  -d '{"authorRole":"COUNSELLOR","noteText":"S7 CAT — Maya disclosed anxiety around health episodes during peer interactions. Coordinating with nurse on private medication space."}' \
  $API/counselling/coordinated-care/$MAYA \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('  authorRole='+d['authorRole']+' authorName='+d['authorName'])"
#   authorRole=COUNSELLOR authorName=Marcus Hayes

# Intersection gate — only callers who hold BOTH hlt-001:read AND cou-007:read pass.
# IAM seed grants both to admin / principal / vp / counsellor (Staff role); teacher
# holds hlt-001:read but NOT cou-007:read; parent the same; student holds neither.
curl -s -o /dev/null -w "  counsellor: %{http_code}\n" -H "Authorization: Bearer $COUNS"   -H "$H" $API/counselling/coordinated-care/$MAYA
curl -s -o /dev/null -w "  admin:      %{http_code}\n" -H "Authorization: Bearer $ADMIN"   -H "$H" $API/counselling/coordinated-care/$MAYA
curl -s -o /dev/null -w "  teacher:    %{http_code}\n" -H "Authorization: Bearer $TEACHER" -H "$H" $API/counselling/coordinated-care/$MAYA
curl -s -o /dev/null -w "  parent:     %{http_code}\n" -H "Authorization: Bearer $PARENT"  -H "$H" $API/counselling/coordinated-care/$MAYA
curl -s -o /dev/null -w "  student:    %{http_code}\n" -H "Authorization: Bearer $STUDENT" -H "$H" $API/counselling/coordinated-care/$MAYA
# counsellor: 200
# admin:      200
# teacher:    403
# parent:     403
# student:    403
```

---

## Scenario 8 — Mandatory report immutability (defence-in-depth)

```bash
# Rivera files SUSPECTED_NEGLECT for Ethan. Status starts at FILED; reporter_person_id
# is stamped server-side from actor.personId.
REP_RESP=$(curl -s -X POST -H "Authorization: Bearer $TEACHER" -H "$H" -H "$CT" \
  -d "{\"studentId\":\"$ETHAN\",\"reportType\":\"SUSPECTED_NEGLECT\",\"reportedToAuthority\":\"Springfield CPS\",\"reportDate\":\"2026-05-05T09:30:00Z\",\"description\":\"S8 CAT — pattern of unexcused absences and tardiness, plus disclosure of inadequate food at home. Welfare check requested.\"}" \
  $API/counselling/mandatory-reports)
S8_REP=$(echo "$REP_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
# reportId=019df757-f103-7cce-87f7-6439932844f3 status=FILED reporter=James Rivera

# Admin updates the MUTABLE fields cleanly.
curl -s -X PATCH -H "Authorization: Bearer $ADMIN" -H "$H" -H "$CT" \
  -d '{"status":"CPS_CONTACTED","cpsResponse":"S8 CAT — CPS opened case. Caseworker assigned, initial visit within 72h."}' \
  $API/counselling/mandatory-reports/$S8_REP \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('  status='+d['status']+' cpsResponse='+d['cpsResponse'][:60]+'...')"
#   status=CPS_CONTACTED cpsResponse=S8 CAT — CPS opened case. Caseworker assigned, initial visit...

# Admin tries to PATCH description (immutable core field) → 400 from the global
# ValidationPipe whitelist (UpdateMandatoryReportDto only declares status + cpsResponse).
# This is the first line of defence; the service-layer immutableFields walk is the second.
curl -s -X PATCH -H "Authorization: Bearer $ADMIN" -H "$H" -H "$CT" \
  -d '{"description":"Try to override locked field."}' \
  $API/counselling/mandatory-reports/$S8_REP
# {"message":["property description should not exist"],"error":"Bad Request","statusCode":400}
```

---

## Scenario 9 — Teacher visibility

```bash
# Rivera sees own referral with ACCEPTED status and assigned-counsellor name.
curl -s -H "Authorization: Bearer $TEACHER" -H "$H" $API/counselling/referrals/$S1_REF \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('  status='+d['status']+' assignedTo='+d['assignedCounselorName'])"
#   status=ACCEPTED assignedTo=Marcus Hayes

# Rivera GET /sessions/:id/notes → 403 (FERPA gate; teachers never hold student_counseling_record:read).
curl -s -o /dev/null -w "  notes: %{http_code}\n" -H "Authorization: Bearer $TEACHER" -H "$H" $API/counselling/sessions/$S4_SESS/notes
#   notes: 403

# Rivera GET /caseloads — sees Maya's caseload (her class student) with notes stripped
# server-side per the per-row manager check (Rivera is not the assigned counsellor of
# record so the row is non-manager; notes is stripped to null in the response DTO).
curl -s -H "Authorization: Bearer $TEACHER" -H "$H" $API/counselling/caseloads \
  | python3 -c "import json,sys;d=json.load(sys.stdin);x=[r for r in d if r['studentId']=='$MAYA'][0];print('  '+x['counselorName']+' / '+x['primaryConcern']+' / has_notes='+str(x['notes'] is not None))"
#   Marcus Hayes / SOCIAL_EMOTIONAL / has_notes=False

# Rivera GET /coordinated-care → 403 (intersection gate; teacher lacks cou-007:read).
curl -s -o /dev/null -w "  coordinated-care: %{http_code}\n" -H "Authorization: Bearer $TEACHER" -H "$H" $API/counselling/coordinated-care/$MAYA
#   coordinated-care: 403

# Rivera GET /mandatory-reports — sees ONLY own filed reports (reporter row scope).
curl -s -H "Authorization: Bearer $TEACHER" -H "$H" $API/counselling/mandatory-reports \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('  own_reports='+str(len(d)))"
#   own_reports=4   (Rivera filed 4 across CAT + previous smoke runs; admin sees more)
```

---

## Scenario 10 — Parent visibility (5 of 6 surfaces locked)

```bash
# Parent sees Maya's caseload row with notes stripped (GUARDIAN row-scope at the service layer).
curl -s -H "Authorization: Bearer $PARENT" -H "$H" $API/counselling/caseloads \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('  count='+str(len(d))+' notes='+str(d[0]['notes'] if d else None))"
#   count=1 notes=None

# Every other surface is locked for parents:
curl -s -o /dev/null -w "  /sessions/:id/notes:    %{http_code}\n" -H "Authorization: Bearer $PARENT" -H "$H" $API/counselling/sessions/$S4_SESS/notes
curl -s -o /dev/null -w "  /referrals:             %{http_code}\n" -H "Authorization: Bearer $PARENT" -H "$H" $API/counselling/referrals
curl -s -o /dev/null -w "  /coordinated-care:      %{http_code}\n" -H "Authorization: Bearer $PARENT" -H "$H" $API/counselling/coordinated-care/$MAYA
curl -s -o /dev/null -w "  /mtss/tiers:            %{http_code}\n" -H "Authorization: Bearer $PARENT" -H "$H" $API/counselling/mtss/tiers
curl -s -o /dev/null -w "  /mandatory-reports:     %{http_code}\n" -H "Authorization: Bearer $PARENT" -H "$H" $API/counselling/mandatory-reports
#   /sessions/:id/notes:    403
#   /referrals:             403
#   /coordinated-care:      403
#   /mtss/tiers:            403
#   /mandatory-reports:     403
```

The parent's only Cycle 11 surface is the caseload assignment row (counsellor name + concern) — every other surface 403s at the gate. This matches the plan's parent-visibility contract exactly: parents see who is counselling their child but nothing about the content of that counselling.

---

## Cleanup — restore tenant_demo to post-Step-4 seed shape

```sql
SET search_path = tenant_demo;

-- S1 + S2 referral and its activity
DELETE FROM svc_referral_activity WHERE referral_id='<S1_REF>';
DELETE FROM svc_referrals WHERE id='<S1_REF>';

-- S4 session + its FERPA note
DELETE FROM svc_session_notes WHERE id='<S4_NOTE>';
DELETE FROM svc_sessions WHERE id='<S4_SESS>';

-- S6 MTSS tier — CASCADE drops the linked intervention which CASCADEs to progress.
DELETE FROM svc_mtss_tiers WHERE id='<S6_TIER>';

-- S7 coordinated care note
DELETE FROM svc_coordinated_care_notes WHERE note_text LIKE 'S7 CAT%';

-- S8 mandatory report (and any prior smoke residue)
DELETE FROM svc_mandatory_reports WHERE description LIKE 'S8 CAT%' OR description LIKE 'Smoke%';
```

After cleanup:

```
caseloads=1 BIP_with_caseload=1 referrals=1 activity=1 types=2
sessions=2 notes=2 (note1 is_locked=false)
tiers=1 interventions=1 progress=1 care_notes=1 reports=0
```

This matches the post-Step-4 seed shape exactly. The next CAT run starts on the same fresh ground.

---

## Reviewer attention items (non-blocking, deferred to post-cycle review or Wave 2 Phase 2)

1. **Counsellor / Nurse / Lead-counsellor role split** — the demo Staff role (covering counsellor + VP + nurse) currently grants every COU code + every HLT code. The intersection gate fires correctly today because admin + Staff both hold both codes, but **before pilot** the Staff role should split into a dedicated Counsellor (no HLT-001:write — so a COUNSELLOR-role coordinated-care note from a counsellor can't accidentally pass the role-vs-perm validator under the NURSE branch) and Nurse (no COU-007:write or COU-001:write) so the role-validation path is exercised correctly. Joins the Cycle 9 + Cycle 10 punch list items already in the Wave 2 Phase 2 backlog.
2. **Mandatory report retention policy at the audit layer** — `svc_mandatory_reports.student_id → sis_students(id) NO ACTION` enforces the schema-side "retained permanently" invariant; an admin trying to delete a student with mandatory reports gets a clean refuse. The full retention policy story (S3 archive bucket / 7-year minimum / state-by-state variation) is out of scope for the application layer and lives in the operational docs.
3. **Coordinated care notes — soft `author_person_id` ref**. Per ADR-001/020 the column is a soft ref to `platform.iam_person(id)` with no DB-enforced FK. The Step 7 service stamps it from `actor.personId` so caller input on that field is a no-op. A future-cycle `platform_reference_health` job would track these soft refs for orphan detection.
4. **No dedicated CAT for the Step 9 Student Counselling tab** — the plan §09 lists a 5th surface (composition view of caseload + MTSS + sessions + coordinated-care + linked BIP on the existing student profile) which the Step 8 + 9 routes already cover individually. A polish-pass tab adding the composition is reasonable post-CAT.
5. **Wellbeing check-ins (6 tables) deferred to Cycle 11.1** — the M27 module ships a self-contained student-facing pulse-survey + auto-alert sub-system that is intentionally out of Cycle 11 scope.

**Cycle 11 ships clean to the post-cycle architecture review. All 10 plan scenarios passed live on `tenant_demo` 2026-05-05 against the Step 9 build.**
