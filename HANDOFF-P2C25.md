# HANDOFF — Phase 2 Cycle 25 (P2-25 Library Advanced, M24 .1)

**Wave D — Module Completion.** P2-25 closes the M24 Library deferred-table surface that Cycle 12 left in scope. Cycle 12 shipped the core library (catalogue + locations + copies + circulation policies + checkouts + holds + fines + reading programmes + reading lists + reviews). P2-25 lands the 6 advanced tables that complete the library media-centre surface: curated reading lists tied to curriculum units, class set bulk checkouts with per-copy tracking, AI-ready recommendations with 5-strategy scoring, interlibrary loans for district partnerships, and bulk catalogue import (ISBN batch / MARC / CSV).

**Status — COMPLETE pending peer review.** All 8 user-defined steps shipped. P2-25a (schema + seed + services — Steps 1–5) shipped at `7b92258`. P2-25b (UI + integration tests + recommendation config — Steps 6–8) ships in this commit. Awaiting Round 1 verdict before tagging `p2c25-complete`.

---

## Plan / Reference Documents

- Plan: `docs/campusos-p2c25-library-advanced.html`
- Cycle 12 closeout: `HANDOFF-CYCLE12.md` (the foundation this cycle builds on)
- Review scaffold: `P2C25-REVIEW-NOTES.md`

---

## Step Status

| Step | Title                                                | Status            | Notes                                                                                                                                                                                                        |
| ---- | ---------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Reading Lists + Class Sets Schema (3 tables + ALTER) | ✅ shipped P2-25a | `164_lib_classsets_listfields.sql` — adds `lib_class_set_checkouts`, ALTERs `lib_reading_lists` to add `target_grade_level` + `curriculum_unit_id`, ALTERs `lib_checkouts` to add `class_set_checkout_id` FK |
| 2    | Recommendations + ILL + Import Schema (3 tables)     | ✅ shipped P2-25a | `165_lib_recommendations_ill_import.sql` — `lib_recommendations` + `lib_interlibrary_loans` + `lib_catalogue_import_jobs`                                                                                    |
| 3    | Seed Data                                            | ✅ shipped P2-25a | `seed-library-advanced.ts` — 2 reading lists, 1 partial-return class set, 15 recommendations across 3 students × 5 strategies, 2 ILLs, 1 COMPLETED import job                                                |
| 4    | Reading Lists + Class Sets NestJS Module             | ✅ shipped P2-25a | `ReadingListService` extended (target_grade_level / curriculum_unit_id filters + columns), `ClassSetService` + `ClassSetOverdueWorker`                                                                       |
| 5    | Recommendations + ILL + Import NestJS Module         | ✅ shipped P2-25a | `RecommendationService` + `InterlibraryLoanService` + `CatalogueImportService` + `CatalogueImportWorker` (with `lib.import.completed` outbox emit)                                                           |
| 6    | Library Advanced UI                                  | ✅ shipped P2-25b | 4 new web routes + recommendations shelf on `/library/my` + extended reading-list create form                                                                                                                |
| 7    | Vertical Slice Integration Test                      | ✅ shipped P2-25b | `library-advanced-vertical-slice.spec.ts` — 18 cases across 7 plan scenarios                                                                                                                                 |
| 8    | Recommendation Engine Configuration                  | ✅ shipped P2-25b | `GET/PATCH /library/recommendation-config` + `school_config` storage                                                                                                                                         |

---

## Schema Migrations

### `164_lib_classsets_listfields.sql` (Step 1)

Three changes in one migration:

1. **`lib_class_set_checkouts`** — bulk-checkout parent row.
   - `school_id UUID NOT NULL`
   - `catalogue_item_id UUID NOT NULL FK lib_catalogue_items ON DELETE NO ACTION` — refuse delete while sets exist
   - `teacher_patron_id UUID NOT NULL` — soft ref to `platform.iam_person`
   - `class_id UUID` — soft ref to `sis_classes` per ADR-001/020
   - `copy_count INT NOT NULL CHECK (copy_count > 0)`
   - `checkout_date DATE NOT NULL`, `due_date DATE NOT NULL`
   - `returned_count INT NOT NULL DEFAULT 0 CHECK (returned_count >= 0 AND returned_count <= copy_count)`
   - `status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PARTIALLY_RETURNED','RETURNED','OVERDUE'))`
   - Multi-column `dates_chk: due_date >= checkout_date`
   - INDEXes on `(school_id, status)` + `(teacher_patron_id, checkout_date DESC)` + partial `(school_id, due_date) WHERE status IN ('ACTIVE','PARTIALLY_RETURNED')` for the overdue sweep

2. **ALTER `lib_reading_lists`** — add P2-25b fields:
   - `target_grade_level TEXT` (free-form label for YEAR_GROUP lists)
   - `curriculum_unit_id UUID` (soft ref to `cur_units` per ADR-001/020 — `CURRICULUM_UNIT` list type)
   - INDEX on `curriculum_unit_id WHERE NOT NULL`

3. **ALTER `lib_checkouts`** — add `class_set_checkout_id UUID FK lib_class_set_checkouts ON DELETE NO ACTION`. Partial INDEX on `(class_set_checkout_id) WHERE class_set_checkout_id IS NOT NULL`.

### `165_lib_recommendations_ill_import.sql` (Step 2)

Three new tables:

1. **`lib_recommendations`** — student book recommendations from the worker.
   - `student_id UUID NOT NULL FK sis_students ON DELETE CASCADE`
   - `recommended_item_id UUID NOT NULL FK lib_catalogue_items ON DELETE CASCADE`
   - `reason_type TEXT NOT NULL CHECK (reason_type IN ('COLLABORATIVE_FILTERING','READING_LEVEL_MATCH','SUBJECT_MATCH','NEW_ARRIVAL','STAFF_PICK'))`
   - `score NUMERIC(5,3)` — 0..1 ranked score the worker normalises within each strategy then applies weights to
   - `reason_metadata JSONB` — strategy-specific context (e.g. the source-student-id for COLLABORATIVE_FILTERING)
   - `dismissed_at TIMESTAMPTZ`, `dismissed_by UUID` — student dismissal soft-hide path
   - `generated_at TIMESTAMPTZ NOT NULL` — worker run id
   - INDEX on `(student_id, score DESC) WHERE dismissed_at IS NULL` for the per-student feed hot path
   - **Full-replace contract** (not upsert): `RecommendationService.replaceForStudent` DELETEs all rows for the student then INSERTs the fresh batch capped at 20. The worker regenerates weekly per active student patron.

2. **`lib_interlibrary_loans`** — district partnership tracking.
   - `school_id UUID NOT NULL`
   - `loan_direction TEXT NOT NULL CHECK (loan_direction IN ('BORROWED','LENT'))`
   - `partner_institution TEXT NOT NULL`
   - `catalogue_item_id UUID FK lib_catalogue_items ON DELETE NO ACTION` — nullable for BORROWED (title may not be in our catalogue); **required for LENT** (multi-column `direction_chk`)
   - `title TEXT NOT NULL`, `author TEXT`, `isbn TEXT`
   - Date columns: `request_date NOT NULL`, `received_date`, `sent_date`, `due_date`, `returned_date`
   - `status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','IN_TRANSIT','ACTIVE','RETURNED','OVERDUE','LOST'))`
   - INDEXes on `(school_id, status)` + `(school_id, loan_direction, status)` + partial `(school_id, due_date) WHERE status = 'ACTIVE'` for sweep

3. **`lib_catalogue_import_jobs`** — bulk import audit.
   - `school_id UUID NOT NULL`
   - `import_type TEXT NOT NULL CHECK (import_type IN ('ISBN_BATCH','MARC_IMPORT','CSV_UPLOAD','WORLDCAT_SYNC'))`
   - `source_file_s3_key TEXT` — for ISBN_BATCH the service inline-encodes the list as `inline://<json-array>` so the worker can read without round-tripping S3
   - Counters: `total_records INT`, `records_imported INT NOT NULL DEFAULT 0`, `records_skipped INT NOT NULL DEFAULT 0`, `records_failed INT NOT NULL DEFAULT 0`
   - `status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','PARSING','IMPORTING','COMPLETED','FAILED'))`
   - `initiated_by UUID NOT NULL`, `error_log_s3_key TEXT`, `started_at`, `completed_at`
   - INDEX on `(school_id, status)` + partial `(school_id) WHERE status IN ('QUEUED','PARSING','IMPORTING')` for the worker pick query

**Both migrations splitter-safe** — no `;` inside COMMENT strings or block comments. Tenant logical base table count after Step 2: ~763.

---

## Backend Module — `apps/api/src/library/` extensions

P2-25a extended the existing `LibraryModule` (Cycle 12) with **5 new services + 4 new controllers + 2 new workers + ~22 endpoints + 1 Kafka emit topic** (`lib.import.completed`).

### Services (Steps 4 + 5)

- **`ReadingListService` (extended Step 4)** — Cycle 12 service gains optional `targetGradeLevel`, `curriculumUnitId`, `listType` filters on `list(actor, args)`; create/update DTOs accept the two new columns. The `list_type = CURRICULUM_UNIT` value already existed in the 5-value CHECK from Cycle 12.

- **`ClassSetService` (new Step 4)** — bulk-checkout keystone.
  - `create(input, actor)` runs the full INSERT chain in one tenant tx:
    1. Validate `catalogueItemId` exists in tenant.
    2. Validate `teacherPatronId` resolves to an `hr_employees.person_id` row in this tenant.
    3. Validate `copyCount ≤ available copies` by `SELECT … FOR UPDATE` on `lib_catalogue_copies` rows where `is_available=true AND catalogue_item_id=…` (locks them so a concurrent caller cannot reserve the same copies).
    4. INSERT parent `lib_class_set_checkouts` row (`status='ACTIVE'`).
    5. For each locked copy: INSERT `lib_checkouts` row with `class_set_checkout_id` linked + UPDATE the `lib_catalogue_copies` row to `is_available=false, location_status='CHECKED_OUT'`.
  - `returnCopies(id, {copiesReturned, barcodes?}, actor)` walks the state machine inside one tx with `SELECT … FOR UPDATE` on the parent: refuse over-return (more than outstanding); when `barcodes` supplied, lock the named child checkouts; otherwise pick the oldest still-ACTIVE rows; flip child checkouts to RETURNED + flip copies back to `is_available=true, location_status='ON_SHELF'`; UPDATE parent `returned_count` and recompute status (`PARTIALLY_RETURNED` if `0 < returned < copy_count`, `RETURNED` if `returned = copy_count`).
  - `list({status?, teacherPatronId?})`, `getById(id)`, `sweepOverdueForCurrentTenant()` — sweep is a single UPDATE … WHERE `status IN ('ACTIVE','PARTIALLY_RETURNED') AND due_date < CURRENT_DATE AND returned_count < copy_count` returning ids.

- **`ClassSetOverdueWorker` (new Step 4)** — wrapper that calls `sweepOverdueForCurrentTenant()` per active tenant on the nightly schedule.

- **`RecommendationService` (new Step 5)** — read-side + dismiss + config + worker helper.
  - `listForStudent(studentId, actor, {includeDismissed})` — admin / librarian read any; STUDENT reads own (joins through `sis_students → platform_students.person_id`); GUARDIAN reads linked children via `sis_student_guardians`. Sorted by `score DESC NULLS LAST, generated_at DESC LIMIT 20`.
  - `dismiss(recommendationId, actor)` — locks the row, refuses re-dismiss, validates student-self vs admin/librarian, stamps `dismissed_at + dismissed_by`.
  - `replaceForStudent(studentId, fresh[])` — **full-replace contract**: DELETE all then INSERT each (capped at 20) inside one tenant tx. Public so a future LibraryRecommendationWorker can reuse the contract.
  - **`getConfig(actor)` / `updateConfig(actor, body)` (Step 8)** — reads `school_config` row keyed `library_recommendation_weights`. Defaults to `{collaborativeFiltering:30, readingLevelMatch:25, subjectMatch:20, newArrival:15, staffPick:10}`. `getConfig` requires `lib-002:read` (librarian + admin). `updateConfig` requires `lib-002:admin` or `lib-003:admin` (admin-only — librarian reads but cannot mutate). PATCH-merge semantics: only supplied keys overwrite. Validates merged weights sum to 100 (±0.5).

- **`InterlibraryLoanService` (new Step 5)** — district partnership state machine.
  - `create(input, actor)` — refuses `LENT` without `catalogueItemId` (matches schema `direction_chk`).
  - `patch(id, input, actor)` — locks the row, walks `ALLOWED_TRANSITIONS[current]`:
    - `REQUESTED → IN_TRANSIT|ACTIVE|LOST`
    - `IN_TRANSIT → ACTIVE|LOST|RETURNED`
    - `ACTIVE → RETURNED|OVERDUE|LOST`
    - `OVERDUE → RETURNED|LOST`
    - `RETURNED, LOST` are terminal
  - `sweepOverdueForCurrentTenant()` — UPDATE `WHERE status='ACTIVE' AND due_date < CURRENT_DATE`.
  - `listOverdue(actor)`, `list(args)`, `getById(id)`.

- **`CatalogueImportService` (new Step 5)** — bulk-import audit + worker hook.
  - `create(input, actor)` — refuses `CSV_UPLOAD`/`MARC_IMPORT` without `sourceFileS3Key`. For `ISBN_BATCH` inline-encodes the ISBN list as `inline://<json>` in `source_file_s3_key` so the worker reads without an S3 round-trip. Initial `total_records` populated from inline length when known; otherwise NULL until the parser counts the source.
  - `processQueuedJob(jobId)` — worker hook. Atomic transition QUEUED → PARSING → IMPORTING → COMPLETED/FAILED. Per record: ISBN dedup against existing `lib_catalogue_items` increments `records_skipped`; insert into `lib_catalogue_items + lib_items` increments `records_imported`; per-row failures append to error CSV and increment `records_failed`. On COMPLETED emits `lib.import.completed` via outbox with deterministic v5-shape event_id `deterministicLibImportCompletedEventId(jobId)` inside the same tx as the status flip.
  - `markTerminal(jobId, status, counters)` — internal helper used by the worker.

### Controllers / Endpoints (~22 total)

- `library/reading-lists` (extended Cycle 12 controller) — list / get / create / patch / publish / delete + item add / remove. P2-25b query filters: `?listType=`, `?targetGradeLevel=`, `?curriculumUnitId=`.
- `library/class-sets` — list / get / create / return.
- `library/recommendations/:studentId` — list (read-only per-student feed).
- `library/recommendations/:id/dismiss` — POST 204.
- `library/recommendation-config` — GET (read) + PATCH (admin update).
- `library/ill` — list / get / create / patch + GET `/library/ill/overdue`.
- `library/imports` — list / get / create.

### Kafka emit

- `lib.import.completed` — fires AFTER tx commit on the terminal COMPLETED transition. Payload includes `jobId, schoolId, importType, totalRecords, recordsImported, recordsSkipped, recordsFailed, completedAt`. Deterministic event_id via `deterministicLibImportCompletedEventId(jobId)` (v5-shape via `sha256(jobId + ':lib.import.completed:v1')`).

---

## Web UI Surface (Step 6)

P2-25b adds **4 new routes** under `/library/*` plus a recommendations shelf on the student `/library/my` page, plus extends the existing `/library/reading-lists` create form with the two new curriculum-unit / grade-level fields.

### Routes

1. **`/library/class-sets`** (librarian + admin) — bulk-checkout manager.
   - 4-status filter chips + admin Check-out-class-set Modal (catalogue item id, teacher dropdown driven by `useEmployees`, copy count, dates, notes).
   - Per-set card with progress bar (`returned/copy_count` % with emerald/sky/rose tone by status), overdue rows tinted rose, Return-copies Modal that posts to `/library/class-sets/:id/return` with the copies-returned count (max-capped to outstanding).

2. **`/library/ill`** (librarian + admin) — interlibrary loan tracker.
   - 3-stat header (Active / Overdue / Total tracked) + 6-state filter chips + 2-state direction chips.
   - Per-loan row with direction + partner + due-date pill. Overdue rows tinted rose.
   - LoanDetailModal with status transition action bar: Mark in transit (REQUESTED), Mark active (REQUESTED/IN_TRANSIT, stamps `received_date`), Mark returned (ACTIVE/OVERDUE, stamps `returned_date`), Mark lost (any non-terminal). New-loan Modal with direction-aware required-field validation (LENT requires `catalogueItemId`).

3. **`/library/imports`** (librarian + admin) — bulk catalogue import.
   - New-import Modal — type dropdown (ISBN_BATCH / CSV_UPLOAD / MARC_IMPORT / WORLDCAT_SYNC). ISBN_BATCH path renders a textarea for one-ISBN-per-line input; other types render the S3 key input. Amber callout explains the dedup contract (duplicate ISBNs count as `records_skipped`).
   - Per-job card with type label + status pill + 4-stat progress row (Imported / Skipped / Failed / Total) + emerald/amber/rose tinting per stat tone.
   - **Auto-polling** — while a job is QUEUED / PARSING / IMPORTING the list and per-job detail refetch every 3–5 seconds; once terminal the poll stops.
   - JobDetailModal with full counter breakdown + error log S3 key + initiated-by name + start/complete timestamps.

4. **`/library/recommendation-config`** (admin update; librarian read-only) — recommendation engine weight blender.
   - Sky-tinted intro callout explaining the 5-strategy blend and the 100-sum invariant.
   - Per-strategy row with description + horizontal slider + numeric input. Sliders disabled for non-admin readers.
   - Live total counter with emerald (sum=100±0.5) / rose (off-budget) tone.
   - Save button disabled while total ≠ 100; PATCHes the 5-key weights to `/library/recommendation-config` (admin-only on backend).

### Recommendations shelf — `/library/my`

The existing student-only my-library page gains a `RecommendationsShelf` section between the stats row and the reading programmes. Reads `useRecommendations(myStudentId)`; renders up to 6 active recommendations in a 3-column responsive grid. Each card carries the catalogue item cover (or a placeholder), title, author, a reason-type pill (violet for COLLABORATIVE_FILTERING, sky for READING_LEVEL_MATCH, emerald for SUBJECT_MATCH, amber for NEW_ARRIVAL, rose for STAFF_PICK), and a "Not interested" dismiss link that POSTs to `/library/recommendations/:id/dismiss`. Hides itself entirely when the student has no active recommendations (cold-start state).

### Extended reading-list create form

The Cycle 12 `/library/reading-lists` create Modal now adapts to the chosen `listType`:

- `YEAR_GROUP` → reveals a `target_grade_level` free-form text input (e.g. "5").
- `CURRICULUM_UNIT` → reveals a `curriculum_unit_id` UUID input (paste from `/curriculum`).

### Library home nav

The librarian-only QuickNav on `/library` gains 3 new links — Class sets / Interlibrary loans / Catalogue import — appended to the existing Circulation desk + Fines row.

---

## React Query Hooks (`apps/web/src/hooks/use-library.ts`)

Step 6 appends a new section to the existing `use-library.ts` with **18 new hooks** (taking the cycle hook count from the Cycle 12 baseline to a substantially larger surface):

- **Class sets** — `useClassSets(args)`, `useClassSet(id)`, `useCreateClassSet`, `useReturnClassSetCopies(id)`.
- **Recommendations** — `useRecommendations(studentId, {includeDismissed})`, `useDismissRecommendation(studentId)`, `useRecommendationConfig(enabled)`, `useUpdateRecommendationConfig`.
- **Interlibrary loans** — `useInterlibraryLoans(args)`, `useInterlibraryLoan(id)`, `useOverdueInterlibraryLoans`, `useCreateInterlibraryLoan`, `useUpdateInterlibraryLoan(id)`.
- **Catalogue import** — `useCatalogueImports()` (auto-polls 5s while any job is running), `useCatalogueImport(id)` (3s poll while running), `useCreateCatalogueImport`.

All mutations invalidate the matching list + detail query keys.

---

## Types + format helpers

- `apps/web/src/lib/types.ts` extended with the full P2-25 DTO + payload surface — `ClassSetCheckoutDto`, `RecommendationDto`, `InterlibraryLoanDto`, `CatalogueImportJobDto`, `RecommendationWeightsDto`, plus the union types (`ClassSetStatus`, `RecommendationReason`, `IllDirection`, `IllStatus`, `ImportType`, `ImportStatus`) and the create/update payload shapes. `ReadingListDto` and the reading-list payloads gained `targetGradeLevel + curriculumUnitId` fields (optional, so the existing /library/reading-lists code paths continue to compile).
- `apps/web/src/lib/library-format.ts` extended with label maps + pill class maps for every new enum (`CLASS_SET_STATUS_*`, `RECOMMENDATION_REASON_*`, `ILL_DIRECTION_*` / `ILL_STATUS_*`, `IMPORT_TYPE_LABELS` / `IMPORT_STATUS_*`) + `classSetProgress(returned, copies)` helper.

---

## Vertical-slice integration test (Step 7)

`apps/api/src/library/__tests__/library-advanced-vertical-slice.spec.ts` — **18 cases across 7 plan scenarios**:

- **S1 Reading list lifecycle** — visibility contract test: non-writer reads exercise the `is_published = true` SQL branch (drafts hidden from students).
- **S2 Class set checkout** — 25-copy INSERT chain produces exactly 1 parent INSERT + 25 child INSERTs + 25 copy flips, all carrying `class_set_checkout_id`. Refusal path: copyCount > available copies → 400.
- **S3 Class set overdue worker sweep** — SQL shape pinned (UPDATE filters `status IN ('ACTIVE','PARTIALLY_RETURNED') AND due_date < CURRENT_DATE`).
- **S4 Recommendations** — full-replace DELETE + INSERT contract; 20-cap on input of 30; student dismiss own succeeds; non-owner student blocked.
- **S5 Interlibrary loan state machine** — LENT-without-catalogueItemId refused; RETURNED → ACTIVE illegal transition refused; sweep UPDATE filters ACTIVE past due_date.
- **S6 Catalogue import dedup** — ISBN_BATCH inline-encodes as `inline://<json>` with all ISBNs round-tripping; empty isbns array refused; CSV_UPLOAD without sourceFileS3Key refused.
- **S7 Visibility + recommendation config admin gate** — student cannot create class sets; parents cannot create ILLs; teachers cannot create imports. Recommendation config: admin reads OK; librarian reads OK; teacher (no lib-002) blocked. Update path: librarian (no admin) refused; sum-≠-100 refused; balanced update succeeds + INSERT lands in `school_config` keyed `library_recommendation_weights`.

**Total library test count after P2-25:** `library-advanced.spec.ts` (30) + `library-advanced-vertical-slice.spec.ts` (18) = **48 cases**.

**Full vitest tally**: 1295 → **1343 passing across 64 spec files** (+48 across the 2 library specs).

---

## Decisions made during the cycle

- **Migration numbers 164 + 165** instead of plan-text 153/154 — 153 + 154 + others were taken by P2-19 / P2-20 / P2-21 / P2-22 / P2-23 / P2-24.
- **`school_config` instead of `platform_tenant_configs`** for recommendation weights — same carry-over as P2-24 engagement-score config; `platform_tenant_configs` does not exist; `school_config` is the canonical per-tenant key/value home from Cycle 0.
- **Recommendation weights — librarian read, admin write** — `lib-002:read` is held by every patron-side reader (librarians + admin); `lib-002:admin` / `lib-003:admin` are admin-tier only. The librarian can audit the current blend; only school admins can mutate.
- **Full-replace recommendations (DELETE all + INSERT)** — not upsert. Schema-level `student_id` index supports the bulk DELETE; the worker contract guarantees the freshly-replaced set always reflects the latest co-checkout graph + reading-level alignment without orphan "stuck" rows. Soft-hide via `dismissed_at` lives outside the replace pattern — `replaceForStudent` only touches rows for the target student, and the worker is responsible for filtering dismissed items out of its candidate pool before producing the fresh batch.
- **ISBN_BATCH inline encoding via `inline://<json>` prefix** — instead of round-tripping a tiny ISBN-list to S3 the service stores the list inline in `source_file_s3_key`. The worker recognises the `inline://` prefix and parses the JSON without an S3 read. Pragmatic for small batches typical of librarian onboarding; CSV / MARC paths continue to use real S3 keys.
- **`lib_recommendations` full-replace + cap at 20** — `RecommendationService.replaceForStudent` caps the input array at 20 before insertion (matches the partial INDEX `(student_id, score DESC) WHERE dismissed_at IS NULL` hot-path budget the per-student feed reads from).
- **Class set per-copy tracking** — instead of a counter-only model, every class set materialises N rows in `lib_checkouts` (one per copy). This means an overdue notification can name the specific outstanding barcodes, and partial returns can release individual copies back to the shelf as students hand them back rather than waiting for the whole set.

---

## Cross-cycle integration

- **Cycle 12 lib_catalogue_items + lib_items + lib_checkouts** — class sets materialise child `lib_checkouts` rows linked via the new `class_set_checkout_id` column; recommendations point at `lib_catalogue_items.id`; the catalogue-import worker writes new `lib_catalogue_items + lib_items` rows.
- **Cycle 23 cur_units** — `lib_reading_lists.curriculum_unit_id` is a soft UUID ref per ADR-001/020. The Step 4 service does not validate against `cur_units` at write time (display-only ref); pre-pilot may want to tighten with an EXISTS probe.
- **Future P3 AI Inference Service** — `lib_recommendations.reason_metadata` JSONB column reserved for embedding-vector context; when AI Inference deploys, the COLLABORATIVE_FILTERING strategy enhances from simple co-checkout counts to embedding-based similarity without a schema change.

---

## Permission distribution

- **LIB-002 (Circulation extended)** — librarian reads + writes everything (class sets, ILL, imports). Teachers can request class sets (their personId on `teacher_patron_id`). Parents + students read only the patron-facing surfaces.
- **LIB-003 (Reading Programmes extended)** — librarian + teacher create/edit reading lists; students + parents read published lists; students dismiss own recommendations; librarians moderate reviews.
- **`lib-002:admin` / `lib-003:admin`** — recommendation engine weight mutation. Held by School Admin + Platform Admin via `everyFunction`.

---

## Reviewer attention items (Phase 2 / pre-pilot punch list)

1. **`curriculum_unit_id` validation** — currently a soft UUID ref; pre-pilot tighten with `EXISTS` probe against `cur_units` at write time so a typo doesn't leave a dead link on the reading-list detail page.
2. **`lib_recommendations.dismissed_by` for student dismissals** — currently NULL because students lack `hr_employees` rows. Pre-pilot extend the audit trail with a soft polymorphic `dismissed_by_account_id` so the librarian dashboard can attribute dismissals back to the student account.
3. **LibraryRecommendationWorker cron deployment** — schema + `replaceForStudent` helper ready; the actual weekly job (per-student co-checkout aggregation + reading-level match + new-arrival surface + subject-tag overlap + staff-pick pull) ships in the next cycle that touches Library. Until then the seed plants representative data.
4. **CatalogueImportWorker MARC + WORLDCAT parsers** — ISBN_BATCH + CSV_UPLOAD paths ship a working worker. MARC + WORLDCAT_SYNC await format-specific parser libraries.
5. **`lib_recommendations.score` normalisation per strategy** — `replaceForStudent` accepts raw scores; pre-pilot wire the worker to normalise within each strategy (rank 0..1) then apply the configured weights to produce the final ranked list.
6. **AI embedding enhancement for COLLABORATIVE_FILTERING** — Phase 3 once AI Inference deploys.
7. **MARC record Z39.50/SRU live lookup** — manual import this cycle.
8. **Interlibrary loan request approval workflow between schools** — single-school today; cross-tenant district routing is Phase 3.
9. **Class set reservation calendar** — teachers can request future-dated class sets (the librarian schedules manually today); a calendar with overlap detection is a polish item.
10. **Digital resource lending (ebooks / audiobooks)** — out of scope this cycle.

---

## CI parity (this commit)

- format:check + lint:logs clean (940 files clean — +1 vertical-slice spec)
- API build clean
- Web build clean (4 new library routes ship 9.23–10.1 kB First Load JS)
- vitest **1343/1343 across 64 spec files** (+48 library cases: 30 unit + 18 vertical slice)

**Cumulative P2-25 totals:** 6 new base tables + 1 ALTER on Cycle 12 `lib_checkouts` + 2 ALTERs on Cycle 12 `lib_reading_lists` (target_grade_level + curriculum_unit_id columns) across 2 tenant migrations (164 + 165). ~22 endpoints across 5 new services. 1 Kafka emit topic (`lib.import.completed`). 4 web routes + recommendations shelf on `/library/my` + extended reading-list form. 18 vertical-slice integration tests across the 7 plan scenarios.

Awaiting peer review verdict before tagging `p2c25-complete`.

---

## REVIEW-P2C25 Round 1 fix log (2026-05-13)

Reviewer's Round 1 verdict against `5085572`: **FAIL** with 6 BLOCKING all in the same Phase 2 category — direct-object references and worker sweeps must be school-scoped all the way through mutation and reload paths.

All 6 BLOCKING + 19 new pinned regression tests landed in the Round 1 fix commit. No schema migrations — every fix is service-layer.

### BLOCKING 1 — Class-set `getById` / `returnCopies` lock / sweep school-scope

`apps/api/src/library/class-set.service.ts`

- `getById(id)` SELECT now reads `WHERE cs.id = $1::uuid AND cs.school_id = $2::uuid`. Cross-school UUIDs collapse to 404 don't-leak-existence.
- `returnCopies(id, input, actor)` parent lock SELECT now reads `WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE`; the final parent UPDATE carries the same predicate as defence-in-depth alongside the locked-row precondition.
- `sweepOverdueForCurrentTenant()` UPDATE now binds `WHERE school_id = $1::uuid` so a worker pass under one tenant's context cannot flip another tenant's class sets in a shared-schema future. The existing `search_path` SET LOCAL pins the schema; this is the row-level cross-school guard.

### BLOCKING 2 — Class-set teacher + classId validation school-scope

`apps/api/src/library/class-set.service.ts`

- `create()` teacher probe now `SELECT 1 FROM hr_employees WHERE person_id = $1::uuid AND school_id = $2::uuid LIMIT 1`. A School A librarian cannot create a class set against a School B employee's iam_person UUID — the foreign employee row returns 0 and the service throws 400.
- New `classId` validation runs before the INSERT chain when the optional `classId` is supplied: `SELECT 1 FROM sis_classes WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`. Cross-school class UUIDs return 400 with the canonical "classId does not match a class in this school" message.

### BLOCKING 3 — Recommendations cross-school hardening

`apps/api/src/library/recommendation.service.ts`

- `assertCanReadFor(studentId, actor)` rewritten with explicit per-actor school-scope:
  - admin/librarian — must prove the student exists in current-school `sis_students` (`SELECT 1 FROM sis_students WHERE id = $1 AND school_id = $2`).
  - STUDENT — joins through `sis_students s` + `platform.platform_students ps` with `s.school_id = $tenant.schoolId AND ps.person_id = $actor.personId`.
  - GUARDIAN — joins through `sis_student_guardians + sis_guardians + sis_students` with `s.school_id = $tenant.schoolId AND g.person_id = $actor.personId`.
- `SELECT_REC_BASE` constant rewritten to `FROM lib_recommendations r JOIN sis_students s ON s.id = r.student_id LEFT JOIN lib_catalogue_items ci …` so every read path proves the recommendation belongs to a student in this tenant via the JOIN.
- `listForStudent` adds `s.school_id = $2::uuid` predicate after the assertCanReadFor check — defence-in-depth.
- `dismiss()` lock query rewritten to `SELECT r.id, r.student_id, r.dismissed_at FROM lib_recommendations r JOIN sis_students s ON s.id = r.student_id WHERE r.id = $1 AND s.school_id = $2 FOR UPDATE OF r`. Student-self check also adds the `s.school_id` predicate.
- `replaceForStudent(studentId, fresh[])` validates the student belongs to this school BEFORE any mutation. After that, validates every `recommendedItemId` against `lib_catalogue_items WHERE school_id = $tenant.schoolId AND id = ANY($itemIds::uuid[])` — any missing ids surface as 400 with the offending UUIDs listed.

### BLOCKING 4 — Reading-list item mutation paths school-scope

`apps/api/src/library/reading-list.service.ts`

- `SELECT_LIST_ITEM_BASE` constant rewritten to JOIN `lib_reading_lists l ON l.id = i.reading_list_id` so every item read path can carry the school predicate.
- `listItems(listId)` adds `WHERE i.reading_list_id = $1::uuid AND l.school_id = $2::uuid`. Cross-school list UUIDs return an empty array.
- `patchItem(itemId, ...)` lock query rewritten to JOIN through the parent list: `SELECT i.id FROM lib_reading_list_items i JOIN lib_reading_lists l ON l.id = i.reading_list_id WHERE i.id = $1 AND l.school_id = $2 FOR UPDATE OF i`. Cross-school item UUIDs return 0 rows and the service throws 404 don't-leak-existence. The UPDATE statement carries a subquery on `reading_list_id IN (SELECT id FROM lib_reading_lists WHERE … AND school_id = $2)` as defence-in-depth alongside the locked-row precondition.
- `removeItem(itemId, ...)` rewritten to `DELETE FROM lib_reading_list_items i USING lib_reading_lists l WHERE i.reading_list_id = l.id AND i.id = $1 AND l.school_id = $2`. Cross-school item UUIDs return 0 rows.
- `loadItemOrFail(itemId)` adds `l.school_id = $2::uuid` predicate to the reload.

### BLOCKING 5 — ILL patch + sweep + LENT catalogue validation

`apps/api/src/library/interlibrary-loan.service.ts`

- `create()` LENT branch now validates `catalogueItemId` against `lib_catalogue_items WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1` BEFORE the INSERT. Foreign-school catalogue ids return 400 with the canonical "does not match a catalogue item in this school" message. BORROWED rows are unaffected (the `catalogueItemId` is optional for BORROWED — partner-supplied title may not be in our catalogue).
- `patch(id, input, actor)` lock query reads `SELECT id, status FROM lib_interlibrary_loans WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE`. The trailing UPDATE carries the same `id + school_id` predicate (the locked-row precondition + the UPDATE-side guard are belt-and-braces).
- `sweepOverdueForCurrentTenant()` UPDATE binds `WHERE school_id = $1::uuid AND status = 'ACTIVE' AND due_date < CURRENT_DATE` — a worker pass under one tenant cannot flip another tenant's ILL rows.

### BLOCKING 6 — Catalogue import `markTerminal` + intermediates school-scope

`apps/api/src/library/catalogue-import.service.ts`

The PARSING / IMPORTING / COMPLETED / FAILED updates all now carry `school_id` predicate:

- PARSING transition: `UPDATE lib_catalogue_import_jobs SET status='PARSING', started_at = now(), updated_at = now() WHERE id = $1::uuid AND school_id = $2::uuid`.
- IMPORTING transition: `UPDATE lib_catalogue_import_jobs SET status='IMPORTING', updated_at = now() WHERE id = $1::uuid AND school_id = $2::uuid`.
- `markTerminal()` (COMPLETED + FAILED): `UPDATE lib_catalogue_import_jobs SET status = $1, records_imported = $2, records_skipped = $3, records_failed = $4, error_log_s3_key = $5, completed_at = now(), updated_at = now() WHERE id = $6::uuid AND school_id = $7::uuid`. The `lib.import.completed` outbox enqueue runs inside the same tx as the terminal UPDATE so the durable contract is unchanged.

Even though `processQueuedJob` initially loads the job via a school-scoped SELECT, the Phase 2 convention is to thread the school predicate through every mutation — including worker-driven terminal states.

### Regression tests (19 new pinned cases)

`apps/api/src/library/__tests__/library-advanced-review-p2c25.spec.ts` — 19 cases across 6 REVIEW-P2C25 R-B1..6 describe blocks:

- **R-B1** × 3 — getById SQL shape; returnCopies parent lock SQL; sweep UPDATE binds to school_id.
- **R-B2** × 2 — hr_employees probe carries school_id arg; classId validation queries sis_classes with school_id.
- **R-B3** × 6 — student self-read joins sis_students with school predicate; guardian read joins through sis_students.school_id; librarian read also validates student belongs to school; list SQL joins through sis_students; dismiss lock JOIN + FOR UPDATE OF r; replaceForStudent refuses cross-school student + refuses cross-school items.
- **R-B4** × 3 — listItems / patchItem lock / removeItem DELETE all JOIN through lib_reading_lists.school_id.
- **R-B5** × 3 — patch lock + UPDATE shape; sweep UPDATE binds school_id; LENT catalogueItemId validated against school.
- **R-B6** × 1 — PARSING + IMPORTING + COMPLETED updates all carry school_id arg + outbox emit shape verified.

Plus 4 pre-existing `replaceForStudent` happy-path tests in `library-advanced.spec.ts` + `library-advanced-vertical-slice.spec.ts` updated to provide the new student-existence + item-ownership stubs.

### Test totals after Round 1

- `library-advanced.spec.ts` — 30 cases (unchanged)
- `library-advanced-vertical-slice.spec.ts` — 18 cases (unchanged)
- `library-advanced-review-p2c25.spec.ts` — 19 cases (new)

Library spec total: **67 cases**. Full vitest tally: 1343 → **1362 passing across 65 spec files**.

### CI parity (Round 1 fix commit)

- format:check + lint:logs (951 files clean)
- API build clean
- Web build clean (no UI changes)
- vitest **1362/1362 across 65 spec files**

Awaiting Round 2 verdict before tagging `p2c25-complete`.
