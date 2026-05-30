# Persona Registration Code Review

Review date: 2026-05-23

Design doc: `docs/campusos-persona-registration-design.html`

## Verdict

Overall result: **FAIL**

This implementation is close structurally, but it is not passable as a foundational auth/persona feature yet. The largest blockers are:

- **Cross-persona permission isolation is not enforced.** `/auth/me` and `/auth/switch-persona` read `iam_effective_access_cache` by account + scope only, so a user with STAFF and PARENT personas at the same school can see STAFF permissions while active as PARENT.
- **`platform_users.managed_by_person_id` is not a database FK.** The migration and Prisma schema add the column and index only.
- **DELETE child behavior violates the requested lifecycle.** `PENDING_LINK` children can be deleted; the request required DELETE only for `PLACEHOLDER`.
- **The requested `personType` grep is not clean.** Auth response data no longer exposes `personType`, but the auth module and `auth-store` still contain `personType` string hits in comments, and the broader web grep still finds legacy profile/emergency-domain usages.

## Summary Table

| Step              | Component                                  | Result  |
| ----------------- | ------------------------------------------ | ------- |
| 1                 | Schema verification                        | DEFECT  |
| 2                 | Persona resolution service                 | SOUND   |
| 3                 | `/auth/me` response                        | DEFECT  |
| 4                 | Switch persona                             | CONCERN |
| 5                 | Family children CRUD                       | DEFECT  |
| 6                 | Child linking                              | SOUND   |
| 7                 | Invitation system                          | CONCERN |
| 8-9               | UI persona switcher + app filter           | SOUND   |
| 10                | Registration page + endpoint               | SOUND   |
| 11                | Getting Started page                       | SOUND   |
| 12                | Family management pages                    | CONCERN |
| 13                | Invitation acceptance page                 | SOUND   |
| 14                | Auto-alumni worker                         | SOUND   |
| 15                | `personType` removal                       | CONCERN |
| Integration tests | DB-backed persona tests + suite            | SOUND   |
| Security checks   | Rate/code/cross-family/minor/cross-persona | DEFECT  |

## Step Findings

### Step 1 — Schema Verification: DEFECT

`platform_family_children`, `platform_personas`, and `platform_invitations` exist in `packages/database/prisma/platform/schema.prisma` and in migration `20260523040935_persona_registration_schema/migration.sql`.

Sound:

- `platform_family_children.status` has `CHECK (status IN ('PLACEHOLDER', 'PENDING_LINK', 'LINKED'))`.
- `platform_family_children.person_id` is nullable.
- Partial unique index exists on `(family_id, person_id) WHERE person_id IS NOT NULL`.
- `invite_code`, `invite_email`, `invite_sent_at`, and `linked_at` exist.
- `platform_personas.type` has the requested persona type check; `school_id` is nullable.
- `platform_personas` has the requested COALESCE unique index.
- `platform_invitations` has requested type/status checks, unique token, and non-null `expires_at`.
- `platform_users.is_minor_account BOOLEAN DEFAULT false` exists.

Defect:

- `platform_users.managed_by_person_id` is only a UUID column plus index. There is no FK constraint to `platform.iam_person(id)` in the migration, and no Prisma relation in `PlatformUser`.

### Step 2 — Persona Resolution Service: SOUND

`apps/api/src/modules/m00-platform/iam/persona-resolution.service.ts` queries the expected projection sources:

- `platform_family_children` via `LINKED` children for PARENT.
- tenant `hr_employees` for active STAFF.
- tenant `sis_students` joined to `platform_students` for STUDENT.
- `platform_substitute_profiles` via Prisma for SUBSTITUTE.
- tenant `alm_alumni_profiles` for ALUMNI.
- tenant `grp_members` for COMMUNITY.

`refreshPersonaCache` deletes stale rows and upserts into `platform_personas`; `getActivePersonas` reads the cache.

No direct school leakage was found in these queries. Tenant-table scans are run through `TenantPrismaService.executeInExplicitSchema`, and school personas are derived from tenant rows.

### Step 3 — `/auth/me` Response: DEFECT

Sound:

- Response shape is `{ user, activePersona, personas, permissions }`.
- `personType` is absent from the returned response object.
- `X-Active-Persona` is supported and non-owned IDs return 404.
- Zero personas produce `activePersona: null` and `permissions: []`.
- Platform-scope permissions are included when the active school scope chain includes PLATFORM.

Defect:

- Permissions are filtered by account + scope only, not by persona. In `AuthService.getMe`, the active persona contributes only `schoolId` or platform scope; then `iamEffectiveAccessCache.findMany` reads all permission codes for the account in those scopes. That means a STAFF+PARENT user at the same school can activate PARENT and still receive STAFF permissions.
- There is no explicit "Platform Admin gets all permissions regardless of persona" bypass. It works only when the platform-scope cache is included by the selected scope path.

### Step 4 — Switch Persona: CONCERN

Sound:

- `POST /auth/switch-persona` accepts `{ personaId }`.
- The service validates ownership and `isActive`.
- Non-owned, inactive, and unknown persona IDs return 404.
- The endpoint returns the full `/auth/me` response shape.

Concern:

- The switched response inherits Step 3's permission isolation defect. Switching personas updates `activePersona`, but it does not reliably narrow permissions to that persona's role.

### Step 5 — Family Children CRUD: DEFECT

Sound:

- `GET /family/children` resolves the caller's family and returns only those children.
- `POST /family/children` creates `PLACEHOLDER` rows with `person_id = NULL`.
- `PATCH` rejects `LINKED` rows and allows `PLACEHOLDER`/`PENDING_LINK`.
- Cross-family read/update/delete attempts collapse to 404.

Defect:

- `DELETE` allows `PENDING_LINK` children and revokes the invitation. The requirement was DELETE only on `PLACEHOLDER`, not `LINKED` and not `PENDING_LINK`.

### Step 6 — Child Linking: SOUND

Sound:

- `create-account` creates `iam_person` + `platform_users` with `is_minor_account = true` and `managed_by_person_id`, then marks the child `LINKED`.
- `create-account` only works from `PLACEHOLDER`.
- `send-link` uses `crypto.randomInt` to generate each character of the 8-char code; no modulo bias was found.
- `send-link` creates a `platform_invitations` row with 72h TTL and marks the child `PENDING_LINK`.
- `send-link` only works from `PLACEHOLDER`.
- `POST /family/link` validates token, pending status, and expiry; uses Redis counter rate limiting at 5 attempts / 15 minutes; links the child and marks invitation `ACCEPTED`.
- Inviter persona cache refresh is called after linking.

### Step 7 — Invitation System: CONCERN

Sound:

- `GET /invitations/:token` is `@Public()`.
- It omits inviter email and phone.
- Accept dispatch exists for `EMPLOYEE`, `CHILD_LINK`, `PARENT_LINK`, and `SUBSTITUTE`.
- Accepted/expired invitations are rejected with 400 from the accept path.
- Decline sets status to `EXPIRED`.
- Persona cache refresh is called for accepted invite flows.

Concerns:

- The public GET response exposes `inviterName`. The request specifically called out email/phone PII, which are not exposed, but this is still personally identifying.
- `InvitationController` declares `@Get(':token')` before `@Get('mine')`; depending on Nest/Express registration order, `/invitations/mine` may be shadowed by the public token route.

### Step 8-9 — UI Persona Switcher + App Filter: SOUND

Sound:

- `PersonaSwitcher` renders in `TopBar`.
- It renders nothing for 0 personas.
- It renders a disabled pill for a single persona.
- Multiple personas are grouped by type and active persona has a checkmark.
- Switching calls `POST /auth/switch-persona`, updates Zustand, stores active persona ID, and invalidates React Query caches.
- App catalog supports `personas?: PersonaType[]`.
- `getAppsForUser` returns no apps without active persona and filters persona-restricted apps by `activePersona.type`.

### Step 10 — Registration Page: SOUND

Sound:

- `/register` is outside the authenticated `(app)` shell.
- Form includes first name, last name, email, password, and confirm password.
- It calls `POST /auth/register`.
- Success sets the access token, fetches `/auth/me`, stores auth state, and redirects to `/getting-started` unless a same-origin return URL exists.
- 409 email conflict is handled inline.
- Login link is present.
- API endpoint is `@Public()`, creates `iam_person`, `platform_users`, `platform_families`, and `platform_family_members`, and returns access token while setting refresh token cookie.

Note: the API currently accepts but ignores `password`, consistent with the local ADR-036/Keycloak comments in the code.

### Step 11 — Getting Started Page: SOUND

Sound:

- App shell redirects 0-persona users to `/getting-started`.
- App shell redirects users with one or more personas away to `/dashboard`.
- Page has four action cards: children, invitation, substitute, find schools.
- Invitation code input validates by public GET and redirects to `/invitations/accept?token=...`.

### Step 12 — Family Management Pages: CONCERN

Sound:

- `/family` lists children, status badges, and action buttons.
- `/family/add-child` implements a three-option wizard.
- Link invitation modal calls `send-link`.
- `/settings/family` has an accept-link-code input.
- Badge colors match requested mapping: placeholder amber/yellow, pending blue, linked green.

Concerns:

- The `/family` page shows a "Resend" action for `PENDING_LINK`, but it calls `send-link`; the API only permits `send-link` for `PLACEHOLDER`, so this action will fail.
- The UI exposes "Cancel Link" by deleting a `PENDING_LINK` child, matching current API behavior but conflicting with Step 5's DELETE-only-PLACEHOLDER requirement.

### Step 13 — Invitation Acceptance Page: SOUND

Sound:

- Reads `?token` from URL.
- Fetches public `GET /invitations/:token`.
- Displays type-specific invitation details.
- Unauthenticated users get "Sign in" and "Create an account".
- Authenticated users get Accept and Decline buttons.
- Accept posts to `/invitations/:token/accept`, refreshes user state, and redirects to `/dashboard`.

### Step 14 — Auto-Alumni Worker: SOUND

Sound:

- `StudentService.update` triggers alumni activation only when `enrollmentStatus === 'GRADUATED'`.
- It upserts `alm_alumni_profiles` via `ON CONFLICT (school_id, person_id) DO NOTHING`.
- It refreshes persona cache when `PersonaResolutionService` is available.
- Non-graduation status changes do not trigger the hook.
- `PersonaResolutionService` is injected as `@Optional()`.

### Step 15 — `personType` Removal: CONCERN

Auth response data no longer includes `personType`.

However, the requested grep is not clean:

- `apps/api/src/modules/m00-platform/auth/auth.controller.ts` and `auth.service.ts` still contain `personType` in comments.
- `apps/web/src/lib/auth-store.ts` still contains `personType` in comments.
- `apps/web/src` still has legitimate legacy profile/emergency-domain `personType` fields, plus `portfolio/readiness` uses a local variable named `personType` for `activePersona.type`.

No `personType` field was found in auth response types or store shape.

## Integration Tests

Persona-related test files found:

- `apps/api/test/integration/m00-platform/persona-resolution.spec.ts`
- `apps/api/test/integration/m00-platform/family-children.spec.ts`
- `apps/api/test/integration/m00-platform/child-linking.spec.ts`
- `apps/api/test/integration/m00-platform/invitations.spec.ts`
- `apps/api/test/integration/m00-platform/auth-me-personas.spec.ts`
- `apps/api/test/integration/m00-platform/switch-persona.spec.ts`
- `apps/api/test/integration/m102-alumni/auto-alumni.spec.ts`
- `apps/api/test/integration/m20-sis/family-relationships.spec.ts`
- `apps/api/test/integration/fixtures/alumni.ts`

These tests are DB-backed: they instantiate real `PrismaClient` / `TenantPrismaService` and use raw SQL setup/assertions. I did not find mock-based implementations in the persona-related specs.

Suite command:

```bash
pnpm --filter @campusos/api test:integration
```

Result: **PASS** — 285 test files passed; 7,611 tests passed and 2 skipped, 7,613 total. Duration: 2055.28s.

## Security Checks

| Check                                         | Result  | Notes                                                                                         |
| --------------------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| Link codes use `crypto.randomInt`, not modulo | SOUND   | `generateLinkCode()` indexes the alphabet via `randomInt(0, alphabet.length)`.                |
| Rate limiting on `POST /family/link`          | SOUND   | Redis `incrementCounter`, 5 attempts / 15 minutes.                                            |
| Invitation tokens do not leak email/phone     | SOUND   | Public GET omits email/phone, but does expose inviter display name.                           |
| Cross-family isolation                        | SOUND   | Service resolves caller family and returns 404 on mismatch.                                   |
| Cross-persona isolation                       | DEFECT  | Permissions are account+scope-based; persona type is not part of the permission cache lookup. |
| Minor account management                      | CONCERN | `is_minor_account` is set correctly, but `managed_by_person_id` has no DB FK.                 |

## Required Fixes Before PASS

1. Add a real FK for `platform_users.managed_by_person_id -> platform.iam_person(id)` and mirror it in Prisma relations.
2. Make permission resolution persona-aware. At minimum, `/auth/me` and `/auth/switch-persona` must not return STAFF permissions while the active persona is PARENT at the same school.
3. Enforce DELETE only on `PLACEHOLDER` family children, or revise the design explicitly and update the test contract.
4. Fix the `PENDING_LINK` resend/cancel UI semantics so the API and UI lifecycle agree.
5. Clean the requested `personType` greps in auth module comments and `auth-store`, or adjust the verification command to ignore comments/legacy non-auth domains.
6. Verify whether `/invitations/mine` is shadowed by `/:token`; if so, move `mine` before `:token`.
