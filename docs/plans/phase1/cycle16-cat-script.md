# Cycle 16 — Customer Acceptance Test (CAT)

End-to-end vertical-slice walkthrough verified live against `tenant_demo`. Reproducible — every block can be re-executed from a clean post-Cycle-15 database with a fresh `seed:onboarding` run. All 7 scenarios pass; one ADR-057 wire envelope captured live (`enr.student.onboarded` with `autoEscalate`-style cross-module signal — fires only when the school finishes onboarding the student, distinct from Cycle 6's offer-accept `enr.student.enrolled`).

Prereqs:

- API running at `http://localhost:4000` (built from `apps/api/dist/main.js`)
- Postgres + Kafka up via `docker compose up -d`
- `tenant_demo` provisioned through Cycle 15 + `seed:onboarding` run (3 of Maya's 8 onboarding tasks pre-seeded as `COMPLETED`)
- Test users from the seed (admin@/principal@/teacher@/parent@/student@)

---

## S0 — Schema preamble (live captured)

```
tenant base tables = 223
cycle 16 new tables = 6
Application status CHECK includes Cycle 16 values:
CHECK ((status = ANY (ARRAY['DRAFT'::text, 'SUBMITTED'::text, 'UNDER_REVIEW'::text, 'INTERVIEW'::text, 'ASSESSMENT'::text, 'OFFERED'::text, 'ACCEPTED'::text, 'REJECTED'::text, 'WAITLISTED'::text, 'WITHDRAWN'::text, 'ENROLLED'::text])))
IAM Staff stu-003 grants = 2
```

The 6 new logical base tables are `enr_application_stages`, `enr_application_scores`, `enr_onboarding_checklists`, `enr_onboarding_tasks`, `enr_student_onboarding_progress`, `enr_student_onboarding_task_completions`. The application status CHECK extends the Cycle 6 8-value set with INTERVIEW + ASSESSMENT + OFFERED for the Cycle 16 multi-stage review pipeline. The IAM Staff role gets `stu-003:read` + `stu-003:write` so Enrolment Officers (covered by Staff in the demo) clear the gate on every read + advance/scoring/onboarding write.

## S1 — Stage history reads (live captured)

```
Maya seeded stage history:
   None → SUBMITTED by Sarah Mitchell
```

The Step 4 seed plants one initial `SUBMITTED` stage row for Maya's ENROLLED application so the audit trail isn't empty for the demo. `fromStatus=None` because the row is the originating SUBMITTED transition. `changedByName` resolves through `platform.platform_users → iam_person`.

## S2 — Multi-stage advance (live captured)

```
Aiden SUBMITTED → INTERVIEW:
  fromStatus= SUBMITTED toStatus= INTERVIEW
Aiden INTERVIEW → ASSESSMENT:
  fromStatus= INTERVIEW toStatus= ASSESSMENT
Aiden DB status=ASSESSMENT
```

Each `POST /applications/:id/stages/advance` locks the application row with `SELECT … FOR UPDATE` inside `executeInTenantTransaction`, validates the transition against `ALLOWED_TRANSITIONS`, then UPDATEs `enr_applications.status` + INSERTs the audit row in the same tx. `enr_applications.status='ASSESSMENT'` post-transition confirms the schema CHECK from migration `056` accepts the new Cycle 16 values.

## S3 — Illegal transition rejected (live captured)

```
ASSESSMENT → UNDER_REVIEW (illegal):
  message= Transition ASSESSMENT → UNDER_REVIEW is not allowed. Valid next statuses: OFFERED, WAITLISTED, REJECTED, WITHDRAWN
```

The `ALLOWED_TRANSITIONS` map is the single source of truth. ASSESSMENT can move forward to OFFERED, sideways to WAITLISTED/REJECTED/WITHDRAWN, but never back to UNDER_REVIEW. The 400 carries the legal next set inline so the EO doesn't have to consult docs.

## S4 — Score lifecycle (live captured)

```
POST CAT Math Assessment 88/100:
  id= 019dfaff-120c-7997-ba37-1f14e6b8bb40 score= 88 / 100
POST duplicate (expect 400):
  message= A score for criterion "CAT Math Assessment" already exists. Use PATCH to update.
PATCH score=92:
  new score= 92
DELETE:
  HTTP 204
```

UNIQUE(application_id, criterion_name) enforces one row per `(application, criterion)` pair. The service catches the duplicate (SQLSTATE 23505 / Prisma message regex) and surfaces the friendly 400 with PATCH-redirect message. `score >= 0` and `max_score >= score` CHECKs both fire on bogus values.

## S5 — Onboarding reads (live captured)

```
Checklists:
  - Standard New Student Checklist ( STANDARD_INTAKE )
Maya onboarding (3 of 8 from seed):
  status= IN_PROGRESS 3 / 8
  - COMPLETED  Uniform ordered
  - COMPLETED  Bus route assigned
  - PENDING    Medical form returned
  - PENDING    Locker allocated
  - PENDING    IT account created
  - COMPLETED  Library card issued
  - PENDING    Emergency contacts confirmed
  - PENDING    Enrolment deposit paid
```

Step 4's seed plants 1 STANDARD_INTAKE checklist with 8 tasks across 7 categories (ADMINISTRATIVE × 2 + TRANSPORT + HEALTH + FACILITIES + IT + COMMUNICATIONS + FINANCE), then a per-Maya progress row with 3 of 8 tasks pre-marked COMPLETED. The seed exercises both the `taskCompletions` row generation and the `tasks_completed` denormalised counter so the Step 8 progress UI has live demo data.

## S6 — Onboarding keystone (live captured)

```
  Completed: Medical form returned                progress= 4 / 8 status= IN_PROGRESS onboarded= False
  Completed: Locker allocated                     progress= 5 / 8 status= IN_PROGRESS onboarded= False
  Completed: IT account created                   progress= 6 / 8 status= IN_PROGRESS onboarded= False
  Completed: Emergency contacts confirmed         progress= 7 / 8 status= IN_PROGRESS onboarded= False
  Completed: Enrolment deposit paid               progress= 8 / 8 status= COMPLETE onboarded= True
```

The keystone behaviour: each `POST /onboarding-task-completions/:id/complete` locks the task-completion row with `SELECT … FOR UPDATE`, stamps `status='COMPLETED' / completed_at=now() / completed_by=actor.accountId`, recomputes `tasks_completed` from the live row count (so manual SQL or out-of-order updates can never cause drift between the counter and the underlying truth), and re-evaluates whether every mandatory task is in `('COMPLETED','WAIVED')`. On the 5th call the predicate evaluates true, the service flips `overall_status='COMPLETE' / completed_at=now()` atomically inside the same tx, and emits `enr.student.onboarded` after commit.

```
----- enr.student.onboarded envelope (live ADR-057) -----
{
    "event_id": "019dfaf1-e5c4-7225-bdf5-08b0699c03eb",
    "event_type": "enr.student.onboarded",
    "event_version": 1,
    "occurred_at": "2026-05-06T01:40:50.244Z",
    "published_at": "2026-05-06T01:40:50.244Z",
    "tenant_id": "019dc92b-ea59-7bb7-aa7f-929729562010",
    "source_module": "enrollment",
    "correlation_id": "019dfaf1-e5c4-7225-bdf5-1771f51c1ca1",
    "payload": {
        "progressId": "019dfadf-0714-7662-95db-9140884ec684",
        "applicationId": "019dd6e3-1e60-7228-b320-e4f73278ef79",
        "checklistId": "019dfadf-0704-7662-95db-4deadbed3c2a",
        "schoolId": "019dc92b-ea59-7bb7-aa7f-929729562010",
        "completedAt": "2026-05-06T01:40:50.242Z",
        "completedBy": "019dc92d-087d-7442-abf5-d16bc2fe960d",
        "tasksTotal": 8,
        "tasksCompleted": 8,
        "sourceRefId": "019dfadf-0714-7662-95db-9140884ec684"
    }
}
```

Wire envelope captured live on `dev.enr.student.onboarded` with full ADR-057 shape: `event_id` + `correlation_id` UUIDv7s, `event_type='enr.student.onboarded'`, `source_module='enrollment'`, `tenant_id` populated, payload includes `progressId / applicationId / checklistId / schoolId / completedAt / completedBy / tasksTotal / tasksCompleted / sourceRefId`. The `enr.student.enrolled` topic (Cycle 6) is **not** retired — it still fires on offer-accept and `PaymentAccountWorker` continues to consume it for billing-account allocation. `enr.student.onboarded` is the new cross-module signal for downstream consumers that should react only after the school has actually completed the new-student onboarding checklist.

## S7 — Permission denials (live captured)

```
  TEACHER POST /stages/advance → 403
  TEACHER POST /onboarding-checklists → 403 (admin-only)
  STUDENT POST /stages/advance → 403
  STUDENT POST /onboarding-checklists → 403 (admin-only)
  PARENT POST /stages/advance → 403
  PARENT POST /onboarding-checklists → 403 (admin-only)
```

Stage advance + scoring + complete-task gate at `stu-003:write` (held by Staff covering EO + Admin); checklist template CRUD gates at `stu-003:admin` (admin-only). Teachers, students, and parents are denied at the controller layer.

## Cleanup (live captured)

```
UPDATE 1   -- Aiden status restored to SUBMITTED
DELETE 2   -- smoke stage rows on Aiden dropped
UPDATE 5   -- Maya's 5 PENDING task completions restored
UPDATE 1   -- Maya's progress restored to 3/8 IN_PROGRESS
DELETE 0   -- no leftover CAT scores (already cleaned in S4)
```

Final tenant state matches the post-`seed:onboarding` shape exactly: 1 checklist + 8 tasks + Maya's progress at 3/8 IN_PROGRESS + 1 SUBMITTED stage row + 0 scores. Re-runnable.

---

## Reviewer attention items (non-blocking, Phase 2 polish)

1. **`enr.student.onboarded` has no consumer yet** — emits land cleanly but no downstream handler reacts (no IT account provisioning, no welcome-packet email, no analytics). Phase 2 wires consumers as the relevant modules ship.
2. **STANDARD_INTAKE-only auto-generation** — `OfferService.respond` ACCEPTED branch only auto-generates a progress row if a STANDARD_INTAKE checklist exists for the school. MID_YEAR_ADMISSION / TRANSFER_IN / RETURNING_STUDENT / INTERNATIONAL admission-type matching against the application's actual `admission_type` is a polish carry-over.
3. **Onboarding consumers + worker scope** — the Step 7 keystone is the manual `POST /complete` flow per task. Bulk import / spreadsheet upload of completions is a polish item (admin-only, low traffic).
4. **Parent-facing onboarding visibility** — `GET /applications/:id/onboarding` is gated on `stu-003:read` which parents do hold for own-child applications; the parent UI surface (e.g. "Your child's first day checklist") is a Step 9 follow-on, not in this cycle.
5. **Counsellor / EO role split** — Staff role currently grants `stu-003:read+write` covering EO duties. Real schools may want a dedicated EO role that excludes counselling functions. Joins the cross-cycle role-split punch list.

**Cycle 16 ships clean to the post-cycle architecture review.**
