# REVIEW-CYCLE11.1-CHATGPT — Round 1 prompt scaffold

**Status:** scaffold for the post-cycle architecture review of Cycle 11.1. Fill in the verdict + triage table after the reviewer responds. Convention matches `REVIEW-CYCLE11-CHATGPT.md`, `REVIEW-CYCLE10-CHATGPT.md`, etc.

**Cycle 11.1 ships at:** tag `cycle11.1-complete` (the closeout commit on `main` after all 8 steps + CAT). Diff against `cycle11-approved` shows the full Wave 2 Domain 5 scope.

---

## Reviewer prompt (paste into the architecture-review chat)

You are an independent senior architect reviewing **Cycle 11.1 — Wellbeing Check-Ins** of CampusOS. The cycle ships the M27 Student Services Domain 5 module: **6 svc*wellbeing*\* tables, 1 IAM grant on the existing COU-004 function, 4 services + 4 controllers + 20 endpoints + 1 Kafka emit (`svc.wellbeing.alert.created`)**, the **first student-input surface in CampusOS** at `/wellbeing` (3 student routes + 4 counsellor routes), and the **5-type alert system with SELF_HARM_INDICATOR auto-escalation** (the auto-escalation is unconditional — `autoEscalate=true` on every SHI alert envelope, not configurable by the school).

The vertical slice is verified live on `tenant_demo` 2026-05-05 in `docs/cycle11.1-cat-script.md`: counsellor creates a survey template → deploys to a CASELOAD audience → bulk-INSERT plants a PENDING check-in for the only student on the caseload → student submits with the SAFETY/YES_NO trigger response → same-tx alert evaluation flags the check-in + creates a WANTS_TO_TALK alert + emits `svc.wellbeing.alert.created` with `autoEscalate=false` → second deployment to a CUSTOM_LIST audience → admin submits with SAFETY/SCALE_1_5=1 → SELF_HARM_INDICATOR alert created (precedence rule wins over FEELS_UNSAFE on the same response) + envelope emitted with `autoEscalate=true` (the keystone) → counsellor acknowledges → admin resolves → re-resolve rejected.

**Read in this order:**

1. `CLAUDE.md` — leading status section + Cycle 11.1 narrative (Steps 1–8 detail).
2. `HANDOFF-CYCLE11.1.md` — the per-step build record at the same level of detail as `HANDOFF-CYCLE11.md`.
3. `docs/campusos-cycle11.1-implementation-plan.html` — the plan the cycle was built against.
4. `docs/cycle11.1-cat-script.md` — the reproducible end-to-end CAT verified live.
5. The 10 source files of the cycle (in approximate read order):
   - `packages/database/prisma/tenant/migrations/039_svc_wellbeing_templates.sql` (Step 1)
   - `packages/database/prisma/tenant/migrations/040_svc_wellbeing_checkins.sql` (Step 2)
   - `packages/database/src/seed-wellbeing.ts` (Step 3)
   - `packages/database/src/seed-iam.ts` — the COU-004 grant block (Step 3)
   - `apps/api/src/wellbeing/dto/wellbeing.dto.ts` (Step 4 + 5)
   - `apps/api/src/wellbeing/survey-template.service.ts` (Step 4)
   - `apps/api/src/wellbeing/deployment.service.ts` (Step 4 — keystone activate path)
   - `apps/api/src/wellbeing/checkin.service.ts` (Step 5 — first student-input keystone + alert evaluation precedence)
   - `apps/api/src/wellbeing/alert.service.ts` (Step 5)
   - `apps/api/src/wellbeing/wellbeing.module.ts` + the 4 controllers
6. The web surface (`apps/web/src/app/(app)/counselling/wellbeing/{page,templates/[id],deployments/[id],alerts}/page.tsx`, `apps/web/src/app/(app)/wellbeing/{page,checkins/[id],history}/page.tsx`, `apps/web/src/hooks/use-wellbeing.ts`, `apps/web/src/lib/wellbeing-format.ts`, `apps/web/src/components/shell/apps.tsx`).

**Areas to scrutinise (the keystones / new patterns):**

- **The first student-input surface in CampusOS.** This is the first time a student directly inputs data into the platform. The submit path lives at `apps/api/src/wellbeing/checkin.service.ts::submit`. Validate (a) that pre-tx response-shape validation rejects every malformed shape (every template question has a response, no foreign questionIds, response_shape numeric-or-text, FREE_TEXT non-whitespace); (b) that the row lock + same-tx alert evaluation is correct under concurrent submits; (c) that the row scope at the service layer (resolves `actor.personId → platform_students → sis_students` and matches `student_id`) prevents a student from submitting another student's check-in even with a guessed UUID; (d) that the resubmit guard (`completed_at IS NOT NULL`) is enforced inside the locked tx so two parallel submits cannot both stamp.
- **Alert evaluation precedence.** SELF_HARM_INDICATOR (SAFETY+SCALE_1_5+numeric=1, autoEscalate=true) > FEELS_UNSAFE (SAFETY+SCALE_1_5+numeric=2 OR SAFETY+SCALE_1_10+numeric≤2) > WANTS_TO_TALK (SAFETY/EMOTIONAL+YES_NO+numeric=1). On a single SAFETY/SCALE_1_5+numeric=1 row this must produce exactly one alert (SHI), not two. Validate the precedence + the `autoEscalate` flag wiring on the Kafka payload.
- **The `acknowledged_chk` schema keystone.** Strict multi-column lockstep (`040_svc_wellbeing_checkins.sql`): NEW requires both `acknowledged_by` + `acknowledged_at` NULL; any non-NEW status requires both NOT NULL. The Step 2 narrative documents that the first draft predicate `(status='NEW') OR (...)` was too permissive (accepted NEW with ack populated because the first branch passed regardless) and was tightened to strict lockstep with an idempotent `ALTER TABLE DROP CONSTRAINT IF EXISTS / ADD CONSTRAINT` tail block. Validate the predicate is correct under all 4 mismatch directions.
- **Activate keystone — audience resolution + bulk-INSERT.** `DeploymentService.activate` locks the deployment row, resolves the audience (CASELOAD = active caseloads by deployer; SCHOOL = active sis_students; CLASS = active enrollments matching target_ids; CUSTOM_LIST = supplied ids verified in tenant; YEAR_GROUP = deferred 400), bulk-INSERTs `svc_wellbeing_checkins` rows, stamps `total_targeted`, flips `status='ACTIVE'` — all in one tx. Validate (a) the per-target-shape validation in `create` (CASELOAD / SCHOOL must omit targetIds; CLASS / YEAR_GROUP / CUSTOM_LIST require non-empty UUID array); (b) the audience-resolution joins are tenant-scoped and the supplied ids are verified to belong to the tenant before insert; (c) the lifecycle guard (only SCHEDULED → ACTIVE).
- **Per-persona visibility model.** Four branches — admin all / counsellor caseload-linked / student own / teacher stripped DTO via `stripCheckinForTeacher` (clears `studentId` + `studentName` + `assignedCounselorId` + `flaggedForFollowUp` so teachers see aggregated trend rows without per-student detail). Validate (a) the row-scope SQL is correct under each persona (especially the teacher branch — does the strip happen unconditionally for STAFF non-counsellors regardless of which class students they happen to teach?); (b) the per-detail teacher 403 fires BEFORE `loadOrFail` to give the redirect message instead of a generic 404; (c) parents are denied at the gate (no `cou-004:*` grant — wellbeing data is student-counsellor confidential).
- **Auto-escalation contract.** SELF_HARM_INDICATOR alerts unconditionally emit `autoEscalate=true` on the wire envelope. The reviewer should confirm the contract is enforced server-side, NOT optional / school-configurable. The Cycle 3 NotificationConsumer wiring against this topic is **deferred** — emit lands cleanly today, no consumer fans it out to IN_APP / EMAIL yet. This is a documented carry-over (item 1 in the CAT reviewer-attention section).
- **Student-visible `flaggedForFollowUp` field.** The API today returns `flaggedForFollowUp=true` to the student who owns the check-in. The Step 7 student UI page intentionally does NOT render this field per the documented contract ("Students never see the flagged status or alert rows — the counsellor initiates any follow-up conversation naturally"). A custom client could still read it via the API. Validate whether this is a privacy gap worth tightening server-side (strip for STUDENT actors at the service layer) or a non-blocking Phase 2 polish.
- **Catalogue convention.** Cycle 11.1 reuses the existing `COU-004` catalogue entry; no new function code added. Catalogue total stays at **450**. Validate the IAM seed change in `seed-iam.ts` is the minimum surface area required.
- **Schema invariants.** 6 base tables, 13 intra-tenant FKs, 0 cross-schema FKs. Validate (a) every CHECK constraint fires on bogus inputs (the Step 1/2 smoke documents 16 + 17 assertions; reviewer should re-run if desired); (b) the splitter `;`-in-string trap is not tripped — the Step 1 narrative caught + fixed 3 stray semicolons in COMMENT strings before first apply; (c) the FK delete-action distribution (CASCADE × 4 on student/checkin/student/response chains; NO ACTION × 2 on template/question to preserve audit; SET NULL × 3 on deployment_id, assigned_counselor_id, acknowledged_by; plus the Step 1 4 — NO ACTION × 3 + CASCADE × 1) matches what the schema documents.

**Deferred / out-of-scope this cycle (don't flag as gaps):**

1. Cycle 3 NotificationConsumer wiring on `svc.wellbeing.alert.created` (emit lands cleanly; no consumer subscribes yet).
2. SIGNIFICANT_SCORE_DROP and PERSISTENT_LOW_SCORE alerts (require longitudinal evaluation; schema accepts both values but no service generates them this cycle).
3. YEAR_GROUP audience-resolution path (`_schoolId` parameter retained on `resolveAudience` for the future shape; current path returns 400 deferred).
4. Scheduled deployment auto-activation (manual activation only; cron / worker that flips SCHEDULED → ACTIVE at `deploy_at` is a future enhancement).
5. Counsellor / Nurse / Lead-counsellor role split — carries from Cycles 9 + 10 + 11; Staff role currently grants every COU code. Wave 2 Phase 2 backlog item 9 / 11.
6. Response RANGE-partitioning by month — ERD v11 tags `svc_wellbeing_responses` for monthly partitioning. Cycle 11.1 ships it as a simple table; partitioning is a Phase 3 ops concern when data volume warrants it.

**Verdict format:** **APPROVED** / **APPROVED with major follow-ups** / **REJECT pending fixes**. For each finding, label severity (BLOCKING / MAJOR / MINOR / DEVIATION) and provide a one-paragraph reproduction (file:line + the smallest reproducible scenario).

---

## Round 1 — misdirected review (reviewer read pre-`a5abe4e` `main`)

The Round 1 review came back **REJECT pending fixes**, but the reviewer was reading `origin/main` _before_ `a5abe4e` was pushed (the Cycle 11.1 closeout commit was committed locally and not yet on the remote). The reviewer explicitly states: _"the numbered 11.1 handoff/review files were not present at the paths I checked."_ They reviewed the prior tip — `81f2be6` — which is the **Phase 2 Parent Polish** state, so all findings are about Phase 2 code (calendar RSVPs, add-child workflow, public enrollment search, multi-school billing) rather than Cycle 11.1.

After the misdirected review, `a5abe4e` was pushed to `origin/main` so the next reviewer pass can read the actual Cycle 11.1 surface. The Phase 2 BLOCKING findings are spurious; the Phase 2 MAJOR 3 + 4 findings are real bugs and have been fixed in a follow-up commit.

### Phase 2 BLOCKING findings — verified spurious against `origin/main`

| Reviewer claim                                                                                                                    | Reality on `origin/main`                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BLOCKING 1** — `TenantResolverMiddleware` doesn't exempt `/api/v1/enrollment/search` and uses `req.path` not `req.originalUrl`. | `apps/api/src/tenant/tenant-resolver.middleware.ts:34` reads `req.originalUrl ?? req.url ?? req.path`. Line 137 lists `/api/v1/enrollment/search` in `exemptPrefixes`. Both already correct. The reviewer was looking at a cached / stale view.                |
| **BLOCKING 2** — `FamilyAccountService` doesn't populate `schoolName` / `sharedBillingGroupId`.                                   | `apps/api/src/payments/family-account.service.ts:72` — `SELECT_ACCOUNT_BASE` does `LEFT JOIN platform.schools sc ON sc.id = a.school_id` and selects `sc.name AS school_name, sc.shared_billing_group_id`. Lines 57–58 map both onto the DTO. Already correct. |

### Phase 2 MAJOR findings — triage

| #           | Severity                                                      | Finding                                                                                                                                                                                                                                                    | Status                                         |
| ----------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **MAJOR 3** | BUG (race) — child-link LINK_EXISTING duplicate-pending.      | `submitLinkExisting` does pre-check + INSERT under `executeInTenantContext` (single-statement tx). Two concurrent submits can both pass the pre-check and both INSERT a PENDING row for the same `(guardian, target student)` pair. No schema-level dedup. | **FIXED** in this commit                       |
| **MAJOR 4** | BUG — child-link ADD_NEW no duplicate guard.                  | `submitAddNew` does an unconditional INSERT with no duplicate check at all — accidental double-clicks create multiple PENDING rows for the same child.                                                                                                     | **FIXED** in this commit                       |
| **MAJOR 5** | Scale — public enrollment search loops all active schools.    | Acceptable for demo per `HANDOFF-PHASE2-POLISH.md`. Add geospatial index + bounding-box prefilter + rate limiting before the public surface goes wide.                                                                                                     | **DEFERRED** to Phase 2 backlog (item carried) |
| **MAJOR 6** | Operational — `enr_period_allows_public_search DEFAULT true`. | Convenient for demo; risky for production (existing OPEN periods auto-become public-search visible). Recommendation: flip default to `false` and require explicit publish-to-search before pilot.                                                          | **DEFERRED** to Phase 2 backlog (item carried) |
| **MAJOR 7** | Acknowledged — calendar RSVP no audience targeting.           | Already documented in `HANDOFF-PHASE2-POLISH.md` as "audience targeting is deferred because calendar events do not yet carry audience columns." Any authenticated user with `sch-003:read` can RSVP to any published event.                                | **DEFERRED** (already on Phase 2 punch list)   |

### Fix for MAJOR 3 + 4 — partial UNIQUE INDEXes + `isUniqueViolation` catch

Tenant migration `041_sis_child_link_requests_dedup.sql` adds two partial UNIQUE indexes scoped to PENDING rows:

```sql
CREATE UNIQUE INDEX sis_child_link_requests_link_existing_pending_uq
  ON sis_child_link_requests (requesting_guardian_id, existing_student_id)
  WHERE status = 'PENDING' AND request_type = 'LINK_EXISTING';

CREATE UNIQUE INDEX sis_child_link_requests_add_new_pending_uq
  ON sis_child_link_requests (
    requesting_guardian_id,
    LOWER(new_child_first_name),
    LOWER(new_child_last_name),
    new_child_date_of_birth
  )
  WHERE status = 'PENDING' AND request_type = 'ADD_NEW';
```

The ADD_NEW index uses functional `LOWER()` on the names so case-flipped retypes (`Lily` / `lily` / `LILY`) hit the same dedup; DOB disambiguates otherwise-identical name pairs. Both indexes are PARTIAL on `status='PENDING'` so APPROVED / REJECTED rows release the slot for a re-submit.

Service-side update — `apps/api/src/sis/child-link-request.service.ts`:

- `submitLinkExisting` and `submitAddNew` now run the existence-check / pre-check + INSERT inside one `executeInTenantTransaction` so concurrent submits see the same snapshot.
- New module-bottom helper `isUniqueViolation(err)` catches PostgreSQL SQLSTATE 23505 from the partial UNIQUE INDEX (matches the helper in `discipline/action.service.ts` and `payments/refund.service.ts` — driver-version-stable: checks Prisma's `P2010` plus the embedded `meta.code='23505'` plus a regex on the message text as belt-and-braces).
- The race-loser path returns the exact same friendly 409 ("You already have a pending request for this student" / "You already have a pending request for this child") that the happy-path pre-check returns.

### Live verification on `tenant_demo` 2026-05-05

**Schema-side dedup smoke** (single BEGIN…ROLLBACK with savepoints, 7 assertions all green):

```
T1 LINK_EXISTING first row INSERT                       OK
T2 LINK_EXISTING duplicate (same pair, PENDING)         REJECTED by sis_child_link_requests_link_existing_pending_uq
T3 LINK_EXISTING same pair APPROVED status              ACCEPTED (slot released)
T4 ADD_NEW first row INSERT                             OK
T5 ADD_NEW exact duplicate                              REJECTED by sis_child_link_requests_add_new_pending_uq
T6 ADD_NEW case-flipped names (LILY chen vs Lily Chen)  REJECTED (LOWER() works)
T7 ADD_NEW same names but different DOB                 ACCEPTED
```

**End-to-end race smoke** (API live, parent submits, parallel curl):

```
LINK_EXISTING — 5 parallel POSTs for (David, Ethan):
  R1..R4 http=409 msg=You already have a pending request for this student
  R5     http=201 status=PENDING
  → DB has exactly 1 PENDING row.

ADD_NEW — 5 parallel POSTs for (David, Lily Chen, 2014-02-10):
  A1..5 → exactly 1× 201 + 4× 409 ("You already have a pending request for this child")
  → DB has exactly 1 PENDING row.
  Case-flipped retype (LILY chen) → http=409 (LOWER() partial index catches it)
```

5 parallel-curl runs land exactly 1× 201 + 4× 409 on both code paths, with the friendly conflict message on every race-loser response — the schema-side partial UNIQUE INDEX is the load-bearing race protection and the service-layer `isUniqueViolation` translator surfaces the same 409 the happy-path pre-check returns.

Smoke residue cleaned (`DELETE FROM sis_child_link_requests WHERE requesting_guardian_id ...`); tenant returns to seed shape (no PENDING child-link requests).

### Files changed in the Phase 2 fix commit

- `packages/database/prisma/tenant/migrations/041_sis_child_link_requests_dedup.sql` — new migration: 2 partial UNIQUE INDEXes scoped to PENDING.
- `apps/api/src/sis/child-link-request.service.ts` — `submitLinkExisting` + `submitAddNew` wrapped in `executeInTenantTransaction`; new module-bottom `isUniqueViolation` helper translates SQLSTATE 23505 to a friendly 409 on the race-loser path.

No web changes. No new Kafka emits. The race-loser surfaces as the same 409 the existing parent UI already handles via its standard error-toast path.

---

## Round 2 — `b58e591` against `origin/main` (the actual Cycle 11.1 review)

**Verdict:** REJECT pending fixes — 2 BLOCKING + 4 MAJOR.

Reviewer confirmed the Round 1 misdirection had been corrected (`/api/v1/enrollment/search` exemption, `FamilyAccountService` joins `platform.schools`, child-link partial UNIQUE indexes all present), confirmed the wellbeing module is registered, schema is disciplined, submit concurrency lock is correct, alert evaluation precedence is correct, alert lifecycle locking is correct, and the ADR-057 envelopes capture cleanly.

Found 2 BLOCKINGs (privacy gap on student `flaggedForFollowUp` + missing per-question-type response validation) plus 4 MAJORs (teacher row-level access leaks counts, CUSTOM_LIST/CLASS silently drops invalid IDs, SCHOOL targeting too broad for non-admin counsellors, no schema-side dedup on `(deployment_id, student_id)`).

### Triage

| #          | Severity                                        | Finding                                                                                                                                                                                                                                                                    | Status                              |
| ---------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| BLOCKING 1 | PRIVACY (student-input contract)                | `CheckinService.list` + `getById` returned `flaggedForFollowUp=true` to the student who owns the check-in. The Step 7 student UI doesn't render it but a custom client could read it.                                                                                      | **FIXED**                           |
| BLOCKING 2 | DATA INTEGRITY (server-side validation)         | Submit pre-tx validation only checked "has either numeric or text"; no per-question-type range. A custom client could store `YES_NO=7`, `SCALE_1_5=999`, or `FREE_TEXT` answered numeric-only.                                                                             | **FIXED**                           |
| MAJOR 3    | PRIVACY (teacher row-level access)              | Teacher list returned row-level cross-tenant data with identity stripped, but counts / completed-vs-pending timing / `flagged=true` filter cardinality leaked. The reviewer's safest-fix path is "no row-level access for teachers; aggregate-only via a future endpoint." | **FIXED** (denied at service layer) |
| MAJOR 4    | BUG (silent drop of invalid target ids)         | `CUSTOM_LIST` and `CLASS` activation resolved supplied ids by `WHERE id = ANY(...)` and silently used whatever rows came back. Mistyped or stale ids reduced the audience without erroring.                                                                                | **FIXED**                           |
| MAJOR 5    | LOCKED PRODUCT/SECURITY DECISION (SCHOOL gate)  | Any counsellor with `cou-004:write` could create + activate a SCHOOL-wide deployment fanning out to every active student. Reviewer said "should be a locked product/security decision." Decision: admin only.                                                              | **FIXED**                           |
| MAJOR 6    | SCHEMA (no `(deployment_id, student_id)` dedup) | The activate keystone's row lock prevents same-deployment double-activation but the schema didn't enforce uniqueness. Future backfills / repair jobs / manual inserts could land duplicate rows.                                                                           | **FIXED**                           |

### Fix details

**BLOCKING 1 — student-strip on `flaggedForFollowUp`.** New `stripCheckinForStudent` helper at `apps/api/src/wellbeing/checkin.service.ts` mirroring the teacher pattern. Applied in `list()` (when `actor.personType === 'STUDENT'`) and `getById()` (final-pass strip after responses are inlined; preserves `responses` because the student legitimately sees their own answers in `/wellbeing/history`). Strips `flaggedForFollowUp` (alert state — students never see follow-up flags) plus `assignedCounselorId` + `assignedCounselorName` (avoid leaking caseload assignments through the student API).

**BLOCKING 2 — per-question-type validation.** New module-bottom `assertResponseShape(q, numeric, text)` helper at `checkin.service.ts`. Called inside the submit pre-tx loop, throws `BadRequestException` with a clear per-question error message on the first malformed response. Rules: `YES_NO` numeric in {0,1} text-not-allowed; `SCALE_1_5` + `EMOJI_SCALE` integer in [1,5] text-not-allowed; `SCALE_1_10` integer in [1,10] text-not-allowed; `FREE_TEXT` non-blank text numeric-not-allowed. The DTO `@IsInt()` decorator stays in place; the per-type range check is the new gate.

**MAJOR 3 — deny teacher row-level entirely.** `CheckinService.list` now throws `ForbiddenException` ("Teachers see aggregated wellbeing trends only — the per-check-in list is restricted to the counselling team.") for any non-admin / non-counsellor STAFF actor. The previous `stripCheckinForTeacher` helper is documented as removed for this reason; future teacher-trend surfaces should land as a dedicated aggregate endpoint that returns pre-aggregated counts, not row-level objects with identity scrubbed.

**MAJOR 4 — count-match validation on CUSTOM_LIST + CLASS.** New `assertAllStudentsExist(ids)` and `assertAllClassesExist(ids)` helpers on `DeploymentService` called from `create()` for the corresponding target types. Pre-flight pass selects matching rows, compares count to input length, and 400s with the missing ids inlined when the counts don't match. Belt-and-braces inside `resolveAudience` at activate time too — if rows changed between create and activate the activate path catches the mismatch.

**MAJOR 5 — SCHOOL admin-only.** `DeploymentService.create()` rejects `target_type='SCHOOL'` from non-admin actors with `ForbiddenException("SCHOOL-wide deployments require school-admin authorisation. Counsellors should target CASELOAD, CLASS, or CUSTOM_LIST instead.")`. Belt-and-braces at activate time too — even if a row somehow exists with `target_type='SCHOOL'` and a non-admin activator, the activate path refuses the fan-out.

**MAJOR 6 — partial UNIQUE INDEX on `(deployment_id, student_id) WHERE deployment_id IS NOT NULL`.** Tenant migration `042_svc_wellbeing_checkins_dedup.sql`. PARTIAL because ad-hoc check-ins (`deployment_id NULL`) intentionally allow multiple rows for the same student over time. The activate keystone's row lock already prevents double-activation; the index is the schema-side belt-and-braces against future backfill / repair / manual insert paths.

### Live verification on `tenant_demo` 2026-05-05

**BLOCKING 1 strip:**

```
Maya GET /checkins (own scope):
  flaggedForFollowUp=False  assignedCounselorId=None  assignedCounselorName=None  (DB has true / Hayes — stripped server-side)
Maya GET /checkins/:id (own detail):
  flaggedForFollowUp=False  responses=5  (responses preserved)
Counsellor GET same /:id:
  flaggedForFollowUp=True  assignedCounselorName='Marcus Hayes'  (counsellor sees truth)
```

**BLOCKING 2 validation:**

```
T1 YES_NO=7              → 400 "is YES_NO and requires numericResponse 0 (No) or 1 (Yes)"
T2 SCALE_1_5=999         → 400 "is SCALE_1_5 and requires numericResponse in [1, 5]"
T3 SCALE_1_10=99         → 400 "is SCALE_1_10 and requires numericResponse in [1, 10]"
T4 FREE_TEXT numeric-only → 400 "is FREE_TEXT and does not accept a numeric response"
T5 SCALE_1_5 text-only   → 400 "is SCALE_1_5 and does not accept a text response"
T6 EMOJI_SCALE=10        → 400 "is EMOJI_SCALE and requires numericResponse in [1, 5]"
T7 happy path all in range → 201
```

**MAJOR 3 teacher row-level denial:**

```
teacher GET /checkins        → 403 "Teachers see aggregated wellbeing trends only — the per-check-in list is restricted to the counselling team"
teacher GET /checkins/:id    → 403  (already in place pre-fix)
```

**MAJOR 4 count-match:**

```
Counsellor POST CUSTOM_LIST [Maya, BOGUS]:
  → 400 "targetIds referenced 1 student id(s) that do not exist in this tenant: 11111111-2222-4333-8444-555555555555"
Counsellor POST CUSTOM_LIST [BOGUS]:
  → 400 (same shape)
Counsellor POST CLASS [<real_class_id>, BOGUS]:
  → 400 "targetIds referenced 1 class id(s) that do not exist in this tenant: 11111111-2222-4333-8444-555555555555"
Counsellor POST CUSTOM_LIST [Maya] — happy path:
  → 201 status=SCHEDULED
```

**MAJOR 5 SCHOOL gate:**

```
Counsellor POST SCHOOL → 403 "SCHOOL-wide deployments require school-admin authorisation. Counsellors should target CASELOAD, CLASS, or CUSTOM_LIST instead."
School admin (principal@) POST SCHOOL → 201 (allowed)
Synthetic Platform Admin (admin@) POST SCHOOL → 403 "Deployer must have an employee record" (Cycle 4 Step 0 design — admin@ is not bridged to hr_employees)
```

**MAJOR 6 partial UNIQUE:**

```
T1 INSERT 2nd row for (deployment_id, student_id) of seeded Maya check-in → REJECTED by svc_wellbeing_checkins_deployment_student_uq
T2 INSERT 2 ad-hoc check-ins (deployment_id NULL) for same student → ACCEPTED (partial index excludes NULL — ad-hoc check-ins legitimately allow multiples over time)
```

Smoke residue cleaned (CAT smoke template + deployments + check-ins + responses + alerts dropped via `DELETE … WHERE template.name = 'R2 BLOCKING2 — Per-type smoke'` walking the graph in reverse). Tenant returns to post-Step-3 seed shape exactly: `templates=1 questions=5 deployments=1 checkins=2 responses=5 alerts=1`.

### Files changed in the Round 2 fix commit

- `apps/api/src/wellbeing/checkin.service.ts` — added `stripCheckinForStudent` helper; `list()` denies non-counsellor STAFF with 403, applies student strip; `getById()` applies student strip to the inlined-responses DTO; `submit()` calls new `assertResponseShape()` per response in the pre-tx validation loop. Removed unused `stripCheckinForTeacher` helper (MAJOR 3 path eliminated all callers).
- `apps/api/src/wellbeing/deployment.service.ts` — `create()` rejects SCHOOL from non-admin (MAJOR 5) + pre-flights `assertAllStudentsExist` / `assertAllClassesExist` for CUSTOM_LIST / CLASS targets (MAJOR 4); `activate()` belt-and-braces SCHOOL admin-only check inside the locked tx; `resolveAudience()` count-match validation on CUSTOM_LIST + CLASS at audience-resolution time too.
- `packages/database/prisma/tenant/migrations/042_svc_wellbeing_checkins_dedup.sql` — new migration: partial UNIQUE INDEX on `(deployment_id, student_id) WHERE deployment_id IS NOT NULL` (MAJOR 6).

No web changes. No new Kafka emits. No new endpoints.

### Open follow-ups carried to Wave 2 Phase 2 backlog

- **Aggregate trend endpoint for teachers** — the MAJOR 3 fix denies row-level entirely. A dedicated `GET /counselling/wellbeing/trends` returning pre-aggregated per-template completion counts (and per-domain mean scores, anonymised) is a reasonable Phase 2 surface to give teachers something useful without leaking row-level data. Out of scope for the Round 2 fix.

## Round 3 — APPROVED at `6d2b04c` (final gate)

**Verdict:** APPROVED. _"Cycle 11.1 is clean from my review perspective. You can tag `cycle11.1-approved`."_

Reviewer cache-busted the six fix paths in code on Round 3 and confirmed each:

1. **BLOCKING 1** — `stripCheckinForStudent()` applied to list + detail; clears `flaggedForFollowUp` / `assignedCounselorId` / `assignedCounselorName`; preserves the student's own responses.
2. **BLOCKING 2** — `assertResponseShape()` called in the submit pre-tx loop. Enforces YES_NO ∈ {0,1}; SCALE_1_5 + EMOJI_SCALE ∈ [1,5]; SCALE_1_10 ∈ [1,10]; FREE_TEXT non-blank text only; cross-shape rejected.
3. **MAJOR 3** — Non-counsellor STAFF rejected on the row-level list + detail paths with `ForbiddenException`; aggregate-only endpoint preserved as a future surface.
4. **MAJOR 4** — `DeploymentService.create()` pre-validates every supplied CUSTOM_LIST student id + CLASS class id; `resolveAudience()` revalidates count-match at activation time.
5. **MAJOR 5** — SCHOOL targeting requires school-admin authority at both create + activate.
6. **MAJOR 6** — Migration `042_svc_wellbeing_checkins_dedup.sql` partial UNIQUE INDEX on `(deployment_id, student_id) WHERE deployment_id IS NOT NULL`.

Tagged `cycle11.1-complete` on `a5abe4e` (the original closeout commit + CAT) and `cycle11.1-approved` on `6d2b04c` (the Round 2 fix commit, after this APPROVED verdict).
