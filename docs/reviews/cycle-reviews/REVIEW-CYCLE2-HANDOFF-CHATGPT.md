# Cycle 2 Architecture Review — Handoff for ChatGPT

**Reviewer:** ChatGPT (adversarial)
**Author of this brief:** Claude (CampusOS implementer)
**Cycle under review:** Cycle 2 — Classroom + Assignments + Grading
**Branch:** `main`
**State at handoff:** Cycle 2 COMPLETE (Steps 1–10), Cycle 1 COMPLETE + reviewed + post-review fixes landed
**Verdict format requested:** same as Cycle 1 — `N PASS · N DEVIATION · N VIOLATION` with each item separately classified

You are doing a hostile architecture review of Cycle 2 the same way you did for Cycle 1. The Cycle 1 review (`REVIEW-CYCLE1-CHATGPT.md`) caught 6 violations including a critical tenant-isolation race; the response is in `REVIEW-CYCLE1-FIXES.md` and `REVIEW-RESPONSE-CYCLE1.md`. We expect the same standard here. Be specific — name the file, line, ADR, and minimum fix.

---

## Scope of this review

**In scope** — anything added or changed since `9e40bdf feat: Cycle 2 Step 4 — Classroom NestJS module (assignments + categories)`. Concretely:

- 2 tenant migrations: `005_cls_lessons_and_assignments.sql`, `006_cls_submissions_and_grading.sql` (15 new tenant tables — `cls_*`)
- 1 new module under `apps/api/src/classroom/` — 4 services, 1 worker, 6 controllers, 6 DTO files, ~22 endpoints
- 1 new module under `apps/api/src/kafka/` — `KafkaConsumerService` + `IdempotencyService` (the producer existed in Cycle 1; the consumer side is new)
- Web surface under `apps/web/src/app/(app)/classes/[id]/{assignments,gradebook,…}`, `assignments/`, `submissions/`, `grades/`, `children/[id]/grades/` plus components in `apps/web/src/components/classroom/`
- New persona: `StudentDashboard`. Modified: `ParentDashboard` (added Grades section).
- Seed: `seed-classroom.ts`
- Permission catalogue: TCH-002 / TCH-003 / TCH-004 added to role-permission map (handled in `seed-iam.ts`)
- 2 new endpoints outside the classroom module:
  - `GET /students/me` (Step 9 — `apps/api/src/sis/student.controller.ts`)
  - `GET /students/:studentId/classes/:classId/grades` (Step 9 — `apps/api/src/classroom/gradebook.controller.ts`)

**Out of scope** (do not flag):

- Anything in Cycle 1 (SIS / Attendance) — already reviewed. If you spot regressions to Cycle 1 contracts caused by Cycle 2 changes, that **is** in scope; if you find an issue that was already in Cycle 1 untouched code, please call it out separately and tag as "carry-over from Cycle 1."
- ADR-057 envelope on Kafka topics other than `cls.grade.{published,unpublished}` — see "Known scope decisions" below.
- Browser-driver e2e — Cycle 1 also deferred this; Cycle 2 ships a manual CAT (`docs/cycle2-cat-script.md`).
- Lesson planning APIs / AI grading worker — schema only this cycle by design (ERD says so).
- Report cards — schema only this cycle, no API.

---

## What to read (in order)

These four documents are the source of truth and should answer 90% of "is X really designed this way?" questions:

1. **`CLAUDE.md`** — top-level project rules + project status. The "Project Status" paragraph for Cycle 2 enumerates every step with a one-line outcome. The "Conventions" + "Key Design Contracts" sections are the durable rules; if Cycle 2 violates one of them, that's a clear violation.
2. **`HANDOFF-CYCLE2.md`** — the running technical handoff. Step status table at the top; per-step sections (Step 1 through Step 10) describe migration shape, FKs, services, endpoints, row-level auth pattern, deviations, and known caveats. Updated as part of every commit.
3. **`docs/cycle2-cat-script.md`** — the live-verified end-to-end walkthrough. Captures real `curl` outputs, the worker log line proving the async snapshot path fires, and the 3 permission denials. Useful as a "is the system actually doing what the docs say?" check.
4. **`docs/campusos-cycle2-implementation-plan.html`** — the upstream plan you'd compare deviations against.

Authoritative ADR/ERD references the cycle is bound to (these are what the implementation MUST satisfy):

- `docs/campusos-erd-v11.html` — schema source of truth (M21 Classroom, ~33 tables).
- `docs/campusos-architecture-review-v10.html` — sections 10 (AI architecture), 11 (events), and 13 (modular monolith) are the most relevant.
- `docs/campusos-function-library-v11.html` — TCH-001 through TCH-006 codes + their access tiers.

---

## Design contracts to verify (these are the hard rules)

These are the contracts Cycle 2 commits to. If any of them is broken anywhere in the cycle's surface, that's a violation. Cite the ADR and the file.

### 1. ADR-001 / ADR-020 / ADR-028 — soft cross-schema refs

Tenant tables MUST NOT have DB-enforced FK constraints to `platform.*`. UUID columns + app-layer Prisma validation only. Reads can join across schemas (the search_path makes that ergonomic); write integrity is app-layer.

**Quick check:**

```sql
SELECT count(*) FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_class r ON r.oid = c.confrelid
JOIN pg_namespace tn ON tn.oid = t.relnamespace
JOIN pg_namespace rn ON rn.oid = r.relnamespace
WHERE c.contype='f' AND tn.nspname='tenant_demo' AND rn.nspname <> 'tenant_demo';
-- expected: 0
```

Cycle 2 declares 28 intra-tenant FKs across the two migrations and zero cross-schema FKs — verify both numbers.

### 2. ADR-001 (REVIEW-CYCLE1 fix) — `SET LOCAL search_path` inside an interactive transaction

This was the critical Cycle 1 finding. `TenantPrismaService.executeInTenantContext` and `executeInTenantTransaction` both wrap their callback in a Prisma `$transaction` and run `SET LOCAL search_path TO "tenant_X", platform, public`. SET LOCAL is mandatory; a session-level SET on a pooled client can leak between concurrent requests.

**Verify:** every classroom service uses `executeInTenantContext` / `executeInTenantTransaction`. No raw `client.$queryRaw` / `client.$executeRaw` outside these helpers, and no manual `SET search_path` anywhere.

The `GradebookSnapshotWorker` is special — it runs OUTSIDE a request, so it has to **reconstruct** tenant context at flush time from Kafka headers (`event-id`, `tenant-id`, `tenant-subdomain`) using `runWithTenantContextAsync`. Verify that path is correct: in particular, that the worker isn't reusing a request-bound tenant context, that the headers it reads are the ones the producer (`grade.service.ts::tenantHeaders`) actually writes, and that idempotency is checked **before** the SET LOCAL transaction runs the recompute (so a redelivered event doesn't reset the debounce nor pay for a redundant query).

### 3. ADR-010 — gradebook snapshots are async-only

`cls_gradebook_snapshots` is NEVER updated inside a transaction that writes a `cls_grades` row. Grade writes emit `cls.grade.{published,unpublished}`; the worker recomputes the snapshot after a 30s debounce per `(school_id, class_id, student_id)`.

**Verify:**

- No `INSERT`/`UPDATE` to `cls_gradebook_snapshots` anywhere outside `gradebook-snapshot-worker.service.ts`.
- No FK or trigger from `cls_grades` to `cls_gradebook_snapshots` at the schema level.
- The `grade.service.ts` write paths emit on every "ends-published" outcome (this is the Step 8 fix — earlier draft missed updates-to-already-published).

### 4. AI / human boundary (M21)

`cls_ai_grading_jobs` and `cls_submission_question_grades.ai_*` columns store AI suggestions. `cls_grades` stores only teacher-confirmed grades. AI services MUST NOT write to `cls_grades`. No AI worker is wired this cycle, but the contract should be obvious from the schema and service layout.

**Verify:**

- `cls_grades` has no `ai_*` columns.
- No path in any service writes to `cls_grades` from an AI source.
- `cls_ai_grading_jobs.status` flow is forward-compatible only (no consumer; documented as such).

### 5. Row-level authorisation — endpoint permission gates are the floor, not the ceiling

`@RequirePermission` is necessary but not sufficient. Multi-persona reads (any endpoint where `tch-002:read` or `tch-003:read` is held by multiple personas) MUST also apply a row filter via `ActorContextService.resolveActor(...)`. Class-bound writes MUST verify caller membership in `sis_class_teachers` before mutating; admins bypass.

The pattern is:

- **Admins** (`actor.isSchoolAdmin`) → no filter.
- **Teachers** → `sis_class_teachers` link.
- **Students** → self via `sis_students.platform_student_id → platform_students.person_id = actor.personId`.
- **Parents** → `sis_student_guardians` link via `sis_guardians.person_id = actor.personId`.

**Verify** every classroom service that takes a `ResolvedActor` applies one of these patterns. The places to scrutinise hardest:

- `assignment.service.ts` — `canReadClass`, `assertCanWriteClass`, `isClassManager`
- `submission.service.ts` — `canSeeSubmission`, `assertEnrolled`, `resolveCallingStudentSisId`
- `grade.service.ts` — `assertCanWriteClass` is shared with assignments
- `gradebook.service.ts` — `assertCanViewStudent`, `isClassManager` (for `getStudentClassGrades`)
- `progress-note.service.ts` — `assertCanViewStudent` + persona-scoped visibility (admin / teacher / `is_student_visible` for STUDENT / `is_parent_visible` for GUARDIAN)

Specifically check the new Step-9 endpoint `GET /students/:studentId/classes/:classId/grades` — it composes `assertCanViewStudent(student, actor)` AND `assertCanReadClass(class, actor)` AND a `(student, class)` enrollment existence check. Confirm that combination cannot be sidestepped (e.g. by a teacher who teaches one class the student is in but not the requested class).

### 6. Admin status is tenant-scope-chain, not cross-scope

Use `permissionCheckService.hasAnyPermissionInTenant(accountId, schoolId, codes)` or read `actor.isSchoolAdmin` from `ActorContextService.resolveActor(...)`. NEVER scan `iam_effective_access_cache` across all scopes.

The previous `hasAnyPermissionAcrossScopes` was removed in REVIEW-CYCLE1. Verify no reintroduction.

### 7. Frozen-tenant gate (ADR-031)

Every write through this module passes the existing TenantGuard frozen check. Reads continue to work even on a frozen tenant. The frozen gate is registered in `AppModule` as `APP_GUARD` and runs after Auth and before Permission. New controllers in this cycle inherit it automatically — verify no controller bypasses the global guard chain (e.g. by registering a per-controller guard order that disables it).

### 8. UUIDv7 for all PKs (ADR-002)

`generateId()` from `@campusos/database` only. No `gen_random_uuid()` or `uuidv4()` in service code. (The seed and a few CAT cleanup queries use `gen_random_uuid()` — that's fine outside the request path.)

### 9. Permission catalogue is reconciled

The catalogue is reconciled from `packages/database/data/permissions.json` by `seed-iam.ts`. Step 3 added TCH role-permission mappings; verify the role-permission map matches what HANDOFF-CYCLE2 documents (Teacher: `tch-002:*`, `tch-003:*`, `tch-004:*`; Student: `tch-002:read+write` for submission, `tch-003:read`, `tch-004:read`; Parent: `tch-002:read`, `tch-003:read`, `tch-004:read`). Cached counts after Step 3: Platform Admin 444, School Admin 444, Teacher 27, Student 14, Parent 11.

Note the Student gets `tch-002:write` rather than just `read` — there is no separate "submit-own-work" permission code; row-level scoping in `SubmissionService.submit` enforces "student_id = self".

### 10. Schema-per-tenant — no `tenant_id` columns on tenant tables

Every Cycle 2 table is created in the tenant schema by `provision-tenant.ts`. None should have a `tenant_id` column. Verify the migrations.

### 11. Idempotent migrations

`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS … ; ADD CONSTRAINT …` for FK changes, `TEXT + CHECK IN (…)` rather than `CREATE TYPE` for enums. Re-running provision on an already-migrated tenant must be a no-op.

### 12. Kafka transport headers (ADR-057 forward-compat)

The producer (`grade.service.ts::tenantHeaders`) injects `event-id`, `tenant-id`, `tenant-subdomain` plus a fresh UUIDv7 on `cls.grade.{published,unpublished}`. The consumer reads the same three headers + `event-id` for idempotency. Cycle 3 will lift everything to the canonical envelope (`event_id`, `event_version`, `tenant_id`, `correlation_id`, etc.) at once. Other topics still emit raw payloads — that's a documented deviation, not a violation.

---

## Known scope decisions / accepted deviations — do not flag these

These are deliberate. If you think any of them is wrong, please call it out as a "deviation" not a "violation," and explain why you'd push back.

1. **`cls_lessons` is created but the lesson API is minimal.** Per the plan, full TCH-001 lesson planning lands in a later cycle. The table exists so assignments can reference it (`cls_assignments.lesson_id`).
2. **`cls_ai_grading_jobs` has no consumer this cycle.** Forward-compat only. The contract that AI never writes to `cls_grades` is documented and enforced at the service layer (no code path connects them).
3. **`cls_report_cards` / `cls_report_card_entries` have no API this cycle.** Schema only.
4. **No partitioning on `cls_grades` or `cls_submissions`.** Volume is bounded; partitioning is appropriate for `sis_attendance_records` (one row per student × period × school day) but overkill at ~`assignments × students` cardinality. Revisit if the table grows past O(10⁷).
5. **`cls_grades.submission_id` is nullable.** A teacher can record a grade for an assignment a student never submitted (zero-grade, paper-based work). The submission FK is informational.
6. **`cls_report_card_entries.subject` is free text, not a FK to `sis_courses`.** From the ERD: report cards label subjects in ways that don't always map 1:1 to courses (e.g. "Mathematics" combining Algebra + Geometry).
7. **No DB triggers.** ADR-010 is enforced by schema layout (no FK or trigger from `cls_grades` to `cls_gradebook_snapshots`) plus the service-layer rule, not by a `BEFORE INSERT` trigger that could be bypassed.
8. **ADR-057 envelope is partial.** Only `cls.grade.*` carries the three transport headers. Other Cycle 2 topics (`cls.submission.submitted`, `cls.progress_note.published`) emit raw. Cycle 3 lifts everything at once. See `KafkaProducerService` TODO.
9. **No browser-driver e2e.** Same scope decision as Cycle 1.
10. **No multi-grading-scale support.** The seed has one `Standard A-F (Percentage)` scale; the gradebook + grade-cell colour buckets hard-code A≥90 / B≥80 / C≥70 / D≥60 / F. Multi-scale support waits until grading_scales becomes admin-editable in Phase 2.
11. **Single teacher persona in the seed.** `sis_class_teachers` assigns James Rivera to all 6 demo classes. The CAT's "teacher can't manage another teacher's class" assertion has to manually delete + restore his class-teacher row on P3 Biology. A second STAFF user lands when HR (Cycle 4) builds out.
12. **The CAT's snapshot delta is `assignments_graded 2→3`, not a percentage change.** Maya's new 88% Homework grade rolls back into the same 30/50/20 weighted sum she already had at 90.50%. The behavioural test is the count, not the value. Documented in the CAT.
13. **`useQueries` over a per-class `useQuery` in the student `/assignments` inbox.** With 6 enrolled classes that's 6 cached round-trips. Could be a single backend endpoint; we chose client-side composition to keep the API surface minimal (and the page works as-is — captured in the CAT).
14. **`cls_lessons.bank_lesson_id` references a future lesson-bank module that doesn't exist.** Soft ref, nullable, unconstrained. Forward-compat per the ERD.

---

## Specific paths worth poking at

These are the spots most likely to harbour a real bug. Look at them first.

| File                                                                           | Why it's load-bearing                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/classroom/gradebook-snapshot-worker.service.ts`                  | First Kafka consumer in the system. Idempotency, debounce, tenant context reconstruction, and the weighted-average algorithm all live here.                                                                                             |
| `apps/api/src/kafka/idempotency.service.ts`                                    | Backed by `platform.platform_event_consumer_idempotency`. The race condition we worry about: two pods process the same event, both check "claim", both claim. Verify the unique-index path.                                             |
| `apps/api/src/kafka/kafka-consumer.service.ts`                                 | Best-effort consumer registry. If Kafka is down at boot, does the API still come up healthy? If a topic doesn't exist, does the worker fail gracefully?                                                                                 |
| `apps/api/src/classroom/grade.service.ts`                                      | The Step-8 fix — emit on update of already-published grade. Lines 471–540 (`upsertGrade`) and 313–445 (`batchGrade`) and 355–374 (`publish`). Verify every "ends-published" path emits.                                                 |
| `apps/api/src/classroom/submission.service.ts`                                 | Idempotent upsert by `(assignment, student)`. Resubmit must reset status to `SUBMITTED` and overwrite text/attachments.                                                                                                                 |
| `apps/api/src/classroom/gradebook.service.ts::getStudentClassGrades`           | New Step-9 endpoint. Three guards: `assertCanViewStudent`, `assertCanReadClass`, `(student, class)` enrollment existence. Try to find a way around them.                                                                                |
| `apps/api/src/classroom/progress-note.service.ts::listForStudent`              | Per-persona visibility. Pay attention to the filter: STUDENT / GUARDIAN must see only `published_at IS NOT NULL` AND the matching `is_*_visible` flag. STAFF must see only their assigned classes. ADMIN no filter.                     |
| `apps/api/src/sis/student.service.ts::getSelfForStudent`                       | New Step-9 endpoint. 404 (not 403) if not a STUDENT or no `sis_students` row — same probe-resistance pattern as Cycle 1.                                                                                                                |
| `packages/database/prisma/tenant/migrations/005_*.sql` and `006_*.sql`         | 28 intra-tenant FKs total. Verify CASCADE rules: assignments cascade-delete their categories, questions, answer keys; submissions cascade their per-question grades and AI jobs; grades do NOT cascade from submissions or assignments. |
| `apps/api/src/classroom/classroom.module.ts`                                   | New module wiring. Confirm guard chain inheritance from AppModule (Auth → Tenant → Permission).                                                                                                                                         |
| `apps/web/src/components/classroom/StudentClassGradesView.tsx`                 | Shared between student `/grades/:classId` and parent `/children/:id/grades/:classId`. Verify the parent route can't fall through to a "view as me" path that would bypass row scope.                                                    |
| `apps/web/src/lib/auth-store.ts` + `apps/web/src/components/shell/Sidebar.tsx` | Web persona gating. Reminder: the backend `PermissionGuard` is the authoritative access check; the web layer is for menu visibility only. Verify nothing client-side claims to enforce access.                                          |

---

## What we'd love you to actively try to break

In Cycle 1 you found a real cross-tenant data leak. Some equivalents to try here:

1. **Cross-class draft leak.** Can a parent of a student in Class A see Class A's draft grades for their own child by going through a different endpoint? The contract is "drafts are hidden from non-managers." The student / parent endpoints should all respect that.
2. **Cross-tenant snapshot pollution.** The worker reconstructs tenant context from Kafka headers. If a malicious producer (or a buggy unit test) emits a `cls.grade.published` event with `tenant-subdomain=demo` but a `class_id` that exists only in `tenant_test`, what happens? The `runWithTenantContextAsync` should pin to the demo schema and the class lookup should miss; verify it doesn't accidentally find a same-named class in test.
3. **Idempotency race.** Two pods process the same `event-id`. Both call `claim()`. Both should not flush. Verify the unique-index path in `IdempotencyService` — is the claim done in its own short transaction? Is a redelivered event dropped before it can reset the debounce?
4. **Permission scoping on `tch-002:write`.** Student gets `tch-002:write` (so the submit endpoint passes the gate). Can a student submit on another student's behalf by passing a different `studentId`? The submit endpoint takes `assignmentId` from the URL and resolves the calling `studentId` from the actor — if there's a payload field for `studentId`, that's a violation.
5. **Snapshot worker isolation.** If a grade is published for Maya in Class A, the debounce key is `(school_id, class_a, maya)`. A simultaneous publish for Liam in Class A should NOT collapse with Maya's debounce. Verify the key cardinality.
6. **Per-class write gate bypass.** A teacher with `tch-002:write` who is removed from `sis_class_teachers` mid-session should immediately lose the ability to write to that class. Permission cache TTL? Is there a gap?
7. **Frozen-tenant write through the worker.** A frozen tenant blocks request-time writes. The snapshot worker writes to `cls_gradebook_snapshots` from outside the request flow — does it honour the frozen flag, or does it bypass it? (We think it currently bypasses; this might or might not be intentional. Frozen+async is a real edge case.)

---

## Output we'd like

Same format as `REVIEW-CYCLE1-CHATGPT.md`:

1. **Verdict header** — `N PASS · N DEVIATION · N VIOLATION` and an overall accept / reject.
2. **Per violation** — title with priority, body explaining the issue, ADR violated, file path + line number, required fix, your own triage. Be specific enough that the fix can be implemented from the description alone.
3. **Per deviation** — a short "this is technically off-spec, but acceptable because X" entry. We'll consolidate and decide.
4. **Per pass** — one bullet each. Helps us know what NOT to second-guess in Cycle 3.
5. **Fix priority order table** — same shape as Cycle 1 (Priority / Violation / Risk / Effort).

When you submit, please save your output as `REVIEW-CYCLE2-CHATGPT.md` in the repo root. The Cycle 1 review bodies were ~115 lines; Cycle 2 is bigger so something in the 150–300-line range is probably right.

If you find nothing material, that's a fine outcome — say so. We'd rather you tell us "Cycle 2 is clean modulo deviations" than synthesise a violation to fill space.
