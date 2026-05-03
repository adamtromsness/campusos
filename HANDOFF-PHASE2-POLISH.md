# HANDOFF — Phase 2 Parent Polish

Cross-cutting parent-experience polish identified during Phase 2 testing.
Five logical commits between `44dff03` and `c9d2de7` on `main` (2026-05-03).
Not a numbered Cycle — these refinements span SIS, Scheduling, Enrollment,
Payments, and the platform schema. No post-cycle architecture review yet.

## Ship summary

| Commit    | Feature                                                | Tenant migration | Platform migration |
| --------- | ------------------------------------------------------ | ---------------- | ------------------ |
| `44dff03` | iPhone-style dashboard launchpad                       | —                | —                  |
| `9f8658c` | Calendar RSVPs + my-kids filter + multi-school toggle  | `023`            | —                  |
| `adc78d4` | Add Child workflow with admin approval                 | `024`            | —                  |
| `ae32299` | Public enrollment search by location                   | `025`            | `20260503130749`   |
| `c9d2de7` | Multi-school billing structure                         | —                | (uses col from #4) |

Tenant base table count: 106 → **108** (`sch_calendar_event_rsvps`,
`sis_child_link_requests`). Platform `schools` gains 4 nullable columns
(`latitude`, `longitude`, `full_address`, `shared_billing_group_id`).

## 1. Dashboard launchpad — iOS app-grid

`apps/web/src/app/(app)/dashboard/page.tsx`

- App tile: 56×56 rounded icon box (campus-50 background) with the icon at
  h-7 w-7 and the label below in `text-xs`. Hover darkens to campus-100;
  active scales to 95% for the iOS press feel.
- Grid: 4 cols mobile / 6 cols desktop (was 2 / 3).
- Badge moves to `-right-1 -top-1` with `ring-2 ring-white` so it sits on
  top of the icon-box edge.
- Removed: card border, card shadow, `aspect-square` envelope.

## 2. Calendar RSVPs + my-kids filter + school selector

### Schema

Tenant migration `023_sch_calendar_event_rsvps.sql`:

- `sch_calendar_event_rsvps` — UUID PK, FK `calendar_event_id` →
  `sch_calendar_events(id)` ON DELETE CASCADE, soft `person_id` →
  `platform.iam_person`. 3-value `response` CHECK
  (GOING / TENTATIVE / NOT_GOING). `responded_at` defaults to `now()`.
- UNIQUE(`calendar_event_id`, `person_id`) so a re-RSVP is an
  ON CONFLICT … DO UPDATE upsert.
- Block-comment header, splitter-safe semicolons.

### API

New `CalendarRsvpService` + 3 endpoints on `CalendarController`:

```
POST   /calendar/:id/rsvp           (set or change my response)
GET    /calendar/:id/rsvps          (admin all, others own only)
GET    /calendar/:id/rsvp-summary   (aggregate counts + my response)
```

All 3 gated on `sch-003:read`. The list/summary 404 on a draft event for
non-admins to mirror the existing leak-prevention pattern in
`CalendarService.getById`.

`CalendarService.list` accepts an optional `myKidsPersonIds` array. When
set, an `EXISTS` clause filters events to ones where any of those persons
have a `GOING / TENTATIVE` RSVP. The controller only populates this set
when caller is GUARDIAN + `myKidsOnly=true`; admins / staff can't use it
(falls through to no filter).

### Web

- Calendar page (`/calendar`) gains:
  - Guardian-only `My children only` checkbox in the controls bar.
  - School selector dropdown (renders only when 2+ schools — placeholder
    for the eventual cross-tenant aggregation).
  - RSVP panel inside `EventDetailModal` for any published event. 3 chip
    buttons, active state colour-coded by response. Aggregate counter
    footer.
- New hooks: `useCalendarEventRsvpSummary`, `useCalendarEventRsvps`,
  `useSetCalendarEventRsvp`. Mutation invalidates summary + list + the
  events list (since the my-kids filter depends on RSVP rows).

### Phase 3 carry-over

Full audience targeting on calendar events (the original spec called for
filtering by class / grade-level audience too — events don't carry the
`audience_type` / `audience_ref` columns yet, that lands when class-targeted
events arrive).

## 3. Add Child workflow with admin approval

### Schema

Tenant migration `024_sis_child_link_requests.sql`:

- Two request types `LINK_EXISTING` / `ADD_NEW`. Multi-column `shape_chk`
  enforces mutually exclusive column population.
- Lifecycle `PENDING` / `APPROVED` / `REJECTED` with `reviewed_chk` keeping
  `reviewed_by` + `reviewed_at` all-set or all-null together.
- 4 negative-path constraint smokes verified live on tenant_demo:
  - LINK_EXISTING happy path
  - ADD_NEW happy path
  - ADD_NEW missing `first_name` rejected by `shape_chk`
  - APPROVED with NULL reviewer rejected by `reviewed_chk`

### API

New `ChildLinkRequestService` + 6 endpoints on `/children`:

```
GET    /children/search?firstName&lastName&dateOfBirth   (case-insensitive)
POST   /children/link-request                            (LINK_EXISTING)
POST   /children/add-request                             (ADD_NEW)
GET    /children/link-requests                           (parent own / admin all)
GET    /children/link-requests/:id
PATCH  /children/link-requests/:id/approve
PATCH  /children/link-requests/:id/reject
```

All gated on `stu-001:read` (search/list/get/submit) or `stu-001:admin`
(approve/reject). The submit paths additionally enforce
`personType=GUARDIAN` at the service layer (since `stu-001:read` covers
read-only catalogue use too).

`approve()` runs inside `executeInTenantTransaction` with `FOR UPDATE`
on the request row so two simultaneous admin approvals serialise. The
ADD_NEW path atomically writes:

1. `iam_person` (PERSON_TYPE STUDENT)
2. `platform_students`
3. `sis_students` with auto-generated `student_number`
4. `sis_student_guardians` link (idempotent — `ON CONFLICT DO NOTHING`)
5. `platform_family_members` CHILD entry, when the guardian has a
   household (idempotent on the UNIQUE on `person_id`)

Emits `iam.child.linked` after commit.

### Web

- `/children` page gains an Add child button (PageHeader actions slot)
  that opens a 3-step Modal:
  - **SEARCH** — first name + last name + DOB inputs.
  - **PICK_RESULT** — exact-match results from
    `GET /children/search`. Each row has a "Link to me" button. If no
    results, falls through to ADD_NEW.
  - **ADD_NEW** — full form. Submit creates an ADD_NEW request.
- Pending banner above the child cards summarises the parent's
  outstanding requests so they can track review progress.
- New admin queue at `/children/link-requests` with status filter chips
  (PENDING default) + per-row Approve / Reject Modal that captures
  optional reviewer notes.

## 4. Public enrollment search by location

### Schema

Platform migration `20260503130749_add_school_location_and_billing_group`:

```
ALTER TABLE platform.schools
  ADD COLUMN latitude DECIMAL(10,8),
  ADD COLUMN longitude DECIMAL(11,8),
  ADD COLUMN full_address TEXT,
  ADD COLUMN shared_billing_group_id UUID;
CREATE INDEX schools_shared_billing_group_id_idx
  ON platform.schools (shared_billing_group_id);
```

`packages/database/src/seed.ts` updated to backfill the demo school's
location + full_address (Springfield IL coords).

Tenant migration `025_enr_period_allows_public_search.sql`:

```
ALTER TABLE enr_enrollment_periods
  ADD COLUMN IF NOT EXISTS allows_public_search BOOLEAN NOT NULL DEFAULT true;
```

### API

`@Public()` `GET /enrollment/search?lat=&lng=&radiusMiles=&gradeLevel=`.
Two-phase:

1. Read every active school with non-null lat/lng from `platform.schools`
   joined to `platform_tenant_routing` for the schema name. App-side
   Haversine filter to the radius (capped at 100 miles).
2. For each surviving school, enter its tenant schema via the new
   `TenantPrismaService.executeInExplicitSchema(schemaName, fn)` helper
   and pull OPEN periods with `allows_public_search=true`. Optionally
   further filtered to ones whose `enr_intake_capacities` accept
   `gradeLevel`.

Returns sorted nearest-first.

### Two infra fixes

The public endpoint surfaced two latent issues that are corrected here:

- **TenantGuard skipped on @Public()**. The global `TenantGuard` ran
  even on public endpoints and threw `'No tenant context — request was
  not resolved to a tenant'`. Now reads `IS_PUBLIC_KEY` via `Reflector`
  and short-circuits, matching the existing `AuthGuard` pattern.
- **Middleware path matching uses originalUrl**. The middleware's
  exempt-path matcher was using `req.path`, but Nest strips the global
  `/api/v1` prefix from `req.path` before middleware runs — so the
  existing `/api/v1/health` entry was relying on a different code path
  to be exempt. Switched to `req.originalUrl` so the existing list
  actually does what its names suggest.

### Web

- New public route `/find-schools` at the app root (outside the
  auth-gated `(app)` layout). Form: lat, lng, radius slider, optional
  grade. "Use my location" button calls `navigator.geolocation`. Results
  render as cards with distance, period name, accepting grades, and the
  application close date.
- Login page gains a "Find a school accepting applications →" link
  below the account picker for unauth visitors.

### Live verification

```
GET /enrollment/search?lat=39.7817&lng=-89.6501&radiusMiles=25
→ Lincoln Elementary @ 0.3 mi, Fall 2026 Admissions, grades 9 + 10

GET /enrollment/search?lat=40.7128&lng=-74.0060&radiusMiles=10
→ []   (NYC query, no matching schools in radius)

GET /enrollment/search?lat=39.7817&lng=-89.6501&radiusMiles=25&gradeLevel=9
→ Lincoln Elementary

GET /enrollment/search?lat=39.7817&lng=-89.6501&radiusMiles=25&gradeLevel=12
→ []   (Lincoln only accepts 9 + 10)
```

## 5. Multi-school billing structure

### API

`family-account.service.ts` SELECT base now joins `platform.schools` to
surface `school_name` + `shared_billing_group_id` on every row.
`FamilyAccountResponseDto` + web `FamilyAccountDto` pick up the two
new fields.

### Web

`/billing` parent dashboard restructured:

- `groupAccounts(accounts)` keys by `sharedBillingGroupId` when set
  (so two schools sharing a district billing module render as one
  combined "District billing" section); otherwise keys by `schoolId`
  (one section per school).
- Per-account UI (3-stat header + outstanding invoices + recent
  payments) extracted into `apps/web/src/app/(app)/billing/FamilyAccountSection.tsx`
  so the page is now a thin layout that maps over grouped accounts.
- PageHeader description switches between
  "Lincoln Elementary · FA-1001" (single account) and
  "Your family accounts across schools." (multi).

### Phase 3 carry-over

True cross-tenant aggregation. Tenancy is still resolved per-request
(via `X-Tenant-Subdomain`), so this page only ever sees the current
tenant's accounts. Showing accounts across multiple tenants for a
single parent needs a different aggregation surface — likely a
platform-side family-billing view, or a parent-side aggregator that
fans out across each tenant the parent has a guardian record in.

## Smoke / build status

- Both API and web build clean (`pnpm --filter @campusos/api build` /
  `pnpm --filter @campusos/web build`).
- All 3 new tenant migrations + 1 platform migration apply cleanly to
  `tenant_demo` and `tenant_test`.
- Public enrollment search end-to-end smoke verified live on
  `tenant_demo` (4 scenarios — see `4. Live verification` above).
- Schema constraint smoke for `sis_child_link_requests` (4 cases) all
  fire correctly.
- Calendar RSVP path not exercised end-to-end live yet — backend builds
  + manual UI test is the validation done so far. End-to-end Kafka
  envelope + DB-row check would be a fresh CAT add-on.

## Known gaps / Phase 3 punch list

- Calendar audience targeting (filter is RSVP-only today; can't filter
  to events that target a child's class or grade level via
  `audience_type` / `audience_ref` since calendar events don't carry
  those columns yet).
- Cross-tenant family-account aggregation (parent with kids at multiple
  schools currently sees only the current tenant's accounts).
- The temporary debug `console.log` in `tenant-resolver.middleware.ts`
  was removed before commit — verify on `git log -p`.

## Files touched per commit

```
44dff03  apps/web/src/app/(app)/dashboard/page.tsx

9f8658c  apps/api/src/scheduling/calendar-rsvp.service.ts          (new)
         apps/api/src/scheduling/calendar.controller.ts
         apps/api/src/scheduling/calendar.service.ts
         apps/api/src/scheduling/dto/calendar.dto.ts
         apps/api/src/scheduling/scheduling.module.ts
         apps/web/src/app/(app)/calendar/page.tsx
         apps/web/src/hooks/use-scheduling.ts
         apps/web/src/lib/types.ts
         packages/database/prisma/tenant/migrations/023_sch_calendar_event_rsvps.sql

adc78d4  apps/api/src/sis/child-link-request.controller.ts          (new)
         apps/api/src/sis/child-link-request.service.ts             (new)
         apps/api/src/sis/dto/child-link-request.dto.ts             (new)
         apps/api/src/sis/sis.module.ts
         apps/web/src/app/(app)/children/link-requests/page.tsx     (new)
         apps/web/src/app/(app)/children/page.tsx
         apps/web/src/hooks/use-children.ts
         apps/web/src/lib/types.ts
         packages/database/prisma/tenant/migrations/024_sis_child_link_requests.sql

ae32299  apps/api/src/enrollment/enrollment-search.controller.ts    (new)
         apps/api/src/enrollment/enrollment-search.service.ts       (new)
         apps/api/src/enrollment/enrollment.module.ts
         apps/api/src/tenant/tenant-prisma.service.ts
         apps/api/src/tenant/tenant-resolver.middleware.ts
         apps/api/src/tenant/tenant.guard.ts
         apps/web/src/app/find-schools/page.tsx                     (new)
         apps/web/src/app/login/page.tsx
         packages/database/prisma/platform/migrations/20260503130749_add_school_location_and_billing_group/migration.sql
         packages/database/prisma/platform/schema.prisma
         packages/database/prisma/tenant/migrations/025_enr_period_allows_public_search.sql
         packages/database/src/seed.ts

c9d2de7  apps/api/src/payments/dto/family-account.dto.ts
         apps/api/src/payments/family-account.service.ts
         apps/web/src/app/(app)/billing/FamilyAccountSection.tsx    (new)
         apps/web/src/app/(app)/billing/page.tsx
         apps/web/src/lib/types.ts
```
