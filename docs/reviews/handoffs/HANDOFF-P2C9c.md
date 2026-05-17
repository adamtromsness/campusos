# HANDOFF — Phase 2 Cycle 9 sub-cycle c (P2-9c Sub Marketplace UI)

**Status:** 6 web routes shipped, CI green (api build clean + web build clean + format:check + lint:logs 697 files clean). The Sub Marketplace UI now lights up the Substitutes launchpad tile for both substitute self-service and admin coverage views.

## Plan reference

`docs/campusos-p2c9-sub-marketplace.html` — step 8 (UI). P2-9a (commit `46751c2`) shipped schema + first 3 services + 13 endpoints. P2-9b (commit `18f0686`) shipped 7 more services + 2 workers + 2 consumers + 21 more endpoints. P2-9c (this commit) closes out the user-facing surface against the existing 34-endpoint backend.

## What landed

### Web routes (6)

| Route                    | Persona                           | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/substitutes/dashboard` | Substitute (sub-001:read)         | Open job offers with accept/decline within window + countdown; upcoming + past assignments with cancel modal (substitute-side late-cancellation flow)                                                                                                                                                                                                                                                                                                                                 |
| `/substitutes/profile`   | Substitute (sub-001:read+write)   | Own profile editor: display name, bio, grade levels (GIN keystone), subject areas, max travel, years experience; availability rows (RECURRING/SPECIFIC/BLOCKED) with type pills + day-of-week or specific-date + time range; school preferences (PREFERRED/BLOCKED) with private reason                                                                                                                                                                                               |
| `/substitutes/pool`      | Admin (sch-004:write)             | Curated school pool with status filter chips (ACTIVE/SUSPENDED/REMOVED); add-substitute modal driven by the matching engine search; suspend modal with date picker + reason; permanent remove with confirm dialog                                                                                                                                                                                                                                                                     |
| `/substitutes/jobs/new`  | Admin (sch-004:write)             | Post job form: select absent teacher → date/time → job type (FULL_DAY/HALF_DAY/SPECIFIC_PERIODS) → grade/subject/requirements → acceptance window. Submits via /jobs which inline-fans-out tier-1 POOL notifications and emits sub.job.posted via outbox                                                                                                                                                                                                                              |
| `/substitutes/coverage`  | Admin (sch-004:read) + Substitute | Coverage status board with 3-stat header (open/filled/unfilled) + status filter chips + per-job cards showing notification fan-out (admin-only details panel) and assignment lifecycle (check-in/out/cancel buttons gated to admin or assigned substitute)                                                                                                                                                                                                                            |
| `/substitutes/ratings`   | Admin (sch-004:write)             | 3-tab admin surface: (1) Rate substitute — left panel lists CHECKED_OUT assignments, right panel shows ratings + session note + computed pay with 5-button rating modal (auto-triggers overall_rating re-materialisation on submit); (2) Pay rates table with school default + per-substitute rows + EXCLUDE-gist 409 error handling on overlap + close-rate action; (3) Cancellation policy editor with multi-column suspension/penalty lockstep validated client-side before submit |

### Supporting infrastructure

- **`apps/web/src/lib/types.ts`** extended with ~25 Sub Marketplace DTOs (SubstituteProfileDto, SchoolPoolMemberDto, SubJobPostingDto, SubJobNotificationDto, SubAssignmentDto, SubRatingDto, SubSessionNoteDto, SubAvailabilityDto, SubPreferenceDto, SubPayRateDto, SubCancellationPolicyDto + 11 enum unions + 13 payload types). Renamed `CredentialType` and `VerificationStatus` to `SubCredentialType` + `SubVerificationStatus` to dodge collisions with Cycle 19 transport types.
- **`apps/web/src/lib/substitutes-format.ts`** — pill class maps + label maps for every enum (POOL_STATUS / JOB_STATUS / NOTIFICATION_RESPONSE / ASSIGNMENT_STATUS / VERIFICATION / AVAILABILITY_TYPE / PREFERENCE_TYPE / RATE_TYPE / CANCEL_CONSEQUENCE) + `formatRating` / `formatRate` / `formatTimeRange` / `formatDate` / `formatDateTime` / `formatRelativeWindow` / `isSchoolDefaultRate` / `isJobLive` helpers. SCHOOL_DEFAULT_SUB_ID sentinel UUID exported for the pay-rates UI.
- **`apps/web/src/hooks/use-substitutes.ts`** — 27 React Query hooks covering all 34 backend endpoints with proper query-key invalidation chains (`['substitutes']` for the cross-surface invalidations on accept/check-out/rating/etc; `['substitutes', 'pool']` etc for narrower scopes). Default `staleTime: 30_000` on profile reads + `refetchOnWindowFocus: true` on jobs + assignments + pool for the live coverage dashboard.
- **`apps/web/src/components/shell/icons.tsx`** — new `SubstitutesIcon` (Heroicons user-plus shape).
- **`apps/web/src/components/shell/apps.tsx`** — new `'substitutes'` AppKey; persona-aware tile that gates on `sub-001:read OR sch-004:read` and routes admin views to `/substitutes/coverage` while substitute self-service routes to `/substitutes/dashboard`. `routePrefix='/substitutes'` keeps the tile lit across every nested route.

### Build sizes

```
/substitutes/coverage    3.15 kB / 117 kB First Load JS
/substitutes/dashboard   3 kB    / 117 kB
/substitutes/jobs/new    2.98 kB / 108 kB
/substitutes/pool        3.24 kB / 108 kB
/substitutes/profile     3.59 kB / 109 kB
/substitutes/ratings     5.46 kB / 111 kB
```

All 6 routes ship as static pages — Next 14 prerendering picks them up cleanly.

## CI gates

| Check                                           | Status                                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `pnpm --filter @campusos/api build`             | ✓ clean (no API changes this commit)                                         |
| `pnpm --filter @campusos/web build`             | ✓ clean — 6 substitute routes ship statically                                |
| `pnpm --filter @campusos/web exec tsc --noEmit` | ✓ clean (after collision fix on `SubCredentialType`/`SubVerificationStatus`) |
| `pnpm format:check`                             | ✓ clean                                                                      |
| `pnpm lint:logs`                                | ✓ 697 files clean                                                            |

## What's still on the punch list (not P2-9c scope)

These remain from P2-9b's deferred items and are intentionally **outside this UI cycle**:

| Item                                                                       | Why deferred                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shadow `hr_employees` row creation for marketplace substitutes             | Architectural — needs HR/payroll/org-chart product decisions before the auto-creation lands. Cover-arrangement consumer will continue to flip OPEN → CANCELLED until this is resolved.                                    |
| TaskWorker integration on `sub.session_note` events                        | Requires Cycle 7 TaskWorker auto-task rule + emit wiring in SessionNoteService. Small, ~1 hour of work but independent of UI.                                                                                             |
| Notification fan-out consumers on `sub.job.*` + `sub.assignment.confirmed` | Substitute-side IN_APP / EMAIL via the Cycle 14 NotificationConsumer pipeline. Independent of UI.                                                                                                                         |
| Cross-tenant `overall_rating` aggregation                                  | Architectural — see P2C9-REVIEW-NOTES.md sections 6 + 13. Needs either cross-tenant iteration (slow) or a platform-side rating-snapshot table consuming sub.rating.created events from every tenant. Phase 2 polish task. |
| Dedicated Substitute role split                                            | Joins items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 / 30 / 32 / 33 in the broader role-split work for the Wave 2 Phase 2 backlog.                                                                                            |
| vitest unit + integration tests                                            | Schema correctness verified by the 51 live SQL assertions in P2-9a's CAT smoke. Service-layer + UI tests are a dedicated test-hardening cycle item before pilot.                                                          |

Smaller polish items also surfaced during the build:

- **School directory picker on `/substitutes/profile`** — preferences modal currently takes a raw UUID. A real school directory picker is a polish item that depends on a public-facing school list endpoint (which exists, just not surfaced here).
- **Cycle 19 `useEmployees` shape** — the job posting form filters to `employmentStatus === 'ACTIVE'` employees; the `EmployeeListItemDto` has the right shape but the filter could be moved into the API for fewer over-the-wire bytes. Minor.

## Cumulative Cycle 9 status after P2-9c

- 13 tables (4 platform + 9 tenant) — unchanged from P2-9a.
- 34 endpoints — unchanged from P2-9b.
- 8 services + 2 workers + 2 consumers — unchanged.
- **6 web routes** (this commit).
- **27 React Query hooks** (this commit).
- 4 Kafka emit topics — unchanged.
- IAM catalogue: 349 codes — unchanged.

## Files in this commit

```
apps/web/src/lib/types.ts                               # +~25 DTOs + enums
apps/web/src/lib/substitutes-format.ts                  # new — labels + pills + formatters
apps/web/src/hooks/use-substitutes.ts                   # new — 27 hooks
apps/web/src/components/shell/icons.tsx                 # +SubstitutesIcon
apps/web/src/components/shell/apps.tsx                  # +substitutes tile (persona-aware)
apps/web/src/app/(app)/substitutes/dashboard/page.tsx   # new
apps/web/src/app/(app)/substitutes/profile/page.tsx     # new
apps/web/src/app/(app)/substitutes/pool/page.tsx        # new
apps/web/src/app/(app)/substitutes/jobs/new/page.tsx    # new
apps/web/src/app/(app)/substitutes/coverage/page.tsx    # new
apps/web/src/app/(app)/substitutes/ratings/page.tsx     # new
HANDOFF-P2C9c.md                                        # this file
```

## Cycle 9 closeout

P2-9 is functionally complete from a backend + UI standpoint. The architectural carry-overs (shadow employee, cross-tenant rating, role split) are correct items to land in dedicated cycles rather than bolted onto the Sub Marketplace cycle.
