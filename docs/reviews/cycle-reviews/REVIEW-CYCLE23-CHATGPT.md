# REVIEW-CYCLE23-CHATGPT

**Cycle:** 23 — Curriculum & Standards (Wave 5 opener).
**Round 1 verdict:** Reject pending fixes — 3 BLOCKING + 4 MAJOR.
**Round 1 commit:** `cycle23-complete` (`7e0d427`).
**Round 1 fix commit:** this commit.
**Live verification:** `tenant_demo` 2026-05-06.

## Triage table

| #        | Class  | Title                                                                 | Disposition                                                |
| -------- | ------ | --------------------------------------------------------------------- | ---------------------------------------------------------- |
| BLOCKING | 1      | `GET /curriculum/units/:id` leaks teacher-only resources              | Fixed — actor-aware getById + SQL `is_teacher_only` filter |
| BLOCKING | 2      | Unit listing + detail bypass parent map visibility                    | Fixed — `assertCanReadMap` propagates parent map status    |
| BLOCKING | 3      | Delivery-gap analytics exposed to read-only personas                  | Fixed — controller `tch-008:write` + service-layer guard   |
| MAJOR    | 4      | `frameworkId` not validated on map create/patch                       | Fixed — `assertFrameworkVisibleForMap` shared helper       |
| MAJOR    | 5      | Unit reorder set-safety (no validation of submitted ids vs map)       | Phase 2 punch list item 38                                 |
| MAJOR    | 6      | `alignStandard` / `linkLesson` rely on FK errors for invalid unit ids | Phase 2 punch list item 39                                 |
| MAJOR    | 7      | Delivery-gap worker swallows per-row UPSERT failures                  | Phase 2 punch list item 40                                 |
| Pass     | strong | Module wiring                                                         | ✓                                                          |
| Pass     | strong | Schema design (lockstep CHECKs + FKs)                                 | ✓                                                          |
| Pass     | strong | Dual-resolution framework model                                       | ✓                                                          |
| Pass     | strong | Platform standards GIN search                                         | ✓                                                          |
| Pass     | strong | Cross-cycle lesson linking validates current-tenant ownership         | ✓                                                          |
| Pass     | strong | Curriculum map row-locked status transitions                          | ✓                                                          |

## Code-level fixes

### BLOCKING 1 — `GET /curriculum/units/:id` teacher-only resource leak

`UnitService.getById` was actor-blind and the inline SQL pulled every `cur_resource_links` row regardless of `is_teacher_only`. The dedicated `/units/:id/resources` endpoint already filtered correctly, so the leak surface was only the unit-detail endpoint.

The fix:

- `UnitService.getById(id, actor: ResolvedActor)` now takes the actor.
- The SQL that loads `cur_resource_links` appends `AND is_teacher_only = false` when the actor is non-staff (`!actor.isSchoolAdmin && actor.personType !== 'STAFF'`). Staff + admin see all resources.
- Controller resolves the actor and passes it through.

**Live verified on `tenant_demo` 2026-05-06**:

- Principal → 3 resources (incl teacher-only Rubric).
- Teacher → 3 (incl teacher-only).
- **Student → 2** (no teacher-only).
- **Parent → 2** (no teacher-only).

### BLOCKING 2 — unit reads must inherit parent map visibility

`UnitService.listForMap` and `getById` didn't check the parent map's status, so a parent or student with `tch-008:read` who knew a draft map id (or unit id) could enumerate the unit structure + lesson links + resources + gaps before the school chose to publish.

New private helper `assertCanReadMap(mapId, actor)`:

- Loads the map's `status` from `cur_curriculum_maps` (school-scoped).
- If the actor is school admin OR holds `tch-008:write`, returns immediately.
- Otherwise refuses unless `status='PUBLISHED'`. Throws a collapsed `404 NotFoundException` (matches the don't-leak-existence pattern from Cycles 9/10/11).

Both `listForMap` (called once with the supplied `mapId`) and `getById` (called via the parent map id from the looked-up unit row) gate through `assertCanReadMap`. Internal callers — `units.create`, `units.patch`, `units.reorder` — already validate `tch-008:write` through `assertCurriculumWriter`, so the gate passes for legitimate post-mutation re-reads.

**Live verified**:

- Principal GET `/maps/<DRAFT>/units` → 200.
- Teacher (`tch-008:write`) GET `/maps/<DRAFT>/units` → 200.
- **Student GET `/maps/<DRAFT>/units` → 404**.
- **Parent GET `/units/<DRAFT_UNIT>` → 404**.

### BLOCKING 3 — delivery-gap analytics restricted to staff/admin

The two endpoints exposed coverage analytics:

- `GET /curriculum/delivery-gaps`
- `GET /curriculum/units/:id/gaps`

Both were gated on `tch-008:read`, which parents and students hold per the Step 3 IAM seed. Coverage analytics (`NOT_STARTED` / `PARTIAL` / `COMPLETE` per standard, planned vs delivered counts) are internal pacing data — they should not surface to read-only personas.

Two-layer fix:

1. **Controller-tier permission gate** — both endpoints now require `tch-008:write` (held by Teacher / Curriculum Coordinator / School Admin via `everyFunction`, but **not** by Parent or Student).
2. **Service-tier defence-in-depth** — `DeliveryGapService.list({}, actor?)` takes an optional actor; when supplied, refuses any non-staff non-admin actor with a 403 + the documented message. Internal callers (`UnitService.getById` hydrates per-unit gaps for the unit-detail surface) bypass the gate by omitting the actor — they already gate teacher-only-resources + parent-map visibility upstream.

**Live verified**:

- Principal GET `/delivery-gaps` → 200.
- Teacher GET `/delivery-gaps` → 200.
- **Student GET `/delivery-gaps` → 403**.
- **Parent GET `/delivery-gaps` → 403**.
- **Student GET `/units/<id>/gaps` → 403**.

### MAJOR 4 — `frameworkId` validation on map create / patch

Map create/patch accepted any UUID for `framework_id` and inserted it directly. The schema's soft FK pattern means the only safe validation surface is the application layer.

New private helper `CurriculumMapService.assertFrameworkVisibleForMap(frameworkId, academicYearId)`:

- Resolves to **(a)** a current-tenant `cur_standards_frameworks` row that belongs to this school AND `is_active = true`; OR
- **(b)** an adopted platform framework — verified via `cur_school_framework_adoptions` where `platform_framework_id = $frameworkId AND school_id = current AND academic_year_id = $academicYearId`.
- Throws `400 BadRequestException` otherwise.

`create` validates with the supplied `academicYearId`. `patch` reads the existing `academic_year_id` under the same `FOR UPDATE` lock that runs the rest of the patch (the academic year is not editable via the DTO, so reading it under the lock is the right snapshot). The check fires only when `input.frameworkId !== undefined`.

**Live verified**:

- Bogus UUID → 400.
- Unadopted platform framework (CCSS Math is in the platform catalogue but not adopted by Lincoln Academy) → 400.
- Adopted platform framework (CCSS ELA — Lincoln adopted it for 2025-2026) → 201.

## Phase 2 punch list (carried)

- **Item 38** — `UnitService.reorder` set-safety. Validate every submitted unit id belongs to the map; reject duplicate `sequenceOrder` values; require all units in the map are represented in the input. Today's implementation relies on the schema UNIQUE for the duplicate-final-position case; a friendly 400 with the offending ids is the polish.
- **Item 39** — `alignStandard` / `linkLesson` should validate the `unitId` exists in the calling tenant before INSERT. Today the FK catches an invalid unit id but surfaces as a generic database error; a friendly 404 collapsed result matches the rest of the curriculum surface.
- **Item 40** — `DeliveryGapService.materialiseCurrentTenant` swallows per-row UPSERT failures with a `Logger.warn` and continues. For the nightly read-model worker this is acceptable for transient failures; before pilot, the worker should return a `failedRows` count + persist worker-run diagnostics so ops sees partial materialisation. The manual admin endpoint should fail visibly when any gap upsert errors out.

These join the existing Wave 2-4 Phase 2 punch list (items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 / 30 / 32 / 33 / 34 / 35 / 36 / 37) for hardening before pilot.

## Verdict trail

- 2026-05-06 — `cycle23-complete` (7e0d427) submitted for review.
- 2026-05-06 — Round 1 verdict: **Reject pending fixes** (3 BLOCKING + 4 MAJOR).
- 2026-05-06 — All 3 BLOCKING + MAJOR 4 landed in fix commit `13e8484`, live-verified on `tenant_demo`.
- 2026-05-06 — Round 2 verdict: **Approved** at `13e8484`. Reviewer cache-busted each affected file in code and confirmed all 4 fixes — actor-aware unit detail with `is_teacher_only` filter, `assertCanReadMap` parent-visibility propagation with collapsed 404, `tch-008:write` re-gating + service-tier defence on delivery-gap analytics, and `assertFrameworkVisibleForMap` validating either active tenant custom framework OR adopted platform framework via `cur_school_framework_adoptions`.
- 3 remaining MAJORs (5 / 6 / 7) carried as Phase 2 punch list items 38 / 39 / 40.

**Cycle 23 APPROVED.** Tagged `cycle23-complete` at `7e0d427` and `cycle23-approved` at `13e8484`.
