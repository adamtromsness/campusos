# REVIEW-CYCLE25-CHATGPT

**Cycle:** 25 — Publications (Wave 5 closeout).
**Round 1 verdict:** Reject pending fixes — 5 BLOCKING + 4 MAJOR.
**Round 1 commit:** `cycle25-complete` (`5aee99c`).
**Round 1 fix commit:** this commit.
**Live verification:** `tenant_demo` 2026-05-06.

## Triage table

| #        | Class  | Title                                                         | Disposition                                                                    |
| -------- | ------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| BLOCKING | 1      | Publication / section / comment reads not actor-aware         | Fixed — list+getById+listForPublication+listForSection take actor              |
| BLOCKING | 2      | Students can create sections on any publication they identify | Fixed — student section create requires CONTRIBUTOR/EDITOR collaborator        |
| BLOCKING | 3      | Section approval too broad (any pub-002:write actor)          | Fixed — canApproveSection requires admin / creator / EDITOR / REVIEWER         |
| BLOCKING | 4      | Collaborator + contributor IDs not tenant-validated           | Fixed — assertAccountInCurrentTenant helper applied to invite + addContributor |
| BLOCKING | 5      | GROUP_MEMBERSHIP audience resolution joins iam_person         | Fixed — grp_members.person_id used directly as account_id (Cycle 18 semantics) |
| MAJOR    | 6      | Distribution reads exposed without row scope                  | Fixed — assertCanReadDistribution gates list + deliveryStatus                  |
| MAJOR    | 7      | Distribution rule_value not validated                         | Fixed — validateRule walks ROLE / GRADE / CLASS / GROUP_MEMBERSHIP             |
| MAJOR    | 8      | Subscription series existence not validated                   | Fixed — series existence + active check before insert/update                   |
| MAJOR    | 9      | Audience resolved outside tx (eventual consistency)           | Acknowledged — Cycle 25 accepts eventual consistency; pre-pilot fix            |
| Pass     | strong | Module wiring                                                 | ✓                                                                              |
| Pass     | strong | Schema additive + soft-integrity compliant                    | ✓                                                                              |
| Pass     | strong | Edition auto-numbering concurrency-safe                       | ✓                                                                              |
| Pass     | strong | ADR-035 publication approval gate                             | ✓                                                                              |
| Pass     | strong | Distribution recipient INSERT idempotent                      | ✓                                                                              |
| Pass     | strong | Subscription lockstep schema                                  | ✓                                                                              |

## Code-level fixes

### BLOCKING 1 — Actor-aware reads with publication visibility lattice

`PublicationService.list(actor, filters)` and `getById(id, actor)` now take an actor. New private `isWriterPersona(actor)` helper resolves writer status — school admin OR `STAFF` actor with `pub-001:write` / `pub-002:write`. Non-writer non-collaborator readers see PUBLISHED publications only; the SQL appends `AND (p.status = 'PUBLISHED' OR EXISTS (SELECT 1 FROM pub_publication_collaborators c WHERE c.publication_id = p.id AND c.user_id = $...))` so collaborators can still read non-published rows on which they hold a role. `getById` re-runs the visibility check after the SELECT and throws collapsed `404 NotFoundException` for non-PUBLISHED rows the actor doesn't have collaborator access to.

`SectionService.listForPublication(publicationId, actor)` resolves the parent publication's status, then runs `canEditPublication(...)` (admin OR pub-001/pub-002:write OR collaborator). Non-writer non-collaborator readers on a PUBLISHED publication get only `is_approved=true` sections; non-writer non-collaborator readers on a non-PUBLISHED publication get a collapsed 404.

`CommentService.listForSection(sectionId, actor)` is now restricted to writers/collaborators per the reviewer's "editorial review surface" framing. Controller gate flipped from `pub-001:read` to `pub-002:write` so parents (who hold `pub-001:read`) get 403 at the gate; students (who hold `pub-002:write`) pass the gate but are filtered by the service-layer `canEditPublication` collaborator check.

**Live verified:**

- Parent `GET /publications` → **2** rows (PUBLISHED only); Principal → 3 (all).
- Parent `GET /publications/{DRAFT}` → **404**; Principal → 200.
- Parent `GET /publications/{DRAFT}/sections` → **404**.
- Parent `GET /publications/{PUBLISHED}/sections` → **3 approved** (pending Student Spotlight filtered).
- Parent `GET /publication-sections/{id}/comments` → **403** at gate.
- Principal `GET` same → 200.

### BLOCKING 2 — Student section creation gated by collaborator role

`SectionService.create(actor, publicationId, input)` now refuses `actor.personType === 'STUDENT'` unless `isStudentCollaborator(...)` resolves an active EDITOR or CONTRIBUTOR row on the parent publication. The error message points to the student-submission workflow ("Students must be invited as a CONTRIBUTOR or EDITOR collaborator on the publication before adding a section."). The `personType !== 'STAFF'` check at the section-owner level continues to default `is_approved=false` for student-authored sections per ADR-035.

**Live verified:**

- Maya tries to add section to Pub #11 (no collaborator role) → **403**.
- Maya adds section to Pub #12 (CONTRIBUTOR per seed) → **201**.

### BLOCKING 3 — Section approval = admin / creator / EDITOR / REVIEWER

`SectionService.approve(actor, sectionId)` previously refused only students. New `canApproveSection(...)` helper requires:

- `actor.isSchoolAdmin`, OR
- `pub_publications.created_by = actor.accountId` (publication creator), OR
- `pub_publication_collaborators` row with role IN (EDITOR, REVIEWER) for this publication.

Generic `pub-002:write` is no longer enough. The error message names the three valid authorities so a teacher who lands a 403 understands why.

**Live verified:**

- Teacher (`pub-002:write`, no collaborator role on Pub #12) tries to approve → **403**.
- Counsellor (REVIEWER on Pub #12 per seed) approves → **200**.

### BLOCKING 4 — Collaborator + contributor tenant validation

New shared `assertAccountInCurrentTenant(tenantPrisma, accountId, fieldName)` helper in `apps/api/src/publications/access.ts` validates the supplied `platform_users.id` has at least one current-tenant projection in `sis_students` (via `platform_students.person_id`), `sis_guardians.person_id`, or `hr_employees.person_id`. Mirrors the Cycle 6.1 / 12 / 14 / 22 / 24 pattern. Applied to:

- `CollaboratorService.invite(...)` — validates `input.userId` before `INSERT INTO pub_publication_collaborators`.
- `ContributorService.add(...)` — validates `input.contributorId` before `INSERT INTO pub_section_contributors`.

**Live verified:**

- Principal invites with bogus `userId` → **400** with the standard "does not match a user in this school." message.
- Principal adds contributor with bogus `contributorId` → **400**.

### BLOCKING 5 — GROUP_MEMBERSHIP audience resolution

The Cycle 18 fix renamed `grp_members.person_id` semantically — the column stores `platform_users.id` despite the misleading name (verified: `EXISTS (SELECT 1 FROM grp_members m JOIN platform.platform_users pu ON pu.id = m.person_id LIMIT 1)` returns `true`; the iam_person join returns `false`). The Cycle 25 query was joining through `iam_person` and would have returned zero rows in production.

Fix: drop the `iam_person` + `platform_users` joins and use `m.person_id` directly as `account_id`. The query becomes:

```sql
SELECT DISTINCT m.person_id::text AS account_id
FROM grp_members m
WHERE m.group_id = $1::uuid AND m.status = 'ACTIVE'
```

**Live verified:**

- Distribution list with `GROUP_MEMBERSHIP` rule on a real group → audience preview returns **3 group members** (David Chen + Linda Park + Sarah Mitchell, with Hayes excluded as UNSUBSCRIBED on the parent series).

### MAJOR 6 — Distribution reads admin / editor / distributor only

New `assertCanReadDistribution(actor, publicationId)` helper on `DistributionService`. Gate: `actor.isSchoolAdmin` OR `pub-003:write` permission OR `pub_publication_collaborators` row with `role='EDITOR'` for the publication. Generic `PUB-003:read` (now redundant for non-writers) no longer reaches the rows. Applied to `listForPublication` and `deliveryStatus`.

**Live verified:**

- Parent (no PUB-003) `GET /publications/{id}/distribution-lists` → **403**.
- Counsellor (Staff PUB-003:write) → 200.

### MAJOR 7 — Distribution rule_value validation

New private `validateRule(ruleType, ruleValue)` walks the four supported types:

- `ROLE`: must be one of `PARENT / STAFF / STUDENT / TEACHER / SCHOOL_ADMIN / PLATFORM_ADMIN`.
- `GRADE`: must match an existing `sis_students.grade_level` in this tenant.
- `CLASS`: `sis_classes.id` must exist in this tenant.
- `GROUP_MEMBERSHIP`: `grp_groups.id` must exist in this tenant.

Applied to both `createList` (loop over `input.rules`) and `addRule`. Friendly 400 with the supported list when invalid.

**Live verified:**

- Bogus ROLE token (`GHOST`) → **400** with the supported list.
- Bogus CLASS UUID → **400**.
- Bogus GROUP_MEMBERSHIP UUID → **400**.
- Bogus GRADE → **400**.

### MAJOR 8 — Subscription series existence + active check

`SubscriptionService.subscribe(actor, seriesId)` now validates the series exists AND is `is_active=true` before insert/update. `unsubscribe` validates existence (allows unsubscribing from inactive series — a graceful exit). Bogus series id returns `404 NotFoundException` instead of a raw FK violation.

**Live verified:**

- Parent subscribes to bogus series → **404 "Series not found or inactive"**.

## Phase 2 punch list (carried)

- **MAJOR 9 (acknowledged)** — `distribute()` resolves the audience before locking the publication. The race window is small (a few ms), the worst case is a slightly stale audience (one extra/missing recipient if subscriptions or rules change in the gap). Pre-pilot move: relocate `resolveAudience` inside the locked tx after the publication FOR UPDATE, OR formally accept the eventual-consistency contract on the distribute path. Cycle 25 ships with the current ordering.
- **`PUB-003` permission rename** — catalogue currently labels PUB-003 "Parent Portal" while Cycle 25 uses it as Distribution per the plan. Pre-pilot rename to "Publication Distribution" or split into a dedicated `PUB-005` code.

These join the existing Wave 2-5 Phase 2 punch list (items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 / 30 / 32 / 33 / 34 / 35 / 36 / 37 / 38 / 39 / 40) for hardening before pilot.

## Verdict trail

- 2026-05-06 — `cycle25-complete` (`5aee99c`) submitted for review.
- 2026-05-06 — Round 1 verdict: **Reject pending fixes** (5 BLOCKING + 4 MAJOR).
- 2026-05-06 — All 5 BLOCKING + 3 actionable MAJORs (6 / 7 / 8) landed in this commit, live-verified on `tenant_demo`.
- 1 remaining MAJOR (9) acknowledged + carried to Phase 2 punch list.

**Cycle 25 ships clean to Round 2.** Tagging `cycle25-approved` after Round 2 APPROVED.
