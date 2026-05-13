# REVIEW NOTES — Phase 2 Cycle 23 (P2-23): Accreditation

**Scope:** P2-23a (schema + seed + services + worker) at `cc385e4` +
P2-23b (UI + integration tests + docs) at this commit.
**Plan:** `docs/campusos-p2c23-accreditation.html`
**Handoff:** `HANDOFF-P2C23.md`
**Dates:** 2026-05-13

This document is the peer-review scaffold for the full P2-23 cycle. It
enumerates the load-bearing structural decisions, the live verification
trail, and the documented carry-overs so the reviewer can move
efficiently through 8 new tables (6 tenant + 2 platform), ~22
endpoints, 1 background worker, 6 web routes, and 47 tests (24 unit
from P2-23a + 23 integration from P2-23b).

---

## 1. Cycle deliverable summary

**Schema:**

| Layer    | Migration                           | Tables                            |
| -------- | ----------------------------------- | --------------------------------- |
| Platform | Prisma `20260513051400_add_p2c23_…` | `acc_frameworks_platform`,        |
|          |                                     | `acc_standards_platform`          |
| Tenant   | `161_acc_evidence_selfstudy.sql`    | `acc_school_framework_adoptions`, |
|          |                                     | `acc_frameworks`,                 |
|          |                                     | `acc_evidence_items`,             |
|          |                                     | `acc_self_study_ratings`,         |
|          |                                     | `acc_action_plans`,               |
|          |                                     | `acc_site_visit_prep`             |

**Backend:** 5 services + 1 worker + 1 controller + 22 endpoints + 1
Kafka emit topic in `apps/api/src/accreditation/`. AccreditationModule
wired in `AppModule` between `AlumniModule` and `KafkaModule`.

**Web:** 6 routes under `/accreditation/*`, 1 launchpad tile gated on
`tch-008:read AND (isStaff OR isAdmin)`, 18 React Query hooks, ~30 DTOs.

**Tests:** 24 unit tests in `accreditation.spec.ts` (P2-23a) + 23
integration tests in `accreditation-integration.spec.ts` (P2-23b).
Total vitest pass count: 1191 / 1191 across 60 spec files.

---

## 2. Platform vs Tenant split — the architectural keystone

**The decision.** National accreditation frameworks (AdvancED, IB MYP,
CIS, NEASC, WASC, SACS, MSA) and their standards live in the platform
schema, seeded once and shared across every tenant. School-custom
frameworks (e.g. "Lincoln Teaching Excellence") live in the tenant
schema. School adoptions live in the tenant schema as a many-to-many
link table to platform frameworks.

**Why.** A platform standard is a shared resource. Every Lincoln, every
Roosevelt, every St. Mary's adopting AdvancED references THE SAME 30
standards — there is no per-school customisation of the AdvancED text.
Putting them in the platform layer means a single seed maintenance
point (`ensurePlatformFramework`), zero per-tenant duplication, and
zero schema migrations when AdvancED ships a new version (just update
the seed file). The platform schema's `acc_frameworks_platform` and
`acc_standards_platform` ship in a single Prisma platform migration
(`20260513051400_add_p2c23_accreditation_platform_tables`).

**Custom frameworks stay tenant-side.** When a school wants its own
"Teaching Excellence" standards, those live in `tenant_<x>.acc_frameworks`
with `UNIQUE(school_id, name)` + a schema-level invariant
`CHECK(school_id IS NOT NULL)` ensuring platform frameworks NEVER land
in the tenant table.

**Adoption is the join.** `acc_school_framework_adoptions(school_id,
platform_framework_id)` is the M2M that lets schools layer multiple
frameworks (AdvancED + IB MYP simultaneously, very common in
international schools). UNIQUE(school, platform_framework_id) so a
school adopts each framework at most once.

**No cross-schema FK on adoptions.** Per ADR-001/020, the adoption row's
`platform_framework_id` is a soft UUID ref — no DB-enforced FK. The
`FrameworkService.createAdoption` validates platform-side existence in
the app layer via `SELECT id FROM platform.acc_frameworks_platform
WHERE id = $1::uuid AND is_active = true LIMIT 1` before the INSERT.

**Reviewer check:**

```sql
-- Verify the platform-vs-tenant split is observed
SELECT 'platform' AS layer, COUNT(*) FROM platform.acc_frameworks_platform
UNION ALL SELECT 'tenant', COUNT(*) FROM tenant_demo.acc_frameworks;
-- Custom row in acc_frameworks where school_id IS NULL should be impossible
SELECT COUNT(*) FROM tenant_demo.acc_frameworks WHERE school_id IS NULL;
-- expected: 0
```

---

## 3. SOFT INTEGRITY for `standard_id` — the second keystone

**The contract.** Three tables carry a `standard_id UUID NOT NULL`
column that resolves to EITHER `platform.acc_standards_platform(id)`
OR a tenant-side custom standard:

- `acc_evidence_items.standard_id`
- `acc_self_study_ratings.standard_id`
- `acc_action_plans.standard_id`

NONE of these have a DB-enforced FK. Resolution happens at the service
layer via `resolveStandard()` in `apps/api/src/accreditation/access.ts`:

```ts
// 1. Try platform first
SELECT id::text, framework_id::text, standard_code, domain, standard_text
FROM platform.acc_standards_platform WHERE id = $1::uuid LIMIT 1
// 2. Fall back to tenant custom framework row (treated as a single
//    standard via SOFT INTEGRITY for P2-23a — the proper custom-
//    standards child table is deferred to a future cycle)
SELECT id::text, name FROM acc_frameworks
WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1
```

Every create path (`EvidenceService.create`, `SelfStudyService.create`,
`ActionPlanService.create`) calls `assertStandardResolves()` which
throws `NotFoundException` on miss. A bogus UUID gets a friendly 404
"Standard <id> not found in platform or tenant catalogues" — see S6
in the integration spec.

**Why SOFT INTEGRITY rather than DB FK?**

1. A cross-schema FK from a tenant table to a platform table is the
   exact thing ADR-001/020 forbids — tenant schemas must be detachable
   from the platform layer at any time. A DB FK would couple them.
2. The standard_id column needs to resolve to two different tables.
   PostgreSQL has no polymorphic FK; a CHECK constraint with an
   EXISTS subquery is not enforced cross-row. Service-layer resolution
   is the only correct shape.
3. The tenant-side custom-standards child table is deferred — for the
   P2-23 scope, each `acc_frameworks` row IS the standard. Future
   cycles add a real child table; the resolver in `access.ts` is
   designed to absorb that change with one extra SQL query and no
   API contract change.

**Reviewer check (S6 in the integration spec):**

The spec covers all 4 SOFT INTEGRITY paths:

- platform standard resolves → 201
- tenant custom framework row resolves → 201
- non-existent UUID → 404
- readiness denominator counts each `acc_frameworks` row as 1 standard

---

## 4. Readiness score formula — Step 7 (integrated into P2-23a)

**The formula** in `SiteVisitService.readinessForVisit`:

```
ready_count = COUNT(standards with rating in current cycle
                    AND ≥1 APPROVED evidence)
total = COUNT(adopted platform standards) + COUNT(active acc_frameworks rows)
readiness_score = ROUND((ready_count / total) × 100)
```

**Where "current cycle" comes from.** `resolveCurrentCycle(schoolId)`
reads the most-recent `cycle_id` from `acc_self_study_ratings` for this
school. If no ratings exist yet, defaults to the calendar academic year
(`${YYYY}-${YYYY+1}`). This means a school never needs to configure a
cycle — the first rating they submit defines it. A school can change
cycles by submitting a rating with a different `cycle_id`; subsequent
calls pick up the new value.

**Recompute side effects (Step 7).** The cached
`acc_site_visit_prep.readiness_score` is updated automatically by:

- `EvidenceService.review` APPROVED branch — best-effort via try/catch
  so a recompute failure doesn't roll back the review.
- `SelfStudyService.create` — same pattern after the rating INSERT.
- `SiteVisitService.create` — initial recompute so a new visit row
  carries a real score instead of NULL.

**Coverage:**

```
24/30 → 80, 30/30 → 100, 0/0 → 0 (graceful zero-standards branch),
25/40 → 63 (rounding verified via Math.round)
```

Integration spec S5 pins all four scenarios.

**Edge case — VISIT_COMPLETE rows are NOT recomputed.** Once a visit
is closed, its readiness_score snapshot is frozen for audit. The
`persistScore` helper short-circuits on `status === 'VISIT_COMPLETE'`.

**Reviewer check:**

```ts
// In SiteVisitService.persistScore — line 400:
if (status === 'VISIT_COMPLETE') return;
// recomputeReadinessForSchool — line 387:
WHERE school_id = $2::uuid AND status <> 'VISIT_COMPLETE'
```

---

## 5. Action plan JSONB sub-actions pattern

**The shape.** `acc_action_plans.actions JSONB NOT NULL` stores an array
of `{ description, due_date, status }` sub-tasks. The DTO type:

```ts
interface AccSubAction {
  description: string;
  due_date: string; // YYYY-MM-DD
  status: 'PENDING' | 'COMPLETED' | 'OVERDUE';
}
```

**Why JSONB rather than a child table?** Action plans typically carry
3–7 sub-actions, all of which are inspected together when the
coordinator opens the plan. A child table would join + sort + filter
on every read. JSONB stores them inline with the parent — 1 query per
plan, normalised at the service layer via `normaliseActions()` which
enforces shape validation on every write (description non-empty,
due_date non-empty, status in the 3-value enum).

**Auto-complete cascade.** `ActionPlanService.updateSubAction` flips a
single sub-action by index. When every sub-action ends in `COMPLETED`,
the parent plan auto-transitions to status='COMPLETE'. The schema's
4-value status CHECK + the service's transition graph
(PLANNED → IN_PROGRESS → COMPLETE, with OVERDUE branch from worker)
keep the lifecycle consistent.

**Reviewer attention:** The JSONB shape limits us to "all sub-actions
visible together". When district-level reporting wants "show every
COMPLETED sub-action across all plans this quarter", we need a
relational child table. Deferred — see Open question #4 in the
handoff.

**ActionPlanOverdueWorker** is the keystone that flips
IN_PROGRESS → OVERDUE on every 6-hour sweep when target_date is past.
Emits `acc.action_plan.overdue` via the platform outbox with a
deterministic v5-shape event_id from
`deterministicActionPlanOverdueEventId(planId)`. Per-tenant fan-out is
wrapped in try/catch so one tenant's failure doesn't abort the others.
Idempotent via the standard outbox + downstream consumer-group claim
pattern.

---

## 6. Idempotent platform framework seeder (Step 8)

**Lives at:** `packages/database/src/seed-accreditation.ts`.

**The idempotency keystone:** `ensurePlatformFramework(name, args)`:

```ts
const existing = await client.$queryRawUnsafe(
  'SELECT id FROM platform.acc_frameworks_platform WHERE name = $1 LIMIT 1',
  args.name,
);
if (existing.length > 0) {
  return { id: existing[0]!.id, created: false };
}
// otherwise INSERT framework + INSERT each standard
```

**Coverage:** 3 frameworks seeded with ~70 total standards:

- AdvancED Performance Standards (Cognia) — 7 domains × ~4-5 standards = 30
- IB MYP — 4 domains × 4 standards = 16
- CIS — 8 domains × 3 standards = 24

**To add a 4th framework:** edit `seed-accreditation.ts`, add a
`StandardSpec[]` constant, add the `ensurePlatformFramework` call.
Re-run `pnpm seed:accreditation`. The first 3 frameworks short-circuit,
the new one gets inserted. Schools see the new framework the next time
they open the adoption modal — no schema migration, no API change.

**Tenant seed idempotency:** `seedAccreditation` gates on the demo
school's `acc_school_framework_adoptions` row count. Re-running logs
`acc_school_framework_adoptions already populated for demo school —
skipping`.

**Reviewer check:**

```bash
# Run twice — second run should produce identical row counts
pnpm seed:accreditation
pnpm seed:accreditation
# Then verify
psql -c "SELECT COUNT(*) FROM platform.acc_frameworks_platform;"
# expected: 3
psql -c "SELECT COUNT(*) FROM platform.acc_standards_platform;"
# expected: ~70
```

---

## 7. IAM gating — TCH-008 reuse

**The decision.** The plan calls for "TCH-008 extended" — reuse the
existing curriculum permission code rather than mint a new ACR-001.

**The risk:** TCH-008:read is held by Parent + Student for the
curriculum surface. If the accreditation reads gate ONLY on
`@RequirePermission('tch-008:read')`, parents and students would see
the entire accreditation surface.

**The mitigation.** The service layer is the actual access boundary:

```ts
// access.ts
export function assertStaffOrAdmin(actor: ResolvedActor, surface: string) {
  if (actor.isSchoolAdmin) return;
  if (actor.personType === 'STAFF') return;
  throw new ForbiddenException(
    `${surface} is restricted to staff and administrators — ` +
      'accreditation data is not parent/student-facing',
  );
}
```

Every read endpoint funnels through `assertStaffOrAdmin`. Every write
endpoint funnels through `assertCoordinatorScope` which adds the
`tch-008:write` requirement on top of the personType check.

**Visibility matrix (verified in S7):**

| Persona             | Read | Write | Notes                                  |
| ------------------- | ---- | ----- | -------------------------------------- |
| Platform Admin      | ✓    | ✓     | isSchoolAdmin bypass                   |
| School Admin        | ✓    | ✓     | isSchoolAdmin bypass                   |
| Coordinator (Staff  | ✓    | ✓     | Holds TCH-008:write via Staff role     |
| with TCH-008:w)     |      |       |                                        |
| Read-only Staff     | ✓    | —     | Staff but no TCH-008:write — read only |
| Teacher (TCH-008:r) | ✗    | ✗     | personType=STAFF + read on curriculum  |
|                     |      |       | but `assertStaffOrAdmin` allows them   |
|                     |      |       | through. Coordinator-only writes are   |
|                     |      |       | gated separately. Teachers may submit  |
|                     |      |       | DRAFT evidence per the plan's "all     |
|                     |      |       | staff can submit evidence" scope.      |
| Parent (TCH-008:r)  | ✗    | ✗     | Refused at service layer               |
| Student (TCH-008:r) | ✗    | ✗     | Refused at service layer               |

**Tile gating.** The launchpad tile in `apps.tsx` adds `&& (isStaff ||
isAdmin)` so parents + students never see it even if they hold the
permission. The 6 page-level guards also early-return an EmptyState
for non-staff non-admin actors.

**Reviewer attention:** Pre-pilot we may want to split TCH-008 into a
dedicated ACR-001 (Accreditation) code so IAM reporting and admin
audit queries can distinguish "Mary is a curriculum coordinator" from
"Mary is the accreditation coordinator". Today's reuse is the
minimum-friction shape per the plan; future split is a clean
additive change.

---

## 8. Live verification trail

`tenant_demo` was already seeded with the P2-23a data at the
`cc385e4` commit. The seed shape is:

- **Platform:** 3 frameworks (AdvancED, IB MYP, CIS) + ~70 standards
- **Tenant:** 1 adoption (Lincoln adopts AdvancED) + 1 custom framework
  (Lincoln Teaching Excellence) + 8 evidence items across all 5 evidence
  types and mixed statuses (APPROVED/SUBMITTED/DRAFT) + 10 self-study
  ratings (4 ACCOMPLISHED, 3 DEVELOPING, 2 EXEMPLARY, 1 NOT_MET) +
  2 action plans (1 IN_PROGRESS, 1 OVERDUE) + 1 site visit prep
  (PREPARING, readiness_score=75)

The 23 integration tests in
`apps/api/src/accreditation/__tests__/accreditation-integration.spec.ts`
exercise every endpoint against fake-DB doubles and verify the
SQL-shape predicates the production code emits. Tests are stable across
re-runs (no flakes observed across 5 sequential runs during P2-23b
development).

---

## 9. Documented Phase 2 / pre-pilot carry-overs

| #   | Item                                                                 |
| --- | -------------------------------------------------------------------- |
| 1   | Custom standards child table (replaces SOFT INTEGRITY simplification |
|     | where each `acc_frameworks` row counts as a single standard).        |
| 2   | External accreditor portal (read-only view for visiting evaluation   |
|     | teams).                                                              |
| 3   | Site visit team member management — schedule + agenda builder.       |
| 4   | Evidence auto-linking from other modules (auto-attach attendance     |
|     | data as evidence for relevant standards). Heuristic + worker-driven. |
| 5   | Multi-cycle comparison (how ratings changed between accreditation    |
|     | cycles). Longitudinal trend chart.                                   |
| 6   | Peer school benchmarking (cross-tenant anonymised).                  |
| 7   | PDF export of the self-study report (current export is CSV-only).    |
|     | Production needs PDF renderer for submission to the accrediting      |
|     | body.                                                                |
| 8   | Cycle 14 NotificationConsumer wiring on `acc.action_plan.overdue`    |
|     | for responsible-party IN_APP fan-out.                                |
| 9   | TCH-008 → dedicated ACR-001 permission code split for cleaner IAM    |
|     | reporting before real-school pilot.                                  |
| 10  | Action plan sub-actions → relational child table for district-       |
|     | level cross-plan reporting.                                          |

---

## 10. Reviewer's quick-start

```bash
# Schema sanity
psql tenant_demo -c "\d acc_evidence_items"
psql tenant_demo -c "SELECT COUNT(*) FROM acc_school_framework_adoptions;"
# Live API smoke
curl -H "X-Tenant-Subdomain: demo" http://localhost:4000/api/v1/accreditation/frameworks
curl -H "X-Tenant-Subdomain: demo" http://localhost:4000/api/v1/accreditation/self-study/2025-2026
# Test suite
pnpm --filter @campusos/api test -- --run accreditation
# Web build
pnpm --filter @campusos/web build 2>&1 | grep accreditation
```

Expected outcomes:

- 8 acc\_\* tables in tenant_demo
- 3 frameworks platform-side, 1 adopted by Lincoln
- 6 web routes ship statically (`/accreditation`, `/standards`, `/evidence`,
  `/self-study`, `/action-plans`, `/site-visit`)
- All 47 accreditation tests pass (24 P2-23a unit + 23 P2-23b integration)
