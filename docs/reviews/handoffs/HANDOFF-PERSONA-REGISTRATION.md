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
