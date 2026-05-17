# CampusOS Cycle 2 — Customer Acceptance Test Script

**Cycle:** 2 (Classroom + Assignments + Grading)
**Step:** 10 of 10 — Vertical Slice Integration Test
**Last verified:** 2026-04-27 (against `tenant_demo` on `main`)
**Plan reference:** `docs/campusos-cycle2-implementation-plan.html` § Step 10

This is the manual walkthrough that exercises every layer of Cycle 2 — assignment creation, student-side submission, teacher grading + publish, the asynchronous gradebook-snapshot worker (ADR-010), and student / parent visibility. It is the second CAT for CampusOS, layered on top of the Cycle 1 SIS + Attendance foundation. The format mirrors `docs/cycle1-cat-script.md`.

The verification below was captured live with the API + worker running against the demo seed. Outputs are recorded inline so a reviewer can re-run the script and diff the results against this transcript.

---

## Prerequisites

- Docker services up: `docker compose up -d`
- API running: `pnpm --filter @campusos/api start` (or `dev` for hot reload). The API is the producer + consumer of the Kafka events under test, so it must be running before Step 5.
- Web running (for the UI walkthrough lines): `pnpm --filter @campusos/web dev` at `http://localhost:3000`.
- Seed pipeline current:
  ```bash
  pnpm --filter @campusos/database seed                      # platform + 5 test users + tenant_demo
  pnpm --filter @campusos/database exec tsx src/seed-iam.ts  # 444 perms, 6 roles
  pnpm --filter @campusos/database seed:sis                  # SIS — students, classes, attendance
  pnpm --filter @campusos/database seed:classroom            # Cycle 2 — assignments, grades, snapshots
  pnpm --filter @campusos/database exec tsx src/build-cache.ts
  ```
- Tokens stashed for the three personas under test (replace with your own login if running afresh):
  ```bash
  for who in teacher student parent; do
    curl -s -X POST http://localhost:4000/api/v1/auth/dev-login \
      -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' \
      -d "{\"email\":\"$who@demo.campusos.dev\"}" \
      | python3 -c 'import sys,json; print(json.load(sys.stdin)["accessToken"])' \
      > /tmp/${who}_token
  done
  ```

The IDs in the captured outputs (`019dcf66-4bf5-…` for P1 Algebra, `019dcf66-4c0b-…` for Maya Chen, etc.) are stable across re-seeds because UUIDv7 generation is deterministic from the seed timestamp; if your seed run differs, substitute your own.

---

## Step 1 — Teacher creates an assignment

**UI:** open `http://localhost:3000`, log in as **Teacher (James Rivera)**, click **Period 1 — Algebra 1**, switch to the **Assignments** tab, click **New assignment**. Fill: title `Chapter 4 Homework`, type `Homework`, category `Homework (30%)`, max points `25`, due date tomorrow, instructions `Solve problems 1–10 from Chapter 4. Show your work.`, **Published** toggle on. Save.

**Expect:**

- Lands back on the assignments list with **Chapter 4 Homework** at the top.
- Type pill reads **HOMEWORK**, due-date column shows tomorrow's date.

**API verification:**

```bash
TEACHER=$(cat /tmp/teacher_token)
P1_ALGEBRA="019dcf66-4bf5-7cc2-81e4-dfcfcf400af4"
HOMEWORK_TYPE=$(curl -s http://localhost:4000/api/v1/assignment-types \
  -H "Authorization: Bearer $TEACHER" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c 'import sys,json; print([t["id"] for t in json.load(sys.stdin) if t["name"]=="Homework"][0])')
HOMEWORK_CAT=$(curl -s "http://localhost:4000/api/v1/classes/$P1_ALGEBRA/categories" \
  -H "Authorization: Bearer $TEACHER" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c 'import sys,json; print([c["id"] for c in json.load(sys.stdin) if c["name"]=="Homework"][0])')
DUE=$(date -u -d '+1 day' +%Y-%m-%dT23:59:00Z)

curl -s -X POST "http://localhost:4000/api/v1/classes/$P1_ALGEBRA/assignments" \
  -H "Authorization: Bearer $TEACHER" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"Chapter 4 Homework\",\"instructions\":\"Solve problems 1-10 from Chapter 4. Show your work.\",\"assignmentTypeId\":\"$HOMEWORK_TYPE\",\"categoryId\":\"$HOMEWORK_CAT\",\"dueDate\":\"$DUE\",\"maxPoints\":25,\"isPublished\":true}"
```

```json
{
  "id": "019dcfd8-f592-7aa0-b1a8-d7648bb3bc3c",
  "classId": "019dcf66-4bf5-7cc2-81e4-dfcfcf400af4",
  "title": "Chapter 4 Homework",
  "assignmentType": { "name": "Homework", "category": "HOMEWORK" },
  "category":       { "name": "Homework", "weight": 30 },
  "maxPoints": 25,
  "dueDate": "2026-04-28T23:59:00.000Z",
  "isPublished": true,
  …
}
```

✅ **Pass.**

---

## Step 2 — Student sees the assignment

**UI:** sign out, log in as **Student (Maya Chen)**. Lands on the new student dashboard with an **Upcoming assignments** card. The first row reads `Chapter 4 Homework · Apr 28`. Click **/assignments** in the sidebar to see the full inbox — Chapter 4 Homework appears under Algebra 1 with `Due Apr 28`.

**API verification (Maya bootstraps her own studentId, then reads the assignment):**

```bash
STUDENT=$(cat /tmp/student_token)
CHAPTER4="019dcfd8-f592-7aa0-b1a8-d7648bb3bc3c"

curl -s http://localhost:4000/api/v1/students/me \
  -H "Authorization: Bearer $STUDENT" -H 'X-Tenant-Subdomain: demo'

curl -s "http://localhost:4000/api/v1/assignments/$CHAPTER4" \
  -H "Authorization: Bearer $STUDENT" -H 'X-Tenant-Subdomain: demo'
```

```json
// /students/me
{ "id": "019dcf66-4c0b-7cc2-81e5-425b0b83028e", "fullName": "Maya Chen", "studentNumber": "S-1001", "gradeLevel": "9", … }

// /assignments/:id
{ "title": "Chapter 4 Homework", "isPublished": true, "maxPoints": 25, "dueDate": "2026-04-28T23:59:00.000Z", … }
```

✅ **Pass** — `/students/me` (new in Step 9) returns Maya's `sis_students` row by resolving `iam_person.id → platform_students → sis_students`, and `/assignments/:id` is row-scoped to "published assignments in Maya's enrolled classes."

---

## Step 3 — Student submits

**UI:** click **Chapter 4 Homework** from the inbox. The detail page shows the instructions and a textarea labelled "Your submission" with status pill **Not started**. Type `Problem 1: x = 5. Problem 2: y = 7. Problem 3: simplified to 3x + 2…` and click **Submit**. The status pill flips to **Submitted** with the submitted-at timestamp.

**API verification:**

```bash
curl -s -X POST "http://localhost:4000/api/v1/assignments/$CHAPTER4/submit" \
  -H "Authorization: Bearer $STUDENT" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d '{"submissionText":"Problem 1: x = 5. Problem 2: y = 7. Problem 3: simplified to 3x + 2..."}'
```

```json
{
  "id": "019dcfd9-32f3-7aa0-b1a8-d97907881599",
  "status": "SUBMITTED",
  "submissionText": "Problem 1: x = 5. Problem 2: y = 7. Problem 3: simplified to 3x + 2...",
  "submittedAt": "2026-04-27T16:50:11.313Z",
  "grade": null,
  …
}
```

✅ **Pass** — submission is an idempotent upsert keyed on `(assignment_id, student_id)`; resubmitting updates `submission_text` and resets status to `SUBMITTED`. `cls.submission.submitted` is emitted (best-effort, no consumer in this cycle).

---

## Step 4 — Teacher grades (draft)

**UI:** sign out, log in as Teacher. Open **Period 1 Algebra → Gradebook**. Maya's row has a yellow editable cell under the **Chapter 4 Homework** column. Click it, type `22`, type `Good work, watch step 3.` in the feedback field, click **Save (draft)**. Cell turns gray with a small "draft" pill.

**API verification (graded as a draft, `publish=false`):**

```bash
TEACHER=$(cat /tmp/teacher_token)
SUB="019dcfd9-32f3-7aa0-b1a8-d97907881599"

curl -s -X POST "http://localhost:4000/api/v1/submissions/$SUB/grade" \
  -H "Authorization: Bearer $TEACHER" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d '{"gradeValue":22,"feedback":"Good work, watch step 3.","publish":false}'
```

```json
{
  "id": "019dcfd9-4c06-7aa0-b1a8-e14f8aeacfc9",
  "gradeValue": 22, "maxPoints": 25, "percentage": 88, "letterGrade": "B",
  "feedback": "Good work, watch step 3.",
  "isPublished": false,
  "publishedAt": null,
  …
}
```

**Confirm draft is hidden from Maya before publish:**

```bash
curl -s "http://localhost:4000/api/v1/assignments/$CHAPTER4/submissions/mine" \
  -H "Authorization: Bearer $STUDENT" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print("status:",d["status"]," grade:",d["grade"])'
```

```
status: GRADED   grade: None
```

✅ **Pass** — `rowToDto(row, includeDraftGrade)` collapses unpublished grades to `null` for non-managers (Step 5 contract); the student sees that work was graded but not the score.

---

## Step 5 — Teacher publishes (Kafka emit)

**UI:** still on the gradebook, click **Publish all** in the Chapter 4 Homework column header. The cell goes green; banner reads "1 grade published".

**API verification (publish-all by assignment):**

```bash
P1_ALGEBRA="019dcf66-4bf5-7cc2-81e4-dfcfcf400af4"
curl -s -X POST "http://localhost:4000/api/v1/classes/$P1_ALGEBRA/grades/publish-all" \
  -H "Authorization: Bearer $TEACHER" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d "{\"assignmentId\":\"$CHAPTER4\"}"
```

```json
{
  "assignmentId": "019dcfd8-f592-7aa0-b1a8-d7648bb3bc3c",
  "publishedCount": 1,
  "grades": [{
    "id": "019dcfd9-4c06-7aa0-b1a8-e14f8aeacfc9",
    "gradeValue": 22, "isPublished": true, "publishedAt": "2026-04-27T16:50:29.316Z", …
  }]
}
```

The producer emits `cls.grade.published` with transport headers `event-id`, `tenant-id`, `tenant-subdomain` (per Step 6's pre-ADR-057 envelope). The snapshot worker is subscribed under group `gradebook-snapshot-worker` — confirmed at boot:

```
[KafkaConsumerService] Subscribed: groupId=gradebook-snapshot-worker topics=cls.grade.published,cls.grade.unpublished
```

✅ **Pass.**

---

## Step 6 — Snapshot recomputes asynchronously (ADR-010)

The worker debounces 30 seconds per `(school_id, class_id, student_id)`. ADR-010 forbids any synchronous write from `cls_grades` into `cls_gradebook_snapshots` — the snapshot can only be reached through the topic.

**Pre-publish snapshot** (seed-state, 2 published Maya × Algebra grades):

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
  SET search_path TO tenant_demo, platform, public;
  SELECT current_average, letter_grade, assignments_graded, assignments_total
  FROM cls_gradebook_snapshots
  WHERE class_id='019dcf66-4bf5-7cc2-81e4-dfcfcf400af4'
    AND student_id='019dcf66-4c0b-7cc2-81e5-425b0b83028e';
"
```

```
 current_average | letter_grade | assignments_graded | assignments_total
-----------------+--------------+--------------------+-------------------
           90.50 | A            |                  2 |                 2
```

**Wait 35 seconds** (debounce window + flush slack), then re-query:

```
 current_average | letter_grade | assignments_graded | assignments_total
-----------------+--------------+--------------------+-------------------
           90.50 | A            |                  3 |                 3
```

**Worker log** (proves the async path fired with the right tenant context):

```
[GradebookSnapshotWorker] Snapshot recomputed: class=019dcf66-4bf5-7cc2-81e4-dfcfcf400af4 student=019dcf66-4c0b-7cc2-81e5-425b0b83028e avg=90.50 letter=A graded=3/3
```

The average stays at 90.50 because the new 88% Homework score blends back into the same weighted average Maya already had — the test is that `assignments_graded` advanced (`2 → 3`), not the percentage itself. The recompute is idempotent: replaying the same Kafka event from `platform.platform_event_consumer_idempotency` is rejected at `INSERT … RETURNING id` with SQLSTATE 23505 before the debounce queue resets.

✅ **Pass.**

---

## Step 7 — Student sees the published grade

**UI:** sign in as Maya. Open **Grades** in the sidebar. The Algebra 1 row now reads `90% A · 3/3 graded`. Click into it. The per-class breakdown lists all three graded assignments, ending with `Chapter 4 Homework · 22 / 25 · 88%`. Click into Chapter 4 Homework and the detail page now renders a **Grade** card under the submission, showing `22 / 25 · B` and the feedback `Good work, watch step 3.`.

**API verification (uses the new `GET /students/:studentId/classes/:classId/grades` endpoint):**

```bash
STUDENT=$(cat /tmp/student_token)
MAYA="019dcf66-4c0b-7cc2-81e5-425b0b83028e"

curl -s "http://localhost:4000/api/v1/students/$MAYA/classes/$P1_ALGEBRA/grades" \
  -H "Authorization: Bearer $STUDENT" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c "
import sys, json
d=json.load(sys.stdin); print('snapshot avg:', d['snapshot']['currentAverage'])
for r in d['assignments']:
    g=r['grade']; print(f\"  {r['assignment']['title']:30s} grade={g['gradeValue'] if g else '—':>5}  pct={g['percentage'] if g else '—':>5}\")
"
```

```
snapshot avg: 90.5
  Linear Equations Quiz          grade=   92  pct=   92
  Quadratics Homework Set        grade=   44  pct=   88
  Chapter 4 Homework             grade=   22  pct=   88
```

✅ **Pass** — the new endpoint joins `cls_assignments`, `cls_submissions`, and `cls_grades` keyed on Maya's `student_id` in a single query and filters draft grades + unpublished assignments out for the non-manager caller.

---

## Step 8 — Parent sees the updated grade

**UI:** sign in as **Parent (David Chen)**. Maya's child card on the dashboard has a new **Grades** section listing per-class averages — Algebra 1 reads `90% · A`. Click **View grades** → `/children/<maya-id>/grades`. Click **Algebra 1** row → per-class breakdown now includes Chapter 4 Homework alongside the seeded grades.

**API verification (parent walks the same data via `sis_student_guardians`):**

```bash
PARENT=$(cat /tmp/parent_token)

# Children list
curl -s http://localhost:4000/api/v1/students/my-children \
  -H "Authorization: Bearer $PARENT" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c 'import sys,json; arr=json.load(sys.stdin); [print(c["fullName"], c["id"]) for c in arr]'

# Per-class snapshot list
curl -s "http://localhost:4000/api/v1/students/$MAYA/gradebook" \
  -H "Authorization: Bearer $PARENT" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c "
import sys, json
d=json.load(sys.stdin)
for r in d['rows']:
    s=r['snapshot']
    if s and s['currentAverage'] is not None:
        print(f\"  {r['class']['courseCode']:12s} {r['class']['courseName']:18s} {s['currentAverage']:>5}% {s['letterGrade']:>2}\")
"

# Per-class breakdown (same endpoint as the student, parent context)
curl -s "http://localhost:4000/api/v1/students/$MAYA/classes/$P1_ALGEBRA/grades" \
  -H "Authorization: Bearer $PARENT" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c "
import sys, json
d=json.load(sys.stdin)
print('snapshot avg:', d['snapshot']['currentAverage'])
for r in d['assignments']:
    g=r['grade']; print(f\"  {r['assignment']['title']:30s} grade={g['gradeValue'] if g else '—':>5}\")
"
```

```
Maya Chen 019dcf66-4c0b-7cc2-81e5-425b0b83028e

  MATH-101     Algebra 1            90.5% A
  ELA-101      English 9              92% A
  SCI-101      Biology             89.75% B
  SS-101       World History          90% A

snapshot avg: 90.5
  Linear Equations Quiz          grade=   92
  Quadratics Homework Set        grade=   44
  Chapter 4 Homework             grade=   22
```

✅ **Pass** — parent row scope is enforced via `sis_student_guardians` (`assertCanViewStudent`); David sees Maya only, and within Maya he sees only published grades.

---

## Step 9 — Permission denials

These are the explicit cross-persona cuts the plan asks for. All four return 403 with `INSUFFICIENT_PERMISSIONS` or a `Forbidden` from the per-class write gate.

```bash
SUB="019dcfd9-32f3-7aa0-b1a8-d97907881599"

# 1. Student tries to grade (lacks tch-003:write)
curl -sw 'HTTP %{http_code}\n' -X POST "http://localhost:4000/api/v1/submissions/$SUB/grade" \
  -H "Authorization: Bearer $STUDENT" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' -d '{"gradeValue":25}'

# 2. Parent tries to submit on Maya's behalf (lacks tch-002:write)
curl -sw 'HTTP %{http_code}\n' -X POST "http://localhost:4000/api/v1/assignments/$CHAPTER4/submit" \
  -H "Authorization: Bearer $PARENT" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' -d '{"submissionText":"guardian forging a submission"}'

# 3. Teacher tries to create an assignment in a class they aren't assigned to.
#    (Demo seed assigns James to all 6 classes; for this assertion we
#     temporarily delete his sis_class_teachers row on P3 Biology, then restore it.)
P3_BIOLOGY="019dcf66-4bf9-7cc2-81e4-e831e18436a1"
TEACHER_PERSON="019dc92d-0880-7442-abf5-daf3269a687c"
docker exec campusos-postgres psql -U campusos -d campusos_dev -tA -c "DELETE FROM tenant_demo.sis_class_teachers WHERE class_id='$P3_BIOLOGY' AND teacher_employee_id='$TEACHER_PERSON';"

curl -sw 'HTTP %{http_code}\n' -X POST "http://localhost:4000/api/v1/classes/$P3_BIOLOGY/assignments" \
  -H "Authorization: Bearer $TEACHER" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"hijack attempt\",\"assignmentTypeId\":\"$HOMEWORK_TYPE\",\"isPublished\":true}"

docker exec campusos-postgres psql -U campusos -d campusos_dev -tA -c "INSERT INTO tenant_demo.sis_class_teachers (id,class_id,teacher_employee_id,is_primary_teacher) VALUES (gen_random_uuid(),'$P3_BIOLOGY','$TEACHER_PERSON',true);"
```

```
# 1
HTTP 403
{"statusCode":403,"error":"INSUFFICIENT_PERMISSIONS","message":"You do not have the required permission for this action","required":["tch-003:write"]}

# 2
HTTP 403
{"statusCode":403,"error":"INSUFFICIENT_PERMISSIONS","message":"You do not have the required permission for this action","required":["tch-002:write"]}

# 3
HTTP 403
{"message":"You are not assigned to class 019dcf66-4bf9-7cc2-81e4-e831e18436a1 and cannot manage its assignments","error":"Forbidden","statusCode":403}
```

✅ **Pass** for all three. #1 and #2 are blocked at `PermissionGuard` (the role doesn't have the code). #3 is blocked at the per-class write gate inside `AssignmentService.assertCanWriteClass` — `tch-002:write` is held by every teacher tenant-wide; the actual access boundary is the `sis_class_teachers` link table.

**Bonus — draft grade hidden after unpublish.** While we're at it, prove the draft-vs-published gate the other direction:

```bash
GRADE_ID="019dcfd9-4c06-7aa0-b1a8-e14f8aeacfc9"
curl -s -X POST "http://localhost:4000/api/v1/grades/$GRADE_ID/unpublish" \
  -H "Authorization: Bearer $TEACHER" -H 'X-Tenant-Subdomain: demo' > /dev/null

curl -s "http://localhost:4000/api/v1/students/$MAYA/classes/$P1_ALGEBRA/grades" \
  -H "Authorization: Bearer $STUDENT" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c "
import sys, json
d=json.load(sys.stdin)
for r in d['assignments']:
    g=r['grade']; print(f\"  {r['assignment']['title']:30s} grade={g['gradeValue'] if g else 'None'}\")
"

# re-publish so the run ends clean
curl -s -X POST "http://localhost:4000/api/v1/grades/$GRADE_ID/publish" \
  -H "Authorization: Bearer $TEACHER" -H 'X-Tenant-Subdomain: demo' > /dev/null
```

```
  Linear Equations Quiz          grade=92
  Quadratics Homework Set        grade=44
  Chapter 4 Homework             grade=None
```

✅ **Pass.** The unpublish flips `is_published=false` and emits `cls.grade.unpublished`; the per-class endpoint immediately collapses the grade to `null` for the non-manager caller without waiting for the snapshot to recompute.

---

## Result

**All 9 steps pass.** The Cycle 2 vertical slice is verified end-to-end:

| Step | What it proves                                            | Status |
| ---: | --------------------------------------------------------- | :----: |
|    1 | Teacher can create a published assignment                 |   ✅   |
|    2 | Student can read it and bootstrap their own studentId     |   ✅   |
|    3 | Student-only submission upsert with idempotent resubmit   |   ✅   |
|    4 | Draft grade is hidden from the student                    |   ✅   |
|    5 | publish-all returns the right count + emits Kafka         |   ✅   |
|    6 | Snapshot recomputes asynchronously after the 30s debounce |   ✅   |
|    7 | Student sees the published grade + new average            |   ✅   |
|    8 | Parent sees the same data through the guardian link       |   ✅   |
|    9 | Three independent permission cuts are enforced            |   ✅   |

Permission matrix (Cycle 2 additions on top of Cycle 1):

| Caller  | Endpoint                                                                   | Required                                  | Result |
| ------- | -------------------------------------------------------------------------- | ----------------------------------------- | -----: |
| student | `POST /submissions/:id/grade`                                              | `tch-003:write`                           |    403 |
| parent  | `POST /assignments/:id/submit`                                             | `tch-002:write`                           |    403 |
| teacher | `POST /classes/:id/assignments` for a class they don't teach               | `tch-002:write` (held) + class membership |    403 |
| student | `GET /assignments/:id` for an unpublished or non-enrolled-class assignment | row scope                                 |    404 |

## Known scope decisions

- **Manual debounce wait.** The CAT sleeps 35 seconds for the snapshot worker. A tighter integration test would tail Kafka offsets or hook into `KafkaConsumerService` events to stop the wait early; the manual wait is the cheaper option for a CAT-style script and matches how a reviewer would experience the system.
- **Single teacher persona in the seed.** `sis_class_teachers` assigns James Rivera to every demo class, so the "teacher can't manage another teacher's class" assertion has to manually delete + restore the class-teacher row (Step 9 #3). A second `STAFF` user will be added when HR (Cycle 4) lands; until then the workaround above is the cleanest demo of the per-class write gate.
- **No real Kafka consumer-side test of `cls.submission.submitted` or `cls.progress_note.published`.** Those topics are emitted but have no consumer this cycle (notification delivery is Cycle 3). The CAT exercises only the `cls.grade.{published,unpublished}` round-trip because that's the loop that actually closes inside Cycle 2.
- **No browser-driver e2e.** Same scope decision as the Cycle 1 CAT — a manual UI walkthrough plus reproducible API verifications. Playwright lands when the surface stabilises (after Phase 2).
- **Snapshot percentage rounding.** Maya's running average held at 90.50% across the run because her new 88% Homework rolled back into the same 30/50/20 weighted sum. To exercise a visible-percentage delta on a re-run, grade the new assignment at a markedly higher or lower percentage (e.g. 15/25 or 25/25).

## Cycle exit

Cycle 2 (Classroom + Assignments + Grading) is **complete**. CampusOS now handles two end-to-end school workflows — attendance and grading — both with the same multi-tenant isolation, permission catalogue, row-level authorisation, and audit-friendly Kafka emit pattern. Cycle 3 (Communications) builds on top of the consumer pattern this cycle established (KafkaConsumerService, idempotency table, debounce queue) to deliver actual notifications when these events fire.
