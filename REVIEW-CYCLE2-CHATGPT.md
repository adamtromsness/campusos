# Cycle 2 Architecture Review — ChatGPT (Adversarial)

**Reviewer:** ChatGPT
**Date:** April 27, 2026
**Scope:** Full Cycle 2 (Classroom + Assignments + Grading)
**Initial verdict:** Reject pending fixes
**Final verdict:** **APPROVED** at commit `d876e86` (re-review on April 27, 2026 after fixes landed)

## Summary: 5 PASS · 2 BLOCKING · 2 MAJOR DEVIATION

Cycle 2 is a strong implementation overall, but two blocking security/architecture
issues plus several major deviations were identified.

---

## Blocking issues

### BLOCKING 1 — Class gradebook endpoint leaks full class grades to students/parents

`GET /classes/:classId/gradebook` is protected only by `tch-003:read`. The controller
describes it as a teacher/admin view, but the service only calls
`assertCanReadClass()`, and that allows students enrolled in the class and parents
linked to a child in the class. The service then returns one row per actively
enrolled student in the class roster.

**Impact:** A student or parent with `tch-003:read` can potentially view the entire
class gradebook, not just their own/child's grades.

**Required fix:** Make `/classes/:classId/gradebook` teacher/admin only. Use
`assertCanWriteClass()` or a dedicated `assertCanManageClassGradebook()` gate.
Students/parents should use only:

- `/students/:studentId/gradebook`
- `/students/:studentId/classes/:classId/grades`

**Triage (Claude):** VALID. Real PII / grade-data leak. Fix immediately.

---

### BLOCKING 2 — Kafka consumer path is at-most-once and can silently lose gradebook recomputes

The worker claims idempotency **before** debounce/processing, then if recompute
fails, the idempotency row already exists and the message will not be retried. The
code comments acknowledge DB transient errors are only logged and require a future
event to repair the snapshot.

ADR-057 requires consumers to be idempotent and includes DLQ semantics after
repeated processing failures; the current consumer service catches handler errors
and logs them, with no retry/DLQ path.

**Impact:** Parent/student grade views can remain stale indefinitely after a
transient worker failure unless another grade event arrives.

**Required fix:** For this worker, either:

- claim idempotency only **after** successful snapshot recompute, or
- add status-based idempotency rows: `PROCESSING`, `PROCESSED`, `FAILED`, with
  retry/DLQ handling.

**Triage (Claude):** VALID. The worker's failure mode is at-most-once, not
at-least-once as the docstring claims. Fix immediately.

---

## Major deviations

### DEVIATION 3 — ADR-057 event envelope is still not implemented, despite Cycle 2 adding a real consumer

ADR-057 requires every Kafka event to use the canonical envelope and
`{env}.{domain}.{entity}.{verb}` topic naming. Current producer still emits raw
JSON payloads to topics like `cls.grade.published`, with metadata carried through
ad hoc headers.

This was tolerable when events were fire-and-forget. It is much less tolerable
now that `GradebookSnapshotWorker` consumes them.

**Required fix:** Implement the ADR-057 envelope before adding more consumers.

**Triage (Claude):** VALID but not blocking for Cycle 2. The grade emit headers
already include `event-id`, `tenant-id`, `tenant-subdomain` — the three fields the
worker depends on — and the worker reads them through a header-shaped seam, not the
payload. The full envelope can land at the start of Cycle 3 (Communications) where
multiple new event types and consumers will arrive together, without rewriting the
gradebook worker. Documented as deferred work in `HANDOFF-CYCLE2.md`.

---

### DEVIATION 4 — Teacher identity is being overloaded

Several classroom tables describe teacher/author IDs as soft references to future
`hr_employees`, but the services are writing/comparing `actor.personId` against
those fields. Examples:

- `sis_class_teachers.teacher_employee_id = actor.personId` (assignment authz check)
- `cls_grades.teacher_id = actor.personId` (grade write)
- `cls_student_progress_notes.author_id = actor.personId` (progress-note write)
- `cls_lessons.teacher_id` (declared as soft → `hr_employees`; lessons API not yet active)

**Required fix:** Either rename the temporary columns to `teacher_person_id` /
`author_person_id`, or introduce an explicit temporary mapping rule until HR
projections exist.

**Triage (Claude):** VALID and the deeper bug originates in Cycle 1
(`sis_class_teachers.teacher_employee_id`) — it has propagated. Going with option
(b): document an explicit "Temporary HR-Employee Identity Mapping" rule in CLAUDE.md

- HANDOFF-CYCLE2.md, and add `COMMENT ON COLUMN` annotations in the migration SQL
  so the constraint is discoverable from the schema. Renaming columns later is a
  non-breaking, additive migration when the HR module ships.

---

## Positive findings

- The Cycle 2 schema adds the expected 15 classroom tables and keeps platform
  references soft.
- `cls_gradebook_snapshots` is not updated in the grade write transaction; the
  async worker pattern follows ADR-010 directionally.
- Tenant query execution now uses interactive transactions with
  `SET LOCAL search_path`, which addresses the prior tenant isolation concern.
- Student endpoints are now row-scoped via `ActorContextService`.
- Most classroom endpoints are permission-protected with `@RequirePermission`.

## Final decision (reviewer)

**Reject pending fixes.**

Fix the class-gradebook data leak first. Then fix the gradebook worker
idempotency/retry behavior before building additional Kafka consumers.

---

# Fixes applied (REVIEW-CYCLE2)

This section is filled in as fixes land. Each entry maps to one of the items
above and links to the exact change.

## Fix 1 — Class gradebook leak (BLOCKING 1)

**Changed:** `apps/api/src/classroom/gradebook.controller.ts` — the
`GET /classes/:classId/gradebook` route is now gated by `tch-003:write` (teachers
and admins only).
**Changed:** `apps/api/src/classroom/gradebook.service.ts::getClassGradebook` —
authorisation check is now `assertCanWriteClass` (admin OR membership in
`sis_class_teachers`). Students/parents are denied at both the permission gate and
the row-scope gate.

Why both layers: parents, students and teachers all hold `tch-003:read`, so the
permission gate alone cannot distinguish them. `tch-003:write` is held only by
Teacher / School Admin / Platform Admin (per `seed-iam.ts`), giving a clean cut at
the controller. `assertCanWriteClass` enforces the per-class membership scope so a
teacher in another school's class still 403s.

Students/parents continue to use the per-student endpoints
(`/students/:studentId/gradebook`, `/students/:studentId/classes/:classId/grades`)
which are unaffected.

## Fix 2 — Snapshot worker idempotency (BLOCKING 2)

**Changed:** `apps/api/src/classroom/gradebook-snapshot-worker.service.ts`.

The idempotency claim is now made **after** a successful recompute, not on message
arrival. The new flow:

1. On message arrival: validate headers + payload. Look up the event-id in
   `platform_event_consumer_idempotency` (read-only `SELECT`). If already
   processed, skip. Otherwise, register the event-id against the in-flight
   debounce entry (an in-memory `Set<eventId>` per `(schoolId, classId, studentId)`)
   and reset the 30s debounce timer.
2. On flush: run the recompute under tenant context. Only on success, claim all
   contributing event-ids (`Promise.all` of `idempotency.claim`). Failures during
   recompute leave the event-ids unclaimed, so a redelivered duplicate (or the
   next grade event for the same (class, student)) re-enters the queue and the
   recompute retries.

The in-memory event-id set guards against the same eventId rapidly repeating
inside the 30s window — the debounce timer is only reset for genuinely new ids.

Failure modes (updated):

- DB transient error during recompute → log; no claim; next event for the same
  (class, student) re-runs the recompute. Snapshots converge.
- Duplicate redelivery before flush → the event-id is already in the in-memory
  set; the timer is not reset; no extra work.
- Duplicate redelivery after flush (DB row exists) → the on-arrival `SELECT`
  catches it; no debounce, no recompute.

`KafkaConsumerService` already wraps the handler in a try/catch and logs on
failure; this fix moves the worker from at-most-once to at-least-once with
idempotent flush.

## Fix 3 — ADR-057 envelope (DEVIATION 3, deferred)

Tracked. The full envelope and topic-prefixing convention land at the start of
Cycle 3 (Communications), where multiple new producers and consumers arrive
together. The grade-emit headers already include the three fields the gradebook
worker reads (`event-id`, `tenant-id`, `tenant-subdomain`), so the migration is
additive — no rewrite of the worker is required.

## Fix 4 — Teacher identity overload (DEVIATION 4)

**Documented:** A "Temporary HR-Employee Identity Mapping" convention has been
added to `CLAUDE.md` (Key Design Contracts) and `HANDOFF-CYCLE2.md`. Until the HR
module ships, the columns `sis_class_teachers.teacher_employee_id`,
`cls_grades.teacher_id`, `cls_student_progress_notes.author_id`, and
`cls_lessons.teacher_id` carry `iam_person.id` directly; services compare them
against `actor.personId` and the soft-FK to `hr_employees` is suspended.
**Annotated:** `COMMENT ON COLUMN` statements in
`002_sis_academic_structure.sql`, `005_cls_lessons_and_assignments.sql`, and
`006_cls_submissions_and_grading.sql` so the rule is discoverable from the
schema.

When the HR module lands, the migration is: insert `hr_employees` rows keyed by
person_id, then re-point the columns. The change is additive — no service code
needs to flip on day one because `hr_employees.person_id = iam_person.id` is the
intended bridge.

---

# Re-review verdict — APPROVED at commit `d876e86`

**Date:** April 27, 2026 (same day, after fixes landed and were pushed)
**Reviewer:** ChatGPT

## Sequence

1. Initial review on the pre-fix tree → **Reject pending fixes** (2 blocking, 2 major).
2. Fixes pushed in commit `d876e86` on `main`.
3. First re-review hit a stale GitHub raw view of `main` that still showed the
   pre-fix worker. Reviewer flagged BLOCKING 2 as "not actually fixed" and quoted
   `firstTime = await this.idempotency.claim(...)`. That string did not exist in
   the new commit — it was the variable name in the deleted code path.
4. The author pointed the reviewer at commit `d876e86` directly with line
   citations. Re-review against the commit confirmed the fix.

## Final reviewer statement (verbatim)

> Yes — Claude is right **for commit `d876e86`**.
>
> I checked both:
>
> 1. `main` file view — which still appears stale in the raw/browser result I first hit.
> 2. The specific commit `d876e86` — which shows the corrected implementation.
>
> At commit `d876e86`, `firstTime` is gone, `isClaimed()` is used on arrival, and
> the claim is performed only after `recomputeSnapshot()` succeeds. The relevant
> commit page also describes the exact fix: idempotency claim moved from arrival
> to after successful recompute.
>
> The corrected worker at `d876e86` shows:
>
> - no `firstTime` match
> - `isClaimed(CONSUMER_GROUP, eventId)` on message arrival
> - `recomputeSnapshot(...)` runs first inside `flush`
> - `idempotency.claim(...)` happens after recompute, for each contributing event id
>
> ## Updated gate decision
>
> **Approve Cycle 2.**
>
> The two blocking findings are resolved:
>
> 1. Class gradebook leak — fixed.
> 2. Snapshot worker at-most-once behavior — fixed in `d876e86`.
>
> Remaining items are non-blocking:
>
> - ADR-057 full envelope deferred to Cycle 3.
> - Temporary HR-employee identity mapping documented.
>
> You are good to proceed.

## Outstanding (non-blocking) carry-overs into Cycle 3

- **ADR-057 envelope.** The canonical event envelope and `{env}.{domain}.{entity}.{verb}`
  topic prefixing land at the start of Cycle 3 (Communications), where multiple
  new producers and consumers arrive together. The grade-emit headers already
  carry `event-id`, `tenant-id`, `tenant-subdomain` — the three fields the
  gradebook worker reads — so the migration is additive; the worker will not
  need to be rewritten.
- **Temporary HR-employee identity mapping.** Documented as a project-wide rule
  in CLAUDE.md, annotated on the live schema via `COMMENT ON COLUMN`. The
  rebinding migration ships with M16 (HR module) and is a soft-FK rename only.

Cycle 2 is closed. Cycle 3 may begin.
