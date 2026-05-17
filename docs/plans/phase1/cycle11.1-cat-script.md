# Cycle 11.1 CAT — Wellbeing Check-Ins

**Status:** verified live on `tenant_demo` 2026-05-05 against the Step 7 build (commit at HEAD of `main`). All 10 plan scenarios pass. Two ADR-057 wire envelopes captured live (`svc.wellbeing.alert.created` × 2 — one with `autoEscalate=false` for Maya's WANTS_TO_TALK, one with `autoEscalate=true` for the SELF_HARM_INDICATOR keystone).

**Vertical slice:** Hayes (counsellor) creates a "S8 CAT — Daily Pulse" template with 5 questions across Emotional / Social / Safety domains (UNIQUE(school, name) keystone catches a duplicate-name attempt with the conflicting template id in a friendly 400) → Hayes deploys to her CASELOAD (auto-resolves Maya as the only active-caseload student for Hayes) and activates: the audience-resolution + bulk-INSERT keystone fires, planting one PENDING `svc_wellbeing_checkins` row for Maya with `total_targeted=1`; double-activate is rejected with the lifecycle guard → **THE FIRST STUDENT-INPUT KEYSTONE** Maya submits her check-in with Q3 SAFETY/YES_NO=YES ("Do you want to talk to a counsellor?"); the alert evaluation runs inside the same transaction, stamps `completed_at` + `flagged_for_follow_up=true`, INSERTs the matching `svc_wellbeing_responses` rows, creates a WANTS_TO_TALK alert linked to the Q3 response, and emits `svc.wellbeing.alert.created` outside the tx — **envelope captured live with `autoEscalate=false`** → **THE SAFETY KEYSTONE** Hayes deploys a second instance to Ethan via CUSTOM_LIST; admin submits on Ethan's behalf with Q4 SAFETY/SCALE_1_5=1 (the lowest rating); the alert evaluator's precedence rule fires SELF_HARM_INDICATOR (winning over FEELS_UNSAFE on the same response) and **the wire envelope shows `autoEscalate=true`** — the unconditional auto-escalation path for self-harm indicators is verified live → Hayes acknowledges Maya's WANTS_TO_TALK alert (the multi-column `acknowledged_chk` lockstep is satisfied atomically with `status='ACKNOWLEDGED' AND acknowledged_by NOT NULL AND acknowledged_at NOT NULL`); admin resolves with notes; re-resolve attempt rejected → student-visibility row scope verified live (Maya sees only her own 2 check-ins; tries to read Ethan's check-in → 404 don't-leak-existence; tries `/alerts` → 403 service-layer counsellor+admin-only); teacher-visibility stripped-DTO contract verified (Rivera GETs the list and every row has `studentId=''`, `studentName=null`, `assignedCounselorId=null`, `flaggedForFollowUp=false` — aggregated trend access only, no individual-student data; per-detail `/checkins/:id` returns 403; alert queue 403; template POST 403); parent-visibility verified locked out at the gate (David Chen's account holds no `cou-004:*` permission so every wellbeing surface returns 403 INSUFFICIENT_PERMISSIONS — wellbeing data is student-counsellor confidential per the plan); counsellor-full-detail verified (Hayes sees the full check-in DTO with responses + flagged + alert visibility scoped to her caseload — sees Maya's 2 alerts but not Ethan's SHI; admin sees school-wide queue with severity-sort placing SELF_HARM_INDICATOR first).

**Pre-conditions:**

- `pnpm seed` + the full Cycle 1–11 + Cycle 11.1 seed pipeline run on `tenant_demo` (the `seed:wellbeing` step is the relevant Cycle 11.1 addition).
- `tsx src/build-cache.ts` rebuilt the IAM cache. 7 personas:
  - admin / principal: 450 perms (every code × every tier via everyFunction)
  - counsellor / vp: 49 perms (Staff role — full COU-001..007 read+write + `student_counseling_record:read` + **`cou-004:read+write`** added by Step 3)
  - teacher: 47 perms (incl. **`cou-004:read`** for aggregated wellbeing trends; service strips identity for non-counsellor readers)
  - student: 20 perms (incl. **`cou-004:read`** — the first student-input permission in the platform)
  - parent: 23 perms (no `cou-004:*` — wellbeing data is student-counsellor confidential)
- `dev.svc.wellbeing.alert.created` Kafka topic pre-created via `kafka-topics.sh --create --if-not-exists` to dodge the auto-creation race documented in Cycles 3 + 5.
- API running on `localhost:4000` from `pnpm --filter @campusos/api build && node apps/api/dist/main.js`.

## Schema preamble (8 checks)

```sql
-- 1. Tenant logical base table count after Cycle 11.1 (2 schema migrations on top of Cycle 11)
SELECT COUNT(*) FROM information_schema.tables t
WHERE table_schema='tenant_demo' AND table_type='BASE TABLE'
  AND NOT EXISTS (
    SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = t.table_schema AND c.relname = t.table_name
  );
-- expected: 175

-- 2. Cycle 11.1 wellbeing tables: 3 from Step 1 (templates / questions / deployments)
--    + 3 from Step 2 (checkins / responses / alerts) = 6
SELECT COUNT(*) FROM information_schema.tables
WHERE table_schema='tenant_demo' AND table_name LIKE 'svc_wellbeing_%';
-- expected: 6

-- 3. 13 intra-tenant FKs across Cycle 11.1 wellbeing tables (4 from Step 1 + 9 from Step 2)
SELECT COUNT(*) FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE c.contype='f' AND n.nspname='tenant_demo' AND t.relname LIKE 'svc_wellbeing_%';
-- expected: 13

-- 4. 0 cross-schema FKs across all Cycle 11.1 wellbeing tables (per ADR-001/020)
SELECT COUNT(*) FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_class ft ON ft.oid = c.confrelid
JOIN pg_namespace fn ON fn.oid = ft.relnamespace
WHERE c.contype='f' AND n.nspname='tenant_demo'
  AND t.relname LIKE 'svc_wellbeing_%' AND fn.nspname <> 'tenant_demo';
-- expected: 0

-- 5. IAM catalogue — 450 permissions (Cycle 11.1 reuses the existing COU-004 entry; no catalogue edit required).
SELECT COUNT(*) FROM platform.permissions;
-- expected: 450

-- 6. COU-004 grant distribution after Step 3 IAM updates.
--    read: admin + principal + vp + counsellor + teacher + student = 6 personas.
--    write: admin + principal + vp + counsellor = 4 personas.
SELECT
  (SELECT COUNT(*) FROM platform.iam_effective_access_cache WHERE 'cou-004:read'  = ANY(permission_codes)) AS reads,
  (SELECT COUNT(*) FROM platform.iam_effective_access_cache WHERE 'cou-004:write' = ANY(permission_codes)) AS writes;
-- expected: reads=6 writes=4

-- 7. Parent intentionally NOT granted COU-004 — wellbeing data is student-counsellor confidential.
SELECT COUNT(*) FROM platform.iam_effective_access_cache eac
JOIN platform.platform_users pu ON pu.id = eac.account_id
WHERE pu.email='parent@demo.campusos.dev'
  AND 'cou-004:read' = ANY(eac.permission_codes);
-- expected: 0

-- 8. Step 3 seed shape on tenant_demo (post-seed, pre-CAT — the cleanup section restores this).
SELECT
  (SELECT COUNT(*) FROM tenant_demo.svc_wellbeing_survey_templates) AS templates,    -- 1
  (SELECT COUNT(*) FROM tenant_demo.svc_wellbeing_questions)        AS questions,    -- 5
  (SELECT COUNT(*) FROM tenant_demo.svc_wellbeing_deployments)      AS deployments,  -- 1
  (SELECT COUNT(*) FROM tenant_demo.svc_wellbeing_checkins)         AS checkins,     -- 2 (1 completed Maya + 1 pending Ethan)
  (SELECT COUNT(*) FROM tenant_demo.svc_wellbeing_responses)        AS responses,    -- 5
  (SELECT COUNT(*) FROM tenant_demo.svc_wellbeing_alerts)           AS alerts;       -- 1 (ACKNOWLEDGED WANTS_TO_TALK)
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
```

---

## Scenario 1 — Hayes creates a template; UNIQUE(school, name) catches duplicate

```bash
RESP=$(curl -s -X POST -H "Authorization: Bearer $COUNS" -H "$H" -H "$CT" \
  -d '{"name":"S8 CAT — Daily Pulse","description":"Vertical-slice CAT walkthrough template.",
       "frequencyRecommendation":"DAILY","questions":[
         {"questionText":"How are you feeling today?","questionType":"SCALE_1_5","domain":"EMOTIONAL","sortOrder":1},
         {"questionText":"Do you feel connected to your peers?","questionType":"YES_NO","domain":"SOCIAL","sortOrder":2},
         {"questionText":"Do you want to talk to a counsellor?","questionType":"YES_NO","domain":"SAFETY","sortOrder":3},
         {"questionText":"How safe do you feel at school?","questionType":"SCALE_1_5","domain":"SAFETY","sortOrder":4},
         {"questionText":"Pick an emoji for your day:","questionType":"EMOJI_SCALE","domain":"EMOTIONAL","sortOrder":5}
       ]}' \
  $API/counselling/wellbeing/templates)
S8_TPL=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

echo "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin);print('  questions='+str(len(d['questions']))+' frequency='+d['frequencyRecommendation']+' isActive='+str(d['isActive']))"
# Output:
#   questions=5 frequency=DAILY isActive=True

# Verify ordered-by-sort_order on the inlined questions
echo "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin);[print('  Q'+str(q['sortOrder'])+' ['+q['domain']+'/'+q['questionType']+'] '+q['questionText']) for q in sorted(d['questions'], key=lambda x:x['sortOrder'])]"
#   Q1 [EMOTIONAL/SCALE_1_5] How are you feeling today?
#   Q2 [SOCIAL/YES_NO] Do you feel connected to your peers?
#   Q3 [SAFETY/YES_NO] Do you want to talk to a counsellor?           ← WANTS_TO_TALK trigger
#   Q4 [SAFETY/SCALE_1_5] How safe do you feel at school?              ← SELF_HARM_INDICATOR trigger when score=1
#   Q5 [EMOTIONAL/EMOJI_SCALE] Pick an emoji for your day:

# Duplicate name — UNIQUE(school_id, name) keystone fires
curl -s -X POST -H "Authorization: Bearer $COUNS" -H "$H" -H "$CT" \
  -d '{"name":"S8 CAT — Daily Pulse","description":"dup",
       "frequencyRecommendation":"DAILY","questions":[
         {"questionText":"x","questionType":"SCALE_1_5","domain":"EMOTIONAL","sortOrder":1}]}' \
  $API/counselling/wellbeing/templates
# {"statusCode":400,"message":"A wellbeing survey template named \"S8 CAT — Daily Pulse\" already exists in this school"}
```

---

## Scenario 2 — Hayes deploys to CASELOAD + activate keystone

```bash
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
RESP=$(curl -s -X POST -H "Authorization: Bearer $COUNS" -H "$H" -H "$CT" \
  -d "{\"templateId\":\"$S8_TPL\",\"deployAt\":\"$NOW\",\"targetType\":\"CASELOAD\"}" \
  $API/counselling/wellbeing/deployments)
S8_DEP=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin);print('  status='+d['status']+' targetType='+d['targetType']+' totalTargeted='+str(d.get('totalTargeted'))+' totalCompleted='+str(d.get('totalCompleted')))"
#   status=SCHEDULED targetType=CASELOAD totalTargeted=None totalCompleted=None

# THE ACTIVATE KEYSTONE: locks deployment row, resolves CASELOAD audience to Hayes's
# active caseload students (Maya only), bulk-INSERTs svc_wellbeing_checkins,
# stamps total_targeted, flips status SCHEDULED → ACTIVE — all in one tx.
curl -s -X PATCH -H "Authorization: Bearer $COUNS" -H "$H" -H "$CT" -d '{}' \
  $API/counselling/wellbeing/deployments/$S8_DEP/activate \
  | python3 -c "import json,sys;d=json.load(sys.stdin);dep=d['deployment'];print('  status='+dep['status']+' totalTargeted='+str(dep['totalTargeted'])+' checkinsCreated='+str(d['checkinsCreated']))"
#   status=ACTIVE totalTargeted=1 checkinsCreated=1

# Verify the schema state — Maya now has a PENDING check-in
q "SELECT 'maya_pending_checkin='||(SELECT COUNT(*) FROM svc_wellbeing_checkins WHERE student_id='$MAYA' AND deployment_id='$S8_DEP' AND completed_at IS NULL)"
# maya_pending_checkin=1

# Double-activate guard — only SCHEDULED → ACTIVE is allowed
curl -s -X PATCH -H "Authorization: Bearer $COUNS" -H "$H" -H "$CT" -d '{}' \
  $API/counselling/wellbeing/deployments/$S8_DEP/activate
# {"statusCode":400,"message":"Deployment is in status ACTIVE; only SCHEDULED can be activated"}
```

---

## Scenario 3 — Maya submits her check-in (the first student-input keystone)

```bash
S8_CKIN_MAYA=$(q "SELECT id FROM svc_wellbeing_checkins WHERE student_id='$MAYA' AND deployment_id='$S8_DEP' AND completed_at IS NULL")

# Resolve question ids by sort order
Q1=$(q "SELECT id FROM svc_wellbeing_questions WHERE template_id='$S8_TPL' AND sort_order=1")  # EMOTIONAL/SCALE_1_5
Q2=$(q "SELECT id FROM svc_wellbeing_questions WHERE template_id='$S8_TPL' AND sort_order=2")  # SOCIAL/YES_NO
Q3=$(q "SELECT id FROM svc_wellbeing_questions WHERE template_id='$S8_TPL' AND sort_order=3")  # SAFETY/YES_NO ← trigger
Q4=$(q "SELECT id FROM svc_wellbeing_questions WHERE template_id='$S8_TPL' AND sort_order=4")  # SAFETY/SCALE_1_5
Q5=$(q "SELECT id FROM svc_wellbeing_questions WHERE template_id='$S8_TPL' AND sort_order=5")  # EMOTIONAL/EMOJI_SCALE

# Maya — STUDENT-FACING SUBMIT — Q3 SAFETY/YES_NO=YES (1) is the WANTS_TO_TALK trigger.
curl -s -X POST -H "Authorization: Bearer $STUDENT" -H "$H" -H "$CT" \
  -d "{\"responses\":[
    {\"questionId\":\"$Q1\",\"numericResponse\":3},
    {\"questionId\":\"$Q2\",\"numericResponse\":1},
    {\"questionId\":\"$Q3\",\"numericResponse\":1},
    {\"questionId\":\"$Q4\",\"numericResponse\":4},
    {\"questionId\":\"$Q5\",\"numericResponse\":3}
  ]}" \
  $API/counselling/wellbeing/checkins/$S8_CKIN_MAYA/submit > /dev/null

# Verify schema state — completed_at + flagged + 5 responses + total_completed bumped, all in one tx.
q "SELECT 'maya_responses='||(SELECT COUNT(*) FROM svc_wellbeing_responses WHERE checkin_id='$S8_CKIN_MAYA')"
# maya_responses=5
q "SELECT 'flagged='||flagged_for_follow_up::text||' completed='||(completed_at IS NOT NULL)::text FROM svc_wellbeing_checkins WHERE id='$S8_CKIN_MAYA'"
# flagged=true completed=true
q "SELECT 'deployment_total_completed='||total_completed FROM svc_wellbeing_deployments WHERE id='$S8_DEP'"
# deployment_total_completed=1
```

---

## Scenario 4 — `svc.wellbeing.alert.created` envelope captured live (WANTS_TO_TALK)

```bash
# WANTS_TO_TALK alert created in same tx as the response INSERTs.
q "SELECT 'maya_alert: type='||alert_type||' status='||status||' response_id='||response_id FROM svc_wellbeing_alerts WHERE student_id='$MAYA' ORDER BY created_at DESC LIMIT 1"
# maya_alert: type=WANTS_TO_TALK status=NEW response_id=<Q3-row-id>

# Capture the wire envelope on dev.svc.wellbeing.alert.created
docker exec campusos-kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic dev.svc.wellbeing.alert.created \
  --from-beginning --timeout-ms 4000 2>/dev/null \
  | python3 -c "
import json, sys
events = []
for line in sys.stdin:
    line = line.strip()
    if line:
        try: events.append(json.loads(line))
        except: pass
maya_wtt = [e for e in events if e['payload']['studentId']=='$MAYA' and e['payload']['alertType']=='WANTS_TO_TALK']
print(json.dumps(maya_wtt[-1], indent=2))
"
```

**`svc.wellbeing.alert.created` envelope captured live** with full ADR-057 shape:

```json
{
  "event_id": "019df7f2-a84c-7113-83dc-40df2d1fde60",
  "event_type": "svc.wellbeing.alert.created",
  "event_version": 1,
  "occurred_at": "2026-05-05T11:42:48.396Z",
  "published_at": "2026-05-05T11:42:48.396Z",
  "tenant_id": "019dc92b-ea59-7bb7-aa7f-929729562010",
  "source_module": "wellbeing",
  "correlation_id": "019df7f2-a84c-7113-83dc-4cd0c0adc7f9",
  "payload": {
    "alertType": "WANTS_TO_TALK",
    "sourceRefId": "019df7f2-a846-7113-83dc-20f93e5e4701",
    "schoolId": "019dc92b-ea59-7bb7-aa7f-929729562010",
    "studentId": "019dd544-7e06-777b-94e8-2e3304310985",
    "checkinId": "019df7f1-d293-7113-83db-a9a412c21df8",
    "responseId": "019df7f2-a846-7113-83dc-20f93e5e4701",
    "questionId": "019df7ed-53c2-7113-83da-67d486a799fb",
    "questionText": "Do you want to talk to a counsellor?",
    "autoEscalate": false,
    "submittedByAccountId": "019dc92d-0887-7442-abf5-f3161367aa88"
  }
}
```

`autoEscalate=false` is correct here — WANTS_TO_TALK is a non-emergency alert; only SELF_HARM_INDICATOR carries `autoEscalate=true`.

---

## Scenario 5 — SELF_HARM_INDICATOR keystone (autoEscalate=true)

```bash
# Hayes deploys a fresh CUSTOM_LIST instance for Ethan and activates.
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
RESP=$(curl -s -X POST -H "Authorization: Bearer $COUNS" -H "$H" -H "$CT" \
  -d "{\"templateId\":\"$S8_TPL\",\"deployAt\":\"$NOW\",\"targetType\":\"CUSTOM_LIST\",\"targetIds\":[\"$ETHAN\"]}" \
  $API/counselling/wellbeing/deployments)
S8_DEP2=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s -X PATCH -H "Authorization: Bearer $COUNS" -H "$H" -H "$CT" -d '{}' \
  $API/counselling/wellbeing/deployments/$S8_DEP2/activate \
  | python3 -c "import json,sys;d=json.load(sys.stdin);dep=d['deployment'];print('  activate: status='+dep['status']+' totalTargeted='+str(dep['totalTargeted'])+' checkinsCreated='+str(d['checkinsCreated']))"
#   activate: status=ACTIVE totalTargeted=1 checkinsCreated=1

S8_CKIN_ETHAN=$(q "SELECT id FROM svc_wellbeing_checkins WHERE student_id='$ETHAN' AND deployment_id='$S8_DEP2' AND completed_at IS NULL")

# Admin submits on Ethan's behalf with Q4 SAFETY/SCALE_1_5=1 (the lowest rating).
# Per the alert-evaluation precedence rule, SAFETY/SCALE_1_5+numeric=1 fires
# SELF_HARM_INDICATOR; SELF_HARM_INDICATOR takes precedence over FEELS_UNSAFE on the
# same response, so a single SAFETY/SCALE_1_5+numeric=1 row creates exactly one
# alert (SHI), not two.
curl -s -X POST -H "Authorization: Bearer $ADMIN" -H "$H" -H "$CT" \
  -d "{\"responses\":[
    {\"questionId\":\"$Q1\",\"numericResponse\":2},
    {\"questionId\":\"$Q2\",\"numericResponse\":0},
    {\"questionId\":\"$Q3\",\"numericResponse\":0},
    {\"questionId\":\"$Q4\",\"numericResponse\":1},
    {\"questionId\":\"$Q5\",\"numericResponse\":1}
  ]}" \
  $API/counselling/wellbeing/checkins/$S8_CKIN_ETHAN/submit > /dev/null

q "SELECT 'ethan_alert: type='||alert_type||' status='||status FROM svc_wellbeing_alerts WHERE student_id='$ETHAN' ORDER BY created_at DESC LIMIT 1"
# ethan_alert: type=SELF_HARM_INDICATOR status=NEW

# Capture the wire envelope; verify autoEscalate=true on the SHI payload.
docker exec campusos-kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic dev.svc.wellbeing.alert.created \
  --from-beginning --timeout-ms 4000 2>/dev/null \
  | python3 -c "
import json, sys
events = []
for line in sys.stdin:
    line = line.strip()
    if line:
        try: events.append(json.loads(line))
        except: pass
ethan_shi = [e for e in events if e['payload']['studentId']=='$ETHAN' and e['payload']['alertType']=='SELF_HARM_INDICATOR']
e = ethan_shi[-1]
p = e['payload']
print('  alertType='+p['alertType']+' autoEscalate='+str(p['autoEscalate']))
print('  questionText='+p['questionText'])
"
#   alertType=SELF_HARM_INDICATOR autoEscalate=True
#   questionText=How safe do you feel at school?
```

**The SELF_HARM_INDICATOR auto-escalation contract is verified live.** `autoEscalate=true` on the wire envelope is the unconditional escalation signal — a future Cycle 3 NotificationConsumer wiring against this topic will fan out IN_APP + EMAIL notifications to the school administrator AND the assigned counsellor (the consumer is deferred per the plan; the emit lands cleanly today and the consumer can subscribe without any producer change).

---

## Scenario 6 — Alert triage NEW → ACKNOWLEDGED → RESOLVED

```bash
S8_ALERT_WTT=$(q "SELECT id FROM svc_wellbeing_alerts WHERE student_id='$MAYA' AND alert_type='WANTS_TO_TALK' AND status='NEW' ORDER BY created_at DESC LIMIT 1")

# Hayes acknowledges. AlertService stamps both ack_by + ack_at atomically per the
# multi-column acknowledged_chk lockstep — NEW requires both NULL, non-NEW requires
# both NOT NULL; the schema CHECK rejects any mid-flight half-state.
curl -s -X PATCH -H "Authorization: Bearer $COUNS" -H "$H" -H "$CT" -d '{}' \
  $API/counselling/wellbeing/alerts/$S8_ALERT_WTT/acknowledge \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('  status='+d['status']+' acknowledgedByName='+str(d.get('acknowledgedByName')))"
#   status=ACKNOWLEDGED acknowledgedByName=Marcus Hayes

q "SELECT 'lockstep: status='||status||' has_ack_by='||(acknowledged_by IS NOT NULL)::text||' has_ack_at='||(acknowledged_at IS NOT NULL)::text FROM svc_wellbeing_alerts WHERE id='$S8_ALERT_WTT'"
# lockstep: status=ACKNOWLEDGED has_ack_by=true has_ack_at=true

# Admin resolves with notes.
curl -s -X PATCH -H "Authorization: Bearer $PRINCIPAL" -H "$H" -H "$CT" \
  -d '{"resolutionNotes":"S8 CAT — Hayes met with Maya 2026-05-06. Established 1:1 weekly cadence. No safety concerns."}' \
  $API/counselling/wellbeing/alerts/$S8_ALERT_WTT/resolve \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('  status='+d['status']+' resolutionNotes='+d['resolutionNotes'][:60]+'...')"
#   status=RESOLVED resolutionNotes=S8 CAT — Hayes met with Maya 2026-05-06...

# Re-resolve attempt — terminal state guard
curl -s -X PATCH -H "Authorization: Bearer $PRINCIPAL" -H "$H" -H "$CT" \
  -d '{"resolutionNotes":"redo"}' \
  $API/counselling/wellbeing/alerts/$S8_ALERT_WTT/resolve
# {"statusCode":400,"message":"Alert is already RESOLVED"}
```

---

## Scenario 7 — Maya student visibility (own-only row scope)

```bash
# Maya GET /checkins → sees only her own (the row scope at the service layer
# resolves actor.personId → platform_students → sis_students → student_id IN (...)).
curl -s -H "Authorization: Bearer $STUDENT" -H "$H" $API/counselling/wellbeing/checkins \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
own_only = all(c['studentId']=='$MAYA' for c in d)
print('  count='+str(len(d))+' all_own='+str(own_only))
"
#   count=2 all_own=True

# Maya GET /alerts → 403. Counsellor + admin only at the service layer; students never
# see alert state — the counsellor initiates any follow-up conversation naturally.
curl -s -o /dev/null -w "  /alerts: %{http_code}\n" -H "Authorization: Bearer $STUDENT" -H "$H" $API/counselling/wellbeing/alerts
#   /alerts: 403

# Maya tries to read Ethan's check-in by guessing the URL → 404 (don't-leak-existence
# row scope, not 403, so a non-target student can't even confirm the check-in exists).
curl -s -o /dev/null -w "  /checkins/<ethan>: %{http_code}\n" -H "Authorization: Bearer $STUDENT" -H "$H" $API/counselling/wellbeing/checkins/$S8_CKIN_ETHAN
#   /checkins/<ethan>: 404
```

---

## Scenario 8 — Teacher visibility (aggregated trends, identity stripped)

```bash
# Teacher GET /checkins — sees rows but every row's identity-bearing fields are
# stripped server-side (studentId='', studentName=null, assignedCounselorId=null,
# flaggedForFollowUp=false). Aggregated trend access only — no individual-student data.
curl -s -H "Authorization: Bearer $TEACHER" -H "$H" $API/counselling/wellbeing/checkins \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('  count='+str(len(d)))
if d:
    s = d[0]
    print('  sample shape:')
    print('    studentId='+repr(s.get('studentId'))+'  (stripped to empty string)')
    print('    studentName='+repr(s.get('studentName'))+'  (stripped to null)')
    print('    assignedCounselorId='+repr(s.get('assignedCounselorId'))+'  (stripped to null)')
    print('    flaggedForFollowUp='+repr(s.get('flaggedForFollowUp'))+'  (stripped to false)')
    print('    templateName='+repr(s.get('templateName'))+'  (kept — non-PII trend metadata)')
"
#   count=4
#   sample shape:
#     studentId=''  (stripped to empty string)
#     studentName=None  (stripped to null)
#     assignedCounselorId=None  (stripped to null)
#     flaggedForFollowUp=False  (stripped to false)
#     templateName='Weekly Emotional Check-In'  (kept — non-PII trend metadata)

# Per-detail and alert queue blocked at the service layer.
curl -s -o /dev/null -w "  /checkins/:id: %{http_code}\n" -H "Authorization: Bearer $TEACHER" -H "$H" $API/counselling/wellbeing/checkins/$S8_CKIN_MAYA
#   /checkins/:id: 403
curl -s -o /dev/null -w "  /alerts:       %{http_code}\n" -H "Authorization: Bearer $TEACHER" -H "$H" $API/counselling/wellbeing/alerts
#   /alerts:       403

# Templates POST → 403 (counsellor + admin only at the service layer via hasCounsellorScope).
curl -s -X POST -H "Authorization: Bearer $TEACHER" -H "$H" -H "$CT" \
  -d '{"name":"unauthorized","frequencyRecommendation":"DAILY","questions":[]}' \
  $API/counselling/wellbeing/templates
# {"statusCode":403,"message":"You do not have the required permission for this action"}
```

---

## Scenario 9 — Parent denied at the gate (no `cou-004:*` permission)

```bash
# Parent (David Chen) holds zero cou-004:* permissions. Every wellbeing surface
# returns 403 INSUFFICIENT_PERMISSIONS at the PermissionGuard before reaching any
# service-layer logic — wellbeing data is student-counsellor confidential per the
# Cycle 11.1 plan.
curl -s -o /dev/null -w "  /templates:    %{http_code}\n" -H "Authorization: Bearer $PARENT" -H "$H" $API/counselling/wellbeing/templates
curl -s -o /dev/null -w "  /deployments:  %{http_code}\n" -H "Authorization: Bearer $PARENT" -H "$H" $API/counselling/wellbeing/deployments
curl -s -o /dev/null -w "  /checkins:     %{http_code}\n" -H "Authorization: Bearer $PARENT" -H "$H" $API/counselling/wellbeing/checkins
curl -s -o /dev/null -w "  /checkins/:id: %{http_code}\n" -H "Authorization: Bearer $PARENT" -H "$H" $API/counselling/wellbeing/checkins/$S8_CKIN_MAYA
curl -s -o /dev/null -w "  /alerts:       %{http_code}\n" -H "Authorization: Bearer $PARENT" -H "$H" $API/counselling/wellbeing/alerts
#   /templates:    403
#   /deployments:  403
#   /checkins:     403
#   /checkins/:id: 403
#   /alerts:       403
```

---

## Scenario 10 — Counsellor + admin full detail (caseload row scope vs school-wide)

```bash
# Hayes GET full check-in detail — sees responses + flagged + alert visibility.
curl -s -H "Authorization: Bearer $COUNS" -H "$H" $API/counselling/wellbeing/checkins/$S8_CKIN_MAYA \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('  templateName='+d['templateName']+' studentName='+d['studentName']+' flaggedForFollowUp='+str(d['flaggedForFollowUp'])+' responses='+str(len(d.get('responses',[])))+' completed='+str(d.get('completedAt') is not None))
"
#   templateName=S8 CAT — Daily Pulse studentName=Maya Chen flaggedForFollowUp=True responses=5 completed=True

# Hayes alert queue — caseload row scope (Maya only; Hayes is not Ethan's counsellor).
curl -s -H "Authorization: Bearer $COUNS" -H "$H" $API/counselling/wellbeing/alerts \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
maya = sum(1 for a in d if a['studentName']=='Maya Chen')
ethan = sum(1 for a in d if a['studentName']=='Ethan Rodriguez')
print('  count='+str(len(d))+'  maya_alerts='+str(maya)+'  ethan_alerts='+str(ethan))
"
#   count=2  maya_alerts=2  ethan_alerts=0

# Admin alert queue — school-wide; severity-sorted via SQL CASE so SELF_HARM_INDICATOR
# is always first regardless of created_at.
curl -s -H "Authorization: Bearer $PRINCIPAL" -H "$H" $API/counselling/wellbeing/alerts \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
shi = sum(1 for a in d if a['alertType']=='SELF_HARM_INDICATOR')
wtt = sum(1 for a in d if a['alertType']=='WANTS_TO_TALK')
print('  count='+str(len(d))+'  SHI='+str(shi)+'  WANTS_TO_TALK='+str(wtt))
print('  first_alert_type='+d[0]['alertType']+'  (SQL CASE places SELF_HARM_INDICATOR first)')
"
#   count=3  SHI=1  WANTS_TO_TALK=2
#   first_alert_type=SELF_HARM_INDICATOR  (SQL CASE places SELF_HARM_INDICATOR first)
```

---

## Cleanup — restore tenant_demo to post-Step-3 seed shape

The cleanup walks the CAT graph in reverse — alerts whose `response_id` points at a CAT response → responses linked to CAT check-ins → CAT check-ins → CAT deployments → CAT questions → the CAT template. Anchoring on `response_id` (not on a date filter) means the seeded WANTS_TO_TALK alert stays intact even if the CAT runs on the same day as the seed.

```sql
SET search_path = tenant_demo;

-- (1) Alerts: anchored on response_id pointing at CAT-template responses.
DELETE FROM svc_wellbeing_alerts
 WHERE response_id IN (
   SELECT r.id FROM svc_wellbeing_responses r
   JOIN svc_wellbeing_checkins c ON c.id = r.checkin_id
   JOIN svc_wellbeing_deployments d ON d.id = c.deployment_id
   JOIN svc_wellbeing_survey_templates t ON t.id = d.template_id
   WHERE t.name = 'S8 CAT — Daily Pulse'
 );

-- (2) Responses on CAT check-ins.
DELETE FROM svc_wellbeing_responses
 WHERE checkin_id IN (
   SELECT id FROM svc_wellbeing_checkins WHERE deployment_id IN (
     SELECT id FROM svc_wellbeing_deployments
     WHERE template_id IN (SELECT id FROM svc_wellbeing_survey_templates WHERE name='S8 CAT — Daily Pulse')
   )
 );

-- (3) CAT check-ins.
DELETE FROM svc_wellbeing_checkins
 WHERE deployment_id IN (
   SELECT id FROM svc_wellbeing_deployments
   WHERE template_id IN (SELECT id FROM svc_wellbeing_survey_templates WHERE name='S8 CAT — Daily Pulse')
 );

-- (4) CAT deployments (CASELOAD + CUSTOM_LIST).
DELETE FROM svc_wellbeing_deployments
 WHERE template_id IN (SELECT id FROM svc_wellbeing_survey_templates WHERE name='S8 CAT — Daily Pulse');

-- (5) CAT questions.
DELETE FROM svc_wellbeing_questions
 WHERE template_id IN (SELECT id FROM svc_wellbeing_survey_templates WHERE name='S8 CAT — Daily Pulse');

-- (6) CAT template.
DELETE FROM svc_wellbeing_survey_templates WHERE name='S8 CAT — Daily Pulse';
```

After cleanup the tenant returns to the post-Step-3 seed shape exactly:

```
templates=1 questions=5 deployments=1 checkins=2 responses=5 alerts=1
```

This matches the post-Step-3 seed shape exactly. The next CAT run starts on the same fresh ground.

---

## Reviewer attention items (non-blocking, deferred to post-cycle review or Wave 2 Phase 2)

1. **Cycle 3 NotificationConsumer wiring on `svc.wellbeing.alert.created`** — the emit lands cleanly on Kafka with the full payload (alertType / autoEscalate / studentId / checkinId / responseId / questionId / questionText / submittedByAccountId), but no consumer fans it out to IN_APP / EMAIL today. The plan explicitly defers this; SHI alerts in production should page the school administrator AND the assigned counsellor on top of the wire emit. The consumer can subscribe without any producer change — pattern matches the Cycle 5 CoverageConsumer or Cycle 6 PaymentAccountWorker.
2. **Student-visible `flaggedForFollowUp` field on `/checkins/:id`** — the API today returns `flaggedForFollowUp=true` to the student who owns the check-in. The Step 7 student UI page intentionally does NOT render this field per the documented contract ("Students never see the flagged status or alert rows — the counsellor initiates any follow-up conversation naturally without surfacing the technical flag to the student"). A custom client could still read it via the API; tightening the response shape to strip `flaggedForFollowUp` for STUDENT actors at the service layer is a small Phase 2 polish.
3. **SIGNIFICANT_SCORE_DROP and PERSISTENT_LOW_SCORE alerts** — the schema accepts both values but no service generates them this cycle (they require historical comparison across deployments). The 5-type alert system ships forward-compatible; a future cycle can add the longitudinal evaluator without a migration.
4. **YEAR_GROUP audience-resolution path** — the `DeploymentService.resolveAudience` helper has YEAR_GROUP wired with the `_schoolId` parameter intentionally retained for the future shape, but the current path returns 400 deferred. Schools pinning year-group conventions can land this in Phase 2 without changing the deployment shape on the wire.
5. **Scheduled deployment auto-activation** — manual activation only this cycle; the plan defers the cron / worker that flips SCHEDULED → ACTIVE at `deploy_at`. The schema's `deploy_at` field is already populated and the activate endpoint is idempotent on SCHEDULED-only, so the cron can be added without a service-shape change.
6. **Counsellor / Nurse / Lead-counsellor role split** — carries from Cycles 9 + 10 + 11; Staff role currently grants every COU code. Joins the Wave 2 Phase 2 backlog.

**Cycle 11.1 ships clean to the post-cycle architecture review. All 10 plan scenarios passed live on `tenant_demo` 2026-05-05 against the Step 7 build. Two ADR-057 wire envelopes captured live (WANTS_TO_TALK with `autoEscalate=false` + SELF_HARM_INDICATOR with `autoEscalate=true`).**
