# HANDOFF — Phase 2 Cycle 23 (P2-23): Accreditation

**Status:** COMPLETE pending peer review across both sub-cycles
(2026-05-13). P2-23a (Steps 1–4 + integrated 7+8) shipped at `cc385e4` —
backend schema + seed + services + readiness recompute side-effects + idempotent
platform seeder. P2-23b ships in this commit — Step 5 UI + Step 6 vertical-slice
integration test + handoff/review docs covering all 8 user-defined steps.
Awaiting peer review verdict before tagging `p2c23-complete`.

**Plan:** `docs/campusos-p2c23-accreditation.html`
**Review scaffold:** `P2C23-REVIEW-NOTES.md`
**Dates:** 2026-05-13

## Cycle totals (across both sub-cycles)

| Surface                           | Count                                 |
| --------------------------------- | ------------------------------------- |
| Platform migrations               | 1 (Prisma `20260513051400`)           |
| Tenant migrations                 | 1 (`161_acc_evidence_selfstudy.sql`)  |
| New platform tables               | 2 (`acc_*_platform`)                  |
| New tenant tables                 | 6 (`acc_*`)                           |
| Intra-tenant FKs                  | 1 NO ACTION on `acc_action_plans`     |
| Cross-schema FKs                  | 0 (SOFT INTEGRITY for `standard_id`)  |
| Backend services                  | 5 (Framework / Evidence / SelfStudy / |
|                                   | ActionPlan / SiteVisit)               |
| Background workers                | 1 (ActionPlanOverdueWorker)           |
| Controllers                       | 1 (`AccreditationController`)         |
| Endpoints registered live on boot | ~22                                   |
| Kafka emit topics                 | 1 (`acc.action_plan.overdue`)         |
| Permission code                   | TCH-008 (already in catalogue)        |
| Web routes                        | 6                                     |
| React Query hooks                 | 18                                    |
| Unit tests (P2-23a)               | 24                                    |
| Integration tests (P2-23b)        | 23                                    |
| Total vitest pass count           | 1191 / 1191 (across 60 spec files)    |

## Sub-cycle layout

| Sub-cycle | Surface                                             | Commit      |
| --------- | --------------------------------------------------- | ----------- |
| P2-23a    | Schema + seed + 5 services + worker + ~22 endpoints | `cc385e4`   |
| P2-23b    | Step 5 UI + Step 6 vertical-slice tests + docs      | this commit |

## Plan steps — completion status

| Step | Title                                               | Sub-cycle | Status |
| ---- | --------------------------------------------------- | --------- | ------ |
| 1    | Platform schema — frameworks + standards (2 tables) | P2-23a    | ✓ Done |
| 2    | Tenant schema — adoptions + evidence + ratings + …  | P2-23a    | ✓ Done |
| 3    | Seed data (platform frameworks + tenant demo)       | P2-23a    | ✓ Done |
| 4    | Accreditation NestJS module (5 services + 1 worker) | P2-23a    | ✓ Done |
| 5    | Accreditation UI (6 routes)                         | P2-23b    | ✓ Done |
| 6    | Vertical-slice integration test (7 scenarios)       | P2-23b    | ✓ Done |
| 7    | Readiness score auto-computation                    | P2-23a    | ✓ Done |
| 8    | Idempotent platform framework seeder                | P2-23a    | ✓ Done |

Steps 7 and 8 were folded into P2-23a because they were already structural
prerequisites for the keystone Step 4 service surfaces. `SiteVisitService.
recomputeReadinessForSchool` is invoked from `EvidenceService.review` on the
APPROVED branch and from `SelfStudyService.create` after every rating insert.
The idempotent platform seeder (`ensurePlatformFramework`) lives in
`packages/database/src/seed-accreditation.ts` and short-circuits on
`SELECT id FROM platform.acc_frameworks_platform WHERE name = $1 LIMIT 1`.

## Schema layer (P2-23a)

### Platform tables (2)

| Table                     | Notes                                               |
| ------------------------- | --------------------------------------------------- |
| `acc_frameworks_platform` | National frameworks. UNIQUE(name) + UNIQUE(abbrev). |
| `acc_standards_platform`  | UNIQUE(framework_id, standard_code).                |

Seeded: AdvancED (7 domains × ~5 standards = 30 rows), IB MYP (4 domains × 4 = 16),
CIS (8 domains × 3 = 24). Total ~70 platform standards.

### Tenant tables (6)

| Table                            | Notes                                              |
| -------------------------------- | -------------------------------------------------- |
| `acc_school_framework_adoptions` | UNIQUE(school, platform_framework_id).             |
| `acc_frameworks`                 | School-custom only. UNIQUE(school, name).          |
| `acc_evidence_items`             | 5-value `evidence_type` + 4-value `status` CHECK.  |
|                                  | Multi-column `reviewed_chk` lockstep.              |
| `acc_self_study_ratings`         | UNIQUE(standard_id, school, cycle_id).             |
| `acc_action_plans`               | `actions JSONB` sub-tasks. NO ACTION FK to         |
|                                  | `hr_employees`. Partial INDEX(target_date, status) |
|                                  | WHERE `status='IN_PROGRESS'` for the worker.       |
| `acc_site_visit_prep`            | `readiness_score NUMERIC(3,0)` cached by service.  |
|                                  | Bounds CHECK enforces 0..100.                      |

### Cross-schema soft integrity

`acc_evidence_items.standard_id`, `acc_self_study_ratings.standard_id`, and
`acc_action_plans.standard_id` are all SOFT INTEGRITY refs that resolve to
either `platform.acc_standards_platform(id)` OR a tenant `acc_frameworks(id)`
custom row. Implemented as `resolveStandard()` in
`apps/api/src/accreditation/access.ts` — tries platform first, then tenant.
`assertStandardResolves()` is the throw-on-miss helper used by every create
path (`EvidenceService.create`, `SelfStudyService.create`, `ActionPlanService.
create`).

## Backend module (P2-23a)

Lives at `apps/api/src/accreditation/`. Controller mounts at
`/accreditation/*`. 22 endpoints across 5 services + 1 worker:

| Service / Worker        | Endpoints | Surface                                 |
| ----------------------- | --------- | --------------------------------------- |
| FrameworkService        | 6         | Frameworks + adoptions + standards      |
| EvidenceService         | 5         | Create / list / review (DRAFT → SUB →   |
|                         |           | APPROVED/REJECTED). Multi-column        |
|                         |           | `reviewed_chk` stamped atomically.      |
| SelfStudyService        | 3         | UNIQUE per (standard, school, cycle).   |
|                         |           | Summary aggregates by rating + domain.  |
| ActionPlanService       | 6         | CRUD + sub-action update. Auto-complete |
|                         |           | parent when all sub-actions done.       |
| SiteVisitService        | 5         | CRUD + readiness keystone formula.      |
| ActionPlanOverdueWorker | —         | Nightly sweep → IN_PROGRESS → OVERDUE.  |
|                         |           | Emits `acc.action_plan.overdue` via     |
|                         |           | outbox with deterministic v5 event_id.  |

### IAM gating

Reuses TCH-008 per the plan ("TCH-008 extended"). Controller gates on:

- `tch-008:read` for every read endpoint
- `tch-008:write` for every write endpoint

The service-layer `assertStaffOrAdmin` + `assertCoordinatorScope` helpers in
`access.ts` provide the actual access boundary:

- `assertStaffOrAdmin`: admin / STAFF only. Parents + Students are explicitly
  refused even though they hold the gate-tier `tch-008:read` for the
  curriculum surface.
- `assertCoordinatorScope`: admin OR STAFF holding `tch-008:write` /
  `tch-008:admin`. Generic STAFF with `tch-008:read` alone cannot rate, approve
  evidence, or manage action plans.

### Kafka emits

| Topic                     | Trigger                                          |
| ------------------------- | ------------------------------------------------ |
| `acc.action_plan.overdue` | ActionPlanOverdueWorker flips IN_PROGRESS →      |
|                           | OVERDUE. Deterministic v5 event_id from          |
|                           | `deterministicActionPlanOverdueEventId(planId)`. |
|                           | Durable via `OutboxService.enqueueInTx`.         |

## Readiness score (Step 7 — integrated into P2-23a)

Formula in `SiteVisitService.readinessForVisit`:

```
ready_count = COUNT(standards with rating in current cycle
                    AND ≥1 APPROVED evidence)
readiness_score = ROUND((ready_count / total_adopted_standards) × 100)
```

- "Adopted standards" = every platform standard whose framework is adopted by
  this school (active row in `acc_school_framework_adoptions`) PLUS each
  tenant `acc_frameworks` custom row (counts as 1 standard each per the
  SOFT INTEGRITY contract — custom standards child table deferred).
- "Current cycle" is the most-recent `cycle_id` in
  `acc_self_study_ratings` for this school. Defaults to the calendar
  academic year (`${YYYY}-${YYYY+1}`) on first compute.

**Auto-recompute side effects:**

- `EvidenceService.review` APPROVED branch → calls
  `siteVisit.recomputeReadinessForSchool(schoolId)` (best-effort — wrapped in
  try/catch so a recompute failure doesn't abort the review).
- `SelfStudyService.create` → same call after the INSERT commits.
- `SiteVisitService.create` → initial recompute so a new visit row carries a
  real score instead of NULL.

**Cache:** `acc_site_visit_prep.readiness_score` is the cached snapshot read by
the dashboard. `readinessForVisit(visitId)` also UPDATEs every non-COMPLETE
visit row for the school with the freshly computed score.

## Platform framework seeder (Step 8 — integrated into P2-23a)

Lives at `packages/database/src/seed-accreditation.ts`. The
`ensurePlatformFramework(name, …)` helper is the idempotency keystone:

```sql
SELECT id FROM platform.acc_frameworks_platform WHERE name = $1 LIMIT 1
```

- If a row exists, return its id and skip the standards insert.
- Otherwise insert the framework + all standards.

Idempotency verified — running the seed twice produces the same row counts
(3 frameworks × ~25 standards each = ~70 standards). Schools see new
frameworks the next time they open the adoption modal — no schema migration
required to add a fourth framework, only an entry in the seed file.

The tenant-side seed gates on `acc_school_framework_adoptions` row count for
the demo school; re-running logs `… already populated for demo school —
skipping`.

## P2-23b — UI (Step 5)

### 6 web routes

| Route                         | Surface                                             |
| ----------------------------- | --------------------------------------------------- |
| `/accreditation`              | Dashboard — 4 stat cards (adopted, rated, evidence  |
|                               | pending, action plans overdue) + upcoming site      |
|                               | visit readiness gauge + self-study summary + nav.   |
| `/accreditation/standards`    | Standards Explorer — framework picker, group-by-    |
|                               | domain, per-standard Rate / Evidence quick actions. |
|                               | AdoptFrameworkModal + CreateCustomFrameworkModal +  |
|                               | RateStandardModal.                                  |
| `/accreditation/evidence`     | Evidence Manager — coordinator queue + per-row      |
|                               | Review modal (Submit / Approve / Reject with notes  |
|                               | required on reject) + create-evidence form with     |
|                               | type-shape validation. Supports                     |
|                               | `?standardId=…` deep-link from Standards Explorer.  |
| `/accreditation/self-study`   | Self-Study Report — rating distribution bars +      |
|                               | by-domain table + per-rating list + CSV export.     |
| `/accreditation/action-plans` | Kanban board (PLANNED / IN_PROGRESS / OVERDUE /     |
|                               | COMPLETE) + per-card detail modal with sub-action   |
|                               | checklist + status transitions.                     |
| `/accreditation/site-visit`   | Site visit list (Upcoming / Past) + detail modal    |
|                               | with readiness gauge + per-standard gap list +      |
|                               | status transitions (PREPARING → READY →             |
|                               | VISIT_COMPLETE).                                    |

### Launchpad tile

Gated on `tch-008:read AND (isStaff OR isAdmin)`. Description copy:
"Frameworks, evidence, self-study, action plans, site visit readiness".
Icon: `CheckCircleIcon`. Tile is intentionally hidden for parents + students
— even though they hold `tch-008:read` for the Curriculum surface, the
service-layer `assertStaffOrAdmin` refuses them at every read endpoint.

### Helper modules

| Module                           | Contents                                           |
| -------------------------------- | -------------------------------------------------- |
| `apps/web/src/lib/types.ts`      | ~30 new Acc\* DTOs + enums + payloads.             |
| `apps/web/src/lib/accreditation- | Per-enum label + pill maps. readinessTone helper   |
| format.ts`                       | (green ≥80 / amber ≥50 / rose <50). formatDateOnly |
|                                  | + currentCycleId + daysUntil.                      |
| `apps/web/src/hooks/use-         | 18 React Query hooks (reads + mutations).          |
| accreditation.ts`                |                                                    |

### Build sizes

```
/accreditation               2.65 kB     117 kB
/accreditation/action-plans  3.11 kB     117 kB
/accreditation/evidence      3.95 kB     118 kB
/accreditation/self-study    2.06 kB     116 kB
/accreditation/site-visit    2.9 kB      117 kB
/accreditation/standards     3.46 kB     118 kB
```

## P2-23b — Integration test (Step 6)

`apps/api/src/accreditation/__tests__/accreditation-integration.spec.ts` ships
23 pinned regression tests covering all 7 plan scenarios:

| Scenario | Tests | Surface                                             |
| -------- | ----- | --------------------------------------------------- |
| S1       | 3     | Framework adoption (success / 23505 → 409 / 404 on  |
|          |       | bogus platform framework).                          |
| S2       | 3     | Evidence lifecycle (DRAFT → SUBMITTED → APPROVED    |
|          |       | with recompute side-effect + DOCUMENT/URL/METRIC    |
|          |       | type-shape validation + URL column persistence).    |
| S3       | 2     | Self-study UNIQUE per (standard, school, cycle)     |
|          |       | catch + summary aggregation (Custom domain bucket). |
| S4       | 3     | ActionPlanOverdueWorker flip + emit shape +         |
|          |       | sub-action auto-complete cascade + COMPLETE delete  |
|          |       | refusal.                                            |
| S5       | 4     | Readiness keystone: 24/30 → 80, 30/30 → 100,        |
|          |       | 0/0 → 0, 25/40 → 63 (rounding).                     |
| S6       | 4     | SOFT INTEGRITY — platform standard resolves /       |
|          |       | tenant custom resolves / bogus → 404 / custom       |
|          |       | acc_frameworks counted in readiness denominator.    |
| S7       | 4     | Visibility — coordinator full / parent 403 /        |
|          |       | readonly staff 403 / admin queue read 200.          |

Full vitest pass count: **1191 / 1191** across 60 spec files (was 1168 before
P2-23b — +23 new integration tests).

## CI parity green at the closeout commit

- `pnpm format:check` — All matched files pass
- `pnpm lint:logs` — 922 files clean
- `pnpm --filter @campusos/api build` — clean
- `pnpm --filter @campusos/api test` — 1191/1191 passing across 60 spec files
- `pnpm --filter @campusos/web build` — clean (6 accreditation routes ship
  with First Load JS 116–118 kB)

## Reviewer attention items (Phase 2 / pre-pilot polish, non-blocking)

1. **Custom standards child table** — the SOFT INTEGRITY contract currently
   treats each `acc_frameworks` row as a single standard. Future cycles ship
   a proper `acc_custom_standards` child table for richer school-authored
   frameworks. The resolver in `access.ts` is designed to accept both shapes
   without an API change.
2. **External accreditor portal** — a read-only view for visiting evaluation
   teams. Deferred per the plan.
3. **Site visit team member management** — schedule + agenda builder.
   Deferred.
4. **Evidence auto-linking** — auto-attach attendance data, grade summaries,
   etc. as evidence for relevant standards. Heuristic + worker-driven.
5. **Multi-cycle comparison** — how ratings changed between accreditation
   cycles. Drives the longitudinal trend chart.
6. **Peer school benchmarking** — cross-tenant comparison (anonymised) for
   how Lincoln Academy ranks against other AdvancED schools.
7. **PDF export of the self-study report** — current export is CSV-only.
   Production needs a PDF renderer for submission to the accrediting body.
8. **Action plan responsible-party notification** — when an action plan
   flips to OVERDUE, the `acc.action_plan.overdue` envelope already carries
   `responsiblePartyEmployeeId`; a Cycle 14 NotificationConsumer wires this
   to IN_APP fan-out (Phase 2 work).

## Files added / changed

### New files (15)

**Backend (P2-23a, already shipped at `cc385e4`):**

- `apps/api/src/accreditation/access.ts` (177 LoC)
- `apps/api/src/accreditation/event-ids.ts` (46 LoC)
- `apps/api/src/accreditation/framework.service.ts` (343 LoC)
- `apps/api/src/accreditation/evidence.service.ts` (273 LoC)
- `apps/api/src/accreditation/self-study.service.ts` (188 LoC)
- `apps/api/src/accreditation/action-plan.service.ts` (285 LoC)
- `apps/api/src/accreditation/site-visit.service.ts` (428 LoC)
- `apps/api/src/accreditation/action-plan-overdue.worker.ts` (151 LoC)
- `apps/api/src/accreditation/accreditation.controller.ts` (289 LoC)
- `apps/api/src/accreditation/accreditation.module.ts` (61 LoC)
- `apps/api/src/accreditation/dto/accreditation.dto.ts` (405 LoC)
- `apps/api/src/accreditation/__tests__/accreditation.spec.ts` (984 LoC)
- `packages/database/prisma/platform/migrations/20260513051400_…/migration.sql`
- `packages/database/prisma/tenant/migrations/161_acc_evidence_selfstudy.sql`
- `packages/database/src/seed-accreditation.ts` (850 LoC)

**P2-23b (this commit):**

- `apps/api/src/accreditation/__tests__/accreditation-integration.spec.ts`
- `apps/web/src/app/(app)/accreditation/page.tsx`
- `apps/web/src/app/(app)/accreditation/standards/page.tsx`
- `apps/web/src/app/(app)/accreditation/evidence/page.tsx`
- `apps/web/src/app/(app)/accreditation/self-study/page.tsx`
- `apps/web/src/app/(app)/accreditation/action-plans/page.tsx`
- `apps/web/src/app/(app)/accreditation/site-visit/page.tsx`
- `apps/web/src/lib/accreditation-format.ts`
- `apps/web/src/hooks/use-accreditation.ts`
- `HANDOFF-P2C23.md`
- `P2C23-REVIEW-NOTES.md`

### Modified files (4)

- `apps/web/src/lib/types.ts` — +257 lines (Accreditation DTOs / enums)
- `apps/web/src/components/shell/apps.tsx` — Accreditation launchpad tile
- `CLAUDE.md` — Project status updated for P2-23b
- `packages/database/src/seed-iam.ts` (P2-23a — TCH-008 grants)

## Open questions for the reviewer

Captured in `P2C23-REVIEW-NOTES.md`. Headline items:

1. **SOFT INTEGRITY shape** — is the platform-first / tenant-second resolution
   order sufficient, or should the tenant table layer ship a marker (e.g.
   `acc_custom_standards.source='TENANT'`) so the API can fan out reads
   without two SQL queries?
2. **Readiness denominator** — counting each `acc_frameworks` row as exactly
   one standard is a simplification. When custom standards child rows land,
   the formula must continue to produce sensible scores in the transition.
3. **TCH-008 reuse vs new permission code** — should accreditation get its
   own ACR-001 code before pilot? Today the service-layer `assertStaffOrAdmin`
   - `assertCoordinatorScope` are the access boundary; a dedicated function
     code would be cleaner for downstream IAM reporting.
4. **Action plan JSONB shape** — should sub-actions move to a real child
   table (`acc_action_plan_steps`) for joinable reporting + per-step audit?
   Today JSONB is fine for the demo + small schools but doesn't scale to
   district-wide queries.
