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

## Round 1 verdict — TBD

> _(Paste reviewer's verdict here after the Round 1 response.)_

---

## Triage table — TBD

| #   | Severity | Finding | Status |
| --- | -------- | ------- | ------ |
| —   | —        | —       | —      |

---

## Files changed in the closeout fix commit — TBD

> _(After Round 1 fixes, list the changed files + the Round 2 verdict here. Tag `cycle11.1-approved` after the Round 2 APPROVED verdict.)_
