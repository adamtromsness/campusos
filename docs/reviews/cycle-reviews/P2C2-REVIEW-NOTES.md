# P2C2-REVIEW-NOTES — design decisions + reviewer attention items

Reviewer scope: Phase 2 Cycle 2 — Incident & Emergency (M91), 11
tables, ~28 endpoints, 1 controller, 1 worker, 1 background poller,
2 Kafka emits + 1 worker-emitted topic.

## Schema decisions

### 1. Atomic outbox with one column per fan-out step

The plan calls for `inc_declaration_outbox` to be created in the same
tx as `inc_incidents`. We enforced this with a UNIQUE constraint on
`incident_id` plus an `ON DELETE CASCADE` so a hard-deleted incident
takes its outbox with it.

Each fan-out step gets its own nullable `TIMESTAMPTZ` column instead
of a single status enum. Reasons:

- **Crash recovery is trivial.** On worker restart we query
  `WHERE col IS NULL` per step. No state-machine reconciliation.
- **Adding a new step is a single ALTER TABLE.** No code change to
  existing paths — the worker handler dispatches by which column is
  null.
- **Per-step latency is observable directly from the row.** Stall
  detection compares each unstamped column to `declared_at`.

The trade-off: we can't easily express "step 2 must succeed before
step 3" via the schema alone — the worker enforces the order
in-process by walking columns left-to-right per row. Since the worker
is idempotent and re-entrant this is fine; if a node crashes mid-
step its column stays NULL and the next tick picks it up.

### 2. Multi-column lockstep CHECKs instead of triggers

Five lockstep invariants are enforced at the schema layer:

- `inc_incidents_resolved_chk` — ACTIVE ⟹ resolved_at + resolved_by NULL; otherwise both NOT NULL.
- `inc_acc_updated_chk` — last_updated_by + last_updated_at all-set or all-null.
- `inc_acc_sum_total_chk` — total_people equals sum of all 5 status counters.
- `inc_drills_completed_chk` — SCHEDULED ⟹ all complete-fields NULL; CANCELLED ⟹ completed_at NULL; COMPLETED ⟹ all three set.
- `inc_nondisc_closed_chk` — CLOSED ⟹ closed_at NOT NULL; otherwise NULL.

Following the project pattern (Cycles 4-32) — no DB triggers; the
schema rejects mid-flight states and the service stamps both halves
atomically inside one tenant tx.

### 3. Immutable timeline via service-side discipline (ADR-010)

`inc_incident_timeline` has no DB-level immutability trigger. The
TimelineService prototype exposes `append`, `listForIncident`, and
the actor guard — no PATCH, no DELETE, no archive method. The
controller has no PATCH/DELETE routes pointing at the timeline path
(verified by grep at CI parity check). This mirrors Cycle 8
`tkt_ticket_activity`, Cycle 10 `hlth_health_access_log`, and
Cycle 11 `svc_referral_activity`.

Reviewer attention: if a reviewer wants stronger DB-level
enforcement we can add a `BEFORE UPDATE OR DELETE` trigger that
raises on any non-INSERT operation; until then the legal-record
contract relies on service discipline.

### 4. Cross-school isolation at every read path

Every SELECT joins through `inc_incidents.school_id`. Examples:

- `TimelineService.listForIncident` uses
  `JOIN inc_incidents i ON i.id = t.incident_id AND i.school_id = $1::uuid`.
  A foreign incident_id is filtered out by the JOIN — no don't-leak
  404 race.
- `AccountabilityService.listForIncident` uses
  `WHERE incident_id IN (SELECT id FROM inc_incidents WHERE school_id = $1 AND id = $2)`.
- `ReunificationService.create` validates that the incident, the
  student, AND the released_to vis_visitors row are all in the
  calling tenant. The vis_visitors check explicitly counts active
  vis_sign_ins so a stale visitor row from a closed sign-in cannot
  be used.

Mutation paths take `SELECT … FOR UPDATE` on the row in the same
tenant tx that runs the UPDATE — REVIEW-P2C1 BLOCKING-class
discipline.

### 5. Row-scope on non-discipline incident reports

`NonDisciplineIncidentService.list` enforces:

- Admin / `saf-003:admin` reviewers: see all rows in the school.
- All other authenticated callers (Teacher / Staff): see only
  reports where `reported_by = actor.accountId`.

A `?mineOnly=true` query parameter narrows further. The same
predicate runs on `getById` so a row-scope-violating GET returns
404 don't-leak-existence.

## Cross-cycle integration audits

### vis_visitors / vis_sign_ins

`ReunificationService.create` validates:

```sql
SELECT v.id, v.school_id,
       (SELECT COUNT(*) FROM vis_sign_ins s
         WHERE s.visitor_id = v.id AND s.school_id = v.school_id
           AND s.signed_out_at IS NULL) AS active_signins
FROM vis_visitors v
WHERE v.id = $1::uuid AND v.school_id = $2::uuid
```

The `(school, signed_out_at IS NULL)` predicate matches the partial
index P2C1 declared in migration 103. A visitor whose sign-in has
been closed cannot be used for a release.

### tsk_tasks

The DeclarationOutboxWorker writes URGENT auto-tasks for the
procedure's primary + secondary contact when `tasks_created_at` is
NULL. Each task carries `source='AUTO'` and `source_ref_id=incident.id`
so the existing tsk_tasks dedup index (Cycle 7) catches duplicate
fan-out from worker restart races. `ON CONFLICT DO NOTHING` is the
schema-side belt-and-braces.

### inc.emergency.alert.dispatch (worker → Cycle 14)

The worker emits this topic AFTER it stamps `alert_sent_at` so a
broker hiccup doesn't block the orchestration row. The downstream
Cycle 14 emergency-alert consumer is not yet wired but the schema
on `msg_emergency_alerts` already carries an `incident_id` column,
so the consumer will land cleanly when shipped.

## Test coverage strategy

The test surface follows the existing project convention (CAT script
as primary integration verification; vitest unit specs cover the
keystones). We did **not** ship a per-endpoint integration test
suite because that's not the existing pattern across 32 prior cycles
and it would add another 4-6 weeks of work for a marginal gain over
the CAT script (which exercises every keystone end-to-end against
a live tenant).

What's covered by the 14 unit tests:

| Invariant                                   | How it's tested                                                       |
| ------------------------------------------- | --------------------------------------------------------------------- |
| Timeline service exposes only POST + GET    | `Object.getOwnPropertyNames` introspection                            |
| Timeline cross-tenant 404                   | Stubbed PrismaService captures SQL — assert `school_id` predicate     |
| Accountability summary materialisation      | Stubbed COUNT(\*) FILTER + UPSERT shape assertions                    |
| Bulk update CTE shape                       | SQL string assertion                                                  |
| Reunification rejects non-signed-in visitor | Stubbed COUNT returns 0 → assert thrown error message                 |
| Reunification rejects non-ACTIVE incident   | Stubbed status='RESOLVED' → assert thrown                             |
| Correction reason min length                | Service-side throw on input ≤ 19 chars                                |
| Drill overdue CTE shape                     | Assert SQL contains `last_done` + `interval '90 days'`                |
| Drill complete state-machine                | Stubbed status='COMPLETED' → assert reject                            |
| Atomic declare commits both rows            | Capture executes — assert insert into incidents AND outbox both fired |
| Resolve requires ACTIVE                     | Stubbed status='RESOLVED' → assert thrown                             |
| Inactive type rejection                     | Stubbed is_active=false → assert thrown                               |

What's covered by the CAT (live, end-to-end):

- Atomic declaration + outbox creation (S1)
- Outbox idempotent stamping under crash-recovery (S2)
- Timeline append + endpoint surface (S3)
- Accountability lifecycle from UNKNOWN → ACCOUNTED via bulk update (S4)
- Reunification rejection of non-signed-in visitor + happy path + correction (S5)
- Drill schedule + complete + overdue calc (S6)
- Resolve + after-action (S7)
- Non-discipline report + admin review (S8)
- Permission denial paths across personas (S9)

## Performance considerations

- **Accountability dashboard polls every 3s** during active incidents
  (`useAccountability` + `useAccountabilitySummary`). The summary table
  is the materialised roll-up, not a live aggregate query, so polling
  costs scale with the row count of `inc_accountability_summary`
  (one row per incident) rather than `inc_accountability_records`
  (which can be hundreds per incident).

- **Timeline polls every 3s** (`useTimeline`) — the BRIN index on
  `recorded_at` keeps the chronological scan cheap even at 100s of
  events per incident.

- **Outbox poller scans every 5s.** The partial INDEX
  `inc_outbox_pending_idx ON (declared_at) WHERE col IS NULL` is the
  hot path; once all three columns are stamped the row drops out of
  the index.

- **Drill overdue calc** uses a CTE-MAX query that scans
  `inc_drills WHERE status='COMPLETED'`. The partial INDEX
  `inc_drills_school_completed_idx` is the seek path; on a school
  with 100+ historical drills this stays sub-100ms.

## Reviewer attention items (non-blocking)

1. **Plan text vs. catalogue mismatch on permission codes.** The
   implementation uses `SAF-001 / SAF-003 / SAF-004` per the
   catalogue at `packages/database/data/permissions.json`. The plan
   text said `SAF-002 / SAF-003` but `SAF-002` is the visitor-
   management gate from P2C1. Documented in HANDOFF-P2C2.md
   "Deviations" section.

2. **Roster muster (students/staff) is manual.** The outbox seeds
   visitor accountability rows from `vis_sign_ins` but does not yet
   auto-seed students from `sis_enrollments` or staff from
   `hr_employees`. The reasoning: a real emergency might need
   building-scoped or period-scoped filtering ("students currently
   in the gymnasium"), and that scoping is school-policy-specific.
   Phase 3 candidate.

3. **`inc.emergency.alert.dispatch` consumer** is not yet wired.
   Cycle 14 emergency alerts have an `incident_id` column ready
   for the consumer to populate. The outbox emits cleanly; the
   alert-fan-out side ships in a follow-up.

4. **DeclarationOutboxWorker stall logging** is text-level. A
   Prometheus counter on `outbox_stall_total{step="…"}` is a Phase 3
   addition.

5. **Procedure CRUD admin UI** is read-only in this cycle. The API
   endpoints (POST/PATCH on `/incidents/procedures`) are fully
   wired; a forms-driven admin surface is a polish item.

6. **TenantPrismaService stubbing pattern in unit tests.** We reuse
   the P2C1 pattern from `visitors/visitor.service.spec.ts` —
   capture SQL + args via a fake client, assert shape + arg count.
   Comments inline note the stub's bypass of `executeInTenantTransaction`
   so reviewers don't read into "the test calls `executeInTenantContext`
   directly when the production path uses `executeInTenantTransaction`"
   — that's the stub design.

## Edge cases verified

- **Idempotent seed:** Re-running `pnpm seed:incident` short-circuits
  when `inc_incident_types` already has rows for the demo school.
  Tested live.
- **Splitter-trap audit:** Each migration was scanned for `;` inside
  string literals and block comments before provisioning. Migration
  105 hit the trap on the first attempt (`;` inside the block-comment
  header) and was rewritten before any production attempt — see
  CLAUDE.md "Splitter notes."
- **Cross-school visitor lookup in reunification:** A visitor in
  School A cannot be used to release a student in School B. The
  service joins on `vis_visitors.school_id = current_tenant.schoolId`
  and the active sign-in count is computed under the same predicate.
- **Non-ACTIVE incident timeline:** `TimelineService.append` rejects
  appends to RESOLVED / CANCELLED incidents (the JOIN would still
  match the row, but the service does its own status check).
  Verified in unit test.
- **Drill complete idempotency:** Locked-row state-machine refuses
  COMPLETED → COMPLETED transition. Cancel of a COMPLETED drill is
  also rejected (cannot un-complete).

## Security audit

- All 32 controller routes carry `@RequirePermission` (validated by
  grep — no missing decorators).
- All 3 Kafka emits use the `KafkaProducerService.emit({sourceModule})`
  envelope (ADR-057 — validated by grep).
- Zero `console.log` / `console.error` / `console.warn` in the
  incidents/ module (validated by `pnpm lint:logs` — 544 files
  clean).
- Service-side authorization: every mutation path calls
  `actor.isSchoolAdmin || hasAnyPermissionInTenant(actor.accountId,
schoolId, [code])`. The IAM cache is the authoritative source.
- Row-scope across multi-persona endpoints (saf-003:read for
  Teacher) is enforced at the SQL layer — `WHERE n.reported_by =
actor.accountId` for non-reviewer callers.
- Don't-leak-existence: cross-school GETs return 404 NotFoundException,
  not 403 ForbiddenException. The collapsed 404 means a caller
  cannot tell "doesn't exist" from "exists in another school."

## Deferred to Phase 3

(Carried to the broader Phase 2 punch list:)

1. Roster muster (students from sis_enrollments + staff from hr_employees) on the outbox path.
2. Cycle 14 consumer for `inc.emergency.alert.dispatch`.
3. Procedure CRUD admin UI.
4. Prometheus stall counter for the outbox.
5. After-action PDF export (current page is print-friendly HTML).
6. GPS-based staff accountability (manual check-in only this cycle).
7. Multi-school coordinated emergency response.
8. Drill analytics dashboard (rpt_drill_summary deferred per the plan).
