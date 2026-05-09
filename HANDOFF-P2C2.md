# HANDOFF-P2C2 — Phase 2 Cycle 2: Incident & Emergency (M91)

**Status:** REVIEW-P2C2 ROUND 1 fixes applied — re-submitting for review.
**Plan:** `docs/campusos-p2c2-incident-emergency.html`.
**CAT script:** `docs/p2c2-cat-script.md`.
**Tag (after review approval):** `p2c2-complete` then `p2c2-approved`.

## REVIEW-P2C2 ROUND 1 — fix log

Round 1 against commit `f223880` returned **FAIL** with 3 BLOCKING + 4 MAJOR.
This commit lands all 3 BLOCKING + the actionable MAJOR (declare-emit ordering),
plus new unit-test coverage for the failure modes.

### BLOCKING #1 — Lost-alert failure mode in `runStepAlert()` (FIXED)

**Before**: stamped `alert_sent_at = now()` inside the tx, then emitted Kafka
outside the tx; emit failure was caught and logged. A broker outage left the
outbox saying "alert sent" while the wire never carried the event. The next
poll would skip the row (alert_sent_at IS NOT NULL no longer matches the
pending predicate) and the alert was permanently lost.

**Fix**: emit-first-stamp-after for ALL THREE outbox steps. Worker now:

1. Lock the row + check the step column is still NULL.
2. Emit Kafka with a deterministic event_id (sha1(outboxId + ':step') as a
   v5-shaped UUID, mirroring Cycle 4's `deterministicCoverageEventId`).
3. On emit success, stamp the column + clear `last_error` in a fresh tx.
4. On emit failure, increment `attempt_count` + record `last_error`, leave
   the column NULL so the next poll picks the row up.

A worker crash between emit success and stamp re-emits with the same
deterministic event_id; consumers dedupe via the standard
`processWithIdempotency` claim-after-success contract.

**File**: `apps/api/src/incidents/declaration-outbox.worker.ts` — `runStepAlert`,
`runStepTasks`, `runStepMuster` all rewritten. New helpers
`checkStillPending`, `stampStepSuccess`, `recordStepError`, and the exported
`deterministicStepEventId` used by both production code and the new tests.

### BLOCKING #2 — Direct INSERT into `tsk_tasks` violated ADR-011 (FIXED)

**Before**: `runStepTasks` directly INSERTed URGENT response tasks into
`tsk_tasks` for the procedure's primary + secondary contacts. ADR-011 says
the Cycle 7 TaskWorker is the sole writer to `tsk_tasks`.

**Fix**: M91 now emits one `inc.emergency.task.requested` event per contact.
Each event has a deterministic event_id keyed on `(outboxId, 'tasks-N')` so
retries dedupe. The Cycle 7 TaskWorker consumes via a new `tsk_auto_task_rules`
row (seeded by `seed-incident.ts`) with `target_role=NULL` and
`payload.recipientAccountId` as the owner-resolution fallback, then creates
the task itself per its existing rule-engine contract.

**Schema-side dedup**: The TaskWorker honors the existing `tsk_tasks`
partial INDEX on `(owner_id, source, source_ref_id) WHERE source<>'MANUAL'`
plus its Redis SET NX dedup keyed on `tsk:auto:{tenant}:{owner}:{sourceRefId}`
— our deterministic event_id is the upstream gate; these are belt-and-braces.

**Files**:

- `declaration-outbox.worker.ts::runStepTasks` — emit instead of INSERT.
- `packages/database/src/seed-incident.ts` — adds the `tsk_auto_task_rules`
  row for `inc.emergency.task.requested` with template `{title}` /
  `{description}` and `priority='URGENT'`.

### BLOCKING #3 — Direct INSERT into `vis_emergency_muster` violated cross-module ownership (FIXED)

**Before**: `runStepMuster` directly INSERTed into `vis_emergency_muster`,
which is owned by P2C1 Visitor Management. The v11 contract is "no module
writes another module's tables — events cross the boundary."

**Fix**: M91 now emits `inc.emergency.muster.requested` (deterministic event
id keyed on `(outboxId, 'muster')`). The Visitor module's new
**`VisitorMusterConsumer`** (in `apps/api/src/visitors/visitor-muster.consumer.ts`)
subscribes under group `visitor-muster-consumer` and creates the
`vis_emergency_muster` row in its own namespace.

**Cross-cycle reads stay**: the M91-internal accountability seed still
reads `vis_sign_ins` (a defensible cross-cycle read per the reviewer) and
INSERTs into `inc_accountability_records` + `inc_accountability_summary`
(both M91-owned tables). Those are not cross-module writes.

**Files**:

- `declaration-outbox.worker.ts::runStepMuster` — emit instead of INSERT.
- `apps/api/src/visitors/visitor-muster.consumer.ts` — new consumer.
- `apps/api/src/visitors/visitors.module.ts` — registers the consumer.

### MAJOR #2 — `IncidentService.declare()` emit was inside the tx (FIXED)

**Before**: `void this.kafka.emit(...)` was inside the
`executeInTenantTransaction` callback. Comments said "emit AFTER tx commits"
but the call returned to the executor before the tx had finalised.

**Fix**: declare path now returns from `executeInTenantTransaction` first
(returning `{dto, incidentId, declaredAt, head}` from the callback), then
runs `await this.kafka.emit(...)` in a clean async block with try/catch.
Best-effort emit failure is now logged; the durable orchestration is the
outbox.

**File**: `incident.service.ts::declare`.

### MAJOR #1 — Integration tests for outbox failure modes (FIXED)

Added 11 new unit tests in `apps/api/src/incidents/incidents.spec.ts`:

- `runStepAlert`: emit failure leaves `alert_sent_at` NULL + `last_error`
  populated.
- `runStepAlert`: emit success stamps `alert_sent_at` + clears `last_error`.
- `runStepAlert`: re-running after stamped is a no-op (still-pending check
  short-circuits).
- `runStepTasks`: emits one event per contact + NEVER INSERTs into `tsk_tasks`
  (asserted by capturing all SQL calls and grepping for `INSERT INTO tsk_tasks`).
- `runStepTasks`: emit failure for any contact leaves `tasks_created_at` NULL
  and `last_error` populated.
- `runStepTasks`: stamps successfully when no procedure contacts exist
  (no-op success path).
- `runStepMuster`: emits muster-request event + NEVER INSERTs into
  `vis_emergency_muster` (asserted via SQL capture).
- `runStepMuster`: emit failure leaves `muster_taken_at` NULL.
- `deterministicStepEventId`: same (outboxId, step) → same v5-shaped UUID;
  different inputs → different IDs.

**Total spec count: 25 tests** (14 from the original ship + 11 from the
review-fix coverage). Full vitest sweep: **100/100 tests across 11 files**.

### MAJOR / MINOR items deferred per reviewer's gate decision

- **MAJOR 3 (timeline DB-level immutability trigger)**: reviewer
  acknowledged this mirrors prior cycles and is non-blocking. Phase 3 work.
- **MAJOR 4 (roster muster from sis_enrollments + hr_employees)**:
  reviewer accepted as an intentional scope cut. Phase 3 work — adds a
  second event consumer or a roster-fan-out worker.
- **MINOR 1 (post-insert reload by id only)**: kept for next cycle to
  match the reviewer-preferred school_id-explicit pattern.
- **MINOR 2 (per-step error columns)**: would split `last_error` into
  `tasks_last_error` / `muster_last_error` / `alert_last_error`. The
  current single-column model captures the most recent failure across
  all steps; rich per-step diagnostics are deferred.
- **MINOR 3 (incident-types JOIN school compatibility)**: defence-in-depth
  predicate; the app-layer validates already.

---

The cycle ships the M91 Incident & Emergency module — all 11 ERD
tables in scope. Atomic emergency declarations with multi-step
fan-out via the inc_declaration_outbox keystone, an immutable
incident timeline that serves as the legal record, real-time
accountability summary materialisation, identity-verified
parent reunification cross-cycled with P2C1 vis_visitors, drill
scheduling with 90-day overdue detection, and a non-discipline
incident reporting surface for day-to-day safety documentation.

## Per-step status

| Step | Deliverable                                                                                | Status                                                                 |
| ---- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 1    | Migration `105_inc_incidents.sql` — types + incidents + procedures + outbox                | ✅ verified live (7 negative-path checks all green)                    |
| 2    | Migration `106_inc_accountability.sql` — timeline + accountability + reunification         | ✅ verified live (13 negative-path checks all green)                   |
| 3    | Migration `107_inc_drills.sql` — drills + non-discipline incidents                         | ✅ verified live (10 negative-path checks all green)                   |
| 4    | `seed-incident.ts` + IAM SAF-001/003/004 grants                                            | ✅ idempotent seed; 7-persona grant distribution verified              |
| 5    | IncidentService + IncidentTypeService + ProcedureService + DeclarationOutboxWorker         | ✅ build + 4 spec tests green                                          |
| 6    | TimelineService (immutable) + AccountabilityService + recomputeSummaryInTx                 | ✅ build + 4 spec tests green                                          |
| 7    | ReunificationService + DrillService + NonDisciplineIncidentService                         | ✅ build + 6 spec tests green; cross-cycle vis_sign_ins guard verified |
| 8    | Web UI part 1 — dashboard + procedures + active-incident panel + timeline + accountability | ✅ web build clean                                                     |
| 9    | Web UI part 2 — reunification, drills, report form, reports log, after-action              | ✅ web build clean (7 emergency routes shipped)                        |
| 10   | Vertical-slice CAT at `docs/p2c2-cat-script.md`                                            | ✅ 10 scenarios + cleanup                                              |
| 11   | CI parity — format / lint / typecheck / vitest / build                                     | ✅ all green (89/89 tests, 544 lint-clean files)                       |
| 12   | HANDOFF + CLAUDE.md + REVIEW-NOTES                                                         | ✅ this commit                                                         |
| 13   | Commit + push                                                                              | ⏭ next                                                                |

## Tables (11 new)

| Table                           | Migration | Notes                                                                                                                                                                                                    |
| ------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inc_incident_types`            | 105       | 4-value severity + COALESCE-sentinel UNIQUE on (school_id, code) for platform defaults + per-school overrides                                                                                            |
| `inc_incidents`                 | 105       | 3-value status with multi-column resolved_chk lockstep                                                                                                                                                   |
| `inc_emergency_procedures`      | 105       | 9-value procedure_type + procedure_steps JSONB array + assembly_points JSONB                                                                                                                             |
| `inc_declaration_outbox`        | 105       | **ATOMIC ORCHESTRATION KEYSTONE** — created in same tx as inc_incidents (UNIQUE on incident_id); each nullable TIMESTAMPTZ column is one fan-out step (tasks_created_at, muster_taken_at, alert_sent_at) |
| `inc_incident_timeline`         | 106       | **IMMUTABLE legal record** — no PATCH/DELETE service methods; BRIN on recorded_at                                                                                                                        |
| `inc_accountability_records`    | 106       | Multi-column updated_chk lockstep; UNIQUE(incident, person)                                                                                                                                              |
| `inc_accountability_summary`    | 106       | Materialised real-time roll-up; UNIQUE(incident_id); total_chk = sum of all 5 status counters                                                                                                            |
| `inc_reunification_records`     | 106       | UNIQUE(incident, student); cross-cycle FK to vis_visitors via service-side validation                                                                                                                    |
| `inc_reunification_corrections` | 106       | Audit chain; ≥20-char service-enforced reason                                                                                                                                                            |
| `inc_drills`                    | 107       | Multi-column completed_chk lockstep on (status, completed_at, duration, participation_rate); 90-day overdue calc                                                                                         |
| `inc_non_discipline_incidents`  | 107       | 7-value type + UUID[] students_involved/staff_involved soft refs; closed_chk lockstep                                                                                                                    |

**Tenant logical base table count: previous + 11 = expected ~438 (per the plan).**

## Endpoints (~28 surfaced)

All routes carry `@RequirePermission` (32 total decorator instances across the controller).

```
POST   /incidents/declare                      saf-001:write
GET    /incidents                              saf-001:read
GET    /incidents/:id                          saf-001:read
PATCH  /incidents/:id/resolve                  saf-001:write
PATCH  /incidents/:id/cancel                   saf-001:write

GET    /incidents/types/list                   saf-001:read
GET    /incidents/types/:id                    saf-001:read
POST   /incidents/types                        saf-001:admin
PATCH  /incidents/types/:id                    saf-001:admin

GET    /incidents/procedures                   saf-001:read
GET    /incidents/procedures/by-type/:t        saf-001:read
GET    /incidents/procedures/:id               saf-001:read
POST   /incidents/procedures                   saf-001:admin
PATCH  /incidents/procedures/:id               saf-001:admin

GET    /incidents/:id/timeline                 saf-001:read
POST   /incidents/:id/timeline                 saf-001:write   ← append-only

GET    /incidents/:id/accountability           saf-001:read
GET    /incidents/:id/accountability/summary   saf-001:read
PATCH  /incidents/accountability/:recordId     saf-001:write
POST   /incidents/:id/accountability/bulk      saf-001:write

GET    /incidents/:id/reunification            saf-001:read
POST   /incidents/:id/reunification            saf-001:write   ← identity-verified
POST   /incidents/reunification/:id/correct    saf-001:write   ← ≥20-char reason

GET    /incidents/drills/list                  saf-004:read
GET    /incidents/drills/overdue               saf-004:read
POST   /incidents/drills                       saf-004:write
PATCH  /incidents/drills/:id/complete          saf-004:write
PATCH  /incidents/drills/:id/cancel            saf-004:write

GET    /incidents/reports/list                 saf-003:read
GET    /incidents/reports/:id                  saf-003:read
POST   /incidents/reports                      saf-003:write
PATCH  /incidents/reports/:id                  saf-003:read   (service-layer reviewer gate enforces saf-003:admin)
```

## Kafka emits (2 cycle-emitted + 1 worker-emitted)

| Topic                          | Producer                            | Trigger                               | Payload highlights                                                       |
| ------------------------------ | ----------------------------------- | ------------------------------------- | ------------------------------------------------------------------------ |
| `inc.emergency.declared`       | IncidentService.declare             | After atomic incident + outbox commit | incidentId, schoolId, severity, requiresLockdown, declaredBy, declaredAt |
| `inc.incident.reported`        | NonDisciplineIncidentService.create | After non-discipline insert commits   | incidentId, schoolId, incidentType, severity, location, reportedBy       |
| `inc.emergency.alert.dispatch` | DeclarationOutboxWorker             | When the outbox alert step fires      | incidentId, schoolId, incidentTypeCode, severity, notificationTemplate   |

## Workers

- **DeclarationOutboxWorker** — polls `inc_declaration_outbox` every
  5s (warmup 30s) for unstamped step columns. Per row: stamps each
  step idempotently in a single tenant tx (lock-row → check unstamped
  → execute step → stamp column → release lock). Crash-recoverable
  because it picks up from the last unstamped step. Stall detection
  fires at error level when any step is unstamped >5 min after
  declared_at — Prometheus scraper picks up the log line for the PAGE
  alert. Disable via `DECLARATION_OUTBOX_DISABLED=1`.

## Permission distribution

Per-catalogue codes (no plan typo carried — see "Deviations" below):

- **SAF-001** Emergency Management: read+write to Staff/Admin; read to Teacher; admin tier via everyFunction.
- **SAF-003** Incident Reporting: read+write to Teacher/Staff/Admin; admin tier via everyFunction.
- **SAF-004** Drill Management: read+write to Staff/Admin; admin tier via everyFunction.

Parent / Student have no SAF-001/003/004 grants — the emergency
module is staff-internal. Parents receive emergency notifications via
Cycle 14's emergency-alert channel (the outbox alert step emits
`inc.emergency.alert.dispatch` for that pipeline to consume).

## Web surface (7 routes)

```
/emergency                                  Persona-aware dashboard.
                                            Quiet mode: drill schedule, overdue list,
                                            procedure review status, declaration panel.
                                            Active mode: rose-tinted banner + elapsed clock
                                            + accountability summary bar + 3-tile outbox
                                            status + per-person accountability table +
                                            timeline feed + resolve panel.
/emergency/procedures                       Read-only procedure viewer.
/emergency/reunification                    Identity-verified release station.
/emergency/drills                           Schedule + complete + cancel.
/emergency/report                           Non-discipline incident form.
/emergency/reports                          Reports log with status/type filters + admin review.
/emergency/incidents/[id]/report            Auto-generated after-action report (printable).
```

The `Emergency` launchpad tile is registered in `apps/web/src/components/shell/apps.tsx`
under key `'emergency'` and gated on `saf-001:read OR saf-003:read`.

## Cross-cycle integration

| Cross-cycle dependency               | What we read/write                                                                                                          | Notes                                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **P2C1 vis_visitors + vis_sign_ins** | ReunificationService validates `releasedToId` exists in vis_visitors AND has an active vis_sign_ins (signed_out_at IS NULL) | Service-side guard, not DB FK — vis_visitors is in P2C1's namespace                                                      |
| **P2C1 vis_emergency_muster**        | DeclarationOutboxWorker.runStepMuster inserts a vis_emergency_muster row keyed on incident_id + drill_type                  | Best-effort — the outbox warns and continues if vis_emergency_muster doesn't exist                                       |
| **Cycle 7 tsk_tasks**                | DeclarationOutboxWorker.runStepTasks inserts URGENT auto-tasks for the procedure's primary + secondary contact              | source='AUTO', source_ref_id = incident_id                                                                               |
| **Cycle 14 emergency alerts**        | DeclarationOutboxWorker.runStepAlert emits `inc.emergency.alert.dispatch` for Cycle 14's notifier to consume                | The Cycle 14 consumer is not yet wired — the emit is captured on the wire and the alert_sent_at column stamps regardless |
| **Cycle 8 tkt_tickets**              | NonDisciplineIncidentService accepts `followUpTicketId` soft ref                                                            | Display-only — admin reviewers attach the ticket id when triaging                                                        |

## Test coverage

`apps/api/src/incidents/incidents.spec.ts` — 14 unit tests covering every keystone:

- TimelineService immutability (Object.getOwnPropertyNames check that no PATCH/DELETE/UPDATE/ARCHIVE methods exist on the prototype + cross-tenant 404 on append + JOIN scope on listForIncident).
- AccountabilityService: COUNT(\*) FILTER summary recompute + bulkUpdate CTE shape + empty-recordIds rejection.
- ReunificationService: rejects non-signed-in releasedToId + rejects releases on non-ACTIVE incidents + correction reason ≥20-char enforcement.
- DrillService: overdue() emits the 90-day CTE shape + complete() rejects non-SCHEDULED.
- IncidentService: atomic declare commits both incident + outbox + resolve() requires ACTIVE + inactive type rejection.

Full vitest sweep: 11 files / 89 tests / all green.

## Deviations from the plan

1. **Permission codes — corrected from plan typo.** The plan text (page intro + summary table) says "SAF-002 + SAF-003" for this cycle. The actual catalogue at `packages/database/data/permissions.json` has:
   - `SAF-001` = "Emergency Management"
   - `SAF-002` = "Visitor Management" (used by P2C1)
   - `SAF-003` = "Incident Reporting"
   - `SAF-004` = "Drill Management"
     We use **SAF-001** (declaration / accountability / reunification / procedures), **SAF-003** (non-discipline reporting), **SAF-004** (drill management). Using SAF-002 here would conflate emergency authority with the visitor-portal gate held by reception staff — not desirable.

2. **Task table is `tsk_tasks`, not `wsk_tasks`.** Plan referred to the latter. Migration 026 declares `tsk_tasks`. Worker writes there directly with `source='AUTO'`.

3. **Roster muster (students/staff) is manual this cycle.** Plan calls for outbox `muster_taken_at` to seed accountability_records from `sis_enrollments` + `hr_employees`. The schema accepts the rows, but auto-seed from rosters during a real emergency requires careful filtering (which buildings? which periods?) — deferred to a follow-up. Outbox seeds visitors only and writes empty summary; staff bulk-mark roster from the dashboard.

4. **Cycle 14 emergency-alert consumer for `inc.emergency.alert.dispatch`** is not yet wired. The outbox emits cleanly; subscriber is a future enhancement.

## Known limitations / follow-ups

| Item                                                                        | Severity | Recommendation                                                                                      |
| --------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| Outbox stall detection logs at error but does not push a Prometheus counter | Minor    | Add `outbox_stall_total` gauge keyed on `step`                                                      |
| Roster muster from sis_enrollments + hr_employees is manual                 | Minor    | Phase 3 — a Cycle 14-style roster fan-out worker                                                    |
| Procedure CRUD admin UI is minimal (read-only viewer)                       | Minor    | Admin form ships in a follow-up sprint; the API endpoints are complete                              |
| `inc.emergency.alert.dispatch` consumer                                     | Minor    | Cycle 14 consumer + dispatch logic ships later                                                      |
| OutboxStatus on incident.list() responses                                   | Minor    | Inlining the outbox status on every incident in the list query is currently per-id only via getById |

## Files changed

```
packages/database/prisma/tenant/migrations/105_inc_incidents.sql           NEW
packages/database/prisma/tenant/migrations/106_inc_accountability.sql      NEW
packages/database/prisma/tenant/migrations/107_inc_drills.sql              NEW
packages/database/src/seed-incident.ts                                     NEW
packages/database/src/seed-iam.ts                                          MODIFIED (SAF-001/003/004 grants)
packages/database/src/seed-all.ts                                          MODIFIED (P2C2 step appended)
packages/database/package.json                                             MODIFIED (seed:incident wired)

apps/api/src/incidents/dto/incident.dto.ts                                 NEW
apps/api/src/incidents/incident.service.ts                                 NEW
apps/api/src/incidents/incident-type.service.ts                            NEW
apps/api/src/incidents/procedure.service.ts                                NEW
apps/api/src/incidents/timeline.service.ts                                 NEW
apps/api/src/incidents/accountability.service.ts                           NEW
apps/api/src/incidents/reunification.service.ts                            NEW
apps/api/src/incidents/drill.service.ts                                    NEW
apps/api/src/incidents/non-discipline.service.ts                           NEW
apps/api/src/incidents/declaration-outbox.worker.ts                        NEW
apps/api/src/incidents/incidents.controller.ts                             NEW
apps/api/src/incidents/incidents.module.ts                                 NEW
apps/api/src/incidents/incidents.spec.ts                                   NEW (14 tests)
apps/api/src/app.module.ts                                                 MODIFIED (IncidentsModule wired)

apps/web/src/lib/types.ts                                                  MODIFIED (~25 P2C2 DTOs appended)
apps/web/src/lib/incidents-format.ts                                       NEW
apps/web/src/hooks/use-incidents.ts                                        NEW
apps/web/src/app/(app)/emergency/page.tsx                                  NEW
apps/web/src/app/(app)/emergency/procedures/page.tsx                       NEW
apps/web/src/app/(app)/emergency/reunification/page.tsx                    NEW
apps/web/src/app/(app)/emergency/drills/page.tsx                           NEW
apps/web/src/app/(app)/emergency/report/page.tsx                           NEW
apps/web/src/app/(app)/emergency/reports/page.tsx                          NEW
apps/web/src/app/(app)/emergency/incidents/[id]/report/page.tsx            NEW
apps/web/src/components/shell/apps.tsx                                     MODIFIED ('emergency' AppKey + tile)

docs/p2c2-cat-script.md                                                    NEW
HANDOFF-P2C2.md                                                            NEW (this file)
P2C2-REVIEW-NOTES.md                                                       NEW
CLAUDE.md                                                                  MODIFIED (P2C2 status block)
```
