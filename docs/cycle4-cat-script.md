# CampusOS Cycle 4 — Customer Acceptance Test Script

**Cycle:** 4 (HR & Workforce Core)
**Step:** 10 of 10 — Vertical Slice Integration Test
**Last verified:** 2026-04-28 (against `tenant_demo` on `main`)
**Plan reference:** `docs/campusos-cycle4-implementation-plan.html` § Step 10

This is the manual walkthrough that exercises every layer of Cycle 4 — the HR-Employee identity bridge from Step 0, the 17 hr_* tables landed across Steps 1–4, the seeded employee / leave / certification / compliance state from Step 5, the 23 HR endpoints across Steps 6–7, the LeaveNotificationConsumer that republishes `hr.leave.coverage_needed` for Cycle 5 Scheduling, and the 7 HR web routes from Steps 8–9. The format mirrors `docs/cycle1-cat-script.md`, `docs/cycle2-cat-script.md`, and `docs/cycle3-cat-script.md`.

The verification below was captured live with the API, all Cycle 1–3 Kafka consumers, the LeaveNotificationConsumer, the audience-fan-out-worker, the gradebook-snapshot-worker, and the notification-delivery worker all running against the freshly-seeded demo tenant. Outputs are recorded inline so a reviewer can re-run the script and diff the results against this transcript.

The plan's 9 scenarios are bracketed by a Step 0 bridge-verification block (scenarios 0a–0d) that proves the Cycle 2 DEVIATION 4 mapping is fully retired before any HR business flow runs.

---

## Prerequisites

- Docker services up: `docker compose up -d` (Postgres, Redis, Kafka, Keycloak).
- All Cycle 1–3 schema + seed in place. The full reset for a fresh CAT run:

  ```bash
  docker exec campusos-postgres psql -U campusos -d campusos_dev \
    -c "DROP SCHEMA IF EXISTS tenant_demo CASCADE; DROP SCHEMA IF EXISTS tenant_test CASCADE;"
  pnpm --filter @campusos/database provision --subdomain=demo
  pnpm --filter @campusos/database provision --subdomain=test
  pnpm --filter @campusos/database seed                       # platform + 7 test users (Cycle 4 added vp@ + counsellor@)
  pnpm --filter @campusos/database exec tsx src/seed-iam.ts   # 444 perms, 6 roles, vp@/counsellor@ → Staff
  pnpm --filter @campusos/database seed:sis                   # SIS
  pnpm --filter @campusos/database seed:classroom             # Cycle 2
  pnpm --filter @campusos/database seed:messaging             # Cycle 3
  pnpm --filter @campusos/database seed:hr                    # Cycle 4 — bridges 4 employees + 7 data layers
  pnpm --filter @campusos/database exec tsx src/build-cache.ts
  ```

- API running: `pnpm --filter @campusos/api start:prod`. The API hosts every Kafka producer + consumer + delivery worker the CAT exercises, so it must be running before Scenario 1.

- Pre-create the 6 Cycle 4 dev topics on a fresh broker (the same auto-creation race that affects Cycle 3's audience-fan-out worker):

  ```bash
  for t in dev.hr.leave.requested dev.hr.leave.approved dev.hr.leave.rejected \
           dev.hr.leave.cancelled dev.hr.leave.coverage_needed dev.hr.certification.verified; do
    docker exec campusos-kafka /opt/kafka/bin/kafka-topics.sh \
      --bootstrap-server localhost:9092 --create --if-not-exists \
      --topic "$t" --partitions 3 --replication-factor 1
  done
  ```

- Web running (for the UI walkthrough lines): `pnpm --filter @campusos/web dev` at `http://localhost:3000`.

- Tokens stashed for the four personas under test:

  ```bash
  login() {
    curl -s -X POST http://localhost:4000/api/v1/auth/dev-login \
      -H "Content-Type: application/json" -H "X-Tenant-Subdomain: demo" \
      -d "{\"email\":\"$1\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])"
  }
  PRINCIPAL=$(login principal@demo.campusos.dev)   # School Admin (Sarah Mitchell)
  TEACHER=$(login teacher@demo.campusos.dev)       # Teacher (James Rivera)
  PARENT=$(login parent@demo.campusos.dev)         # Parent — no HR codes
  STUDENT=$(login student@demo.campusos.dev)       # Student — no HR codes
  COUNSELLOR=$(login counsellor@demo.campusos.dev) # Staff (Marcus Hayes)
  ```

  Every request below sends `X-Tenant-Subdomain: demo` and the appropriate `Authorization: Bearer …` token. Where the persona matters, the snippet shows it inline.

---

## Scenarios 0a–0d — Bridge verification (Cycle 2 DEVIATION 4 retired)

Step 0 of Cycle 4 retired the temporary HR-Employee identity mapping: the four soft-FK columns (`sis_class_teachers.teacher_employee_id`, `cls_grades.teacher_id`, `cls_lessons.teacher_id`, `cls_student_progress_notes.author_id`) used to hold `iam_person.id` directly; they now hold `hr_employees.id`. The first four CAT scenarios prove the bridge is intact before the HR business flow runs.

### 0a. `hr_employees` row count

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -t \
  -c "SELECT count(*) FROM tenant_demo.hr_employees;"
```

```
4
```

The 4 staff bridged by `seed-hr.ts`: Mitchell (`principal@`), Rivera (`teacher@`), Park (`vp@`), Hayes (`counsellor@`). The synthetic Platform Admin (`admin@`) is intentionally NOT bridged.

### 0b. Orphan check across all four bridged columns

```sql
SELECT 'sis_class_teachers' AS table, count(*) AS orphans
  FROM tenant_demo.sis_class_teachers t
 WHERE NOT EXISTS (SELECT 1 FROM tenant_demo.hr_employees e WHERE e.id = t.teacher_employee_id)
UNION ALL SELECT 'cls_grades', count(*) FROM tenant_demo.cls_grades t
  WHERE t.teacher_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM tenant_demo.hr_employees e WHERE e.id = t.teacher_id)
UNION ALL SELECT 'cls_lessons', count(*) FROM tenant_demo.cls_lessons t
  WHERE t.teacher_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM tenant_demo.hr_employees e WHERE e.id = t.teacher_id)
UNION ALL SELECT 'cls_student_progress_notes', count(*) FROM tenant_demo.cls_student_progress_notes t
  WHERE NOT EXISTS (SELECT 1 FROM tenant_demo.hr_employees e WHERE e.id = t.author_id);
```

```
           table            | orphans
----------------------------+---------
 sis_class_teachers         |       0
 cls_grades                 |       0
 cls_lessons                |       0
 cls_student_progress_notes |       0
```

Every value in every bridged column resolves to a real `hr_employees` row.

### 0c. Tenant base table count

```sql
SELECT count(*) FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'tenant_demo' AND c.relkind IN ('r','p') AND c.relispartition = false;
```

```
74
```

Cycle 3 left 57; Cycle 4 added 17 (`hr_employees` + 5 in Step 1 + 3 in Step 2 + 5 in Step 3 + 3 in Step 4).

### 0d. Cross-schema FKs from `tenant_demo`

```sql
SELECT count(*) FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace nt ON nt.oid = t.relnamespace
  JOIN pg_class r ON r.oid = c.confrelid JOIN pg_namespace nr ON nr.oid = r.relnamespace
 WHERE c.contype = 'f' AND nt.nspname = 'tenant_demo' AND nr.nspname <> 'tenant_demo';
```

```
0
```

ADR-001/020 holds: zero DB-enforced FKs from a tenant table to anything outside `tenant_demo`.

---

## Scenario 1 — Admin views the staff directory

The plan's "admin creates an employee" beat is exercised through the seeded directory, since `seed-hr.ts` seeded the 4 employees the directory needs to display. (The admin-create endpoint itself is exercised separately in Step 6's smoke; here we verify the read path.)

```bash
curl -s -H "Authorization: Bearer $PRINCIPAL" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/employees | jq '.[] | {fullName, employeeNumber, primaryPositionTitle, email}'
```

```
count=4
  Marcus Hayes             EMP-1004   Counsellor                counsellor@demo.campusos.dev
  Sarah Mitchell           EMP-1001   Principal                 principal@demo.campusos.dev
  Linda Park               EMP-1003   Vice Principal            vp@demo.campusos.dev
  James Rivera             EMP-1002   Teacher                   teacher@demo.campusos.dev
```

UI walkthrough: log in as `principal@demo.campusos.dev` at `http://localhost:3000`, click the **Staff** tile on the launchpad. The 4 employees appear in the directory list with avatar, name, position, employee number, and email. The Step 5 unassigned **Administrative Assistant** position has no holder, so it doesn't appear in this list (it shows up only on `/positions` for admins).

---

## Scenario 2 — Employee views own profile

`GET /employees/me` resolves the calling user's `hr_employees` row via `actor.employeeId` (populated by `ActorContextService` in Step 0). Rivera sees their full profile: position, certifications (3 verified), and balances. Note Teaching Licence at `daysUntilExpiry=60` — the dynamic seed expiry that drives the CAT amber row.

```bash
curl -s -H "Authorization: Bearer $TEACHER" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/employees/me
```

```
fullName=James Rivera employeeNumber=EMP-1002
primaryPositionTitle=Teacher hireDate=2021-08-23
positions[0]=Teacher fte=1
```

```bash
curl -s -H "Authorization: Bearer $TEACHER" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/employees/$RIVERA/certifications
```

```
TEACHING_LICENCE         VERIFIED  expiry=2026-06-27 daysUntilExpiry=60
SAFEGUARDING_LEVEL1      VERIFIED  expiry=2027-01-12 daysUntilExpiry=259
FIRST_AID                VERIFIED  expiry=2027-04-15 daysUntilExpiry=352
```

```bash
curl -s -H "Authorization: Bearer $TEACHER" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/leave/me/balances
```

```
Bereavement Leave              accrued=5  used=0  pending=0  available=5
Personal Leave                 accrued=3  used=0  pending=0  available=3
Professional Development       accrued=5  used=0  pending=1  available=4
Sick Leave                     accrued=10 used=2  pending=0  available=8
Unpaid Leave                   accrued=0  used=0  pending=0  available=0
```

The PD `pending=1` is the seeded PENDING request. The Sick `used=2` is the seeded APPROVED 2-day Sick request from March. UI: the teacher logs in, clicks the **Staff** tile, then clicks their own row (or hits `/staff/me` which redirects). The tabbed profile shows Info / Certifications / Leave / Documents — the Certifications tab surfaces the green/amber/red urgency pills, and the Teaching Licence row carries an amber `Expiring` pill.

---

## Scenario 3 — Employee submits a new leave request

Rivera submits a 1-day Sick request for `2026-06-15`. The schema-layer non-negative `pending_chk` doesn't fire here (balance only goes up); the path lives in `LeaveService.submit` which bumps `pending` inside `executeInTenantTransaction` then emits `hr.leave.requested`.

```bash
curl -s -X POST -H "Authorization: Bearer $TEACHER" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"leaveTypeId":"<sick-leave-id>","startDate":"2026-06-15","endDate":"2026-06-15","daysRequested":1,"reason":"Medical appointment"}' \
  http://localhost:4000/api/v1/leave-requests
```

```json
{
  "id":"019dd548-d1b6-7666-af87-af3a8d0ad89a",
  "status":"PENDING",
  "daysRequested":1,
  "reason":"Medical appointment",
  "startDate":"2026-06-15",
  "endDate":"2026-06-15"
}
```

Balance immediately reflects the bump:

```
Sick Leave  accrued=10  used=2  pending=1  available=7
```

UI: teacher clicks the **Leave** tile → **New request** → fills the form (Sick Leave / 2026-06-15 / 2026-06-15 / 1 day / "Medical appointment"). On submit, the toast "Leave request submitted" appears and the page navigates back to `/leave` where the new row sits at the top of the request list with a `pending` pill. The Sick balance card shows `available=7` and the two-tone progress bar gains a small amber `pending` segment.

---

## Scenario 4 — `hr.leave.requested` envelope verified on the wire

ADR-057 envelope, source_module=hr, full payload inline. Captured from Kafka:

```bash
docker exec campusos-kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic dev.hr.leave.requested \
  --from-beginning --timeout-ms 6000 2>/dev/null | grep "$REQ_ID"
```

```json
{
  "event_id":"019dd548-d1c3-7666-af87-b0e29c0e2f11",
  "event_type":"hr.leave.requested",
  "event_version":1,
  "occurred_at":"2026-04-28T18:10:12.547Z",
  "published_at":"2026-04-28T18:10:12.547Z",
  "tenant_id":"019dc92b-ea59-7bb7-aa7f-929729562010",
  "source_module":"hr",
  "correlation_id":"019dd548-d1c3-7666-af87-bc6250d220ea",
  "payload":{
    "requestId":"019dd548-d1b6-7666-af87-af3a8d0ad89a",
    "employeeId":"019dd544-85e6-7997-b89d-099bf973ba2b",
    "accountId":"019dc92d-0882-7442-abf5-e33e03046357",
    "leaveTypeId":"019dd544-8608-7997-b89d-6fe5885a36ca",
    "leaveTypeName":"Sick Leave",
    "startDate":"2026-06-15","endDate":"2026-06-15",
    "daysRequested":1,
    "reason":"Medical appointment",
    "status":"PENDING"
  }
}
```

The `LeaveNotificationConsumer` (group `leave-notification-consumer`) consumed this and enqueued one IN_APP notification per school admin into `msg_notification_queue` — verified by Scenario 7's notification check.

---

## Scenario 5 — Admin approves the request

`PATCH /leave-requests/:id/approve` is admin-only at the service layer. The transaction does both: decrements `pending`, increments `used`, then emits `hr.leave.approved`.

```bash
curl -s -X PATCH -H "Authorization: Bearer $PRINCIPAL" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"reviewNotes":"Approved — feel better"}' \
  http://localhost:4000/api/v1/leave-requests/$REQ_ID/approve
```

```json
{
  "status":"APPROVED",
  "reviewedBy":"019dc92d-087d-7442-abf5-d16bc2fe960d",
  "reviewedAt":"2026-04-28T18:11:19.004Z",
  "reviewNotes":"Approved — feel better"
}
```

UI: the principal clicks the **Leave** tile → **Approvals** (admin-only). The PENDING request appears with Rivera's name, the dates, and the reason. Click **Approve** → modal opens with optional review-notes textarea → type "Approved — feel better" → click **Approve** primary CTA. Toast "Approved 1d Sick Leave"; the row drops out of the queue.

---

## Scenario 6 — Balance update + `hr.leave.approved` envelope + `hr.leave.coverage_needed` republish

Balance reflects the approve transaction (Sick `used` 2 → 3, `pending` 1 → 0):

```
Sick Leave  accrued=10  used=3  pending=0  available=7
```

`hr.leave.approved` envelope on the wire:

```json
{
  "event_id":"019dd549-d565-7666-af87-ee8c13cb9ae8",
  "event_type":"hr.leave.approved",
  "tenant_id":"019dc92b-ea59-7bb7-aa7f-929729562010",
  "source_module":"hr",
  "payload":{
    "requestId":"019dd548-d1b6-7666-af87-af3a8d0ad89a",
    "leaveTypeName":"Sick Leave",
    "startDate":"2026-06-15","endDate":"2026-06-15",
    "daysRequested":1,
    "reviewedBy":"019dc92d-087d-7442-abf5-d16bc2fe960d",
    "reviewedAt":"2026-04-28T18:11:19.004Z",
    "status":"APPROVED"
  }
}
```

The `LeaveNotificationConsumer` consumes this, enqueues a `leave.approved` IN_APP notification for the submitter (Rivera), and **republishes `hr.leave.coverage_needed`** with all 6 of Rivera's class assignments inline (resolved via `sis_class_teachers`):

```json
{
  "event_id":"019dd549-d572-7666-af88-00daf92bfec6",
  "event_type":"hr.leave.coverage_needed",
  "source_module":"hr",
  "payload":{
    "requestId":"019dd548-d1b6-7666-af87-af3a8d0ad89a",
    "startDate":"2026-06-15","endDate":"2026-06-15",
    "affectedClasses":[
      {"classId":"019dd544-…","sectionCode":"1","courseName":"Algebra 1"},
      {"classId":"019dd544-…","sectionCode":"2","courseName":"English 9"},
      {"classId":"019dd544-…","sectionCode":"3","courseName":"Biology"},
      {"classId":"019dd544-…","sectionCode":"4","courseName":"World History"},
      {"classId":"019dd544-…","sectionCode":"5","courseName":"Geometry"},
      {"classId":"019dd544-…","sectionCode":"6","courseName":"Chemistry"}
    ]
  }
}
```

When Cycle 5 Scheduling lands, its consumer subscribes to `hr.leave.coverage_needed` and produces substitute assignments. For Cycle 4 the contract is publish-only; nothing else consumes the topic yet.

---

## Scenario 7 — Notifications enqueued for admins (requested) + submitter (approved)

`msg_notification_queue` shows three rows landed by the consumer + drained by `NotificationDeliveryWorker`. All three are `SENT` (delivered to Redis ZADD inbox per the Cycle 3 worker contract).

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
SELECT u.email, q.notification_type, q.status, q.created_at::time AS created
FROM tenant_demo.msg_notification_queue q
JOIN platform.platform_users u ON u.id = q.recipient_id
WHERE q.notification_type LIKE 'leave.%'
ORDER BY q.created_at DESC;"
```

```
            email            | notification_type | status |     created
-----------------------------+-------------------+--------+-----------------
 teacher@demo.campusos.dev   | leave.approved    | SENT   | 18:11:19.020593
 principal@demo.campusos.dev | leave.requested   | SENT   | 18:10:12.575785
 admin@demo.campusos.dev     | leave.requested   | SENT   | 18:10:12.571126
```

UI: the teacher's notification bell (top-right) ticks up by one as the `leave.approved` row hits Redis. Clicking the bell reveals the new notification with the leave-type, the date, and a deep link to `/leave`. The principal sees one `leave.requested` notification on submit + one self-`leave.approved` if they happen to be Mitchell (the same `iam_person` the Step 5 seed wires into the approval path). The Platform Admin (`admin@`) sees the `leave.requested` notification too — they hold `sch-001:admin` via the platform scope chain.

---

## Scenario 8 — Compliance dashboard + amber row

```bash
curl -s -H "Authorization: Bearer $PRINCIPAL" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/compliance/dashboard
```

```
totalEmployees=4 employeesWithGaps=2
  Marcus Hayes             Counsellor               total=0 compliant=0 amber=0 red=0
  Sarah Mitchell           Principal                total=1 compliant=0 amber=0 red=1
  Linda Park               Vice Principal           total=0 compliant=0 amber=0 red=0
  James Rivera             Teacher                  total=3 compliant=2 amber=1 red=0
```

Per-employee detail for Rivera:

```bash
curl -s -H "Authorization: Bearer $TEACHER" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/employees/$RIVERA_ID/compliance
```

```
James Rivera  total=3  compliant=2  amber=1  red=0
  Annual Safeguarding Refresh    urgency=green  compliant=true  daysUntilDue=259
  First Aid Recertification      urgency=green  compliant=true  daysUntilDue=351
  Teaching Licence Renewal       urgency=amber  compliant=false daysUntilDue=60
```

`/certifications/expiring-soon`:

```
Texas Standard Teaching Licence    expiry=2026-06-27  days=60
```

UI: the principal clicks the **Compliance** tile (admin-only — hidden for everyone else). The dashboard shows 4 employees / 2 with gaps / 50 % compliant. Filter chip **Has gaps** narrows to Mitchell + Rivera. Click **Details** on Rivera's row to expand the per-requirement breakdown — Teaching Licence Renewal carries the amber `Expiring` pill. Click **View profile** → `/staff/$RIVERA_ID` → the **Certifications** tab, where the same amber pill appears on the Teaching Licence card.

---

## Scenario 9 — Permission denials

Five denial paths exercise the global `PermissionGuard` + the service-layer admin checks.

### 9a. teacher@ filtering the leave queue with `?employeeId=other` is silently scoped to own rows (200, no leak)

```bash
curl -s -H "Authorization: Bearer $TEACHER" -H "X-Tenant-Subdomain: demo" \
  "http://localhost:4000/api/v1/leave-requests?status=PENDING&employeeId=$MITCHELL_ID"
```

```
HTTP 200 — teacher passing employeeId=Mitchell → got 1 rows (own-only filter strips it)
```

`LeaveService.list` short-circuits non-admins to their own `employee_id` regardless of the supplied filter, so the teacher sees only their own PENDING — never another employee's. This is the right behaviour: the API doesn't 403 on a benign read attempt; it just restricts the row scope. The actual approval *write* path is the gated one (9b).

### 9b. teacher@ tries to approve their own request (admin-only at the service layer)

```bash
curl -s -X PATCH -H "Authorization: Bearer $TEACHER" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" -d '{}' \
  http://localhost:4000/api/v1/leave-requests/$OWN_REQ/approve
```

```
{"message":"Only admins can approve leave requests","error":"Forbidden","statusCode":403}
```

### 9c. teacher@ tries to verify a certification (admin-only — `hr-004:write` is admin-only per Step 5 seed)

```bash
curl -s -X PATCH -H "Authorization: Bearer $TEACHER" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" -d '{"status":"VERIFIED"}' \
  http://localhost:4000/api/v1/certifications/$RIVERA_LICENCE/verify
```

```
{"statusCode":403,"error":"INSUFFICIENT_PERMISSIONS","message":"You do not have the required permission for this action","required":["hr-004:write"]}
```

### 9d. teacher@ tries the compliance dashboard (admin-only at the service layer)

```bash
curl -s -H "Authorization: Bearer $TEACHER" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/compliance/dashboard
```

```
{"message":"Only admins can read the compliance dashboard","error":"Forbidden","statusCode":403}
```

### 9e. parent@ tries the staff directory (no `hr-001:read`)

```bash
curl -s -H "Authorization: Bearer $PARENT" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/employees
```

```
{"statusCode":403,"error":"INSUFFICIENT_PERMISSIONS","message":"You do not have the required permission for this action","required":["hr-001:read"]}
```

### 9f. student@ tries leave types (no `hr-003:read`)

```bash
curl -s -H "Authorization: Bearer $STUDENT" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/leave-types
```

```
{"statusCode":403,"error":"INSUFFICIENT_PERMISSIONS","message":"You do not have the required permission for this action","required":["hr-003:read"]}
```

UI: the parent and student log in and the launchpad has no Staff / Leave / Compliance tile. Direct URL guesses (`/staff`, `/leave`, etc.) hit the global `PermissionGuard` and surface the 403 body above. The teacher sees the Staff and Leave tiles but not the Compliance tile.

---

## Scenario summary

| #  | Scenario                                                                  | Outcome  |
| -- | ------------------------------------------------------------------------- | -------- |
| 0a | hr_employees row count                                                    | 4 ✅       |
| 0b | Bridge orphan check (4 columns)                                           | 0 / 0 / 0 / 0 ✅ |
| 0c | Tenant base table count                                                   | 74 ✅      |
| 0d | Cross-schema FKs from tenant_demo                                          | 0 ✅       |
| 1  | principal@ GET /employees                                                  | 4 employees, ordered by last name ✅ |
| 2  | teacher@ profile + certifications + balances                                | Rivera profile, 3 verified certs, balances correct (PD pending=1, Sick used=2) ✅ |
| 3  | teacher@ submits 1-day Sick                                                | 201 PENDING; balance pending bumps 0 → 1 ✅ |
| 4  | hr.leave.requested envelope on the wire                                    | source_module=hr, full payload inline ✅ |
| 5  | principal@ approves                                                        | 200 APPROVED; reviewedBy + reviewedAt set ✅ |
| 6  | Balance update + hr.leave.approved + hr.leave.coverage_needed              | Sick used 2 → 3, pending 1 → 0; coverage envelope contains all 6 of Rivera's classes ✅ |
| 7  | Notifications enqueued (2 admins on requested + Rivera on approved)        | 3 rows SENT in msg_notification_queue ✅ |
| 8  | Compliance dashboard amber row + Rivera's per-employee detail              | totalEmployees=4 employeesWithGaps=2; Teaching Licence amber at 60d ✅ |
| 9a | teacher@ leave queue is own-rows-only (no leak)                            | 1 row ✅ |
| 9b | teacher@ approve attempt → 403 service-layer admin check                   | "Only admins can approve leave requests" ✅ |
| 9c | teacher@ certification verify → 403 hr-004:write gate                      | "INSUFFICIENT_PERMISSIONS required hr-004:write" ✅ |
| 9d | teacher@ compliance dashboard → 403 service-layer admin check              | "Only admins can read the compliance dashboard" ✅ |
| 9e | parent@ /employees → 403 hr-001:read gate                                  | "INSUFFICIENT_PERMISSIONS required hr-001:read" ✅ |
| 9f | student@ /leave-types → 403 hr-003:read gate                                | "INSUFFICIENT_PERMISSIONS required hr-003:read" ✅ |

All 16 checks (4 bridge + 12 plan scenarios) pass.

---

## Cycle 4 exit checklist (from the plan)

1. ✅ HR-Employee identity migration complete. Bridge verified (Scenarios 0a–0d).
2. ✅ Tenant schema: 17 new HR tables across Steps 0–4. Total tenant tables: 74.
3. ✅ Employee API: 12 endpoints in Step 6 with row-level auth (own profile vs admin).
4. ✅ Leave API: 7 endpoints + 4 Kafka events for the lifecycle (Scenarios 3–6).
5. ✅ Certification API: 4 endpoints + expiry sweep (Scenarios 2, 8).
6. ✅ Compliance dashboard with school-wide training status (Scenario 8).
7. ✅ Staff Directory UI: searchable employee list, tabbed profile (Scenarios 1–2).
8. ✅ Leave UI: request form, balance view, admin approval queue (Scenarios 3, 5).
9. ✅ Vertical slice test: all scenarios pass (this script).
10. ✅ HANDOFF-CYCLE4.md and CLAUDE.md updated. CI green.

---

## Latent bugs caught and fixed during the cycle

The CAT didn't surface any new bugs on its final run, but the Step 7 approval-flow smoke caught one bug that **would** have tripped the cancel scenario:

**Bug:** Step 5's `seed-hr.ts` seeded Rivera's Professional Development `hr_leave_balances.pending=0` while *also* seeding a PENDING PD request for `days_requested=1.0`. The two were inconsistent. When the cancel path subtracted 1 from `pending=0`, the migration-012 `pending_chk >= 0` correctly fired and rejected the underflow with SQLSTATE 23514 — exactly the contract Step 2's "Approval flow at the schema layer" note documented ("if Step 7's update would underflow `pending` or `used`, the UPDATE fails loudly rather than silently corrupting the running totals").

**Fix:** `seed-hr.ts::balanceFor` now sets Rivera's PD balance to `{ accrued: spec.accrualRate, used: 0, pending: 1.0 }` to match the seeded PENDING request. The same edit reset Rivera's Personal Leave to `used=0 pending=0` since no Personal request was ever seeded — those non-zeros were stale. The fix is baked into the Step 7 commit (`70b6cf3`); on a fresh provision, `seed:hr` produces the correct shape from the start, and the cancel path works without any in-flight patching.

The CHECK is doing its job; the seed had drifted. This is the same shape of bug the Cycle 3 CAT caught (`c.title` → `co.name` in three notification consumers): an integration smoke that exercises a code path the unit-level steps didn't drive surfaces a real-world inconsistency. Both are tracked in their respective HANDOFF docs.

---

## Out-of-scope for the CAT

- **No `hr.certification.expiring` alert emit.** The plan calls for 90 / 30 / 7-day pre-expiry reminders. Step 7 lands the partial-index-backed read (`/certifications/expiring-soon`) and the `hr.certification.verified` emit, but the scheduled job that fires `hr.certification.expiring` per row at the right thresholds is reserved for a future ops follow-up alongside the day-end accrual job.
- **No leave-balance accrual job.** Year-start accrual is reserved for a future scheduled task. The seed sets balances explicitly; the request path's `upsertBalance` helper materialises a balance row from the type's `accrual_rate` if one doesn't exist.
- **No `hr.leave.coverage_needed` consumer.** The CAT verifies that the topic publishes with the right payload. Cycle 5 Scheduling will add the consumer; the contract is publish-only for Cycle 4.
- **No emergency-contact / work-authorisation flows.** Schemas exist; no API surface; no UI. Reserved for a later iteration.
- **No CPD completion flow.** `hr_cpd_requirements` schema is in place; `hr_cpd_completions` is not.
- **No upload pipeline for documents.** `EmployeeDocumentService.create` accepts a pre-uploaded `s3Key`; the actual presign + PUT flow is reserved for Phase 2.

---

## Closeout

After this CAT runs successfully, the Cycle 4 closeout commit:

1. Lands `docs/cycle4-cat-script.md` (this file).
2. Updates `CLAUDE.md` with all 10 steps marked done and the Phase 3 status line moved to "Cycle 4 COMPLETE — Cycles 5–8 next".
3. Updates `HANDOFF-CYCLE4.md` Step 10 row + section to reflect this script is in place.
4. Tags or notes the verification commit SHA so the post-cycle architecture review can diff from a known-good baseline.

The next cycle is **Cycle 5: Scheduling & Calendar** — master schedule, daily coverage, substitute management, room booking. The `hr.leave.coverage_needed` topic published in Scenario 6 is the first event Cycle 5's substitute-assignment consumer will subscribe to.
