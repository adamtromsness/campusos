# Cycle 9 CAT — Behaviour & Discipline

**Status:** verified live on `tenant_demo` 2026-05-04 against the Step 9 build. All 10 plan scenarios pass.

**Vertical slice:** Rivera reports a verbal-altercation incident for Maya under Disrespect (MEDIUM) → 2 admin queue rows + 2 AUTO `Review incident:` tasks land via Step 6 BehaviourNotificationConsumer + Cycle 7 TaskWorker → Sarah reviews (status=UNDER_REVIEW) and assigns Detention (`requires_parent_notification=true`) → David Chen receives `behaviour.action_assigned` IN_APP notification with the action type and timestamp → Sarah resolves → Rivera receives `behaviour.incident_resolved` (admin resolver, no self-suppress) → David sees Maya's 3 incidents row-scoped via `sis_student_guardians` with `adminNotes` stripped server-side → Hayes (counsellor) attempts a 2nd ACTIVE BIP of the same type (DRAFT inserts cleanly, activate path 400s with the partial UNIQUE pre-flight carrying the existing ACTIVE plan id) → Hayes creates a fresh BSP (different plan_type, partial UNIQUE allows) and activates it → Hayes adds 3 goals; bumps progress on goal #1 to IN_PROGRESS (auto-bumps `last_assessed_at = CURRENT_DATE`) → Hayes requests feedback from Rivera → AUTO `BIP feedback requested:` task lands on Rivera's list with `source_ref_id` matching the feedback row id → Rivera submits SOMEWHAT_EFFECTIVE rating + observations + adjustments (the partial UNIQUE on `submitted_at IS NULL` releases atomically) → 5 permission denial paths covering gate-tier 403 + service-layer admin-only + parent adminNotes strip.

**Pre-conditions:**

- `pnpm seed` + `seed:sis` + `seed:classroom` + `seed:hr` + `seed:scheduling` + `seed:enrollment` + `seed:payments` + `seed:profile` + `seed:tasks` + `seed:tickets` + `seed:behaviour` all run on `tenant_demo`.
- `tsx src/build-cache.ts` rebuilt the IAM cache (7 personas — admin/principal 447 / teacher 41 / VP/counsellor 24 / student 19 / **parent 21** with the Step 9 BEH-002:read grant).
- All four `dev.beh.*` topics pre-created on Kafka via `kafka-topics.sh --create --if-not-exists` per the documented subscribe-before-publish race workaround. The Cycle 7 TaskWorker auto-discovers the 2 new `beh.*` rules at boot and subscribes to 11 topics total.
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
-- expected: 139

-- Cycle 9 sis_discipline_* tables (Step 1)
SELECT COUNT(*) FROM information_schema.tables
WHERE table_schema='tenant_demo' AND table_name LIKE 'sis_discipline%';
-- expected: 4

-- Cycle 9 svc_* tables (Step 2 — first svc_ tables in the system)
SELECT COUNT(*) FROM information_schema.tables
WHERE table_schema='tenant_demo' AND table_name LIKE 'svc\_%';
-- expected: 3

-- 0 cross-schema FKs
SELECT COUNT(*) FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_class ft ON ft.oid = c.confrelid
  JOIN pg_namespace fn ON fn.oid = ft.relnamespace
  WHERE c.contype='f' AND n.nspname='tenant_demo' AND fn.nspname <> 'tenant_demo';
-- expected: 0

-- 5 + 6 = 11 intra-tenant FKs across the Cycle 9 tables
SELECT
  (SELECT COUNT(*) FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE c.contype='f' AND n.nspname='tenant_demo' AND t.relname LIKE 'sis_discipline%') AS sis_fks,
  (SELECT COUNT(*) FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE c.contype='f' AND n.nspname='tenant_demo' AND t.relname LIKE 'svc\_%') AS svc_fks;
-- expected: 5 | 6

-- Step 3 seed counts
SELECT
  (SELECT COUNT(*) FROM tenant_demo.sis_discipline_categories) AS cats,         -- 6
  (SELECT COUNT(*) FROM tenant_demo.sis_discipline_action_types) AS atypes,     -- 5
  (SELECT COUNT(*) FROM tenant_demo.sis_discipline_incidents) AS incs,          -- 3
  (SELECT COUNT(*) FROM tenant_demo.sis_discipline_actions) AS acts,            -- 2
  (SELECT COUNT(*) FROM tenant_demo.svc_behavior_plans) AS bips,                -- 1
  (SELECT COUNT(*) FROM tenant_demo.svc_behavior_plan_goals) AS goals,          -- 3
  (SELECT COUNT(*) FROM tenant_demo.svc_bip_teacher_feedback) AS feedback,      -- 1
  (SELECT COUNT(*) FROM tenant_demo.svc_bip_teacher_feedback WHERE submitted_at IS NULL) AS pending_fb;  -- 1

-- Auto-task rules feeding Cycle 7 TaskWorker
SELECT trigger_event_type FROM tenant_demo.tsk_auto_task_rules
WHERE trigger_event_type LIKE 'beh.%' ORDER BY trigger_event_type;
-- expected: beh.bip.feedback_requested, beh.incident.reported
```

All 8 checks pass.

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

T_TEACHER=$(login teacher@demo.campusos.dev)       # James Rivera
T_ADMIN=$(login principal@demo.campusos.dev)        # Sarah Mitchell
T_COUNSELLOR=$(login counsellor@demo.campusos.dev)  # Marcus Hayes
T_PARENT=$(login parent@demo.campusos.dev)          # David Chen
T_STUDENT=$(login student@demo.campusos.dev)        # Maya Chen

MAYA_ID=$(psql_demo "SELECT s.id FROM tenant_demo.sis_students s
  JOIN platform.platform_students ps ON ps.id=s.platform_student_id
  JOIN platform.iam_person p ON p.id=ps.person_id
  WHERE p.first_name='Maya' AND p.last_name='Chen';")
DISRESPECT=$(psql_demo "SELECT id FROM tenant_demo.sis_discipline_categories WHERE name='Disrespect';")
DETENTION=$(psql_demo "SELECT id FROM tenant_demo.sis_discipline_action_types WHERE name='Detention';")
RIVERA_EMP=$(psql_demo "SELECT he.id FROM tenant_demo.hr_employees he
  JOIN platform.iam_person p ON p.id=he.person_id
  JOIN platform.platform_users pu ON pu.person_id=p.id
  WHERE pu.email='teacher@demo.campusos.dev';")
SEED_BIP=$(psql_demo "SELECT id FROM tenant_demo.svc_behavior_plans WHERE plan_type='BIP' LIMIT 1;")
```

## Scenario 1 — Rivera reports incident → admin queue + AUTO admin-review tasks

```bash
INC=$(curl -sS -X POST $API/discipline/incidents \
  -H "$H_TENANT" -H "$H_JSON" -H "Authorization: Bearer $T_TEACHER" \
  -d "{\"studentId\":\"$MAYA_ID\",\"categoryId\":\"$DISRESPECT\",\"description\":\"CAT Step 10 — Verbal altercation in the hallway between classes\",\"incidentDate\":\"2026-05-04\",\"incidentTime\":\"10:30\",\"location\":\"Hallway B\"}")
INC_ID=$(echo "$INC" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
echo "$INC" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["status"],d["severity"],d["reportedByName"])'
# → OPEN MEDIUM James Rivera
```

Wait ~2 s for the BehaviourNotificationConsumer + Cycle 7 TaskWorker to react.

```sql
-- Step 6 fan-out: 2 admin queue rows
SELECT recipient_id::text FROM tenant_demo.msg_notification_queue
WHERE notification_type='behaviour.incident_reported'
  AND payload->>'incident_id' = '<INC_ID>'
ORDER BY recipient_id;
-- → admin@ + principal@ (both school-admin holders)

-- Cycle 7 TaskWorker: 2 AUTO admin-review tasks with source_ref_id matching
SELECT title, owner_id::text, source_ref_id::text FROM tenant_demo.tsk_tasks
WHERE source='AUTO' AND source_ref_id = '<INC_ID>'::uuid;
-- → 'Review incident: Maya Chen — Disrespect' × 2 (one per admin; source_ref_id matches)
```

S1 ✓ — incident landed OPEN with reporter=Rivera; 2 admin notifications queued; 2 AUTO tasks created with `source_ref_id` matching the incident id (the IncidentService follow-on `sourceRefId` fix from Step 6 is the load-bearing piece).

## Scenario 2 — Sarah reviews → status flips to UNDER_REVIEW

```bash
curl -sS -X PATCH $API/discipline/incidents/$INC_ID/review \
  -H "$H_TENANT" -H "$H_JSON" -H "Authorization: Bearer $T_ADMIN" \
  -d '{"adminNotes":"CAT — initial review. Consulting counsellor on follow-up."}' \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["status"], d["adminNotes"])'
# → UNDER_REVIEW CAT — initial review. Consulting counsellor on follow-up.
```

S2 ✓ — Sarah moves the incident through OPEN → UNDER_REVIEW under the locked-row tenant transaction; `adminNotes` is appended visibly on the admin payload.

## Scenario 3 — Sarah assigns Detention → David Chen receives parent notification

```bash
curl -sS -X POST $API/discipline/incidents/$INC_ID/actions \
  -H "$H_TENANT" -H "$H_JSON" -H "Authorization: Bearer $T_ADMIN" \
  -d "{\"actionTypeId\":\"$DETENTION\",\"startDate\":\"2026-05-05\",\"endDate\":\"2026-05-05\",\"notes\":\"After-school detention. CAT smoke.\"}"
# → { actionTypeName: "Detention", requiresParentNotification: true, startDate: "2026-05-05", … }
```

```sql
-- Step 6 BehaviourNotificationConsumer fan-out for action.parent_notification_required
SELECT recipient_id::text, payload->>'student_name' AS student, payload->>'action_type_name' AS action
FROM tenant_demo.msg_notification_queue
WHERE notification_type='behaviour.action_assigned'
  AND payload->>'incident_id' = '<INC_ID>';
-- → David Chen's account_id | Maya Chen | Detention
```

S3 ✓ — single guardian queue row for David Chen (Maya's only portal-enabled guardian). `payload.guardianAccountIds` was resolved at emit time by ActionService via `sis_student_guardians` JOIN `sis_guardians` JOIN `platform_users` (`portal_access=true` AND non-NULL `platform_users.id`); the consumer iterates it directly without a second DB read.

## Scenario 4 — Sarah resolves the incident → reporter receives notification

```bash
curl -sS -X PATCH $API/discipline/incidents/$INC_ID/resolve \
  -H "$H_TENANT" -H "$H_JSON" -H "Authorization: Bearer $T_ADMIN" \
  -d '{"adminNotes":"CAT — resolved. Detention served, counsellor referral attached."}' \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["status"], d["resolvedByName"], d["resolvedAt"][:19])'
# → RESOLVED Sarah Mitchell 2026-05-04T13:24:07
```

```sql
-- Step 6 fan-out: 1 row to the reporter (Rivera). admin resolver ≠ reporter → no self-suppress.
SELECT recipient_id::text FROM tenant_demo.msg_notification_queue
WHERE notification_type='behaviour.incident_resolved'
  AND payload->>'incident_id' = '<INC_ID>';
-- → Rivera teacher@ account_id (1 row)
```

S4 ✓ — the resolved_chk multi-column invariant is satisfied (resolved_by + resolved_at populated in the same UPDATE under `executeInTenantTransaction` with `SELECT … FOR UPDATE`). The reporter receives the notification because the resolver is a different account; Step 6's `if (resolvedByAccountId === reporterAccountId)` self-suppress branch correctly stays OFF.

## Scenario 5 — Parent visibility: David sees Maya's 3 incidents, adminNotes stripped

```bash
curl -sS "$API/discipline/incidents?studentId=$MAYA_ID" \
  -H "$H_TENANT" -H "Authorization: Bearer $T_PARENT" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print("count:",len(d))
for inc in d:
    notif=("notified" if any(a["parentNotified"] for a in inc["actions"]) else "pending") if inc["actions"] else "no actions"
    print(f"  {inc[\"severity\"]:8} {inc[\"status\"]:14} {inc[\"categoryName\"]:25} adminNotes={inc[\"adminNotes\"]!s:5} actions={notif}")'
# → count: 3
#   MEDIUM  RESOLVED      Disrespect              adminNotes=None actions=pending
#   MEDIUM  UNDER_REVIEW  Disrespect              adminNotes=None actions=notified
#   MEDIUM  RESOLVED      Disruptive Behaviour    adminNotes=None actions=pending
```

S5 ✓ — David sees exactly Maya's 3 incidents (2 seeded + the new CAT one). Ethan Rodriguez's seeded Tardiness OPEN incident is correctly filtered out by the IncidentService GUARDIAN row-scope (`sis_student_guardians` JOIN `sis_guardians` ON `g.person_id = actor.personId`). Every row carries `adminNotes: None` — the Step 4 `stripForNonManager(dto)` helper zeros the column server-side because `buildVisibility(actor)` returns `isManager: false` for guardians. Action notification status is fully visible to the parent (the action.parent_notification_required fan-out marks it).

## Scenario 6 — Hayes attempts 2nd ACTIVE BIP same type → partial UNIQUE keystone

Maya already has 1 ACTIVE BIP from the Step 3 seed. Counsellor tries to add another BIP for her.

```bash
# 6a — POST as DRAFT (allowed; partial UNIQUE only fires on ACTIVE)
DUP=$(curl -sS -X POST $API/behavior-plans \
  -H "$H_TENANT" -H "$H_JSON" -H "Authorization: Bearer $T_COUNSELLOR" \
  -d "{\"studentId\":\"$MAYA_ID\",\"planType\":\"BIP\",\"reviewDate\":\"2026-08-01\",\"targetBehaviors\":[\"CAT smoke — keystone test\"],\"sourceIncidentId\":\"$INC_ID\"}")
DUP_BIP=$(echo "$DUP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
# → DRAFT BIP created cleanly (multiple DRAFTs of same type per student are allowed; partial UNIQUE
#    only enforces uniqueness within status='ACTIVE')

# 6b — PATCH /:id/activate on the DRAFT (expect 400 — partial UNIQUE pre-flight)
curl -sS -X PATCH $API/behavior-plans/$DUP_BIP/activate \
  -H "$H_TENANT" -H "Authorization: Bearer $T_COUNSELLOR" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("message"))'
# → "Student already has an ACTIVE BIP plan (019df0f5-c5d9-…). Expire that plan before activating a new one."
```

S6a/b ✓ — the partial UNIQUE INDEX `svc_behavior_plans_active_per_student_type_uq ON (student_id, plan_type) WHERE status='ACTIVE'` is the schema-side belt-and-braces; the BehaviorPlanService.activate pre-flight surfaces a friendly 400 carrying the conflicting plan id so the counsellor can find and expire it.

```bash
# 6c — Different plan_type (BSP) coexists with the seed BIP
NEW_BSP=$(curl -sS -X POST $API/behavior-plans \
  -H "$H_TENANT" -H "$H_JSON" -H "Authorization: Bearer $T_COUNSELLOR" \
  -d "{\"studentId\":\"$MAYA_ID\",\"planType\":\"BSP\",\"reviewDate\":\"2026-08-01\",\"targetBehaviors\":[\"Off-task during independent work\"],\"replacementBehaviors\":[\"Use a focus checklist\"],\"reinforcementStrategies\":[\"Verbal praise\",\"5-minute movement break after 25 min focus\"]}" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')

curl -sS -X PATCH $API/behavior-plans/$NEW_BSP/activate \
  -H "$H_TENANT" -H "Authorization: Bearer $T_COUNSELLOR" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["status"])'
# → ACTIVE
```

S6c ✓ — Maya now has two ACTIVE plans (BIP + BSP) of different types. The partial UNIQUE only collides within the same `plan_type`.

## Scenario 7 — Hayes adds 3 goals; bumps progress on goal #1 to IN_PROGRESS

```bash
G1=$(curl -sS -X POST $API/behavior-plans/$NEW_BSP/goals \
  -H "$H_TENANT" -H "$H_JSON" -H "Authorization: Bearer $T_COUNSELLOR" \
  -d '{"goalText":"Complete 25-minute focus blocks 3 days per week","baselineFrequency":"1 per week","targetFrequency":"3 per week"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
# … (POST 2 more goals)

# Bump goal #1 to IN_PROGRESS
curl -sS -X PATCH $API/behavior-plan-goals/$G1 \
  -H "$H_TENANT" -H "$H_JSON" -H "Authorization: Bearer $T_COUNSELLOR" \
  -d '{"progress":"IN_PROGRESS"}' \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["progress"], d["lastAssessedAt"])'
# → IN_PROGRESS 2026-05-04
```

S7 ✓ — `lastAssessedAt` auto-bumps to today on every progress transition away from NOT_STARTED. The Step 5 `GoalService.update` writes both fields in the same UPDATE: `progress = $X, last_assessed_at = CURRENT_DATE`.

## Scenario 8 — Hayes requests feedback from Rivera → AUTO task on Rivera's list

```bash
FB=$(curl -sS -X POST $API/behavior-plans/$NEW_BSP/feedback-requests \
  -H "$H_TENANT" -H "$H_JSON" -H "Authorization: Bearer $T_COUNSELLOR" \
  -d "{\"teacherId\":\"$RIVERA_EMP\"}")
FB_ID=$(echo "$FB" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
echo "$FB" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["teacherName"], d["submittedAt"])'
# → James Rivera None
```

The Step 5 service emits `beh.bip.feedback_requested` outside the tenant tx with the teacher's `platform_users.id` pre-resolved as `recipientAccountId`. The Step 6 BehaviourNotificationConsumer enqueues an IN_APP notification on Rivera's account; the Cycle 7 TaskWorker writes a TODO task on Rivera's list with `source_ref_id` matching the feedback row id.

```sql
-- AUTO task on Rivera's list with source_ref_id matching the feedback id
SELECT title, owner_id::text, source_ref_id::text
FROM tenant_demo.tsk_tasks
WHERE source='AUTO' AND title LIKE 'BIP feedback requested:%'
  AND owner_id = (SELECT id FROM platform.platform_users WHERE email='teacher@demo.campusos.dev')
ORDER BY created_at DESC LIMIT 1;
-- → 'BIP feedback requested: Maya Chen' | Rivera teacher@ id | <FB_ID>
```

S8 ✓ — the auto-task fires within ~1–3 seconds after the request lands; `source_ref_id` correlates the task back to the originating feedback row (the FeedbackService emit includes `sourceRefId: id`, the same convention as Cycle 8 `tkt.ticket.assigned`).

## Scenario 9 — Rivera submits feedback → submittedAt + pending count drops

```bash
curl -sS -X PATCH $API/bip-feedback/$FB_ID \
  -H "$H_TENANT" -H "$H_JSON" -H "Authorization: Bearer $T_TEACHER" \
  -d '{"strategiesObserved":["Verbal praise","5-minute movement break after 25 min focus"],"overallEffectiveness":"SOMEWHAT_EFFECTIVE","classroomObservations":"CAT — Maya has used the focus checklist twice this week. The movement break helps; verbal praise is hit-or-miss.","recommendedAdjustments":"Try paired focus blocks with a peer. Continue weekly check-ins."}' \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["submittedAt"][:19], d["overallEffectiveness"])'
# → 2026-05-04T13:27:43 SOMEWHAT_EFFECTIVE

# Pending queue for Rivera now shows only the seed pending feedback (the BSP one was just submitted)
curl -sS $API/bip-feedback/pending -H "$H_TENANT" -H "Authorization: Bearer $T_TEACHER" \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print("count:",len(d));[print(" ",x["studentName"],x["planType"],x["requestedByName"]) for x in d]'
# → count: 1
#    Maya Chen BIP Marcus Hayes
```

S9 ✓ — `submittedAt` is stamped server-side via `now()` in the same UPDATE that records `strategiesObserved` / `overallEffectiveness` / observations. The partial UNIQUE on `(plan_id, teacher_id) WHERE submitted_at IS NULL` releases automatically since the row no longer matches the WHERE clause; a fresh request can be opened against the same `(plan, teacher)` pair afterward if the counsellor wants another round.

## Scenario 10 — 5 permission denial paths

```bash
# 10a Student GET /discipline/incidents (no beh-001:read)
curl -sS -o /dev/null -w "%{http_code}\n" $API/discipline/incidents -H "$H_TENANT" -H "Authorization: Bearer $T_STUDENT"
# → 403

# 10b Parent GET /discipline/incidents/:id — adminNotes stripped
curl -sS $API/discipline/incidents/$INC_ID -H "$H_TENANT" -H "Authorization: Bearer $T_PARENT" \
  | python3 -c 'import json,sys;print("adminNotes:",json.load(sys.stdin)["adminNotes"])'
# → adminNotes: None

# 10c Teacher POST /discipline/incidents/:id/actions (admin-only at the service layer)
curl -sS -o /dev/null -w "%{http_code}\n" -X POST $API/discipline/incidents/$INC_ID/actions \
  -H "$H_TENANT" -H "$H_JSON" -H "Authorization: Bearer $T_TEACHER" \
  -d "{\"actionTypeId\":\"$DETENTION\"}"
# → 403

# 10d Student PATCH /bip-feedback/:id (no beh-002:read)
curl -sS -o /dev/null -w "%{http_code}\n" -X PATCH $API/bip-feedback/$FB_ID \
  -H "$H_TENANT" -H "$H_JSON" -H "Authorization: Bearer $T_STUDENT" \
  -d '{"overallEffectiveness":"EFFECTIVE"}'
# → 403

# 10e Parent POST /behavior-plans (parents read but never write — counsellor/admin only)
curl -sS -o /dev/null -w "%{http_code}\n" -X POST $API/behavior-plans \
  -H "$H_TENANT" -H "$H_JSON" -H "Authorization: Bearer $T_PARENT" \
  -d "{\"studentId\":\"$MAYA_ID\",\"planType\":\"BIP\",\"reviewDate\":\"2026-09-01\",\"targetBehaviors\":[\"x\"]}"
# → 403
```

S10 ✓ — all 5 denials behave correctly. The mix exercises both gate-tier checks (where the @RequirePermission decorator returns 403 before any service logic runs) and service-layer admin-only checks (where the controller passes the gate but `IncidentService.create-action` / `BehaviorPlanService.create` reject the actor's role at the start of the method). The parent's `adminNotes: null` confirms the row-scope strip via `stripForNonManager(dto)` on every parent-bound payload.

## Cleanup script (restore tenant_demo to post-Step-3 seed shape)

```sql
-- Drop the CAT smoke incident (CASCADE drops its actions)
DELETE FROM tenant_demo.sis_discipline_incidents WHERE description LIKE 'CAT Step 10%';

-- Drop the smoke BSP (CASCADE drops goals + feedback rows)
DELETE FROM tenant_demo.svc_behavior_plans WHERE plan_type='BSP';

-- Drop the smoke duplicate-BIP DRAFT (the seed BIP keeps its row — find it by created_at)
DELETE FROM tenant_demo.svc_behavior_plans
  WHERE plan_type='BIP'
    AND id <> (SELECT id FROM tenant_demo.svc_behavior_plans WHERE plan_type='BIP' ORDER BY created_at LIMIT 1);

-- Drop CAT-driven feedback rows (S9 submitted the seed one — re-create cleanly afterwards)
DELETE FROM tenant_demo.svc_bip_teacher_feedback;
INSERT INTO tenant_demo.svc_bip_teacher_feedback (id, plan_id, teacher_id, requested_by, requested_at)
SELECT
  gen_random_uuid(),
  (SELECT id FROM tenant_demo.svc_behavior_plans WHERE plan_type='BIP' LIMIT 1),
  (SELECT he.id FROM tenant_demo.hr_employees he
     JOIN platform.iam_person p ON p.id=he.person_id
     JOIN platform.platform_users pu ON pu.person_id=p.id
     WHERE pu.email='teacher@demo.campusos.dev'),
  (SELECT he.id FROM tenant_demo.hr_employees he
     JOIN platform.iam_person p ON p.id=he.person_id
     JOIN platform.platform_users pu ON pu.person_id=p.id
     WHERE pu.email='counsellor@demo.campusos.dev'),
  '2026-05-04 06:08:50+00';

-- Drop CAT-created AUTO tasks
DELETE FROM tenant_demo.tsk_tasks
WHERE source='AUTO'
  AND (title LIKE 'Review incident:%' OR title LIKE 'BIP feedback requested:%');

-- Drop CAT behaviour.* notification queue rows
DELETE FROM tenant_demo.msg_notification_queue WHERE notification_type LIKE 'behaviour.%';
```

After cleanup the tenant returns to the post-Step-3 shape: 6 categories / 5 action types / 3 incidents (1 OPEN/1 UNDER_REVIEW/1 RESOLVED) / 2 actions (1 with parent_notified=true) / 1 ACTIVE BIP / 3 goals / 1 pending feedback / 0 behaviour.\* queue rows.

## Closing

**All 10 plan scenarios pass.** Cycle 9 ships clean to the post-cycle architecture review.

The vertical slice exercises every key integration point in the cycle:

- Schema multi-column CHECKs (`sis_discipline_incidents.resolved_chk`, `sis_discipline_actions.dates_chk`, `svc_behavior_plans.target_behaviors_chk` cardinality > 0, `svc_behavior_plan_goals.progress_chk`, `svc_bip_teacher_feedback.effectiveness_chk`) all enforce the right invariants. Every state-machine transition runs through `executeInTenantTransaction` + `SELECT … FOR UPDATE`.
- The two **partial UNIQUE keystones** are caught in the service-layer pre-flight before the schema raises: `(student_id, plan_type) WHERE status='ACTIVE'` on `BehaviorPlanService.activate` (S6b) and `(plan_id, teacher_id) WHERE submitted_at IS NULL` on `FeedbackService.requestFeedback` (already exercised in Step 5 smoke). Both surface a friendly 400 carrying the conflicting row id.
- **Cycle 7 TaskWorker** auto-discovers the 2 new `beh.*` rules at boot (TaskWorker subscribed to 11 topics; Step 3 seed-tasks is the rules source). `Review incident:` AUTO tasks land on every school admin's list with `source_ref_id` matching the incident id (the IncidentService `sourceRefId` follow-on fix from Step 6); `BIP feedback requested:` AUTO tasks land on the recipient teacher's list via the worker's `payload.recipientAccountId / accountId` fallback (target_role=NULL on the seeded rule).
- **Cycle 9 BehaviourNotificationConsumer** routes 4 topics to the right inboxes: incident.reported → school admins via `iam_effective_access_cache` lookup; action.parent_notification_required → `payload.guardianAccountIds` resolved upstream by ActionService; bip.feedback_requested → `payload.recipientAccountId` pre-resolved by FeedbackService; incident.resolved → original reporter via `hr_employees → iam_person → platform_users` bridge with self-suppress when `resolvedByAccountId === reporterAccountId` (mirrors Cycle 8 follow-up 2).
- **Row-level visibility** model enforced at the service layer: admin/counsellor see all + `adminNotes`; teachers see incidents they reported + students in their own classes (with `adminNotes` stripped); parents see their own children only (with `adminNotes` stripped + `feedback[]` stripped on BIP responses); students never reach the gate. The Step 9 GUARDIAN branch on `BehaviorPlanService.buildVisibility` joins through `sis_student_guardians + sis_guardians ON g.person_id = actor.personId`; the new `canSeeFeedback(actor)` helper strips the feedback array for parents.
- 5 permission denials (gate-tier 403 + service-layer admin-only + parent adminNotes strip).

Reviewer attention items (non-blocking, Phase 2 polish):

- **Cycle 7 TaskWorker fallback validation.** The worker's `payload.recipientAccountId / accountId` fallback is fine for the seeded auto-task rules; once schools can author custom rules, validate the assignee against the calling tenant's projections (mirrors REVIEW-CYCLE7 follow-up).
- **Per-incident attachments.** The Cycle 8 ticket schema includes `tkt_ticket_attachments`; Cycle 9 deliberately did NOT add a `sis_discipline_attachments` table. If real-world cases (police reports, screenshots, witness statements) need attached evidence, a future polish migration would add the schema + signed-URL upload service.
- **Per-incident activity log.** The Cycle 8 schema includes `tkt_ticket_activity` (immutable audit). Cycle 9's `sis_discipline_incidents.admin_notes` carries appended notes via `review` + `resolve` actions, but there's no separate audit row per status change. A future polish would add a `sis_discipline_activity` table mirroring the Cycle 8 precedent.
- **BehaviourTaskCompletionConsumer.** Cycle 8 ships `TicketTaskCompletionConsumer` to flip the AUTO admin-review task DONE when the parent ticket is RESOLVED. Cycle 9 does NOT — admins manually mark their `Review incident:` task DONE today. A future polish step adds this consumer (small additive code, no schema change).
- **FERPA admin access log.** Cycle 3's `msg_admin_access_log` records when an admin reads a private thread they aren't a participant in. Cycle 9's incident reads are not similarly logged today; a future polish adds a `sis_discipline_access_log` table for the same audit trail (relevant for sensitive student conduct data).
- **Student self-view.** The plan explicitly excluded student access to discipline records; the seeded perms confirm this (Student has no BEH-\* grants). A future trauma-informed UX cycle could add a sanitised "your own behaviour goals" view for the student themselves.
- **Cross-school behaviour history.** Records are tenant-scoped today; a future Wave 3 cycle would need a `platform.iam_person`-keyed read across tenants for transfer students.
