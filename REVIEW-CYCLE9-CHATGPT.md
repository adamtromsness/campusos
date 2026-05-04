# REVIEW-CYCLE9-CHATGPT

External post-cycle architecture review of Cycle 9 (Behaviour & Discipline)
by ChatGPT against `cycle9-complete`. Cycle 9 is the **first cycle of
Wave 2 (Student Services)** and ships the M30 module: discipline
catalogues + incidents + actions plus svc\_ behavior plans (BIP / BSP /
Safety Plan) with goals and teacher feedback.

## Verdict — TBD (awaiting Round 1 review)

The closeout commit ships:

- 7 base tables across two new namespaces
  (`sis_discipline_categories` / `_action_types` / `_incidents` /
  `_actions` and `svc_behavior_plans` / `_goals` /
  `svc_bip_teacher_feedback` — first `svc_*` tables in the system),
- 11 intra-tenant FKs / 0 cross-schema FKs (tenant logical base table
  count 132 → 139),
- 18 endpoints under two new modules (`apps/api/src/discipline/` and
  `apps/api/src/behavior-plans/`) gated on `BEH-001` /
  `BEH-002`,
- 4 Kafka emit topics
  (`beh.incident.reported`,
  `beh.incident.resolved`,
  `beh.action.parent_notification_required`,
  `beh.bip.feedback_requested`)
  - 1 new consumer (`BehaviourNotificationConsumer`) under group
    `behaviour-notification-consumer` subscribing to all four,
- 2 auto-task rules feeding the existing Cycle 7 TaskWorker (admin
  incident review + teacher BIP-feedback request),
- 7 web routes (3 staff incident pages + 1 admin catalogue +
  per-student admin tab + per-child parent tab + counsellor
  BIP editor with feedback queue),
- a launchpad `Behaviour` tile gated on `beh-001:read` with badge
  counter wired through `useAppBadges`,
- `seed-behaviour.ts` (idempotent) seeding 6 categories + 5 action
  types + 3 sample incidents + 1 ACTIVE BIP for Maya with 3 goals +
  1 pending feedback request + 2 auto-task rules,
- IAM updates: BEH-001 + BEH-002 grants to Teacher (40→41), Staff
  (20→24), and Parent (19→20→21 across Steps 4 + 9). Catalogue stays
  at 447 functions × 3 tiers (no new function entries).

The vertical-slice CAT at `docs/cycle9-cat-script.md` walks all 10
plan scenarios end-to-end on `tenant_demo` 2026-05-04 with full
cleanup, and was used to drive iterative bug fixes during build:

- Step 4 caught a missing `BEH-001:read` on Parent (added to seed +
  cache rebuild).
- Step 6 caught the Cycle 7 TaskWorker's `pickSourceRefId` helper
  not recognising `incidentId` — fixed by adding `sourceRefId: id`
  to both the `beh.incident.reported` and `beh.incident.resolved`
  emits.
- Step 8 caught a `PlanStatus` name collision with Cycle 6's payment
  plan status — Cycle 9 types renamed to `BehaviorPlanStatus` +
  `BehaviorPlanType` to disambiguate.

## Reviewer prompt (for the next round)

Below is the scaffold prompt the reviewer was given. Round 1 will
return REJECT-with-fixes or APPROVED; Round 2 (if needed) will run
against the closeout commit.

```
Please review CampusOS Cycle 9 (Behaviour & Discipline) at the
`cycle9-complete` tag.

Context: Cycle 9 is the first cycle of Wave 2. It ships M30 Behaviour
& Discipline. Two schemas land:
  - sis_discipline_* — incident lifecycle (categories, action types,
    incidents with 3-status + multi-column resolved_chk, actions with
    UNIQUE(incident_id, action_type_id) + dates_chk).
  - svc_behavior_plans / _goals / svc_bip_teacher_feedback — intervention
    plans with two partial UNIQUE keystones:
      (student_id, plan_type) WHERE status='ACTIVE'
      (plan_id, teacher_id) WHERE submitted_at IS NULL.

Permission model: BEH-001 (incidents) granted Teacher / Staff write,
Parent read. BEH-002 (plans) granted Staff write, Teacher read,
Parent read (read-only — Step 9 added the parent grant for the per-
child Behaviour tab). Counsellor scope = isSchoolAdmin OR holds
beh-002:write.

Visibility model:
  - Incidents: admin/counsellor → all; teacher → reported by me OR for
    students in my classes via sis_class_teachers + sis_enrollments;
    parent → own children via sis_student_guardians + sis_guardians;
    `admin_notes` stripped server-side for non-managers.
  - Plans: admin/counsellor → all; teacher → plans for students in
    my classes; parent → own children's plans;
    `feedback[]` stripped server-side for non-counsellor readers.

Concurrency:
  - IncidentService.review/resolve uses SELECT FOR UPDATE inside
    executeInTenantTransaction with status pre-check.
  - GoalService.update locks the goal row + verifies parent plan is
    not EXPIRED in same tx; auto-bumps last_assessed_at = CURRENT_DATE
    on progress transitions away from NOT_STARTED.
  - BehaviorPlanService.activate pre-flights the partial UNIQUE on
    (student_id, plan_type) WHERE status='ACTIVE' inside the tx +
    catches 23505 from a concurrent winner with a friendly 400.
  - FeedbackService.requestFeedback pre-flights the partial UNIQUE on
    (plan_id, teacher_id) WHERE submitted_at IS NULL inside the tx +
    catches 23505 with a 400 carrying the existing pending id.

Notification fan-out:
  - beh.incident.reported → school admins via iam_effective_access_cache
    (matches AbsenceRequestNotificationConsumer / TicketNotificationConsumer
    pattern).
  - beh.incident.resolved → original reporter via the
    hr_employees → person_id → platform_users.id bridge, with
    self-suppression when resolvedByAccountId === reporterAccountId
    (mirrors Cycle 8 follow-up 2).
  - beh.action.parent_notification_required → portal-enabled
    guardians resolved at emit time via sis_student_guardians AND
    portal_access=true; consumer iterates payload.guardianAccountIds
    without re-querying.
  - beh.bip.feedback_requested → teacher via pre-resolved
    payload.recipientAccountId.

Auto-task integration: 2 seeded rules feed Cycle 7 TaskWorker:
  - beh.incident.reported → SCHOOL_ADMIN, ADMINISTRATIVE/HIGH/24h.
  - beh.bip.feedback_requested → null target_role with the worker
    falling back to payload.recipientAccountId/accountId
    (matches Cycle 8 tkt.ticket.assigned pattern).

Worker boot picks up the new triggers via the existing
auto-discovery query against tsk_auto_task_rules.

Schema changes: 7 new tenant base tables; 11 intra-tenant FKs;
0 cross-schema FKs. Tenant logical base table count 132 → 139.

Please assess against the same rubric used for Cycle 8:
  - tenant isolation
  - module registration
  - ADR-057 envelope shape
  - schema lifecycle invariants (CHECKs / partial UNIQUEs / FKs)
  - row-scope correctness across all four personas
  - service-layer field stripping (admin_notes, feedback[])
  - locked-row state-machine transitions
  - notification routing + self-suppression
  - auto-task wiring + source_ref_id propagation
  - permission model for the M30 surface

Return REJECT pending fixes or APPROVE.
```

## Round 1 — TBD

(awaiting reviewer)

## Round 2 — TBD

(awaiting reviewer; only relevant if Round 1 returns REJECT)

## Phase 2 punch list (carry-over candidates)

- **Custom-rule TaskWorker fallback validation** (still on the Wave 2
  Phase 2 list from Cycle 7). Cycle 9's
  `beh.bip.feedback_requested` rule with `target_role=NULL` exercises
  the worker's `payload.recipientAccountId / accountId` fallback in
  production for the first time outside the seeded smoke. Worth
  watching when school-authored rules ship.
- **Behaviour plan signing / parent acknowledgement.** Schema has
  no signing column; ADR-006 (digital signatures) wasn't applied
  in Cycle 9. Future polish.
- **Teacher-cross-incident summary view.** Step 7 ships the staff
  queue but doesn't aggregate "students in my classes who currently
  have an incident OPEN." Polish item — the UI can derive it
  client-side by filtering `useIncidents()` to the teacher's
  scope.
