# HANDOFF — Persona, Registration & Child Management (Steps 1-5)

Foundation work for the persona-registration feature stream. Implements the
schema, persona resolver, persona-aware `/auth/me`, persona switcher
endpoint, and removes `personType` from the wire format. Drives off the
design doc `docs/campusos-persona-registration-design.html` (Steps 1-4 from
the implementation table; Step 5 is the cross-cutting `personType` cleanup).

UI work (Steps 8-13: persona switcher, registration page, getting-started,
family management pages, invitation acceptance) is NOT in scope here — this
ships only the API and data-layer pieces every subsequent UI piece depends
on.

## Ship summary

| Step | Component                                                                                                                                  | Tests added |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| 1    | Schema — `platform_family_children`, `platform_personas`, `platform_invitations`, `platform_users.{is_minor_account,managed_by_person_id}` | —           |
| 2    | `PersonaResolutionService` (m00-platform/iam)                                                                                              | 12          |
| 3    | `/auth/me` returns `{ user, activePersona, personas, permissions }` (personType REMOVED)                                                   | 7           |
| 4    | `POST /auth/switch-persona`                                                                                                                | 6           |
| 5    | Wire-format `personType` removal (web auth-store, all frontend reads, getAppsForUser)                                                      | —           |

All 517 m00-platform integration tests passing. No regressions in the
auth-controller / auth-service spec suites (37 tests, including the
updated `/auth/me` shape assertions).

## 1. Schema (platform migration `20260523040935_persona_registration_schema`)

### `platform_family_children`

Parent's view of their children **before** any school relationship.
Three-state lifecycle:

| status         | person_id | Meaning                                                       |
| -------------- | --------- | ------------------------------------------------------------- |
| `PLACEHOLDER`  | NULL      | Parent added basic info; no canonical iam_person yet          |
| `PENDING_LINK` | NULL      | Invite code generated; awaiting acceptance                    |
| `LINKED`       | Set       | Canonical iam_person linked; child can be enrolled / messaged |

Partial `UNIQUE (family_id, person_id) WHERE person_id IS NOT NULL` so
multiple PLACEHOLDER siblings can coexist. Indexes: `(family_id, status)`,
`(person_id)`, `(invite_code)`.

### `platform_personas`

Cached persona set per person. Derived from projection tables by
`PersonaResolutionService` and refreshed on persona-changing actions and
on login.

```
person_id  type     school_id  label                          is_active
─────────  ───────  ─────────  ─────────────────────────────  ─────────
<uuid-A>   STAFF    <Lincoln>  Staff at Lincoln Elementary    true
<uuid-A>   PARENT   <Lincoln>  Parent at Lincoln Elementary   true
<uuid-A>   ALUMNI   <Wash HS>  Alumni — Washington High 2005  true
```

UNIQUE constraint is `(person_id, type, COALESCE(school_id, '00...0'::uuid))`
so platform-wide personas (null school_id) still dedupe. The COALESCE
sentinel means Prisma can't express the constraint — it's declared in raw
SQL in the migration.

### `platform_invitations`

Generic invitation envelope. The token is the shareable secret:

- `CHILD_LINK` → 8-char alphanumeric (parent-friendly)
- `EMPLOYEE` / `SUBSTITUTE` / `PARENT_LINK` → UUID v7

`metadata` JSONB carries type-specific payload (position_id,
family_child_id, student_person_id, etc.).

### `platform_users` modifications

```sql
ALTER TABLE platform.platform_users
  ADD COLUMN is_minor_account BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN managed_by_person_id UUID;
```

For under-13 accounts (COPPA / FERPA): the parent creates the child's
account; `managed_by_person_id` points at the parent's iam_person until
the child ages up.

## 2. `PersonaResolutionService`

`apps/api/src/modules/m00-platform/iam/persona-resolution.service.ts`

Three methods:

```typescript
resolveForPerson(personId); // SLOW — reads every projection table; cross-tenant
refreshPersonaCache(personId); // resolve + UPSERT platform_personas + delete stale
getActivePersonas(personId); // FAST — reads platform_personas cache
```

Persona derivation rules:

| Persona      | Source                                                               | Scope                                           |
| ------------ | -------------------------------------------------------------------- | ----------------------------------------------- |
| `SUBSTITUTE` | `platform_substitute_profiles` (active)                              | platform-wide                                   |
| `PARENT`     | LINKED `platform_family_children` rows + family member is the parent | per-school or platform-wide if no enrolment yet |
| `STAFF`      | `hr_employees` ACTIVE / ON_LEAVE                                     | per-school                                      |
| `STUDENT`    | `sis_students` ENROLLED via `platform_students`                      | per-school                                      |
| `ALUMNI`     | `alm_alumni_profiles`                                                | per-school                                      |
| `COMMUNITY`  | `grp_members` ACTIVE                                                 | per-school                                      |

Cross-tenant fanout uses `TenantPrismaService.executeInExplicitSchema` to
iterate every `platform_tenant_routing` row. Acceptable because
`resolveForPerson` runs only on login + persona-changing actions; the
request hot path reads from `platform_personas` via `getActivePersonas`.

`refreshPersonaCache` is idempotent. Stale rows (cached personas no
longer backed by a projection) are deleted; existing rows are upserted
via the COALESCE-aware UNIQUE constraint.

12 integration tests at
`test/integration/m00-platform/persona-resolution.spec.ts` cover:

- No projections → empty personas
- LINKED child but no school enrolment → PARENT with null schoolId
- PLACEHOLDER child does NOT activate PARENT
- ACTIVE hr_employees → STAFF persona at that school
- TERMINATED hr_employees → no STAFF persona
- STAFF + PARENT coexistence
- UPSERT into platform_personas
- Stale persona deletion when projection disappears
- Idempotency
- Cache appears after adding hr_employees + refresh
- getActivePersonas returns cached rows verbatim
- getActivePersonas returns empty for uncached person

## 3. `/auth/me` shape change

Old response (REMOVED):

```json
{
  "id": "...",
  "personId": "...",
  "personType": "STAFF",
  "permissions": [...],
  ...
}
```

New response:

```json
{
  "user": {
    "id": "...",
    "personId": "...",
    "email": "teacher@demo.campusos.dev",
    "firstName": "James",
    "lastName": "Rivera",
    "preferredName": null,
    "displayName": "James Rivera"
  },
  "activePersona": {
    "id": "<persona-uuid>",
    "type": "STAFF",
    "label": "Staff at Lincoln Elementary",
    "schoolId": "<school-uuid>",
    "schoolName": "Lincoln Elementary"
  },
  "personas": [
    { "id": "...", "type": "STAFF",  "label": "...", "schoolId": "..." },
    { "id": "...", "type": "PARENT", "label": "...", "schoolId": "..." }
  ],
  "permissions": ["att-001:read", "tch-003:write", ...]
}
```

**Active persona selection:**

1. `X-Active-Persona` request header (persona id) — must belong to caller
   AND `is_active=true`, otherwise 404.
2. Otherwise the first persona from `getActivePersonas` (sorted by `type`
   then `label`).
3. Otherwise `activePersona: null` and `permissions: []` (the
   "Getting Started" state).

**Permission filtering:** the response surfaces only permissions held
within the active persona's scope chain (SCHOOL → PLATFORM) — Platform
Admins still get every code because the PLATFORM-scope cache row carries
them all.

`personType` is intentionally absent. Removing it is a breaking change;
callers must read `activePersona.type` from the new shape.

7 integration tests at
`test/integration/m00-platform/auth-me-personas.spec.ts`.

## 4. `POST /auth/switch-persona`

```
POST /api/v1/auth/switch-persona
Body: { "personaId": "<persona-uuid>" }
Response: same shape as /auth/me with new activePersona + permissions
```

Validation:

- Missing `personaId` → 400.
- Persona not found, owned by another user, or `is_active=false` → 404.

6 integration tests at
`test/integration/m00-platform/switch-persona.spec.ts`.

## 5. `personType` removal (wire-format)

Scope agreed: API responses + web auth-store + frontend reads +
getAppsForUser. The internal `ResolvedActor.personType` field (and the
~405 service-layer comparisons that consume it) stay — they read the
canonical `iam_person.person_type` column and are unrelated to the wire
format.

### Web changes

- `apps/web/src/lib/auth-store.ts` — `AuthUser` loses `personType`, gains
  `activePersona: ActivePersona | null` and `personas: UserPersona[]`.
  New `PersonaType` union (`PARENT | STUDENT | STAFF | SUBSTITUTE |
ALUMNI | COMMUNITY`).
- `apps/web/src/lib/auth-context.tsx` — `meToAuthUser(MeResponse)`
  flattens the new shape into AuthUser.
- 77 web files mechanically rewritten:
  - `user.personType` / `user?.personType` → `user.activePersona?.type` /
    `user?.activePersona?.type`
  - `=== 'GUARDIAN'` / `!== 'GUARDIAN'` → `=== 'PARENT'` / `!== 'PARENT'`
    where it compares to the new persona type.
- `apps/web/src/components/shell/apps.tsx` — `getAppsForUser` reads
  persona vocabulary. `isGuardian` is now `activePersona?.type === 'PARENT'`.
- `apps/web/src/components/shell/Sidebar.tsx` — `personaLabel` switch
  cases use `PARENT / ALUMNI / COMMUNITY`. Removed obsolete `VOLUNTEER`
  branch (no persona equivalent).

Unrelated `personType` fields (NOT touched):

- `ProfileDto.personType` (profile read endpoint, returns
  iam_person.person_type as data)
- `AccountabilityRecordDto.personType` (m87 safety / accountability)
- `LegacyHouseholdRole = 'PARENT' | 'GUARDIAN' | 'STUDENT'`
- `profile-format.ts profileTabs(personType)` helper (consumes ProfileDto)

## File map

```
packages/database/prisma/platform/
  schema.prisma                                     [edit: PlatformUser + 3 new models]
  migrations/20260523040935_persona_registration_schema/migration.sql  [new]

apps/api/src/modules/m00-platform/
  iam/persona-resolution.service.ts                 [new]
  iam/iam.module.ts                                 [edit: register + export PersonaResolutionService]
  index.ts                                          [edit: re-export PersonaResolutionService + Persona type]
  auth/auth.module.ts                               [edit: import IamModule]
  auth/auth.service.ts                              [edit: getMe / switchPersona / MeResponse]
  auth/auth.controller.ts                           [edit: me delegates to AuthService, new switchPersona endpoint]

apps/api/test/integration/m00-platform/
  persona-resolution.spec.ts                        [new — 12 tests]
  auth-me-personas.spec.ts                          [new — 7 tests]
  switch-persona.spec.ts                            [new — 6 tests]
  auth-controller.spec.ts                           [edit: update me-shape assertions, fix construction]
  auth-service.spec.ts                              [edit: fix AuthService construction]

apps/web/src/
  lib/auth-store.ts                                 [rewrite: PersonaType / AuthUser shape]
  lib/auth-context.tsx                              [edit: meToAuthUser]
  components/shell/Sidebar.tsx                      [edit: personaLabel switch]
  components/shell/apps.tsx                         [edit: persona-vocab comparisons]
  ...77 other files                                  [mechanical: user.personType → user.activePersona?.type, GUARDIAN→PARENT]
```

## Verification

```
pnpm --filter @campusos/api build                 # 0 errors
pnpm --filter @campusos/api exec tsc --noEmit     # 0 errors
pnpm --filter @campusos/web exec tsc --noEmit     # 0 errors
pnpm --filter @campusos/api exec vitest run test/integration/m00-platform/ \
    --config vitest.integration.config.ts          # 517 passing
```

`grep -rn "user\.personType\|user?\.personType" apps/web/src/` → 0 hits
(non-`.next`).

## Not done in this handoff (next steps from the design doc)

- Steps 5-7: Family children CRUD endpoints, child account creation +
  linking flow, invitation system.
- Steps 8-13: persona switcher UI, app catalogue persona filter,
  registration page, getting-started page, family management pages,
  invitation acceptance.
- Step 14: auto-alumni worker (graduation → ALUMNI persona).
- Refresh hook: PersonaResolutionService.refreshPersonaCache is not yet
  wired to the projection-write Kafka events that should trigger it
  (hr.employee.hired, sis.student.enrolled, etc.). Callers refresh
  manually for now.

## Manual-QA follow-up — 2026-05-23 (post-Step-14)

Three bugs surfaced during manual QA of the persona launchpad. Fixes:

1. **Empty launchpad for non-admin personas.** `/auth/me` returned
   `permissions: []` for teacher / parent / student / VP / counsellor.
   FIX 2 in commit `620a5d9` filters role assignments by `source` per
   active persona (STAFF ← HR_SYNC / WORKFLOW_APPROVAL / EMERGENCY,
   PARENT ← GUARDIAN_RELATIONSHIP, STUDENT ← SIS_DERIVED), but
   `seed-iam.ts` wrote every assignment as `source: MANUAL`. Net
   effect: only Platform Admin (which holds `sys-001:admin` and hits
   the bypass) and School Admin (which holds `sys-001:admin` via
   `everyFunction`) saw any tiles; everyone else got an empty grid
   except for the persona-branched Classes / My Classes / My Children
   tile (which has no permission gate).

   `seed-iam.ts` now writes the production-true source per role:

   | Role             | Source                  |
   |------------------|-------------------------|
   | Platform Admin   | MANUAL (bypass key)     |
   | School Admin     | HR_SYNC                 |
   | Teacher          | HR_SYNC                 |
   | Vice Principal   | HR_SYNC                 |
   | Counsellor       | HR_SYNC                 |
   | Staff            | HR_SYNC                 |
   | Parent           | GUARDIAN_RELATIONSHIP   |
   | Student          | SIS_DERIVED             |

   Platform Admin stays MANUAL — the `/auth/me` bypass keys on the
   presence of `sys-001:admin` in the cache (independent of source),
   and MANUAL accurately reflects how a sysadmin is provisioned in
   real deployments. Requires `pnpm db:reset` to take effect.

2. **Getting Started cards looked clickable but weren't.** Only the
   small "Add a child →" text inside each card was a `<Link>`; the
   surrounding card surface (border, icon, title) was an inert
   `<div>`. Refactored `LinkCard` in
   `apps/web/src/app/(app)/getting-started/page.tsx` to render the
   whole shell as a single Next.js `<Link>`, so the entire card is
   the click target. `InvitationCard` stays a non-Link `Card` because
   it expands inline into a code-entry form rather than navigating.

3. **Apps catalogue persona tagging.** Added `personas: ['STAFF']` to
   staff-only tiles (tasks, approvals, staff, leave, schedule,
   compliance, development, expenses, finance, procurement, analytics,
   governance, accreditation, visitors, emergency, admissions) so they
   stay hidden if a future persona model grants the underlying
   permission code to a non-staff role. The existing wellbeing
   (STUDENT), apply (PARENT), and substitutes (STAFF/SUBSTITUTE) tags
   are unchanged. The Classes / My Classes / My Children tile keeps
   its persona-branched copy without a `personas:` allowlist (the
   branch itself enforces the persona affinity).

Verification:

```
pnpm --filter @campusos/web build                                     # ✓
pnpm --filter @campusos/database exec tsc --noEmit                    # ✓
pnpm db:reset                                                         # ✓ 51s
pnpm --filter @campusos/api exec vitest run \
  test/integration/m00-platform/auth-me-personas.spec.ts \
  --config vitest.integration.config.ts                               # 9/9 pass
```

## Manual-QA follow-up — 2026-05-30 (linked-child gender sync)

**Bug: parent's family view and the child's own profile disagreed on
gender.** A parent editing a LINKED child via PATCH
`/family/children/:id` wrote `gender` to `platform_family_children`
(the family-view mirror) but not to `iam_person`. The child's own
`/profile` page reads `iam_person.gender`, so the parent saw e.g.
"Female" while the child saw "Not Specified".

Root cause was a stale assumption in
`FamilyChildrenService.update` (`m00-platform/households/family-children.service.ts`):
a comment claimed "there's no `iam_person.gender` column" and the
`personPatch` object (the LINKED-child iam_person write) omitted
`gender`. In fact `iam_person.gender` was added by migration
`20260525200000_iam_person_gender` and is the canonical value
`/profile/me` reads.

Fix:

1. `personPatch` now includes `gender` for LINKED children, so the
   PATCH writes gender to **both** `platform_family_children` (mirror,
   unchanged) and `iam_person` (canonical) inside the existing
   transaction. Stale comment corrected.
2. One-time backfill migration
   `20260530000000_sync_linked_child_gender_to_iam_person` copies the
   family-mirror gender into `iam_person` for any LINKED child whose
   `iam_person.gender` is NULL or stale. Idempotent — the family
   mirror wins because it holds the parent's most-recent entry.
3. The existing "patch MANAGED LINKED child" integration spec now
   asserts gender lands on `iam_person` as well as the DTO.

**Folded-in test fix (unrelated stale test).** The
`family-children.spec.ts` "medical / emergency / dietary upsert
round-trip" test was failing on `main` independently of the gender
work. It set a per-child `doctorName` and expected to read it back, but
never set `medicalSource: 'CUSTOM'`. The FAMILY/CUSTOM medical
inheritance toggle (commit `ad90251`, shipped 41 min after the test in
`a2707d6`) made `getChildMedical` shadow the per-child doctor/insurance
columns with the family-level values whenever `medicalSource = 'FAMILY'`
(the default). The web client always flips to CUSTOM before sending any
doctor override (`saveDoctor`/`flipSource` in the child page), so
production is correct — the test simply never modelled the override
flow. Fixed by adding `medicalSource: 'CUSTOM'` to the test payload.

Verification:

```
pnpm --filter @campusos/api exec tsc --noEmit                         # ✓ 0 errors
pnpm --filter @campusos/database migrate:deploy                       # ✓ backfill applied
pnpm --filter @campusos/api exec vitest run \
  test/integration/m00-platform/family-children.spec.ts \
  --config vitest.integration.config.ts                               # 54/54 pass
```

## Family Structure & Person Relationships — 2026-05-30

Implements `docs/campusos-family-structure-design.html` (Steps 1-8).
A new relationship graph **distinct from the household model**:
households = who lives together / manages accounts; family structure =
who is biologically or legally related. A child of divorced parents
belongs to two households but has one set of biological parents.

**Schema** — `platform_person_relationships` (platform migration
`20260530010000_family_structure_relationships` + Prisma model
`PlatformPersonRelationship`):

- `person_id` → `related_person_id` (nullable) with `relationship_type`
  (15-value TEXT+CHECK), custody fields (`is_legal_custody`,
  `custody_arrangement` 7-value CHECK, `custody_notes`,
  `is_primary_residence`), verification (`verified` / `verified_by` /
  `verified_at`), `start_date` / `end_date`, `created_by`.
- `related_person_name` captures non-CampusOS people (no placeholder
  iam_person); CHECK requires id OR name. Partial UNIQUE indexes dedup
  linked vs name-only rows. `CHECK (person_id <> related_person_id)`.
  Platform-internal FKs to `iam_person` (ADR-001 soft-FK rule is
  tenant→platform only).

**Service** — `RelationshipService` (m00-platform/iam):

- `addRelationship` writes the row + its auto-reciprocal in one tx
  (BIOLOGICAL_MOTHER/FATHER→BIOLOGICAL_CHILD, GUARDIAN→WARD,
  GRANDPARENT→GRANDCHILD, symmetric SPOUSE/DOMESTIC_PARTNER). Name-only
  rows get no reciprocal. Reciprocal-only types (`*_CHILD`, `LEGAL_WARD`,
  `GRANDCHILD`) cannot be created directly.
- `update` / `delete` touch both sides (reciprocal found by
  reversed-pair + candidate-type lookup). `relationship_type` immutable.
- `getRelationships` = direct rows + **derived siblings** (never stored):
  FULL (2 shared bio parents), HALF (1), ADOPTIVE (shared adoptive
  parent), STEP (a parent's spouse is the candidate's parent).
- `getFamilyTree` buckets into parents/children/grandparents/spouses/
  other + siblings. `isGuardianOf` reuses the household tables for auth.

**Endpoints** — `RelationshipController` under `/people/:personId`:
`GET/POST relationships`, `PATCH/DELETE relationships/:id`,
`GET family-tree`, `PATCH relationships/:id/verify` (school-admin only).
Auth is row-level (self if adult / parent-guardian / school-admin),
enforced per-handler — not a static permission code (mirrors
PeopleSearchController's auth-only pattern).

**Web** — `use-relationships` hooks; `SetRelationshipModal` (CampusOS
search or name-only, mode-scoped type radios, custody); a Family
Structure section on the child profile Account tab (LINKED only;
editable when MANAGED) and the adult profile (self variant — parent/
child read-only, spouse editable); `/family/tree` list view reached
from a "View Family Tree" action on `/family`.

**Seed** — David Chen is Maya's biological father (with reciprocal);
mother captured name-only as "Linda Chen". Idempotent (`seed.ts`).

**Tests** — `relationships.spec.ts`, 15 DB-backed tests (reciprocals,
name-only, delete/update both sides, full/half/step siblings, verify,
duplicate→409, self→400, reciprocal-only→400, family-tree bucketing,
cross-family isolation).

Verification:

```
pnpm --filter @campusos/database migrate:deploy                       # ✓
pnpm --filter @campusos/api exec tsc --noEmit                         # ✓ 0 errors
pnpm --filter @campusos/api build                                     # ✓ 0 errors
pnpm --filter @campusos/web exec tsc --noEmit                         # ✓ 0 errors
pnpm --filter @campusos/api exec vitest run \
  test/integration/m00-platform/relationships.spec.ts \
  --config vitest.integration.config.ts                               # 15/15 pass
```

Deferred (per design §12): graphical SVG tree, school-admin student
family tab, custody calendar, court-order document upload.

### Family Structure on Profiles — 2026-05-30 (edit-permission tighten)

Follow-up to the family-structure feature. No schema migration.

- **Edit is parent/guardian-only.** New `relationship.auth.ts` exports
  `canEditFamilyStructure(actor, profilePersonId, isActiveGuardianOf)`:
  true only when `actor.personType === 'GUARDIAN'` AND (caller is the
  profile owner OR an active guardian of the person). Students (even
  adult / editing self), staff, and school admins are never editors.
  Replaces the prior "parent/guardian or self-if-adult, admin on PATCH"
  rule — the adult-age path and the admin-PATCH path are gone.
- **`isActiveGuardianOf`** (RelationshipService) = the existing
  household link (`isGuardianOf`) ∪ a current parent/guardian
  relationship in the graph (`PARENT_TYPES`, end_date IS NULL). The
  household path preserves bootstrapping (recording a child's first
  relationship before any graph edge exists).
- **`canEdit` flag.** `GET /relationships` and `GET /family-tree`
  return a top-level `canEdit` (same predicate), computed by the
  controller. Rendering hint only — every mutation re-checks server-side.
- **Web.** `FamilyStructureSection` reads `canEdit` from the API instead
  of a `canManage` prop; edit affordances render only when true. New
  read-only `/family/[personId]/structure` page (shared `FamilyTreeView`,
  also used by `/family/tree`), linked from both profiles via "View
  family structure".
- **Tests.** +8 edit-permission cases in `relationships.spec.ts`
  (guardian edits child/own → ok; adult student self → 403; student
  edits other → 403; admin mutate → 403; admin verify → 200; canEdit
  true/false by role on both GETs; cross-family isolation). 23/23 pass.

Verification:

```
pnpm --filter @campusos/api build                               # ✓ 0 errors
pnpm --filter @campusos/api exec tsc --noEmit                   # ✓ 0 errors
pnpm --filter @campusos/web exec tsc --noEmit                   # ✓ 0 errors
pnpm --filter @campusos/api exec vitest run \
  test/integration/m00-platform/relationships.spec.ts \
  --config vitest.integration.config.ts                         # 23/23 pass
```
