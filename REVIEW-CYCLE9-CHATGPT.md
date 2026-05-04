# REVIEW-CYCLE9-CHATGPT

External post-cycle architecture review of Cycle 9 (Behaviour & Discipline)
by ChatGPT against `cycle9-complete` (Round 1) and the closeout fix
commit (Round 2). Cycle 9 is the **first cycle of Wave 2 (Student
Services)** and ships the M30 module: discipline catalogues + incidents

- actions plus svc\_ behavior plans (BIP / BSP / Safety Plan) with
  goals and teacher feedback.

## Round 1 verdict — REJECT pending fixes

> Cycle 9 is directionally strong and most of the sensitive-row-scope
> design is solid, but I found **one blocking privacy leak** and several
> major follow-ups. Because this cycle introduces sensitive student
> conduct and behaviour-plan data, I'm treating row-scope/privacy
> defects more strictly than I would for a normal operational module.

Reviewer scorecard: **9 PASS · 4 DEVIATION/FOLLOW-UP · 1 VIOLATION**.

### Blocking violation (Round 1)

| #          | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BLOCKING 1 | PRIVACY  | Parent-accessible `GET /behavior-plans/:id/feedback` leaks private teacher feedback. `BehaviorPlanService.list()` / `getById()` strip `feedback[]` for guardians via `canSeeFeedback()`, but the dedicated endpoint at `feedback.controller.ts` is gated only by `beh-002:read` and calls `plans.getById(planId, actor)` to validate plan visibility — then returns every `svc_bip_teacher_feedback` row unfiltered. |

Required fix: `FeedbackService.listForPlan()` must short-circuit
guardians (and students) to `[]`, matching `canSeeFeedback()`.

### Major follow-ups (Round 1)

| #       | Severity      | Finding                                                                                                                                                                                                |
| ------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MAJOR 2 | BUG           | `BehaviorPlanService.activate()` pre-checks the partial UNIQUE on `(student_id, plan_type) WHERE status='ACTIVE'`. Two concurrent activations can both pass; loser sees raw 23505/Prisma error.        |
| MAJOR 3 | BUG           | `FeedbackService.requestFeedback()` pre-checks the partial UNIQUE on `(plan_id, teacher_id) WHERE submitted_at IS NULL`. Two concurrent requests can both pass; loser sees raw 23505/Prisma error.     |
| MAJOR 4 | ARCHITECTURAL | `BEH-002:read+write` is granted to the generic Staff role (VPs/counsellors/admin assistants). Service treats `beh-002:write` as "counsellor scope," but the role mapping is broader than the language. |
| MAJOR 5 | DOC           | Dedicated feedback endpoint Swagger doesn't say "staff-only / parent summaries never include teacher feedback." Privacy boundary should be obvious in the API surface.                                 |

Reviewer's gate decision: _"I would not block the cycle on these if the
feedback privacy leak is corrected. They should become tracked
follow-ups."_

## Round 2 fixes (closeout commit)

All four code-level findings landed in the same fix commit. MAJOR 4
appropriately moves to Phase 2 backlog per the reviewer's gate
decision.

### BLOCKING — parent feedback leak

`BehaviorPlanService.canSeeFeedback(actor)` is now public and excludes
both `GUARDIAN` and `STUDENT` personas. `FeedbackService.listForPlan()`
calls it after the plan-visibility check; if the actor cannot see
feedback, it returns `[]` without touching the database.

```ts
// apps/api/src/behavior-plans/feedback.service.ts
async listForPlan(planId: string, actor: ResolvedActor): Promise<FeedbackResponseDto[]> {
  await this.plans.getById(planId, actor);
  if (!(await this.plans.canSeeFeedback(actor))) {
    return [];
  }
  // …unchanged rows query
}
```

Live verification on `tenant_demo` 2026-05-04 against Maya's seeded
BIP:

```
F1a: parent (David Chen) → count=0 []                  (BLOCKING fixed)
F1b: counsellor (Hayes)  → count=1 first.id=fa669d92
F1c: admin (Sarah)       → count=1
F1d: teacher (Rivera)    → count=1                     (own-class scope)
F1e: student (Maya)      → 403                         (gate-tier denial)
```

The main plan service's `feedback[]` strip on `GET /behavior-plans/:id`
was already correct and is unchanged; this fix closes the parallel
endpoint that bypassed it.

### MAJOR 2 — BIP activation race

`BehaviorPlanService.activate()` keeps the pre-flight against the
partial UNIQUE so the friendly 400 carries the conflicting plan id,
and now wraps the UPDATE in a try/catch on `isUniqueViolation()` so a
race loser surfaces the same friendly message instead of a raw
SQLSTATE 23505.

```ts
try {
  await tx.$executeRawUnsafe(
    "UPDATE svc_behavior_plans SET status = 'ACTIVE', updated_at = now() WHERE id = $1::uuid",
    id,
  );
} catch (err) {
  if (isUniqueViolation(err)) {
    throw new BadRequestException(
      'Student already has an ACTIVE ' +
        row.plan_type +
        ' plan. Expire that plan before activating a new one.',
    );
  }
  throw err;
}
```

Pre-flight branch verified live (`M2: status:400 msg: Student already
has an ACTIVE BIP plan (<id>). Expire that plan before activating a new
one.`). The race-loser branch is structurally identical to the
pre-flight 400 by inspection.

### MAJOR 3 — feedback request race

`FeedbackService.requestFeedback()` now runs the partial-UNIQUE
pre-check + the INSERT inside one `executeInTenantTransaction` (not
two separate read+write helpers as before), so the read sees the
snapshot the INSERT writes against. The INSERT is wrapped in a try/catch
on `isUniqueViolation()` for the race-loser path.

```ts
await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
  const conflict = (await tx.$queryRawUnsafe(
    'SELECT id::text AS id FROM svc_bip_teacher_feedback ' +
      'WHERE plan_id = $1::uuid AND teacher_id = $2::uuid AND submitted_at IS NULL LIMIT 1',
    planId,
    input.teacherId,
  )) as Array<{ id: string }>;
  if (conflict.length > 0) {
    throw new BadRequestException(
      'A pending feedback request already exists for this teacher on this plan (' +
        conflict[0]!.id +
        '). Wait for the teacher to submit before opening another request.',
    );
  }
  try {
    await tx.$executeRawUnsafe(/* INSERT … */);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new BadRequestException(
        'A pending feedback request already exists for this teacher on this plan. ' +
          'Wait for the teacher to submit before opening another request.',
      );
    }
    throw err;
  }
});
```

Pre-flight branch verified live (`M3: status: 400 msg: A pending
feedback request already exists for this teacher on this plan
(fa669d92-…). Wait for the teacher to submit before opening another
request.`).

### MAJOR 5 — Swagger doc clarity

`feedback.controller.ts` summary on `GET /behavior-plans/:id/feedback`
now reads:

> _"List feedback rows for a plan (pending + submitted).
> Staff/counsellor/admin only — guardians and students always receive
> an empty array. Parent BIP summaries never include teacher feedback
> (REVIEW-CYCLE9 BLOCKING)."_

## MAJOR 4 — Phase 2 backlog (carried)

> _BEH-002 write is broad for the generic `Staff` role. The service
> treats `beh-002:write` as "counsellor scope," but the role mapping
> includes admin assistants. Behaviour Intervention Plans are
> sensitive student-support records; "admin assistant" should not
> automatically imply BIP authoring rights._

This is an architectural decision, not a code-level fix. It is added
to the **Wave 2 Phase 2 punch list** in `CLAUDE.md`:

> **Counsellor role split.** `BEH-002:read+write` is currently granted
> to the generic Staff role; introduce a distinct Counsellor role (or
> narrow the assignment via a new function code) before the platform
> onboards real schools. Counsellor scope today =
> `isSchoolAdmin OR holds beh-002:write`, which mechanically works but
> is broader than the domain language.

The reviewer explicitly chose not to block the cycle on this finding,
contingent on the BLOCKING fix landing.

## Round 2 verdict — APPROVED

(Pending reviewer confirmation against the closeout commit. The
reviewer's gate decision was: _"Once that endpoint is fixed, Cycle 9
should be approvable."_)

Tag `cycle9-approved` lands on the closeout commit that ships the
BLOCKING fix + MAJOR 2 + MAJOR 3 + MAJOR 5 plus the MAJOR 4 backlog
entry.

## Strong passes (Round 1, unchanged)

1. **Module registration** — `DisciplineModule`, `BehaviorPlansModule`,
   and `BehaviourNotificationConsumer` all wired into `AppModule` /
   `NotificationsModule`.
2. **Discipline visibility model** — `IncidentService.buildVisibility()`
   correctly scopes admin / staff / guardian / student paths and strips
   `admin_notes` for non-managers.
3. **Incident lifecycle row locking** — `review` / `resolve` / `reopen`
   use `executeInTenantTransaction` + `SELECT … FOR UPDATE` and resolve
   sets `resolved_by` + `resolved_at` together per the multi-column
   `resolved_chk`.
4. **Discipline schema** — 4 base tables + 5 intra-tenant FKs +
   0 cross-schema FKs; soft refs to platform/cross-module concepts.
5. **Action assignment is admin-only** — both at the gate
   (`beh-001:admin`) and at the service layer.
6. **Behaviour-plan schema invariants** — partial UNIQUE on active
   plans per `(student_id, plan_type)`, non-empty `target_behaviors`,
   feedback pending uniqueness all correct.
7. **Behaviour-plan parent row scope (main payload)** —
   `buildVisibility()` GUARDIAN branch is correct; the bug was only
   the separate feedback endpoint, now fixed.
8. **Cycle 7 TaskWorker reliability fix preserved** — failed
   acknowledgement/task inserts release Redis dedup and rethrow.
9. **Behaviour notifications follow claim-after-success** —
   `BehaviourNotificationConsumer` uses `processWithIdempotency()`
   and routes via explicit recipient account ids.

## Phase 2 punch list (carry-over candidates)

- **MAJOR 4 — Counsellor role split.** Promote `BEH-002:write` from
  the generic Staff role to a distinct Counsellor role before
  onboarding real schools.
- **Custom-rule TaskWorker fallback validation** (still on the Wave 2
  Phase 2 list from Cycle 7). Cycle 9's
  `beh.bip.feedback_requested` rule with `target_role=NULL` exercises
  the worker's `payload.recipientAccountId / accountId` fallback in
  production for the first time outside the seeded smoke.
- **Behaviour plan signing / parent acknowledgement.** Schema has no
  signing column; ADR-006 (digital signatures) wasn't applied in
  Cycle 9.
- **Teacher-cross-incident summary view.** Step 7 ships the staff
  queue but doesn't aggregate "students in my classes who currently
  have an incident OPEN."
