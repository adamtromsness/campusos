# CampusOS Cycle 3 — Customer Acceptance Test Script

**Cycle:** 3 (Communications)
**Step:** 11 of 11 — Vertical Slice Integration Test
**Last verified:** 2026-04-27 (against `tenant_demo` on `main`)
**Plan reference:** `docs/campusos-cycle3-implementation-plan.html` § Step 11

This is the manual walkthrough that exercises every layer of Cycle 3 — direct messaging with content moderation, audience-targeted announcements with read tracking, and the notification pipeline that closes the loop on every Kafka event from Cycles 1 and 2 (attendance, grading, progress notes, absence requests). It is the third CAT for CampusOS, layered on top of the Cycle 1 SIS + Attendance and Cycle 2 Classroom + Grading foundations. The format mirrors `docs/cycle1-cat-script.md` and `docs/cycle2-cat-script.md`.

The verification below was captured live with the API, all 6 Kafka consumers, the announcements audience-fan-out worker, the gradebook-snapshot worker, and the notification-delivery worker all running against the demo seed. Outputs are recorded inline so a reviewer can re-run the script and diff the results against this transcript.

---

## Prerequisites

- Docker services up: `docker compose up -d` (Postgres, Redis, Kafka, Keycloak).
- API running: `pnpm --filter @campusos/api dev` (watch mode). The API hosts every Kafka producer + consumer + delivery worker the CAT exercises, so it must be running before Scenario 1.
- Web running (for the UI walkthrough lines): `pnpm --filter @campusos/web dev` at `http://localhost:3000`.
- Seed pipeline current:

  ```bash
  pnpm --filter @campusos/database seed                       # platform + 5 test users + tenant_demo
  pnpm --filter @campusos/database exec tsx src/seed-iam.ts   # 444 perms, 6 roles
  pnpm --filter @campusos/database seed:sis                   # SIS — students, classes, attendance
  pnpm --filter @campusos/database seed:classroom             # Cycle 2 — assignments, grades, snapshots
  pnpm --filter @campusos/database seed:messaging             # Cycle 3 — thread types, threads, alert types, prefs, announcements
  pnpm --filter @campusos/database exec tsx src/build-cache.ts
  ```

- Tokens stashed for the four personas under test:

  ```bash
  for who in teacher parent student principal; do
    curl -s -X POST http://localhost:4000/api/v1/auth/dev-login \
      -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' \
      -d "{\"email\":\"$who@demo.campusos.dev\"}" \
      | python3 -c 'import sys,json; print(json.load(sys.stdin)["accessToken"])' \
      > /tmp/${who}_token
  done
  ```

The IDs in the captured outputs (`019dcf66-4bf5-…` for P1 Algebra, `019dcf66-4c0b-…` for Maya Chen, `019dc92d-088d-…` for David Chen the parent, etc.) are stable across re-seeds because UUIDv7 generation is deterministic from the seed timestamp; if your seed run differs, substitute your own.

### One-time setup for the CAT — clear David's quiet hours

The seed sets David Chen's `attendance.tardy` / `grade.published` / `message.posted` / `announcement.published` notification preferences to **quiet hours 22:00–07:00 UTC** so the demo data realistically demonstrates the quiet-window mechanic. If the CAT runs inside that window (e.g. mid-day in the Americas), `NotificationQueueService.enqueue()` correctly defers `scheduled_for` to 07:00 UTC and the delivery worker correctly skips every row. To exercise the end-to-end loop in Scenarios 1–5 we clear David's quiet-window for the duration of the run and restore it on EXIT:

```bash
PARENT_ACCT=019dc92d-088d-7442-abf6-089e5d9460ee
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "UPDATE tenant_demo.msg_notification_preferences \
   SET quiet_hours_start=NULL, quiet_hours_end=NULL, updated_at=now() \
   WHERE platform_user_id='${PARENT_ACCT}'::uuid"
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "UPDATE tenant_demo.msg_notification_queue SET scheduled_for=now(), updated_at=now() \
   WHERE recipient_id='${PARENT_ACCT}'::uuid AND status='PENDING' AND scheduled_for > now()"

trap "docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  \"UPDATE tenant_demo.msg_notification_preferences \
    SET quiet_hours_start='22:00'::time, quiet_hours_end='07:00'::time, updated_at=now() \
    WHERE platform_user_id='${PARENT_ACCT}'::uuid\"" EXIT
```

The full harness lives at `/tmp/cat-cycle3.sh` in the verification environment; the rest of this document walks through each scenario in order with the captured outputs.

---

## Scenario 1 — Notification from attendance

**UI:** open `http://localhost:3000`, log in as **Teacher (James Rivera)**, click **Period 1 — Algebra 1**, switch to the **Attendance** tab, mark **Maya Chen** as **Tardy** with explanation `Late from previous period`, then click **Submit**. Sign out, log in as **Parent (David Chen)**. The notification bell in the top bar shows a red badge. Click the bell — the dropdown shows `Attendance — Maya Chen — Tardy in Period 1 Algebra 1` at the top. Click the row — it deep-links to the child attendance page.

**API verification (teacher marks Maya tardy via the batch endpoint):**

```bash
TEACHER=$(cat /tmp/teacher_token); PARENT=$(cat /tmp/parent_token)
P1_ALGEBRA=019dcf66-4bf5-7cc2-81e4-dfcfcf400af4
MAYA=019dcf66-4c0b-7cc2-81e5-425b0b83028e
DATE=$(date -u +%Y-%m-%d)

curl -s -X POST "http://localhost:4000/api/v1/classes/$P1_ALGEBRA/attendance/$DATE/batch" \
  -H "Authorization: Bearer $TEACHER" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d "{\"period\":\"1\",\"records\":[{\"studentId\":\"$MAYA\",\"status\":\"TARDY\",\"parentExplanation\":\"Late from previous period\"}]}"
```

```json
{
  "classId": "019dcf66-4bf5-7cc2-81e4-dfcfcf400af4",
  "date": "2026-04-28",
  "period": "1",
  "totalStudents": 8,
  "presentCount": 7,
  "tardyCount": 1,
  "absentCount": 0,
  "earlyDepartureCount": 0,
  "excusedCount": 0,
  "confirmedAt": "2026-04-28T01:27:07.858Z"
}
```

Wait ~14s for Kafka delivery + the 10s notification-delivery-worker poll cycle, then read the parent's bell inbox:

```bash
curl -s 'http://localhost:4000/api/v1/notifications/inbox?limit=10' \
  -H "Authorization: Bearer $PARENT" -H 'X-Tenant-Subdomain: demo'
```

```text
unreadCount = 15
  attendance.tardy           student=Maya Chen      status=TARDY    read=False
  message.posted             student=?              status=?        read=False
  grade.published            student=Maya Chen      status=?        read=False
  attendance.tardy           student=Maya Chen      status=TARDY    read=False
  announcement.published     student=?              status=?        read=False
```

✅ **Pass.** The pipeline closes: `att.student.marked_tardy` (envelope-wrapped, env-prefixed `dev.…`) is consumed by `AttendanceNotificationConsumer`, which resolves the portal-enabled guardians of Maya via `sis_student_guardians` and enqueues a `attendance.tardy` row in `msg_notification_queue`. `NotificationDeliveryWorker` polls every 10s, marks the row `SENT`, ZADDs into `notif:inapp:{accountId}`, and writes a `msg_notification_log` row with `channel='IN_APP' status='DELIVERED'`. The parent's bell endpoint reads the Redis sorted set and renders the row at the top.

The matching queue row is visible directly:

```text
 notification_type | status |             recipient_id
-------------------+--------+--------------------------------------
 attendance.tardy  | SENT   | 019dc92d-088d-7442-abf6-089e5d9460ee
```

---

## Scenario 2 — Notification from grading

**UI:** sign back in as Teacher. Open **Period 1 — Algebra 1 → Gradebook → Quadratics Homework Set**. The grade for Maya already exists from the seed; toggle **Unpublish** then **Publish** to fire a fresh `cls.grade.published`. Sign out, log in as **Parent**. The bell badge bumps. The new row reads `Grade published — Maya Chen — Quadratics Homework Set 88%`. Click → `/children/:id/grades/:classId`.

**API verification (re-publish to force a fresh emit, then read parent + student history):**

```bash
GRADE_ID=019dcf66-4f4b-7334-9009-44d910a7a8b7
curl -s -X POST "http://localhost:4000/api/v1/grades/$GRADE_ID/unpublish" \
  -H "Authorization: Bearer $TEACHER" -H 'X-Tenant-Subdomain: demo' > /dev/null
curl -s -X POST "http://localhost:4000/api/v1/grades/$GRADE_ID/publish"   \
  -H "Authorization: Bearer $TEACHER" -H 'X-Tenant-Subdomain: demo' > /dev/null

# After ~14s
STUDENT=$(cat /tmp/student_token)
for who in PARENT STUDENT; do
  curl -s 'http://localhost:4000/api/v1/notifications/history?limit=10&type=grade.published' \
    -H "Authorization: Bearer $(eval echo \$$who)" -H 'X-Tenant-Subdomain: demo'
done
```

```text
parent: grade.published rows = 2 (newest first)
  Quadratics Homework Set        score=88
  Quadratics Homework Set        score=88
student: grade.published rows = 3 (newest first)
  Quadratics Homework Set        score=88
  Quadratics Homework Set        score=88
  Linear Equations Quiz          score=92
```

✅ **Pass.** `GradeNotificationConsumer` runs after `cls.grade.published` is delivered and fans out to every portal-enabled guardian of the student plus the student's own account (resolved via `sis_students → platform_students → platform_users`). The history endpoint paginates `msg_notification_queue` directly so the rows surface even if the user already cleared their bell.

---

## Scenario 3 — Direct messaging

**UI:** sign back in as Teacher. Click **Messages** in the sidebar → **New message**. Pick `Teacher ↔ Parent`, search for `David`, check his row. Subject: `Maya — quick check-in`. Body: `Hi David — Maya did a great job on today's quiz. Wanted to give you a heads up.` Click **Send**. The page routes to `/messages/:threadId`. Sign out, log in as **Parent**. The Messages sidebar shows a `1` badge. Click it. The inbox row is bold with the new subject + sender + preview. Click the row — the thread renders oldest-first, mark-read fires automatically. Type the reply `Thanks for letting me know — really appreciate it.` and click **Send**.

**API verification:**

```bash
TP_TYPE=$(curl -s http://localhost:4000/api/v1/threads/types \
  -H "Authorization: Bearer $TEACHER" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c "import sys,json; print([t['id'] for t in json.load(sys.stdin) if t['name']=='TEACHER_PARENT'][0])")
PARENT_ACCT=019dc92d-088d-7442-abf6-089e5d9460ee

THREAD_RESP=$(curl -s -X POST http://localhost:4000/api/v1/threads \
  -H "Authorization: Bearer $TEACHER" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d "{\"threadTypeId\":\"$TP_TYPE\",\"subject\":\"Maya — quick check-in\",
        \"participants\":[{\"platformUserId\":\"$PARENT_ACCT\"}],
        \"initialMessage\":\"Hi David — Maya did a great job on today's quiz. Wanted to give you a heads up.\"}")
THREAD_ID=$(echo "$THREAD_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')

# Parent inbox now reflects the new thread
curl -s 'http://localhost:4000/api/v1/threads' -H "Authorization: Bearer $PARENT" -H 'X-Tenant-Subdomain: demo'
# Parent posts the reply
curl -s -X POST "http://localhost:4000/api/v1/threads/$THREAD_ID/messages" \
  -H "Authorization: Bearer $PARENT" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d '{"body":"Thanks for letting me know — really appreciate it."}'
# After ~14s for the message-notification-consumer + delivery worker
curl -s -X POST "http://localhost:4000/api/v1/threads/$THREAD_ID/read" \
  -H "Authorization: Bearer $TEACHER" -H 'X-Tenant-Subdomain: demo'
```

```text
Created thread: 019dd1b2-ec6c-7bb0-9df2-6642a3b5bb18
  subject='Maya — quick check-in'  unreadCount=2
  preview="Hi David — Maya did a great job on today's quiz. Wanted to g…"  sender=James Rivera

(after parent reply)
Teacher inbox row:
  subject='Maya — quick check-in'  unreadCount=2
  preview="Thanks for letting me know — really appreciate it.…"  sender=David Chen
message.posted history rows for this thread: 1
  sender=David Chen  preview="Thanks for letting me know — really appreciate it."

mark-read response: {"threadId":"…","marked":1,"unreadCount":0}
```

✅ **Pass.** The thread create with `initialMessage` POSTs to `/threads` then internally calls `MessageService.post()` so the moderation interceptor + Kafka emit run on the first message. The reply emits `msg.message.posted` which `MessageNotificationConsumer` fans out to non-sender thread participants — including the teacher — and bumps the per-(user, thread) unread counter in Redis. `POST /threads/:id/read` is idempotent: marks the unread `msg_messages` rows read, ZREMs the per-thread Redis HASH entry, and returns the new badge.

---

## Scenario 4 — Content moderation

**UI:** in the same thread (`Maya — quick check-in`), as **Parent**, type `that test was utter shit` and click **Send**. The message bubble does NOT appear; an error toast surfaces: `This message was not sent because it contains content that violates school policy.` The thread does not refresh; the body field is preserved so the user can edit and retry.

**API verification (BLOCK keyword → 422 + moderation log row):**

```bash
curl -s -w "\nHTTP_CODE=%{http_code}\n" -X POST "http://localhost:4000/api/v1/threads/$THREAD_ID/messages" \
  -H "Authorization: Bearer $PARENT" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d '{"body":"that test was utter shit"}'
```

```text
{"message":"This message was not sent because it contains content that violates school policy.","error":"Unprocessable Entity","statusCode":422}
HTTP_CODE=422
```

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "SELECT flag_type, severity, matched_keywords FROM tenant_demo.msg_moderation_log \
   WHERE thread_id='${THREAD_ID}'::uuid AND flag_type='BLOCKED' ORDER BY created_at DESC LIMIT 1"
```

```text
 flag_type | severity | matched_keywords
-----------+----------+------------------
 BLOCKED   | URGENT   | {shit}
```

✅ **Pass.** `ContentModerationService.evaluate()` matches whole-word case-insensitive against the active `msg_moderation_policies` rows. The BLOCK action keyword `shit` (URGENT severity) wins via "most-restrictive-wins" precedence, the post path raises `UnprocessableEntityException` with the deliberately generic policy string (no keyword leak), and a `msg_moderation_log` row is inserted with the synthetic message id (no actual `msg_messages` row is created — moderator forensics survives without a real message body in the user-visible thread).

---

## Scenario 5 — Announcements

**UI:** sign in as **Principal (Sarah Mitchell)**. Click **Announcements → New announcement**. Title `Early Dismissal Friday`, body `School will dismiss at 12:30 PM this Friday for staff development. Buses will run on the early schedule.`, audience pill `All school`, click **Publish now**. The page routes to `/announcements/:id`; the header shows the audience pill + Published timestamp. The Stats panel below shows `Audience 5 · Read 0 · Delivered 5 · Pending/Failed 0/0` after the audience worker fans out (~10s). Sign out, log in as Teacher — Announcements feed shows the new row at the top with unread dot. Same for Parent and Student. As Parent, click the announcement, and the read bumps to 1; switch back to Principal and the stats refresh shows `Read 1 (20%)`.

**API verification:**

```bash
PRINCIPAL=$(cat /tmp/principal_token)
ANN=$(curl -s -X POST http://localhost:4000/api/v1/announcements \
  -H "Authorization: Bearer $PRINCIPAL" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d '{"title":"Early Dismissal Friday",
       "body":"School will dismiss at 12:30 PM this Friday for staff development. Buses will run on the early schedule.",
       "audienceType":"ALL_SCHOOL","isPublished":true}')
ANN_ID=$(echo "$ANN" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')

# After ~14s for the audience worker
curl -s "http://localhost:4000/api/v1/announcements/$ANN_ID/stats" \
  -H "Authorization: Bearer $PRINCIPAL" -H 'X-Tenant-Subdomain: demo'

for who in TEACHER PARENT STUDENT; do
  curl -s http://localhost:4000/api/v1/announcements \
    -H "Authorization: Bearer $(eval echo \$$who)" -H 'X-Tenant-Subdomain: demo' \
    | python3 -c "import sys,json; xs=json.load(sys.stdin); hits=[a for a in xs if a['id']=='$ANN_ID']; [print(f'$who: title={a[\"title\"]!r} audienceType={a[\"audienceType\"]} isRead={a[\"isRead\"]}') for a in hits]"
done

curl -s -X POST "http://localhost:4000/api/v1/announcements/$ANN_ID/read" \
  -H "Authorization: Bearer $PARENT" -H 'X-Tenant-Subdomain: demo'

curl -s "http://localhost:4000/api/v1/announcements/$ANN_ID/stats" \
  -H "Authorization: Bearer $PRINCIPAL" -H 'X-Tenant-Subdomain: demo'
```

```text
Created announcement: 019dd1b3-2921-7bb0-9df3-07eba8974779

stats (after fan-out, before any reads):
{"announcementId":"019dd1b3-…","totalAudience":5,"readCount":0,"readPercentage":0,
 "pendingCount":0,"deliveredCount":5,"failedCount":0}

Feeds:
TEACHER: title='Early Dismissal Friday' audienceType=ALL_SCHOOL isRead=False
PARENT:  title='Early Dismissal Friday' audienceType=ALL_SCHOOL isRead=False
STUDENT: title='Early Dismissal Friday' audienceType=ALL_SCHOOL isRead=False

Mark read:
{"announcementId":"019dd1b3-…","readAt":"2026-04-28T01:28:07.054Z","newlyRead":true}

stats (after parent's read):
{"announcementId":"019dd1b3-…","totalAudience":5,"readCount":1,"readPercentage":20,
 "pendingCount":0,"deliveredCount":5,"failedCount":0}
```

✅ **Pass.** `POST /announcements` with `isPublished=true` defaults `publishAt` to `now()` and emits `msg.announcement.published`. `AudienceFanOutWorker` resolves ALL_SCHOOL = every account with an active `iam_role_assignment` in the school+platform scope chain (5 in `tenant_demo` — Platform Admin, Principal, Teacher, Parent, Student). Each row is inserted into `msg_announcement_audiences` with `delivery_status='DELIVERED'`, then queued via `NotificationQueueService` so the bell + history surface them. `POST /announcements/:id/read` is idempotent (returns `newlyRead=false` on the second call) and flips the matching audience row from PENDING → DELIVERED if it wasn't already. Stats reflect the read instantly — `readPercentage = round(1/5 × 100, 2) = 20`.

---

## Scenario 6 — Notification preferences are honored

**UI:** the Step 8 plan reserves a `/notifications/preferences` UI for Phase 2 (Test & Refine). For now, prefs are mutated directly against `msg_notification_preferences` to prove the queue service honors them.

**API verification (snapshot before, disable, re-trigger, snapshot after):**

```bash
# Snapshot parent's attendance.tardy queue rows BEFORE
docker exec campusos-postgres psql -U campusos -d campusos_dev -t -A -c \
  "SELECT COUNT(*) FROM tenant_demo.msg_notification_queue \
   WHERE notification_type='attendance.tardy' AND recipient_id='${PARENT_ACCT}'::uuid"

# Disable parent's attendance.tardy preference
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "UPDATE tenant_demo.msg_notification_preferences \
   SET is_enabled=false, updated_at=now() \
   WHERE platform_user_id='${PARENT_ACCT}'::uuid AND notification_type='attendance.tardy'"

# Mark Maya tardy in Period 2 (different period to avoid the period-1 unique constraint)
curl -s -X POST "http://localhost:4000/api/v1/classes/$P1_ALGEBRA/attendance/$DATE/batch" \
  -H "Authorization: Bearer $TEACHER" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d "{\"period\":\"2\",\"records\":[{\"studentId\":\"$MAYA\",\"status\":\"TARDY\",\"parentExplanation\":\"Pref test\"}]}"

# After ~14s — count must be unchanged
docker exec campusos-postgres psql -U campusos -d campusos_dev -t -A -c \
  "SELECT COUNT(*) FROM tenant_demo.msg_notification_queue \
   WHERE notification_type='attendance.tardy' AND recipient_id='${PARENT_ACCT}'::uuid"

# Restore the preference
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "UPDATE tenant_demo.msg_notification_preferences \
   SET is_enabled=true, updated_at=now() \
   WHERE platform_user_id='${PARENT_ACCT}'::uuid AND notification_type='attendance.tardy'"
```

```text
Parent attendance.tardy queue rows BEFORE pref change: 3
UPDATE 1   (is_enabled flipped to false)
Period-2 tardy mark — counts: totalStudents=8 tardyCount=1 period=2
Parent attendance.tardy queue rows AFTER pref change:  3   (BEFORE was 3 — unchanged)
UPDATE 1   (is_enabled restored to true)
```

✅ **Pass.** `AttendanceNotificationConsumer` still runs (the Kafka event still fires), but `NotificationQueueService.enqueue()` reads the preferences row first; with `is_enabled=false`, the service short-circuits and never inserts into `msg_notification_queue`. The count stays at 3 across the pref-disabled period. The student account's attendance.tardy row IS still inserted because students don't subscribe to attendance notifications by default and aren't fan-out targets — this assertion is specifically about the parent.

---

## Scenario 7 — Permission denials

Three independent permission cuts exercise the gating contract for Cycle 3.

### 7a — Student cannot publish announcements

```bash
curl -s -w "\n  HTTP=%{http_code}\n" -X POST http://localhost:4000/api/v1/announcements \
  -H "Authorization: Bearer $STUDENT" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d '{"title":"Cannot do this","body":"hi","audienceType":"ALL_SCHOOL","isPublished":true}'
```

```text
{"statusCode":403,"error":"INSUFFICIENT_PERMISSIONS",
 "message":"You do not have the required permission for this action",
 "required":["com-002:write"]}
  HTTP=403
```

### 7b — Parent cannot read another author's announcement stats

```bash
curl -s -w "\n  HTTP=%{http_code}\n" \
  "http://localhost:4000/api/v1/announcements/$ANN_ID/stats" \
  -H "Authorization: Bearer $PARENT" -H 'X-Tenant-Subdomain: demo'
```

```text
{"statusCode":403,"error":"INSUFFICIENT_PERMISSIONS",
 "message":"You do not have the required permission for this action",
 "required":["com-002:write"]}
  HTTP=403
```

### 7c — Student cannot read a thread they're not a participant in

```bash
curl -s -w "\n  HTTP=%{http_code}\n" \
  "http://localhost:4000/api/v1/threads/$THREAD_ID" \
  -H "Authorization: Bearer $STUDENT" -H 'X-Tenant-Subdomain: demo'
```

```text
{"message":"Thread 019dd1b2-ec6c-7bb0-9df2-6642a3b5bb18 not found",
 "error":"Not Found","statusCode":404}
  HTTP=404
```

✅ **Pass.** The 3 cuts cover the 3 distinct gating styles in Cycle 3:
- **Endpoint permission** — `PermissionGuard` rejects POST `/announcements` because `com-002:write` is held only by Teacher and School Admin (per the IAM seed). Student gets the standard 403 envelope with the required permission code.
- **Method-tier scope mismatch** — both Parent and the per-author/admin filter behind `GET /announcements/:id/stats` are `com-002:write` gates. Parent holds `com-002:read` only, so the endpoint returns 403 before the row-level "are you the author" check ever fires.
- **Row scope as 404** — `ThreadService.getById` deliberately collapses 403→404 for non-participants who aren't admins so the API can't be probed for thread existence. The student gets the same shape they would for a UUID that genuinely doesn't exist.

---

## Latent bugs caught by the CAT

The vertical-slice run is the first time a real Kafka event has flowed all the way through the notification consumers in `tenant_demo`. Three of the five consumers (`grade.published`, `attendance.tardy/absent`, `progress_note.published`) were silently throwing during recipient-context lookup because their SQL referenced a `c.title` column on `sis_classes` that doesn't exist (the class display name comes from `sis_courses.name` joined through `course_id`). The bug never tripped before:

- Step 5's smoke verified that consumers subscribed to topics and the queue + worker booted, but did not exercise an end-to-end event.
- Step 6's smoke (messaging) doesn't touch these three consumers.
- Step 7's smoke (announcements) uses a different consumer (`AudienceFanOutWorker`).
- Step 8's smoke (notification bell) drove the bell from PRE-EXISTING seeded queue rows — which were inserted directly by `seed-messaging.ts`, never through the consumer path.

Fix: replace `c.title || ' (' || c.section_code || ')' AS class_name` with `co.name || ' (' || c.section_code || ')' AS class_name` and add `JOIN sis_courses co ON co.id = c.course_id` to all three consumer queries:

- `apps/api/src/notifications/consumers/grade-notification.consumer.ts:154`
- `apps/api/src/notifications/consumers/attendance-notification.consumer.ts:170`
- `apps/api/src/notifications/consumers/progress-note-notification.consumer.ts:165`

This is exactly the kind of latent bug a vertical-slice integration test exists to catch. It's documented here so the next cycle's reviewer can see it was found in Step 11 (not pushed to production) and so the fix shows up in the same commit that closes the cycle.

---

## Result

**All 7 plan-mandated scenarios pass.** The Cycle 3 vertical slice is verified end-to-end:

|   # | Scenario                                                          | Status |
| --: | ----------------------------------------------------------------- | :----: |
|   1 | Tardy mark → Kafka → consumer → queue → worker → parent's bell    |   ✅   |
|   2 | Grade publish → fan-out to student + portal-enabled guardians     |   ✅   |
|   3 | Direct messaging (compose, deliver, reply, mark-read)             |   ✅   |
|   4 | Content moderation BLOCK keyword → 422 + msg_moderation_log row   |   ✅   |
|   5 | Announcement publish → audience fan-out → mark-read → stats       |   ✅   |
|   6 | Disabled `is_enabled` preference suppresses enqueue               |   ✅   |
|   7 | Three independent permission denials (403 endpoint / 403 method-tier / 404 row scope) |   ✅   |

Permission matrix (Cycle 3 additions on top of Cycle 1+2):

| Caller  | Endpoint                                  | Required        | Held? | Result |
| ------- | ----------------------------------------- | --------------- | :---: | -----: |
| student | `POST /announcements`                     | `com-002:write` |   ✗   |    403 |
| parent  | `GET /announcements/:id/stats`            | `com-002:write` |   ✗   |    403 |
| student | `GET /threads/:id` (non-participant)      | row scope       |   ✗   |    404 |
| student | `POST /threads` for TEACHER_PARENT type   | role allow-list |   ✗   |    400 |
| parent  | `POST /threads/:id/messages` w/ BLOCK kw  | content policy  |   ✗   |    422 |

---

## Known scope decisions

- **Quiet-hours clear is part of the test.** The seed deliberately sets David's quiet hours to 22:00–07:00 UTC to demonstrate the mechanic — but if the CAT runs inside that window it would never see end-to-end delivery (`scheduled_for` legitimately defers to 07:00). The harness clears + restores the quiet-window for the duration of the run; Scenario 6 covers preference honoring through `is_enabled=false` instead, which is a cleaner assertion anyway. A separate "quiet hours" verification (mark a row, sleep into the window, confirm the worker skips it) is post-cycle work.
- **No /notifications/preferences UI yet.** Scenario 6 mutates `msg_notification_preferences` directly via SQL. The preferences UI is reserved for Phase 2 (Test & Refine).
- **No scheduled-publish announcement.** The plan's compose UI exposes "Save draft" + "Publish now" but not "schedule for later" — `AudienceFanOutWorker` only fires at the moment `isPublished` flips true, so future-publishAt would still fan out immediately. Scheduled publishing is a Phase 2 feature; the draft flow covers the user-facing equivalent of "create now, publish later".
- **No browser-driver e2e.** Same scope decision as Cycle 1 + 2 — a manual UI walkthrough plus reproducible API verifications. Playwright lands when the surface stabilises (after Phase 2).
- **Single teacher persona in the seed.** `sis_class_teachers` assigns James Rivera to every demo class, so a "second teacher can also message David" assertion would require either an HR (Cycle 4) addition or a manual seed edit. The current scenarios test the persona shape that matters most for Phase 1 sign-off.
- **Manual delivery-worker wait.** The CAT sleeps 14s after each Kafka emit. A tighter test would tail Kafka offsets or hook into `KafkaConsumerService` events to stop the wait early; the manual wait matches how a reviewer would experience the system.

---

## Cycle exit

Cycle 3 ships everything in the original plan plus the post-CAT consumer-SQL fix. Phase 1 (Build the Core) is complete. The platform now closes the loop on every Kafka event from Cycles 1 and 2 (attendance, grading, progress notes, absence requests) plus the two Cycle 3-native producers (direct messages and announcements). Next up: **Phase 2 — Test & Refine**: persona walkthroughs, UI design review, edge-case testing, and the `docs/ui-design-guide.md` deliverable before Cycles 4–8 expand the platform with HR, Enrollment, Tasks, Calendar, and Helpdesk.
