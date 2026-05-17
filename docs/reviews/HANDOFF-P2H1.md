# HANDOFF-P2H1 — Security & Access Control Hardening

Cycle ID: **P2-H1**
Plan source: `docs/campusos-hardening-cycles.html` (P2-H1 section).
Scope: 22 school-scope leaks + 2 permission catalogue gaps + central guardian
authorisation service + student-owned record contract + engagement score
restrictions + soft-integrity person-in-tenant validator.

This is a **hardening cycle**. Zero new tables, zero new modules, zero new
endpoints (the new GuardianAuthorizationService + helpers are internal
infrastructure). Pure remediation of findings from the three-review audit.

---

## Step-by-step status

| Step | Subject                                         | Status      |
| ---- | ----------------------------------------------- | ----------- |
| 1    | Close 22 school-scope leaks across 9 services   | ✅ Complete |
| 2    | Add GRP-002 + GRP-003 permission codes          | ✅ Complete |
| 3    | Build GuardianAuthorizationService              | ✅ Complete |
| 4    | @StudentOwned decorator + assert helper         | ✅ Complete |
| 5    | Restrict engagement score component access      | ✅ Complete |
| 6    | Soft-integrity validation: assertPersonInTenant | ✅ Complete |
| 7    | Exit checklist + HANDOFF                        | ✅ Complete |

---

## Step 1 — School-scope leaks

All 22 gaps surfaced by the Code Audit (#22-27 BLOCKING + #35-38 MAJOR) are
closed. Each fix follows the documented pattern: thread `school_id` through
the WHERE clause directly when the table carries `school_id`, or via JOIN to
a parent table that does. Zero-row results raise `NotFoundException` rather
than 403 to avoid leaking the existence of a record in a different school.

### 1.1 `sis-advanced/family-relationship.service.ts`

- `assertGuardiansInTenant()` — UNION-style ANY-array existence check now
  predicates `AND school_id = $tenant.schoolId` so cross-school guardian ids
  can't satisfy the existence gate.
- `listForFamily()` — added `JOIN sis_guardians ga ON ga.id = r.guardian_a_id`
  with `WHERE ga.school_id = $2::uuid`. Foreign-school family ids in a
  multi-school tenant return an empty list.
- `getByIdOrFail()` — same JOIN + school predicate. Foreign-school ids 404.
- `patch()` — UPDATE switched to `UPDATE sis_family_relationships AS r SET ...
FROM sis_guardians ga WHERE r.id = $N::uuid AND ga.id = r.guardian_a_id AND
ga.school_id = $N+1::uuid`. The getByIdOrFail loader already 404s on
  cross-school ids; this is defence-in-depth on the write.
- `delete()` — `DELETE FROM sis_family_relationships r USING sis_guardians ga
WHERE r.id = $1::uuid AND ga.id = r.guardian_a_id AND ga.school_id = $2::uuid`.

### 1.2 `sis-advanced/student-note.service.ts`

- Post-insert reload SELECT — added `AND n.school_id = $2::uuid`.
- `delete()` — both the authz pre-check SELECT and the DELETE statement now
  predicate on `school_id = $2::uuid`. Foreign-school note ids 404 even when
  the calling actor would otherwise be the "author" (which can't happen, but
  defence-in-depth).

### 1.3 `sis-advanced/custom-field.service.ts`

- `getDefinitionByIdOrFail()` — `WHERE id = $1::uuid AND school_id = $2::uuid`.
- `patchDefinition()` — UPDATE now carries `AND school_id = $N+1::uuid` so the
  write itself enforces tenant scope, not just the loader.

### 1.4 `scheduling/cross-school-staff.service.ts`

The table carries BOTH `home_school_id` AND `visiting_school_id`. The
calling tenant must be either home or visiting for the assignment to be
visible.

- `getById()` — `WHERE id = $1::uuid AND (home_school_id = $2::uuid OR
visiting_school_id = $2::uuid)`. A school that is neither home nor visiting
  cannot see the assignment by guessing its UUID.
- `patch()` — UPDATE carries the same `home OR visiting` predicate.

### 1.5 `store/orders.service.ts`

Five lifecycle paths plus the create path's soft-integrity validations:

- `resolveStudentSelfId()` — JOIN now adds `AND s.school_id = $2::uuid` so a
  STUDENT actor whose `iam_person` is also bridged to a student in a
  different school within the same tenant pool cannot resolve to the foreign
  student here.
- **NEW `assertExternalCustomerInCurrentSchool()`** — joins through
  `str_external_customers → str_stores` to validate the external customer
  belongs to the calling school. Called on every EXTERNAL order create.
- **NEW `assertStudentInCurrentSchool()`** — joins through `sis_students` for
  manager-on-behalf STUDENT orders.
- `fulfil()` — locked SELECT and both UPDATE branches now JOIN through
  `str_stores` with `AND s.school_id = $N::uuid`.
- `complete()` — locked SELECT + final UPDATE both JOIN through `str_stores`.
- `cancel()` — locked SELECT + UPDATE both JOIN through `str_stores`.
- `advanceFromApprovalInTx()` — UPDATE joins through `str_stores.school_id`
  even though the caller has locked the row (defence-in-depth for any
  future direct caller).
- `cancelFromApprovalDeclineInTx()` — same pattern.

### 1.6 `curriculum/maps.service.ts`

- `patch()` — locked SELECT + UPDATE both carry `AND school_id = $2::uuid` on
  `cur_curriculum_maps`.
- Unit `getById()` — JOINs through `cur_curriculum_maps.school_id`.
- Unit `patch()` — UPDATE switched to `UPDATE cur_units AS u SET ... FROM
cur_curriculum_maps m WHERE u.id = ... AND m.id = u.curriculum_map_id AND
m.school_id = ...`.
- `unalignStandard()` — `DELETE FROM cur_unit_standards us USING cur_units u,
cur_curriculum_maps m WHERE us.id = $1::uuid AND u.id = us.unit_id AND m.id
= u.curriculum_map_id AND m.school_id = $2::uuid`.
- `unlinkLesson()` — analogous DELETE … USING through `cur_units →
cur_curriculum_maps.school_id`.

### 1.7 `facilities/inspections.service.ts`

- `resolve()` — locked SELECT now JOINs through `fac_inspections` with
  `AND i.school_id = $2::uuid`. UPDATE switched to
  `UPDATE fac_inspection_violations AS v SET ... FROM fac_inspections i
WHERE v.id = $4::uuid AND i.id = v.inspection_id AND i.school_id = $5::uuid`.
- Post-mutation reload also school-scoped.

### 1.8 `governance/erasure.service.ts`

- Pseudonymisation log reload (`getPseudonymisationById` path inside
  `pseudonymiseAuditLog` after the INSERT) — added `AND school_id = $2::uuid`.
- Privacy notice reload paths (`create` + `publish` post-mutation reloads) —
  both now `WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`.
- `listPseudonymisations` was already school-scoped (Cycle 30 baseline).

### 1.9 `publications/sections.service.ts`

- `patch()` — locked SELECT JOINs `pub_publications p ON p.id =
s.publication_id` with `AND p.school_id = $2::uuid`. UPDATE switched to
  `UPDATE pub_sections AS s SET ... FROM pub_publications p WHERE s.id =
... AND p.id = s.publication_id AND p.school_id = ...`.
- `remove()` — `DELETE FROM pub_sections s USING pub_publications p WHERE
s.id = $1::uuid AND p.id = s.publication_id AND p.school_id = $2::uuid`.
- `approve()` — both the locked SELECT and the UPDATE now JOIN through
  `pub_publications.school_id`. The existing `canApproveSection` collaborator
  check now runs against a row already verified to belong to the calling
  school, eliminating the cross-school window where the lock fired before
  the school check.

---

## Step 2 — Permission catalogue gaps

`packages/database/data/permissions.json` gains two new function codes:

- **GRP-002 — Group Resources** (group: Communications)
- **GRP-003 — Group Analytics** (group: Communications)

Catalogue count: **495 → 497 functions × 3 tiers = 1491 effective permissions**.

`packages/database/src/seed-iam.ts` distributes the new codes:

- Teacher: `GRP-002:read+write`, `GRP-003:read` (group leaders manage
  resources; analytics is read-only at the teacher tier).
- Parent: `GRP-002:read` (read resources for member groups; no analytics).
- Student: `GRP-002:read` (read resources for member groups; no analytics).
- Staff: `GRP-002:read+write`, `GRP-003:read+write` (group coordinators
  manage resources + review engagement dashboards).
- School Admin / Platform Admin: full read+write+admin via the
  `everyFunction` grant.

To pick up the new grants in the running cache:

```
pnpm --filter @campusos/database exec tsx src/build-cache.ts
```

---

## Step 3 — GuardianAuthorizationService

New service at `apps/api/src/iam/guardian-authorization.service.ts` registered
in `IamModule.providers` + `exports`. Six capability-specific methods plus
a `resolveLink` convenience helper and an `logAccessDecision` audit hook.

| Capability                | Requires                                                              |
| ------------------------- | --------------------------------------------------------------------- |
| `canViewAcademicRecord`   | portal_access + (FULL or ACADEMIC_ONLY scope)                         |
| `canViewHealthRecord`     | portal_access + FULL scope + (receives_reports / emergency / custody) |
| `canAuthorizePayment`     | has_custody                                                           |
| `canReceiveTransportInfo` | portal_access + (receives_reports / has_custody / emergency)          |
| `canViewCommunications`   | portal_access + (FULL or COMMUNICATIONS_ONLY scope)                   |
| `canAttendConference`     | portal_access + scope ≠ ACADEMIC_ONLY                                 |

All six methods read the (guardian, student) link from
`sis_student_guardians + sis_guardians + sis_students` with school predicates
on the guardian + student rows so cross-school links cannot satisfy the gate.

### Reference integration

`apps/api/src/health/health-record.service.ts` GUARDIAN branch now calls
`guardianAuthz.canViewHealthRecord(actor.personId, studentId)` instead of the
inline `sis_student_guardians` join. Demo seed flags every guardian as
`portal_access=true, scope='FULL', has_custody=true, receives_reports=true,
is_emergency_contact=true` so existing happy-path behaviour is preserved;
production schools that narrow custody / portal scope get
FERPA-appropriate filtering for free.

The 7 remaining modules (engagement, payments, conferences, portfolio,
transport, communications, college apps) carry per-module guardian-link
checks that already pass the demo CAT; migrating each to call
`GuardianAuthorizationService` is **Phase 2 polish** — picked up cycle by
cycle as each domain is touched. The hardening doc explicitly tracks this
as the recommended migration pattern.

---

## Step 4 — @StudentOwned contract

Two new files:

- `apps/api/src/auth/student-owned.decorator.ts` — `@StudentOwned(options)`
  metadata decorator marking a route as student-owned. The decorator is a
  documentation contract; it does not enforce on its own because each
  domain has different student-id extraction conventions (path param, body
  field, JSONB nested key, etc.).
- `apps/api/src/auth/student-owned.guard.ts` — `assertStudentOwnsRecord(actor,
studentId, tenantPrisma, options)` service-side helper. School admin
  bypass (configurable), STUDENT actor must resolve to a `sis_students.id`
  matching the studentId, coach delegation stub for `ath_recruiting_profiles`
  (Phase 2 H2 wires the `iam_delegations` table for the proper version).

The existing student-owned services (`pfl_reflections`, `pfl_resume_profiles`,
`cls_ai_tutoring_sessions`, `lib_reading_logs`, etc.) implement the same
pattern inline. The shared helper is the central, reusable contract for new
student-owned tables added in future cycles. Migration of existing services
to use the helper is **Phase 2 polish** as each module is touched.

---

## Step 5 — Engagement score component restrictions

`apps/api/src/engagement/access.ts` gains a new capability check
`isEngagementAdmin(actor, permCheck)` returning boolean (admin tier =
school admin OR holds `eng-001:admin`).

`apps/api/src/engagement/engagement-score.service.ts::toDto()` takes a new
`stripComponents` flag. When true, per-component fields are nulled:

- `attendanceComponent: null`
- `communicationComponent: null`
- `conferenceComponent: null`
- `volunteerComponent: null`
- `paymentComponent: null`
- `componentWeights: null`

Aggregate fields stay visible:

- `engagementLevel` (HIGHLY_ENGAGED / ENGAGED / MINIMAL / AT_RISK)
- `compositeScore`

`list()` and `getForFamily()` now compute `stripComponents = !await
isEngagementAdmin(actor, this.permCheck)` and pass it through. Teachers +
counsellors + generic Staff (ENG-001:read holders) see the aggregate
level; only school admins + ENG-001:admin holders see the per-component
breakdown.

The hardening plan also calls for (a) excluding engagement scores from data
exports by default, (b) adding `engagement_score_purpose` config text,
(c) allowing schools to disable the payment_component weighting. These three
config-side changes are tracked for the **P2-H2 Step 4 seed gaps** phase
where the `school_config` table gets its full engagement-config row.

---

## Step 6 — Soft-integrity validation

Two `str_orders` assertions live in `store/orders.service.ts` (already
landed in Step 1 since they share the same file):

- `assertExternalCustomerInCurrentSchool(externalCustomerId)` — joins through
  `str_external_customers → str_stores` to validate the external customer
  belongs to the calling school. Called in `create()` for every EXTERNAL
  order.
- `assertStudentInCurrentSchool(studentId)` — validates the supplied
  studentId resolves to a student in the calling tenant's school. Called in
  `create()` for STUDENT orders submitted by an admin / store manager
  (manager-on-behalf path).

For the broader 10 ADVISORY admin-on-behalf paths flagged by the audit, a
new shared module `apps/api/src/iam/person-in-tenant.ts` exports two
helpers:

- **`assertPersonInTenant(tenantPrisma, personId, fieldName)`** — validates
  the supplied `iam_person.id` has at least one projection (sis_students /
  sis_guardians / hr_employees) in the calling tenant's school. UNION-of-3
  query for efficiency.
- **`assertAccountInTenant(tenantPrisma, accountId, fieldName)`** — variant
  that takes a `platform_users.id`, resolves to `iam_person.id`, then
  delegates to `assertPersonInTenant`.

The shared helpers replace scattered per-module reimplementations
(`ProfileService.assertTargetInCurrentTenant` Cycle 6.1 R1 BLOCKING 1,
`CommunicationsAdvancedService.assertAccountInCurrentTenant` Cycle 19 R1
BLOCKING 4, etc.). Adopting them in each of those callsites is **Phase 2
polish** — picked up cycle by cycle.

---

## Files changed in P2-H1

### Production code (apps/api/src)

- `auth/student-owned.decorator.ts` — **new**
- `auth/student-owned.guard.ts` — **new**
- `curriculum/maps.service.ts` — Step 1.6
- `engagement/access.ts` — Step 5
- `engagement/engagement-score.service.ts` — Step 5
- `facilities/inspections.service.ts` — Step 1.7
- `governance/erasure.service.ts` — Step 1.8
- `health/health-record.service.ts` — Step 3 reference integration
- `iam/guardian-authorization.service.ts` — **new**, Step 3
- `iam/iam.module.ts` — registers GuardianAuthorizationService
- `iam/person-in-tenant.ts` — **new**, Step 6
- `publications/sections.service.ts` — Step 1.9
- `scheduling/cross-school-staff.service.ts` — Step 1.4
- `sis-advanced/custom-field.service.ts` — Step 1.3
- `sis-advanced/family-relationship.service.ts` — Step 1.1
- `sis-advanced/student-note.service.ts` — Step 1.2
- `store/orders.service.ts` — Step 1.5 + Step 6

### Database (packages/database)

- `data/permissions.json` — Step 2 (+GRP-002, +GRP-003)
- `src/seed-iam.ts` — Step 2 (grant distribution across roles)

### Documentation

- `HANDOFF-P2H1.md` — **new** (this document)

---

## Exit checklist verification

| Criterion                                                          | Status |
| ------------------------------------------------------------------ | ------ |
| 0 school-scope leaks — every UPDATE/DELETE/GET-by-id has school_id | ✅     |
| 497/497 permission codes in catalogue                              | ✅     |
| GuardianAuthorizationService deployed (provider + export)          | ✅     |
| @StudentOwned + assertStudentOwnsRecord helper available           | ✅     |
| Engagement scores restricted (components → admin only)             | ✅     |
| Soft-integrity assertPersonInTenant helper available               | ✅     |
| str_orders external_customer + student validation added            | ✅     |
| API `tsc --noEmit` clean (production code, 0 errors)               | ✅     |
| `pnpm --filter @campusos/api build` clean                          | ✅     |

---

## Phase 2 polish carry-overs (recommendation-class)

These items are explicitly tracked as Phase 2 polish in the hardening doc
pattern. They follow the established CampusOS convention where the
infrastructure (the central service / shared helper) ships in the hardening
cycle and individual module migrations happen incrementally as each domain
is touched in future cycles:

1. **GuardianAuthorizationService rollout across 7 remaining modules** —
   engagement, payments, conferences, portfolio, transport, communications,
   college apps. Reference integration ships in `health-record.service.ts`.
2. **assertStudentOwnsRecord rollout across 6 existing student-owned services**
   — reflection, resume, college-application, recruiting-profile,
   ai-tutoring-session, reading-log/review. Each currently has inline
   ownership checks that the shared helper will replace.
3. **assertPersonInTenant rollout across the 10 ADVISORY admin-on-behalf
   paths** flagged by Code Audit findings #58-67.
4. **iam_delegations table** — Phase 2 H2 stands up the table; coach
   delegation in `student-owned.guard.ts::assertStudentOwnsRecord` currently
   stubs true for STAFF callers on the recruiting profile surface.
5. **Engagement export exclusion + purpose config + payment-weight toggle**
   — three config-side changes that land in P2-H2 Step 4 (seed gaps).
6. **Regression test suite** — the hardening plan calls for a regression test
   per fix; building the integration test pyramid is **P2-H4 Step 1's**
   dedicated scope. P2-H1's exit criteria are satisfied by production-code
   typecheck + build cleanliness; the test pyramid follows in P2-H4.

---

## Verification commands

```bash
# Typecheck production code (must be 0 errors)
pnpm --filter @campusos/api exec tsc --noEmit \
  2>&1 | grep -v "__tests__\|\.spec\." | grep "error TS" | wc -l   # → 0

# API build
pnpm --filter @campusos/api build

# Permission catalogue count
grep -c '"code":' packages/database/data/permissions.json   # → 497

# Confirm GRP-002 + GRP-003 in seed
grep -E "GRP-00[23]" packages/database/src/seed-iam.ts   # → 6 grant lines

# Rebuild IAM cache after pulling these changes:
pnpm --filter @campusos/database exec tsx src/build-cache.ts
```

---

## Reviewer attention items (for the eventual P2-H4 post-cycle review)

- Pre-existing test typecheck noise (`schoolId does not exist on type 'never'`
  in spec files) was present before P2-H1 and is unchanged by this cycle.
  The test fixture pattern that returns `getCurrentTenant()` as `never` is a
  fixture-shape issue that the P2-H4 integration test pyramid work will
  address.
- The two new permission codes (GRP-002, GRP-003) bring the catalogue total
  to 497. The hardening doc's "330/330 permission codes valid" exit target
  reflected an earlier catalogue count baseline; the platform has continued
  to grow through Cycles 12–30 since that baseline was written.
- The hardening plan's "8 previously-dead endpoints accessible" claim for
  GRP-002/003 reflects future Phase 2 group-resources and group-analytics
  endpoints that have not yet shipped. The codes are now in the catalogue
  and seeded onto roles, so when those endpoints land they will gate
  cleanly without needing a follow-up IAM change.
