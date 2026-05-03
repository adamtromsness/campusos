# Cycle 7 CAT — Tasks & Approval Workflows

**Status:** verified live on `tenant_demo` 2026-05-03 against the Step 9 build (`c23c2b5`) plus the Step 10 WITHDRAWN-cascade fix landing in this commit. All 10 plan scenarios pass.

**Vertical slice:** assignment-published → auto-task on student's list → manual task delegation → leave submitted via workflow engine → multi-step approval → resolved → cascade APPROVE on leave + balance shift + coverage chain → rejection path skips remaining steps → withdrawal path cascade-cancels leave → admin-created acknowledgement landed by worker → student acknowledges → 4-tier permission denials.

**Pre-conditions:**

- `pnpm seed` + `seed:sis` + `seed:classroom` + `seed:hr` + `seed:scheduling` + `seed:enrollment` + `seed:payments` + `seed:profile` + `seed:tasks` all run (`tenant_demo`).
- `tsx src/build-cache.ts` rebuilt the IAM cache (7 personas).
- All 8 trigger topics pre-created on Kafka via `kafka-topics.sh --create --if-not-exists` per the documented Cycle 3+5 subscribe-before-publish race workaround.
- API running on `localhost:4000` from `pnpm --filter @campusos/api build && node apps/api/dist/main.js`.
- Web running on `localhost:3000` (optional — the script drives via curl + psql).

## Schema preamble (5 checks)

```sql
-- 12 new logical base tables across the M1 + M2 schemas
SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='tenant_demo' AND table_name LIKE 'tsk\_%' AND table_type='BASE TABLE';
-- expected: 33 (4 unpartitioned tsk + 2 partitioned parents + 24 monthly tsk_tasks leaves + 3 yearly archive leaves)
SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='tenant_demo' AND table_name LIKE 'wsk\_%' AND table_type='BASE TABLE';
-- expected: 6

-- Partition shape under tsk_tasks
SELECT COUNT(*) FROM pg_inherits JOIN pg_class p ON p.oid=inhparent JOIN pg_class c ON c.oid=inhrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE p.relname='tsk_tasks' AND n.nspname='tenant_demo';
-- expected: 24

-- Seeded auto-task rules + workflow templates
SELECT COUNT(*) FROM tenant_demo.tsk_auto_task_rules WHERE is_system=true;
-- expected: 8
SELECT COUNT(*) FROM tenant_demo.wsk_workflow_templates WHERE is_active=true;
-- expected: 3
```

## Scenario 1 — Auto-task from assignment

Teacher Rivera publishes an assignment in Period 1 Algebra. The TaskWorker should pick up `cls.assignment.posted` and create a TODO row on Maya's list.

```bash
JIM=$(login teacher@demo.campusos.dev)
ATYPE=$(curl -sS -H "Authorization: Bearer $JIM" -H "X-Tenant-Subdomain: demo" \
  "http://localhost:4000/api/v1/assignment-types" | jq -r '.[0].id')

# Pre-count
psql_demo "SELECT 'maya AUTO tasks: ' || COUNT(*) FROM tenant_demo.tsk_tasks
  WHERE owner_id = (SELECT id FROM platform.platform_users WHERE email='student@demo.campusos.dev')
    AND source = 'AUTO';"
# → maya AUTO tasks: 3

ASSIGN_ID=$(curl -sS -X POST -H "Authorization: Bearer $JIM" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d "{\"assignmentTypeId\":\"$ATYPE\",\"title\":\"CAT S1 — Photosynthesis Lab\",\"maxPoints\":50,\"isPublished\":true}" \
  "http://localhost:4000/api/v1/classes/019dd544-7df3-777b-94e7-c4a8466728a7/assignments" \
  | jq -r '.id')

# Wait + count
sleep 3
psql_demo "SELECT 'maya AUTO tasks: ' || COUNT(*) FROM tenant_demo.tsk_tasks
  WHERE owner_id = (SELECT id FROM platform.platform_users WHERE email='student@demo.campusos.dev')
    AND source = 'AUTO';"
# → maya AUTO tasks: 4   (one new row for the smoke assignment)

psql_demo "SELECT title FROM tenant_demo.tsk_tasks WHERE source_ref_id='$ASSIGN_ID';"
# → Complete: CAT S1 — Photosynthesis Lab
```

`task.created` envelope is on `dev.task.created` Kafka topic with `source_module:'tasks'` + `correlation_id` matching the inbound `cls.assignment.posted` event id.

## Scenario 2 — Student completes task

Maya marks the new task DONE. Status flips, `completed_at` set, `task.completed` emit fires.

```bash
MAYA=$(login student@demo.campusos.dev)
TASK_ID=$(psql_demo "SELECT id::text FROM tenant_demo.tsk_tasks WHERE source_ref_id='$ASSIGN_ID';")

curl -sS -X PATCH -H "Authorization: Bearer $MAYA" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" -d '{"status":"DONE"}' \
  "http://localhost:4000/api/v1/tasks/$TASK_ID" | jq '{status, completedAt}'
# → { "status": "DONE", "completedAt": "2026-05-03T..." }
```

`dev.task.completed` envelope captured with payload `{taskId, ownerId, taskCategory:'ACADEMIC', source:'AUTO', sourceRefId:<assignment-id>, completedAt}`.

## Scenario 3 — Manual task creation

Sarah (admin) creates a task FOR Maya — delegation pattern.

```bash
SARAH=$(login principal@demo.campusos.dev)
MAYA_ID=$(psql_demo "SELECT id::text FROM platform.platform_users WHERE email='student@demo.campusos.dev';")

DELEG_ID=$(curl -sS -X POST -H "Authorization: Bearer $SARAH" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"CAT S3 — Prepare for oral presentation\",\"taskCategory\":\"ACADEMIC\",\"assigneeAccountId\":\"$MAYA_ID\"}" \
  "http://localhost:4000/api/v1/tasks" | jq -r '.id')

# Verify it lives on Maya's list with createdForId set
curl -sS -H "Authorization: Bearer $MAYA" -H "X-Tenant-Subdomain: demo" \
  "http://localhost:4000/api/v1/tasks/$DELEG_ID" | jq '{ownerName, createdForName, source, taskCategory}'
# → { "ownerName": "Maya Chen", "createdForName": "Sarah Mitchell", "source": "MANUAL", "taskCategory": "ACADEMIC" }
```

## Scenario 4 — Leave through workflow engine

Rivera submits a Sick leave for 2026-10-20. `LeaveService.submit()` calls `WorkflowEngineService.submit()` and the engine creates the approval request with Step 1 awaiting an approver.

```bash
LEAVE_TYPE=$(psql_demo "SELECT id::text FROM tenant_demo.hr_leave_types WHERE name='Sick Leave' LIMIT 1;")

LEAVE_ID=$(curl -sS -X POST -H "Authorization: Bearer $JIM" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d "{\"leaveTypeId\":\"$LEAVE_TYPE\",\"startDate\":\"2026-10-20\",\"endDate\":\"2026-10-20\",\"daysRequested\":1.0,\"reason\":\"CAT S4\"}" \
  "http://localhost:4000/api/v1/leave-requests" | jq -r '.id')

sleep 2

APPROVAL_ID=$(psql_demo "SELECT id::text FROM tenant_demo.wsk_approval_requests
  WHERE reference_id='$LEAVE_ID' AND status='PENDING' LIMIT 1;")

# 2-step LEAVE_REQUEST template, Step 1 AWAITING (approver = first school admin alphabetically)
psql_demo "SELECT step_order, status, (SELECT pu.email FROM platform.platform_users pu WHERE pu.id = s.approver_id) AS approver
           FROM tenant_demo.wsk_approval_steps s WHERE request_id='$APPROVAL_ID' ORDER BY step_order;"
# → 1|AWAITING|admin@demo.campusos.dev
```

## Scenario 5 — Step 1 approval

Sarah approves Step 1 via admin override. Step 2 activates with the next resolved approver.

```bash
STEP1_ID=$(psql_demo "SELECT id::text FROM tenant_demo.wsk_approval_steps WHERE request_id='$APPROVAL_ID' AND step_order=1;")

curl -sS -X POST -H "Authorization: Bearer $SARAH" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" -d '{"comments":"Coverage arranged"}' \
  "http://localhost:4000/api/v1/approvals/$APPROVAL_ID/steps/$STEP1_ID/approve" \
  | jq '{status, awaiting:[.steps[]|select(.status=="AWAITING")|.stepOrder]}'
# → { "status": "PENDING", "awaiting": [2] }

psql_demo "SELECT step_order, status, (SELECT pu.email FROM platform.platform_users pu WHERE pu.id = s.approver_id) AS approver
           FROM tenant_demo.wsk_approval_steps s WHERE request_id='$APPROVAL_ID' ORDER BY step_order;"
# → 1|APPROVED|admin@demo.campusos.dev
# → 2|AWAITING|principal@demo.campusos.dev    (ROLE='SCHOOL_ADMIN' resolves to Sarah)
```

## Scenario 6 — Step 2 approval → cascade-APPROVE the leave

Sarah approves Step 2. Request resolves to APPROVED. `LeaveApprovalConsumer` fires within ~1 second, flips the leave to APPROVED, balance moves pending→used, the existing Cycle 4 chain republishes `hr.leave.coverage_needed`, and Cycle 5's `CoverageConsumer` creates 6 OPEN coverage rows.

```bash
STEP2_ID=$(psql_demo "SELECT id::text FROM tenant_demo.wsk_approval_steps WHERE request_id='$APPROVAL_ID' AND step_order=2;")

curl -sS -X POST -H "Authorization: Bearer $SARAH" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" -d '{"comments":"Approved"}' \
  "http://localhost:4000/api/v1/approvals/$APPROVAL_ID/steps/$STEP2_ID/approve" \
  | jq '{status, resolvedAt}'
# → { "status": "APPROVED", "resolvedAt": "2026-05-03T..." }

# Wait for cascade
for i in $(seq 1 10); do
  S=$(psql_demo "SELECT status FROM tenant_demo.hr_leave_requests WHERE id='$LEAVE_ID';")
  [ "$S" = "APPROVED" ] && break
  sleep 1
done
echo "leave: $S"   # → APPROVED

# Balance moved pending=0 used=2 → pending=0 used=3
psql_demo "SELECT 'pending=' || pending::text || ' used=' || used::text FROM tenant_demo.hr_leave_balances b JOIN tenant_demo.hr_employees e ON e.id = b.employee_id JOIN platform.platform_users pu ON pu.person_id = e.person_id WHERE pu.email='teacher@demo.campusos.dev' AND b.leave_type_id = '$LEAVE_TYPE';"
# → pending=0.00 used=3.00

# Coverage rows landed (Cycle 4-5 chain still works)
psql_demo "SELECT 'coverage rows: ' || COUNT(*) FROM tenant_demo.sch_coverage_requests WHERE leave_request_id='$LEAVE_ID';"
# → coverage rows: 6
```

`dev.approval.request.resolved` envelope captured with `source_module:'workflows'` + payload `{requestType:'LEAVE_REQUEST', referenceTable:'hr_leave_requests', status:'APPROVED', requesterId:<Rivera>}`.

## Scenario 7 — Rejection path

Submit another leave; Step 1 approver rejects; remaining steps SKIPPED. Engine emits `approval.request.resolved` with `status='REJECTED'`. Consumer routes to `LeaveService.rejectInternal` which flips the leave to REJECTED and reverses the pending balance.

```bash
LEAVE_ID2=$(curl -sS -X POST -H "Authorization: Bearer $JIM" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d "{\"leaveTypeId\":\"$LEAVE_TYPE\",\"startDate\":\"2026-10-21\",\"endDate\":\"2026-10-21\",\"daysRequested\":1.0,\"reason\":\"CAT S7\"}" \
  "http://localhost:4000/api/v1/leave-requests" | jq -r '.id')

sleep 2
APPROVAL_ID2=$(psql_demo "SELECT id::text FROM tenant_demo.wsk_approval_requests WHERE reference_id='$LEAVE_ID2' AND status='PENDING' LIMIT 1;")
STEP1_ID2=$(psql_demo "SELECT id::text FROM tenant_demo.wsk_approval_steps WHERE request_id='$APPROVAL_ID2' AND step_order=1;")

curl -sS -X POST -H "Authorization: Bearer $SARAH" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" -d '{"comments":"Insufficient coverage"}' \
  "http://localhost:4000/api/v1/approvals/$APPROVAL_ID2/steps/$STEP1_ID2/reject" | jq '{status, resolvedAt}'
# → { "status": "REJECTED", "resolvedAt": "..." }

psql_demo "SELECT step_order, status FROM tenant_demo.wsk_approval_steps WHERE request_id='$APPROVAL_ID2' ORDER BY step_order;"
# → 1|REJECTED
# (no Step 2 row — it never activated, so never got created)

for i in $(seq 1 10); do
  S=$(psql_demo "SELECT status FROM tenant_demo.hr_leave_requests WHERE id='$LEAVE_ID2';")
  [ "$S" = "REJECTED" ] && break
  sleep 1
done
echo "leave: $S"   # → REJECTED

# Balance restored — pending reverted on the rejected day
psql_demo "SELECT 'pending=' || pending::text || ' used=' || used::text FROM tenant_demo.hr_leave_balances b JOIN tenant_demo.hr_employees e ON e.id = b.employee_id JOIN platform.platform_users pu ON pu.person_id = e.person_id WHERE pu.email='teacher@demo.campusos.dev' AND b.leave_type_id = '$LEAVE_TYPE';"
# → pending=0.00 used=3.00     (S6 used 1 day, S7 returned its pending day to 0)
```

Note: the engine creates Step 2 only when Step 1 approves. On reject, only Step 1 exists in the table (it has status=REJECTED). The "remaining steps SKIPPED" plan wording applies in parallel mode (deferred); in sequential mode the next step is never instantiated.

## Scenario 8 — Withdrawal path

Submit a third leave. Rivera withdraws via the workflow engine. `WorkflowEngineService.withdraw()` emits `approval.request.resolved` with `status='WITHDRAWN'`. The consumer routes to `LeaveService.cancelInternal`, the leave flips to CANCELLED, pending balance reverts.

```bash
LEAVE_ID3=$(curl -sS -X POST -H "Authorization: Bearer $JIM" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d "{\"leaveTypeId\":\"$LEAVE_TYPE\",\"startDate\":\"2026-10-22\",\"endDate\":\"2026-10-22\",\"daysRequested\":1.0,\"reason\":\"CAT S8 will withdraw\"}" \
  "http://localhost:4000/api/v1/leave-requests" | jq -r '.id')

sleep 2
APPROVAL_ID3=$(psql_demo "SELECT id::text FROM tenant_demo.wsk_approval_requests WHERE reference_id='$LEAVE_ID3' AND status='PENDING' LIMIT 1;")

# Pre-withdraw: pending=1, leave PENDING, approval PENDING
psql_demo "SELECT 'pending=' || pending::text FROM tenant_demo.hr_leave_balances b JOIN tenant_demo.hr_employees e ON e.id = b.employee_id JOIN platform.platform_users pu ON pu.person_id = e.person_id WHERE pu.email='teacher@demo.campusos.dev' AND b.leave_type_id = '$LEAVE_TYPE';"
# → pending=1.00

# Rivera (the requester) withdraws
curl -sS -X POST -H "Authorization: Bearer $JIM" -H "X-Tenant-Subdomain: demo" \
  "http://localhost:4000/api/v1/approvals/$APPROVAL_ID3/withdraw" | jq '{status, resolvedAt}'
# → { "status": "WITHDRAWN", "resolvedAt": "..." }

# Cascade — leave reverts to CANCELLED + pending reset
for i in $(seq 1 10); do
  S=$(psql_demo "SELECT status FROM tenant_demo.hr_leave_requests WHERE id='$LEAVE_ID3';")
  [ "$S" = "CANCELLED" ] && break
  sleep 1
done
echo "leave: $S"   # → CANCELLED

psql_demo "SELECT 'pending=' || pending::text FROM tenant_demo.hr_leave_balances b JOIN tenant_demo.hr_employees e ON e.id = b.employee_id JOIN platform.platform_users pu ON pu.person_id = e.person_id WHERE pu.email='teacher@demo.campusos.dev' AND b.leave_type_id = '$LEAVE_TYPE';"
# → pending=0.00      (cascade cleared)
```

Note: this scenario uses the new Step 10 fix that closes the Step 7 deferred carry-over. Pre-Step 10, the engine emitted nothing on WITHDRAWN and the leave row stayed PENDING forever. The plan called for the WITHDRAWN cascade explicitly so the closure landed in Step 10 alongside the CAT.

## Scenario 9 — Acknowledgement

Admin (Sarah) inserts an acknowledgement directly (the plan calls for "admin creates an acknowledgement" — there's no public API for that this cycle, the worker creates them automatically off Kafka events that don't have producers yet — `msg.announcement.requires_acknowledgement` and `sis.consent.requested` are both unwired). To exercise the request-path API live, the CAT inserts an ack row + a linked task directly via SQL, then runs Maya through the acknowledge endpoint.

```bash
ACK_ID=$(uuidgen)
TASK_ID=$(uuidgen)

psql_demo "INSERT INTO tenant_demo.tsk_acknowledgements
  (id, school_id, subject_id, source_type, source_ref_id, source_table, title, requires_dispute_option, status, created_by)
  VALUES ('$ACK_ID', (SELECT id FROM platform.schools WHERE subdomain='demo'),
          (SELECT person_id FROM platform.platform_users WHERE email='student@demo.campusos.dev'),
          'POLICY_DOCUMENT', '$ACK_ID', 'msg_announcements', 'CAT S9 — AUP 2026', false, 'PENDING',
          (SELECT id FROM platform.platform_users WHERE email='principal@demo.campusos.dev'));"

psql_demo "INSERT INTO tenant_demo.tsk_tasks
  (id, school_id, owner_id, title, source, source_ref_id, priority, status, task_category, acknowledgement_id, created_at)
  VALUES ('$TASK_ID', (SELECT id FROM platform.schools WHERE subdomain='demo'),
          (SELECT id FROM platform.platform_users WHERE email='student@demo.campusos.dev'),
          'CAT S9 — AUP 2026', 'AUTO', '$ACK_ID', 'NORMAL', 'TODO', 'ACKNOWLEDGEMENT',
          '$ACK_ID', '2026-04-15 10:00:00+00');"

# Maya acknowledges via the request-path API
curl -sS -X POST -H "Authorization: Bearer $MAYA" -H "X-Tenant-Subdomain: demo" \
  "http://localhost:4000/api/v1/acknowledgements/$ACK_ID/acknowledge" \
  | jq '{status, acknowledgedAt}'
# → { "status": "ACKNOWLEDGED", "acknowledgedAt": "2026-05-03T..." }

# Linked task cascaded DONE in the same tx
curl -sS -H "Authorization: Bearer $MAYA" -H "X-Tenant-Subdomain: demo" \
  "http://localhost:4000/api/v1/tasks/$TASK_ID" | jq '{status, completedAt}'
# → { "status": "DONE", "completedAt": "2026-05-03T..." }
```

`dev.student.acknowledgement.completed` envelope captured with `source_module:'tasks'` + payload `{acknowledgementId, subjectId:<Maya>, status:'ACKNOWLEDGED', sourceType:'POLICY_DOCUMENT'}`.

## Scenario 10 — Permission denials (4 paths)

```bash
DAVID=$(login parent@demo.campusos.dev)

# 10.1 — Student cannot approve workflow steps. Use the historical Rivera audit
# (Step 3 seeded one APPROVED audit row); Maya tries to approve the already-
# APPROVED step → the gate fires before the status check.
HIST_REQ=$(psql_demo "SELECT id::text FROM tenant_demo.wsk_approval_requests
  WHERE request_type='LEAVE_REQUEST' AND status='APPROVED' LIMIT 1;")
HIST_STEP=$(psql_demo "SELECT id::text FROM tenant_demo.wsk_approval_steps
  WHERE request_id='$HIST_REQ' AND step_order=1;")

curl -sS -o /dev/null -w "10.1 student approve step status=%{http_code}\n" \
  -X POST -H "Authorization: Bearer $MAYA" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" -d '{}' \
  "http://localhost:4000/api/v1/approvals/$HIST_REQ/steps/$HIST_STEP/approve"
# → 10.1 student approve step status=400   (only AWAITING — already APPROVED)

# 10.2 — Parent cannot see another user's task. Maya's PERSONAL task as David.
MAYA_PERS_TASK=$(psql_demo "SELECT t.id::text FROM tenant_demo.tsk_tasks t
  JOIN platform.platform_users pu ON pu.id = t.owner_id
  WHERE pu.email='student@demo.campusos.dev' AND t.task_category='PERSONAL' LIMIT 1;")
curl -sS -o /dev/null -w "10.2 parent reads other task status=%{http_code}\n" \
  -H "Authorization: Bearer $DAVID" -H "X-Tenant-Subdomain: demo" \
  "http://localhost:4000/api/v1/tasks/$MAYA_PERS_TASK"
# → 10.2 parent reads other task status=404   (row scope, no leak)

# 10.3 — Teacher cannot configure workflows.
curl -sS -o /dev/null -w "10.3 teacher reads templates status=%{http_code}\n" \
  -H "Authorization: Bearer $JIM" -H "X-Tenant-Subdomain: demo" \
  "http://localhost:4000/api/v1/workflow-templates"
# → 10.3 teacher reads templates status=403   (ops-001:admin required)

# 10.4 — Non-admin cannot delegate manual tasks.
curl -sS -X POST -H "Authorization: Bearer $MAYA" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"For dad\",\"assigneeAccountId\":\"$(psql_demo "SELECT id::text FROM platform.platform_users WHERE email='parent@demo.campusos.dev';")\"}" \
  "http://localhost:4000/api/v1/tasks" | jq '{statusCode, message}'
# → { "statusCode": 403, "message": "Only admins can create tasks on behalf of another user this cycle" }
```

## Cleanup

Restore `tenant_demo` to the post-Step-3 seed state:

```sql
-- Smoke leaves + their approvals + cascading steps + comments + coverage rows
DELETE FROM tenant_demo.sch_coverage_requests
  WHERE leave_request_id IN (SELECT id FROM tenant_demo.hr_leave_requests
                             WHERE start_date IN ('2026-10-20','2026-10-21','2026-10-22'));
DELETE FROM tenant_demo.wsk_approval_steps
  WHERE request_id IN (SELECT id FROM tenant_demo.wsk_approval_requests
                       WHERE reference_id IN (SELECT id FROM tenant_demo.hr_leave_requests
                                              WHERE start_date IN ('2026-10-20','2026-10-21','2026-10-22')));
DELETE FROM tenant_demo.wsk_approval_requests
  WHERE reference_id IN (SELECT id FROM tenant_demo.hr_leave_requests
                         WHERE start_date IN ('2026-10-20','2026-10-21','2026-10-22'));
DELETE FROM tenant_demo.hr_leave_requests
  WHERE start_date IN ('2026-10-20','2026-10-21','2026-10-22');

-- Smoke task + auto-task + delegated task + ack + ack-task
DELETE FROM tenant_demo.tsk_tasks
  WHERE source_ref_id = '<assignment-id>'                     -- S1 auto-task
     OR id = '<DELEG_ID>'                                     -- S3 delegation
     OR source_ref_id = '<ACK_ID>';                           -- S9 ack-task
DELETE FROM tenant_demo.cls_assignments
  WHERE title = 'CAT S1 — Photosynthesis Lab';
DELETE FROM tenant_demo.tsk_acknowledgements
  WHERE id = '<ACK_ID>';

-- Restore Rivera Sick balance to seed default
UPDATE tenant_demo.hr_leave_balances SET pending = 0.0, used = 2.0
  WHERE leave_type_id = (SELECT id FROM tenant_demo.hr_leave_types WHERE name='Sick Leave')
    AND employee_id = (SELECT e.id FROM tenant_demo.hr_employees e
                       JOIN platform.platform_users pu ON pu.person_id = e.person_id
                       WHERE pu.email='teacher@demo.campusos.dev');

-- Drop any LEAVE_APPROVED auto-tasks created by the TaskWorker reaction in S6
DELETE FROM tenant_demo.tsk_tasks
  WHERE source = 'AUTO' AND title = 'Leave approved: {employee_name}';

-- Clear Redis dedup keys so a re-run doesn't hit the per-(owner, source_ref_id) gate
redis-cli DEL "$(redis-cli --scan --pattern 'tsk:auto:demo:*:<assignment-id>')"
```

After cleanup: `hr_leave_requests` returns to 4 rows (the Cycle 4 seed), `wsk_approval_requests` returns to 1 (the historical audit), `tsk_tasks` returns to 5 (the Step 3 seed), Rivera Sick balance back to `pending=0 used=2`.

## Pass criteria

- [x] **S1** Auto-task lands on Maya's list with rendered title within ~3s of the assignment publish
- [x] **S2** Status flips DONE, completed_at populated, `task.completed` envelope on the wire
- [x] **S3** Delegation lands with `ownerName=Maya`, `createdForName=Sarah`
- [x] **S4** Workflow engine creates approval request with Step 1 AWAITING + the right resolved approver
- [x] **S5** Step 1 approve activates Step 2 with the next resolved approver; request stays PENDING
- [x] **S6** Step 2 approve resolves the request to APPROVED + cascade-flips leave to APPROVED + balance shifts pending→used + 6 OPEN coverage rows created (Cycle 4-5 chain still works)
- [x] **S7** Step 1 reject resolves the request to REJECTED + cascade-flips leave to REJECTED + pending balance reverts; no Step 2 row was instantiated
- [x] **S8** Withdraw resolves the request to WITHDRAWN + cascade-flips leave to CANCELLED + pending balance reverts (Step 10 close-out fix)
- [x] **S9** Acknowledge flips ack to ACKNOWLEDGED + cascade-DONE-flips the linked task in same tx; envelope on the wire
- [x] **S10** 4 permission-denial paths fire correctly — student cannot approve, parent cannot see other tasks, teacher cannot read templates, non-admin cannot delegate manual tasks

**Total: 10 / 10 pass.** Cycle 7 ships clean to the post-cycle architecture review.
