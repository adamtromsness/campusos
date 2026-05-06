# REVIEW-CYCLE24-CHATGPT

**Cycle:** 24 — Student Portfolio (Wave 5 cycle 2).
**Round 1 verdict:** Reject pending fixes — 5 BLOCKING + 4 MAJOR.
**Round 1 commit:** `cycle24-complete` (`c46cacd`).
**Round 1 fix commit:** this commit.
**Live verification:** `tenant_demo` 2026-05-06.

## Triage table

| #        | Class  | Title                                                                  | Disposition                                                                          |
| -------- | ------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| BLOCKING | 1      | `GET /portfolio/:id/items` not actor-scoped                            | Fixed — actor-aware listItemsForPortfolio + parent-portfolio visibility lattice      |
| BLOCKING | 2      | Share-token list leaks to any reader if shares exist                   | Fixed — owner/admin gate runs BEFORE returning rows; collapsed 404 don't-leak        |
| BLOCKING | 3      | addItem source validation does not enforce ownership                   | Fixed — every source-typed item validates source.student_id = portfolio.student_id   |
| BLOCKING | 4      | TEACHER visibility implemented as "all staff", not assigned teachers   | Fixed — isAssignedTeacherOf joins sis_class_teachers + sis_enrollments ACTIVE        |
| BLOCKING | 5      | Achievement source refs not validated when supplied                    | Fixed — assertSourceOwnedBy walks library / clubs / classroom / athletics            |
| MAJOR    | 6      | Public share view exposes raw s3Key                                    | Fixed — public projection nulls s3Key + sourceRefId                                  |
| MAJOR    | 7      | pfl_portfolios.student_id COMMENT mis-states soft FK target            | Fixed — COMMENT now says sis_students(id); applied to live tenant_demo + tenant_test |
| MAJOR    | 8      | Kafka envelope sourceRefId set to achievement id instead of source ref | Fixed — payload.sourceRefId = dto.sourceRefId; achievementId stays separate          |
| MAJOR    | 9      | Achievement patch with awarded_by NULL allows any staff edit           | Fixed — awarded_by IS NULL ⇒ school-admin only                                       |
| Pass     | strong | Module scope and handoff clarity                                       | ✓                                                                                    |
| Pass     | strong | Schema additive + soft-integrity compliant                             | ✓                                                                                    |
| Pass     | strong | Portfolio create/patch ownership                                       | ✓                                                                                    |
| Pass     | strong | Item mutation ownership (the gap was source ownership, fixed)          | ✓                                                                                    |
| Pass     | strong | Share creation + revocation owner/admin scoped                         | ✓                                                                                    |
| Pass     | strong | Achievement list/get row scope                                         | ✓                                                                                    |

## Code-level fixes

### BLOCKING 1 — `GET /portfolio/:id/items` actor-aware

`PortfolioService` now exposes two paths:

- `listItemsForPortfolio(portfolioId, actor)` — public entry point. Loads the parent portfolio's `student_id` + `visibility`, enforces the same `canRead` lattice as `getByStudent`, throws collapsed `404 NotFoundException` for non-authorised callers (matches the don't-leak-existence pattern used by Cycles 9 / 10 / 11 / 23).
- `listItemsInternal(portfolioId)` — internal. Bypasses visibility because the caller has already authorised. Used by `getByStudent` (which calls `canRead` upstream) and by `ShareService.viewByToken` (where the share token is the access gate).

Controller updated to resolve the actor and pass it through. Internal callers in `portfolio.service.ts` and `share.service.ts` updated to use `listItemsInternal`.

**Live verified on `tenant_demo` 2026-05-06** with Maya's portfolio at `visibility='TEACHER'`:

- Maya (owner) → 200
- Principal (school admin override) → 200
- Teacher Rivera (assigned to Maya's classes) → 200
- **Counsellor (STAFF, no teaching relationship) → 404**
- **Parent (TEACHER tier does not unlock parent) → 404**

### BLOCKING 2 — share token list owner/admin only

`ShareService.listForPortfolio` previously only ran the owner check when `rows.length === 0`. If any share row existed, the bearer-credential `share_token` strings flowed straight to any caller with `ach-002:read`. Fix: load the parent portfolio first, validate caller is owning student or school admin, only then run the rows query. Non-owner non-admin gets a collapsed `404 NotFoundException` (don't-leak-existence — they shouldn't be able to distinguish "no shares yet" from "you can't see the shares").

**Live verified** with Maya's portfolio carrying 1 seeded share row:

- Maya (owner) → 200, sees 1 share with the token
- Principal (admin) → 200
- **Teacher → 404**
- **Counsellor → 404**
- **Parent → 404**

### BLOCKING 3 — addItem source-ownership validation

`PortfolioService.addItem` previously validated only that `cls_submissions` / `cls_grades` / `pfl_achievements` rows with the supplied `sourceRefId` existed in the tenant. A student with an arbitrary UUID could thus add another student's submission, grade, or achievement to their own portfolio. Particularly sensitive for `GRADE` items.

Fix: each source-typed branch now joins on `student_id = portfolio.student_id` (the owning student resolved at the top of the locked tx). The error message updates to "does not match a [submission|grade|achievement] belonging to the portfolio owner."

**Live verified:** Maya tries to add Ethan's submission → 400; Maya adds her own submission → 201.

### BLOCKING 4 — TEACHER visibility = assigned teachers only

`canRead` was granting `TEACHER` and `PARENT` visibility to any actor with `personType === 'STAFF'` — this swept in counsellors, VPs, admin assistants, and unrelated teachers from other classes. The handoff documented "assigned teachers" but the implementation said "all staff."

Fix: two new helpers `isAssignedTeacherOf(actor, studentId)` (joins `sis_class_teachers + sis_enrollments` keyed on `actor.employeeId`, requires `enrollment.status = 'ACTIVE'`) and `isLinkedGuardianOf(actor, studentId)` (joins `sis_student_guardians + sis_guardians` on `actor.personId`). `canRead` rewritten:

- `PRIVATE` → owner only (admin override allowed)
- `TEACHER` → owner + isAssignedTeacherOf + admin
- `PARENT` → owner + isAssignedTeacherOf + isLinkedGuardianOf + admin
- `PUBLIC` → any authenticated user (admin override implicit)

Generic STAFF without a teaching relationship is no longer granted any visibility above PRIVATE; non-teaching staff reach the surface via the school-admin override.

**Live verified:** Counsellor (`personType=STAFF`, no teaching assignment) GETs Maya's TEACHER-visibility portfolio → 404. Teacher Rivera (assigned to Maya's classes) → 200. Principal (admin override) → 200.

### BLOCKING 5 — achievement source ref validation

`AchievementService.create` validated `studentId` against `sis_students` but accepted any `sourceModule` + `sourceRefId` pair without further check. The achievement aggregation contract required the source row to actually belong to the awarded student.

Fix: new private helper `assertSourceOwnedBy(sourceModule, sourceRefId, studentId)` walks the four documented cross-cycle integration points:

- `library` → `lib_programme_completions` (Cycle 12) where `student_id = $studentId`
- `clubs` → `ext_service_progress` (Cycle 17) where `student_id = $studentId`
- `classroom` → `cls_grades` (Cycle 2) where `student_id = $studentId`
- `athletics` → `ath_player_game_stats` where `student_id = $studentId`, falling back to `ath_all_time_records` school-scoped (the per-school records are not student-keyed)

Unknown `sourceModule` values fall through to a 400 with the supported-list inlined. `sourceRefId` set without a `sourceModule` also returns 400. Manual teacher-awarded achievements with neither field set continue to flow through unchanged.

**Live verified:** library award with bogus sourceRefId → 400; clubs award with bogus sourceRefId → 400; clubs award with Maya's real `ext_service_progress.id` → 201; bogus sourceModule `'banking'` → 400; sourceRefId without sourceModule → 400; manual award (no source) → 201.

### MAJOR 6 — public share view strips `s3Key`

`ShareService.viewByToken` previously called `listItemsInternal` (then named `listItemsForPortfolio`) and returned items as-is. The public unauthenticated viewer was therefore exposing internal S3 keys and tenant-internal source UUIDs.

Fix: post-process the items + featured arrays inside `viewByToken` to set `s3Key = null` and `sourceRefId = null` for the public projection. The future signed-URL download path will need its own endpoint that issues short-lived signed URLs on demand, never the raw key.

### MAJOR 7 — `pfl_portfolios.student_id` COMMENT correction

The migration COMMENT for `pfl_portfolios.student_id` (and `pfl_achievements.student_id`) said "Soft FK to `platform.platform_students(id)`" but the service code consistently treats both columns as tenant `sis_students.id`. The runtime is correct; the COMMENT was misleading future readers.

Fix: COMMENT rewritten to "Tenant-local soft reference to `sis_students(id)` per ADR-001/020 — schema-per-tenant, validated at the application layer. The owning student record lives in this tenant; cross-school portability flows through `platform.platform_students` at the SIS layer, not here." Applied to both `081_pfl_portfolios.sql` and `082_pfl_achievements.sql` for fresh provisions, plus a `COMMENT ON COLUMN` applied directly to live `tenant_demo` and `tenant_test` so existing tenants match.

### MAJOR 8 — `pfl.achievement.awarded` envelope sourceRefId

The Kafka emit payload was setting `sourceRefId: dto.id` — the achievement id — alongside `achievementId: dto.id`. The handoff documented `sourceRefId` as the originating module reference (e.g. `lib_programme_completions.id`); downstream consumers expecting the cross-cycle pointer were getting the achievement id instead.

Fix: payload now sets `sourceRefId: dto.sourceRefId` (the actual originating ref, null for manual teacher awards). `achievementId` stays as `dto.id`.

**Live verified** with two new awards: one with `sourceModule='clubs'` + Maya's `ext_service_progress.id` → envelope shows `achievementId=<new uuid>` with `sourceRefId=019dfc48` (matches Maya's clubs progress); manual award → envelope shows `sourceRefId=None`.

### MAJOR 9 — patch with `awarded_by IS NULL` = admin only

`AchievementService.patch` previously allowed any actor with `ach-001:write` to edit when `awarded_by` was NULL, because the awarder-mismatch check only fired when both the actor's `employeeId` and the row's `awarded_by` were set. System-generated cross-module achievements (Cycle 12 library backfill, Cycle 17 service-hour milestones) carry `awarded_by IS NULL` by design — they should be admin-only to edit.

Fix: explicit branch — when `awarded_by IS NULL`, allow only `actor.isSchoolAdmin`. Otherwise fall through to the standard `ach-001:write` + `actor.employeeId === awarded_by` rule (admin override allowed).

**Live verified:** Teacher PATCH on Summer Reading Champion (seeded with `awarded_by=NULL`) → 403 with the documented message; Principal PATCH same row → 200.

## Phase 2 punch list (carried)

No new items — Cycle 24's deferred work continues to be the polish list documented in `HANDOFF-CYCLE24.md`:

- Auto-achievement consumers on `lib.programme.completed` / `ext.service_progress.milestone` / `ath.record.set` (today the seed plants both rows side-by-side).
- Portfolio PDF export.
- AI-generated portfolio summaries.
- Athletics achievement integration (the validator branch is in place; no Cycle 13 backfill ships in this cycle).
- Directory student picker on the teacher Award modal (currently a UUID input).
- Badge image S3 signed-URL upload.
- Public share view file download via signed URL (matching MAJOR 6's deferred secure-download path).

These join the existing Wave 2-5 Phase 2 punch list (items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 / 30 / 32 / 33 / 34 / 35 / 36 / 37 / 38 / 39 / 40) for hardening before pilot.

## Verdict trail

- 2026-05-06 — `cycle24-complete` (`c46cacd`) submitted for review.
- 2026-05-06 — Round 1 verdict: **Reject pending fixes** (5 BLOCKING + 4 MAJOR).
- 2026-05-06 — All 5 BLOCKING + 4 actionable MAJORs (6 / 7 / 8 / 9) landed in this commit, live-verified on `tenant_demo`.

**Cycle 24 ships clean to Round 2.** Tagging `cycle24-approved` after Round 2 APPROVED.
