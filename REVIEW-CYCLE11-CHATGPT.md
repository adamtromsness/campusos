# REVIEW-CYCLE11-CHATGPT — Round 1 verdict + fix log

**Round 1** (against `cycle11-complete` at `a46d905`) returned **Reject pending fixes** — 2 Cycle 11 blockers + 1 stale-report Cycle 10 carry-over + 4 majors. Reviewer scorecard: 7 PASS · 3 actionable BLOCKING (one already fixed in code) · 4 follow-ups.

The two real Cycle 11 blockers are valid privacy / row-scope defects and are fixed in this commit. The third "blocker" (Cycle 10 medication administration history) was already corrected in commit `970a6b3` (REVIEW-CYCLE10 BLOCKING) — the controller is gated on `hlt-002:read`, not `hlt-001:read` — but the reviewer surfaced it again, so we re-verified live and it 403s for parents. Documented in the table below as DEVIATION-VERIFIED.

Three of the four MAJOR items were code-fixable and are addressed here (4 + 5 + 6). MAJOR 7 (Counsellor / Nurse / Lead-counsellor role split) joins the Wave 2 Phase 2 punch list — it's an architectural role-redesign task that should land before the platform onboards real schools, not a code fix on this cycle.

---

## Triage table

| #          | Severity                | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                 | Status                                    |
| ---------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| BLOCKING 1 | PRIVACY                 | `ReferralService.buildVisibility` STAFF branch returned the union (assigned-to-me OR unassigned-SUBMITTED-triage-queue OR own-submitted) for **every** STAFF actor with `employeeId`, with no check that the actor is actually a counsellor. A teacher who held `cou-002:read` (which the IAM seed grants to Teacher) could list every unassigned referral in the school — including referral reasons (social/emotional, crisis, etc.). | **FIXED**                                 |
| BLOCKING 2 | ROW-SCOPE               | `SessionService.create` / `patch` / `addParticipant` / `markAttendance` only checked counsellor scope. Any counsellor-scope actor could mutate sessions or participants for another counsellor by knowing the UUID. `create` accepted `input.counselorId` directly without verifying `actor.employeeId === input.counselorId`.                                                                                                          | **FIXED**                                 |
| BLOCKING 3 | PRIVACY (Cycle 10)      | Reviewer flagged `GET /health/medications/:id/administrations` as still gated on `hlt-001:read` with a GUARDIAN service branch. **Already fixed in `970a6b3`** (REVIEW-CYCLE10) — the controller is gated on `hlt-002:read` and the service is gated by `hasNurseScope` (no GUARDIAN branch). Reviewer's reading was stale; we re-verified live and parent / teacher / student all 403.                                                 | **DEVIATION-VERIFIED**                    |
| MAJOR 4    | BUG (row scope)         | `MtssTierService.create` allowed any counsellor-scope actor to assign a tier to any student in the tenant, even though the read scope says non-admin counsellors see only caseload-linked students. `patch` had the same gap.                                                                                                                                                                                                           | **FIXED**                                 |
| MAJOR 5    | BUG (row scope)         | `InterventionService` (listForTier / getById / create / patch / logProgress / listProgress) gated on counsellor scope but did not verify that the parent tier's student is on the actor's caseload.                                                                                                                                                                                                                                     | **FIXED**                                 |
| MAJOR 6    | DOC (security decision) | `MandatoryReportService.create` allowed any STAFF actor to file a report for any student in the tenant. Intended policy ("every employee is a mandated reporter") was correct but only partially documented. Reviewer asked for an explicit product/security note.                                                                                                                                                                      | **FIXED** (Swagger expanded)              |
| MAJOR 7    | ARCHITECTURAL           | Generic Staff role grants every COU code + `student_counseling_record:read`. Should split into Counsellor / Nurse / VP / Teacher-referral-submitter / General-staff before pilot.                                                                                                                                                                                                                                                       | **DEFERRED** to Wave 2 Phase 2 punch list |

---

## BLOCKING 1 — Referral triage queue leak

`apps/api/src/counselling/referral.service.ts::buildVisibility` for STAFF returned the same OR predicate regardless of whether the actor was a counsellor. A teacher with `cou-002:read` (Teacher role grant) could list every unassigned referral in the school via `GET /counselling/referrals`.

### Fix

`buildVisibility` is now `async` and branches on `hasCounsellorScope(actor)`:

- **Counsellor (STAFF + cou-001:write):** assigned-to-me OR unassigned-SUBMITTED-triage-queue OR own-submitted.
- **Non-counsellor STAFF (e.g. teacher):** own-submitted only (`r.referred_by = me`). Teachers cannot enumerate the triage queue.

The two callers (`list`, `loadOrFail`) propagate the `await`. `loadOrFail` is called by `getById` and the state-machine transitions (`triage`, `accept`, `start`, `complete`, `decline`) so a teacher who guesses a UUID gets 404 instead of seeing the row.

### Live verification (`tenant_demo`, 2026-05-05)

```
================ R1 — BLOCKING 1: triage queue not visible to teachers ================
  smoke ref id: eda7239d-3d41-423c-b962-03cd5f4d007e (Park submitted, unassigned, SUBMITTED)
  teacher sees Park's unassigned referral:    False  (must be False)
  teacher own list (count + reporters):       1 ['James Rivera']
  counsellor sees Park's unassigned referral: True  (must be True)
  vp     sees Park's unassigned referral:     True  (must be True)
  admin sees Park's unassigned referral:      True  (must be True)
  teacher GET /referrals/<smoke> http:        404  (must be 404)
```

Teacher Rivera's own list still includes his own seeded referral (count=1). The unassigned-SUBMITTED triage queue is now invisible to teachers; counsellors (Hayes), counsellor-tier Staff (Park), and admins see it as before. Direct GET-by-id on the smoke referral returns 404 (don't-leak-existence).

---

## BLOCKING 2 — Session write paths row-scope

`apps/api/src/counselling/session.service.ts` had four endpoints (`create`, `patch`, `addParticipant`, `markAttendance`) that only checked `hasCounsellorScope`. The lock pattern in `patch` already used `SELECT … FOR UPDATE`, but didn't validate the locked row's `counselor_id` against `actor.employeeId`. Any counsellor-scope actor could mutate any other counsellor's session by knowing the UUID.

### Fix

- **`create`**: non-admin actors must supply `input.counselorId === actor.employeeId`. Admins may schedule on any counsellor's calendar.
- **`patch`**: lock query also returns `counselor_id`; non-admin caller is rejected with `Forbidden` if the row is not theirs. Check runs inside the same tx as the UPDATE so a race cannot bypass it.
- **`addParticipant`**: existence check on the parent session also returns `counselor_id`; non-admin caller is rejected.
- **`markAttendance`**: resolves the parent session's `counselor_id` via JOIN through `svc_session_participants`; non-admin caller is rejected.

### Live verification

```
================ R2 — BLOCKING 2: session row-scope to owning counsellor ================
  smoke session owned by Park: 5075bf4c-0af4-4860-83d4-9e32272d9e82
  Hayes PATCH Park's session http:                       403  (must be 403)
  Hayes POST participant on Park's session http:         403  (must be 403)
  Hayes POST /sessions counselorId=Park http:            403  (must be 403)
  Park (owner) PATCH own session http:                   200  (must be 200)
  admin PATCH Park's session http:                       200  (must be 200)
  Hayes PATCH attendance on Park's participant http:     403  (must be 403)
  Park (owner) PATCH attendance on own participant http: 200  (must be 200)
```

Owner (Park) and admin paths both stay 200; Hayes (a different counsellor with the same `cou-001:write` IAM grant) is correctly rejected on every cross-counsellor mutation path.

---

## BLOCKING 3 — Cycle 10 medication administration history

The reviewer reported that `GET /health/medications/:id/administrations` was still gated on `hlt-001:read` with a GUARDIAN service branch. **This was already fixed in commit `970a6b3` (REVIEW-CYCLE10 BLOCKING)** — the controller is gated on `hlt-002:read` (which guardians do NOT hold) and the service uses `hasNurseScope` with no GUARDIAN allow path. The reviewer was reading a cached / stale view of the file.

### Live re-verification

```
================ R3 — BLOCKING 3 (Cycle 10): medication history nurse-only ================
  med id: 019df382-3c2d-722d-b574-a45ba0af3b32
  parent  GET /administrations:    403  (must be 403)
  teacher GET /administrations:    403  (must be 403)
  student GET /administrations:    403  (must be 403)
  admin   GET /administrations:    200  (must be 200)
```

Already correct on `main` at the time of the Cycle 11 review; verified again post-Cycle-11 fixes.

---

## MAJOR 4 — MTSS tier creation requires caseload

`MtssTierService.create` and `patch` did not enforce that non-admin counsellors only manage MTSS state for students on their own active caseload. The list / get endpoints already filtered by caseload, but writes did not.

### Fix

New private helper `assertActorOwnsStudent(actor, studentId)`:

- Admin → bypass.
- Non-admin counsellor → require an `ACTIVE` row in `svc_caseloads` with `(counselor_id = actor.employeeId, student_id = $)`.

Called at the top of `create` (with `input.studentId`) and inside the `patch` tx after the FOR UPDATE lock returns the `student_id`.

### Live verification

```
================ R4 — MAJOR 4: MTSS tier create requires caseload ================
  Hayes POST tier for Ethan (no caseload) http:          403  (must be 403)
  admin POST tier for Ethan id:                          019df779-bb6b-7ff4-92c3-7f6f1127ab47
  Hayes PATCH Ethan's tier (no caseload) http:           403  (must be 403)
  Hayes PATCH Maya's tier (own caseload) http:           200  (must be 200)
```

Hayes has Maya on an active caseload but not Ethan. The new check rejects every write path that touches Ethan from Hayes; admin still passes; Hayes patching Maya's tier still works.

---

## MAJOR 5 — Intervention APIs caseload row-scope

Same class of bug, one level deeper. `InterventionService.{listForTier, getById, create, patch, logProgress, listProgress}` gated on counsellor scope but did not verify the parent tier's student is on the actor's caseload.

### Fix

Two new private helpers in `InterventionService`:

- `assertActorOwnsTier(actor, tierId)` — admin bypass, otherwise require an active caseload row keyed on `(counselor_id, t.student_id)` resolved via `svc_mtss_tiers` JOIN `svc_caseloads`.
- `assertActorOwnsIntervention(actor, interventionId)` — same, but resolves via `svc_interventions → svc_mtss_tiers → svc_caseloads`.

Called from every read + mutation method.

### Live verification

```
================ R5 — MAJOR 5: Intervention APIs caseload row-scope ================
  Hayes GET /tiers/<ethan>/interventions http:           403  (must be 403)
  Hayes POST progress on Ethan intervention http:        403  (must be 403)
  Hayes GET progress on Ethan intervention http:         403  (must be 403)
  Hayes PATCH Ethan intervention (no caseload) http:     403  (must be 403)
  admin PATCH Ethan intervention http:                   200  (must be 200)
  Hayes PATCH Maya intervention (own caseload) http:     200  (must be 200)
  admin GET /tiers/<ethan>/interventions http:           200  (must be 200)
```

Every Hayes-on-Ethan path 403s; admin and Hayes-on-Maya stay 200. `GET /interventions/:id` is intentionally not exposed on the controller (only `/tiers/:id/interventions`, `PATCH /interventions/:id`, and the progress sub-routes ship); the service-layer `getById` carries the same scope check for any future controller that needs it.

---

## MAJOR 6 — Mandatory reporter Swagger

`MandatoryReportService.create` correctly allows any STAFF actor with `cou-006:write` to file a report for any student in the school — **every employee is a mandated reporter under FERPA + state CPS statutes**, and the legal duty runs against any student a staff member knows about, not just students within their day-to-day teaching scope. The reviewer asked for this to be explicit.

### Fix

`MandatoryReportController.create` `@ApiOperation` summary rewritten to spell out the locked product/security decision:

> File a new mandatory report. Locked product/security decision per REVIEW-CYCLE11 MAJOR 6: every employee is a mandated reporter under FERPA + state CPS statutes, so any staff actor with `cou-006:write` can file a report for ANY student in the school — there is intentionally no caseload / class-roster row-scope on the studentId. The legal duty to report runs against any student a staff member knows of, not just students within their day-to-day teaching scope. Stamps `reporter_person_id` from `actor.personId`. status=FILED on creation. Core fields are immutable once filed (see PATCH).

No code change. Read scope on list / getById remains conservative (admin sees all, reporter sees own only).

---

## MAJOR 7 — Counsellor / Nurse / role split

Carried to **Wave 2 Phase 2 punch list** as item 9 / 11 / 13 already document. Demo Staff role is mechanically correct for every Cycle 9 / 10 / 11 surface (the intersection gate fires; the FERPA gate fires; the counsellor-scope check fires). Splitting the Staff role into Counsellor / Nurse / VP / General Staff is an architectural change that should land before pilot, not on this fix commit.

---

## Files changed

- `apps/api/src/counselling/referral.service.ts` — async `buildVisibility` + counsellor-vs-non-counsellor branch (BLOCKING 1).
- `apps/api/src/counselling/session.service.ts` — counsellor row-scope on `create`, `patch`, `addParticipant`, `markAttendance` (BLOCKING 2).
- `apps/api/src/counselling/mtss-tier.service.ts` — new `assertActorOwnsStudent` helper, called from `create` + `patch` (MAJOR 4).
- `apps/api/src/counselling/intervention.service.ts` — new `assertActorOwnsTier` + `assertActorOwnsIntervention` helpers, called from every read + mutation (MAJOR 5).
- `apps/api/src/counselling/mandatory-report.controller.ts` — Swagger summary rewritten (MAJOR 6).

No schema migrations. No test changes. No new Kafka emits. No web changes — the row-scope tightenings surface as 403 / 404 to the calling client, which the existing UI handles via the standard error-toast path.
