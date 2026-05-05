# Cycle 12 Handoff — Library

**Status:** Cycle 12 **COMPLETE — all 10 steps done + REVIEW-CYCLE12 Round 1 fixes applied.** Round 1 against `cycle12-complete` at `41b8736` returned **Reject pending fixes** with 4 BLOCKING items (3 row-scope leaks + 1 cross-tenant patron validation gap) + 3 MAJOR follow-ups (teacher review moderation scope / STAFF reading-log breadth / hold duplicate race) tracked as Phase 2 punch list per reviewer's gate decision. All 4 BLOCKING fixes landed in the closeout commit at HEAD of `main`, verified live on `tenant_demo` 2026-05-05. See `REVIEW-CYCLE12-CHATGPT.md` for the triage table + per-fix verification trail. Vertical-slice CAT at `docs/cycle12-cat-script.md` is unchanged; `lib.fine.issued` envelope was captured live with full ADR-057 shape during Round 1's CAT run. Awaiting Round 2 verdict. Cycle 12 ships the M24 Library module — 14 of the 20 ERD tables in scope across 4 domains (catalogue + locations + copies in Step 1; circulation policies + checkouts + holds + fines in Step 2; reading programmes + lists + reviews in Step 3). The 6 deferred tables (recommendations, class set checkouts, interlibrary loans, import jobs, AI scan sessions) park as Cycle 12.1 / Wave 3. Cycle 12 introduces the **first entirely new module prefix** (`lib_*`) since Cycle 10's `hlth_*`, ships the **second student-input surface** in CampusOS after Cycle 11.1 (students log reading entries + write book reviews — verified live in Step 7), and adds the librarian as the third specialist operator persona alongside the nurse (Cycle 10) and counsellor (Cycle 11). Backend phase complete: 46 endpoints across 10 services + 10 controllers + 1 Kafka emit. UI surface complete: 11 web routes (5 catalogue/circulation from Step 8 + 5 reading/reviews/student-portal from Step 9 + the persona-aware `/library` dashboard) + Library launchpad tile + `library-format.ts` helpers + `use-library.ts` hooks (~30 hooks) + ~300 lines of Library DTOs.

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle12-implementation-plan.html`
**Vertical-slice deliverable:** Librarian adds "The Giver" to the catalogue (ISBN, author, Dewey decimal) → adds 3 physical copies with unique barcodes to the Fiction shelf location → sets checkout policy (students: 14-day loan, 2 renewals, $0.25/day fine) → Maya checks out copy #1 by barcode scan → copy marked unavailable, due date calculated → Ethan places a hold on the same title (all copies out) → Maya returns the book after due date → overdue fine auto-calculated and `lib.fine.issued` emits to Kafka → Ethan's hold flips to READY (copy reassigned) → librarian creates "Summer Reading Challenge" programme (target: 10 books) → Maya logs "The Giver" as read → programme progress updates (1/10 books) → Maya writes a 4-star review → teacher creates a "Grade 5 Fiction" reading list with "The Giver" as a required item → students browse the catalogue and see the reading list + Maya's review.

This document tracks the Cycle 12 build at the same level of detail as `HANDOFF-CYCLE9.md` through `HANDOFF-CYCLE11.1.md`. It is the source of truth that external architecture reviewers read alongside `CLAUDE.md`. **A step is not complete until both files are current** (per the Operating Rules at the bottom of `CLAUDE.md`).

---

## Step status

| Step | Title                                                       | Status   |
| ---- | ----------------------------------------------------------- | -------- |
| 1    | Catalogue Schema — Locations + Items + Copies               | **DONE** |
| 2    | Circulation Schema — Policies + Checkouts + Holds + Fines   | **DONE** |
| 3    | Reading + Reviews Schema                                    | **DONE** |
| 4    | Seed Data — Catalogue, Copies, Policy, Checkouts, Programme | **DONE** |
| 5    | Catalogue NestJS Module                                     | **DONE** |
| 6    | Circulation NestJS Module                                   | **DONE** |
| 7    | Reading + Reviews NestJS Module                             | **DONE** |
| 8    | Library UI — Catalogue + Circulation                        | **DONE** |
| 9    | Library UI — Reading + Reviews + Student Portal             | **DONE** |
| 10   | Vertical Slice Integration Test                             | **DONE** |

---

## What this cycle adds on top of Cycle 11.1

Cycle 12 opens the Library module — the second-to-last cycle of Wave 2 Student Services (Cycle 13 Athletics & Clubs closes the wave). It is a clean greenfield surface with no cross-cycle dependencies on the wellbeing / counselling / health modules; the only existing-system touchpoints are the soft refs to `platform.iam_person` (used as the patron identity for checkouts and holds, covering both students and staff uniformly per the ADR-055 person model) and `sis_students` (used by the student-facing reading log and reviews).

- **Library catalogue infrastructure (M24 Domain 1, 3 tables in Step 1).** `lib_locations` is the named library locations catalogue (shelves, displays, processing areas, repair queue, storage). `lib_catalogue_items` is the bibliographic record — one row per title — with a **GIN full-text index on `to_tsvector('english', title || ' ' || COALESCE(author, ''))`** that backs the public catalogue search bar with `ts_rank` scoring + `plainto_tsquery` parsing. `lib_catalogue_copies` is the physical copy — one row per book on the shelf — with a UNIQUE barcode (the scannable spine identifier the circulation desk reads on every checkout / return) + `is_available` denormalised boolean for fast availability filters + 7-value `location_status` enum tracking the copy state across the building.
- **Circulation engine (Step 2, deferred).** Per-(school, patron_type) checkout policies, the checkout log with auto-fine calculation on overdue return, the hold queue with PENDING → READY → COLLECTED lifecycle, and fine tracking with `lib.fine.issued` Kafka emit for future Cycle 6 payment integration.
- **Reading programmes + reviews (Step 3, deferred).** Reading programmes with target_books / target_pages and per-(programme, student) progress rows. Reading lists curated by librarians or teachers with REQUIRED / RECOMMENDED / EXTENSION / REFERENCE per-item types. Student-facing reading log + book reviews — the second student-input surface in CampusOS after Cycle 11.1's wellbeing check-ins.
- **Patron identity model.** `lib_checkouts.patron_id` and `lib_holds.patron_id` reference `platform.iam_person(id)` so both students and staff are first-class patrons under one uniform identity — students borrow personal-reading material, teachers borrow professional development titles. `lib_reading_logs.student_id` and `lib_reviews.student_id` reference `sis_students(id)` because reading-programme participation and book reviews are student-only features.
- **Permission model.** New LIB-001 (catalogue), LIB-002 (circulation), LIB-003 (reading programmes + lists + reviews) functions. LIB-001:read is granted broadly (catalogue browsing is public to authenticated users); LIB-001:write is librarian-only. LIB-002:read covers patron self-service (own checkouts / holds / fines); LIB-002:write is librarian-only. LIB-003:read+write for students (log reading + write reviews), LIB-003:write for librarians (create programmes, curate lists). LIB-004 (Library Space, the optional study-room booking surface) is deferred entirely.
- **Cycle 6 payment integration emit lands without consumer.** `lib.fine.issued` envelope ships in Step 6; no Cycle 6 PaymentService consumer subscribes today (a school-config flag would convert the fine into a payable `pay_invoices` row). Documented Phase 2 follow-up.
- **Out-of-scope deferrals.** RANGE partitioning on `lib_checkouts` (simple table; partition when volume warrants). Redis caching of available-copies counts (computed on demand via the `is_available` denormalisation). `lib.programme.completed` Kafka emit for the Task Worker fan-out (programme completion certificate generation is a placeholder S3 key this cycle). lib_recommendations + AI inference, lib_class_set_checkouts (bulk teacher checkout flow), lib_interlibrary_loans, lib_catalogue_import_jobs, lib_scan_sessions all park.

What does not change: every existing module continues to function. Cycle 12 is purely additive.

---

## Step 1 — Catalogue Schema (Locations + Items + Copies)

**Status:** DONE. Migration applied cleanly to `tenant_demo` and `tenant_test` on 2026-05-05. Idempotent re-provision verified (zero new applies on the second run; tenant base table count stable at 178). Splitter-clean — Python state-machine audit (block-comment + line-comment + single-quoted-string aware with `''` escape handling) confirmed zero `;` outside legitimate statement terminators. **Fifteenth migration in a row to clear the splitter trap on first attempt** (Cycles 4–12 unbroken streak).

**Migration:** `packages/database/prisma/tenant/migrations/043_lib_catalogue.sql`.

**Migration numbering note:** the Cycle 12 plan calls for migrations `041_lib_catalogue.sql` / `042_lib_circulation.sql` / `043_lib_reading_reviews.sql`, but slots 041 and 042 were taken between plan-write and start-of-build by Phase 2 / REVIEW-CYCLE11.1 fix migrations (`041_sis_child_link_requests_dedup.sql` from `b58e591` and `042_svc_wellbeing_checkins_dedup.sql` from the Cycle 11.1 Round 2 closeout in `6d2b04c`). Cycle 12 therefore renumbers to **043 / 044 / 045**. The migration filenames are the only references to the numbers; the table names and the plan's narrative are unaffected.

**Tables (3):**

1. **`lib_locations`** — Named library locations driving the where-is-this-copy tracking on `lib_catalogue_copies`. `school_id UUID NOT NULL` (soft to `platform.schools(id)` per ADR-001/020), `name TEXT NOT NULL`, `location_type TEXT NOT NULL` 6-value CHECK `SHELF / DISPLAY / BOOK_DROP / PROCESSING / REPAIR / STORAGE`, `sort_order INT NOT NULL DEFAULT 0`, `is_active BOOLEAN NOT NULL DEFAULT true`. UNIQUE INDEX `(school_id, name)` so two locations cannot share a name in the same school. INDEX `(school_id, is_active)` for the active-locations browse path. Locations are deactivated rather than hard-deleted; the schema-side SET NULL on `lib_catalogue_copies.location_id` ensures a hard-delete of a location leaves copies addressable while their location is reassigned.

2. **`lib_catalogue_items`** — Bibliographic record. One row per title. `school_id UUID NOT NULL` (soft), `title TEXT NOT NULL`, `author TEXT` nullable, `isbn TEXT` nullable, `publisher TEXT` nullable, `publish_year INT` nullable, `category TEXT` nullable, `dewey_decimal TEXT` nullable (free-form because schools mix Dewey with custom shelf labels), `description TEXT` nullable, `cover_image_url TEXT` nullable. INDEX `(school_id, title)` for alphabetical browse. INDEX `(isbn)` for direct ISBN lookup from the librarian add-copy flow. **The keystone — GIN INDEX `USING GIN (to_tsvector('english', title || ' ' || COALESCE(author, '')))`** backs the public catalogue search bar with `ts_rank` scoring + `plainto_tsquery` parsing. `COALESCE(author, '')` ensures a missing author cannot null out the tsvector. The Step 5 `CatalogueItemService.search(q)` uses `plainto_tsquery('english', q)` against this index and orders by `ts_rank DESC`.

3. **`lib_catalogue_copies`** — Physical copy. One row per book on the shelf. `catalogue_item_id UUID NOT NULL FK to lib_catalogue_items(id) ON DELETE CASCADE` (a copy without its bibliographic record is meaningless), `location_id UUID FK to lib_locations(id) ON DELETE SET NULL` nullable (a copy survives a shelf retirement; the librarian then reassigns it), `barcode TEXT NOT NULL` UNIQUE across the tenant (the scannable identifier on the spine — the circulation desk hits this via `GET /library/copies/barcode/:barcode` to resolve copy + item + checkout state in one call), `condition TEXT NOT NULL DEFAULT 'NEW'` 5-value CHECK `NEW / GOOD / FAIR / POOR / LOST`, `is_available BOOLEAN NOT NULL DEFAULT true` (mirrors the available-vs-not state; flips false on checkout, true on return; denormalised so the catalogue list can compute available-copies count without joining `lib_checkouts`), `replacement_value NUMERIC(8,2)` nullable with `>= 0` CHECK (used by the Step 6 FineService when a copy is marked LOST), `location_status TEXT NOT NULL DEFAULT 'ON_SHELF'` 7-value CHECK `ON_SHELF / IN_BOOK_DROP / IN_PROCESSING / CHECKED_OUT / ON_HOLD_SHELF / IN_REPAIR / LOST`. UNIQUE INDEX `(barcode)`. INDEX `(catalogue_item_id, is_available)` for the per-item available-copies count hot path. Partial INDEX `(location_id) WHERE location_id IS NOT NULL` for the per-location browse path (excluding copies between locations).

**Soft cross-schema refs per ADR-001 / ADR-020:**

- `lib_locations.school_id → platform.schools(id)`
- `lib_catalogue_items.school_id → platform.schools(id)`

**FK summary — 2 new intra-tenant DB-enforced FKs:**

| FK                                                                 | Action   |
| ------------------------------------------------------------------ | -------- |
| `lib_catalogue_copies.catalogue_item_id → lib_catalogue_items(id)` | CASCADE  |
| `lib_catalogue_copies.location_id → lib_locations(id)`             | SET NULL |

0 cross-schema FKs.

**Tenant logical base table count after Step 1:** 175 → **178** (3 new logical base tables).

**Smoke results (live on `tenant_demo`, single BEGIN…ROLLBACK transaction with savepoints, 17 assertions, all green):**

1. **T1 happy path** — INSERT 2 locations + 1 catalogue item + 1 copy all succeed; copy linked through item + location.
2. **T2 location_type_chk** — rejects `BOGUS`.
3. **T3 UNIQUE(school_id, name)** on locations rejects duplicate `Smoke Fiction` row.
4. **T4 condition CHECK** — rejects `BOGUS` on `lib_catalogue_copies.condition`.
5. **T5 location_status CHECK** — rejects `BOGUS` on `lib_catalogue_copies.location_status`.
6. **T6 replacement_value CHECK** — rejects negative value (`-1.00`).
7. **T7 UNIQUE barcode** — rejects duplicate `LIB-FIC-SMOKE-001`.
8. **T8 FK rejection** on bogus `lib_catalogue_copies.catalogue_item_id`.
9. **T9 FK rejection** on bogus `lib_catalogue_copies.location_id`.
10. **T10 GIN full-text search KEYSTONE — title hit.** `to_tsvector(...) @@ plainto_tsquery('english', 'Giver')` returns `The Giver` with `ts_rank=0.06079271`.
11. **T11 GIN full-text search KEYSTONE — author surname hit.** `plainto_tsquery('english', 'Lowry')` returns `The Giver` (the COALESCE(author, '') concatenation is exercised) with `ts_rank=0.06079271`.
12. **T12 GIN full-text search miss.** `plainto_tsquery('english', 'Tolkien')` returns 0 hits.
13. **T13 ISBN INDEX lookup** — returns `The Giver` for the seeded ISBN `978-0544336261`.
14. **T14 partial available-copies INDEX path** — returns `available=1` for the new copy.
15. **T15 SET NULL on location delete** — DELETE of `Smoke Fiction` location leaves the copy intact with `location_id=NULL` (`location_cleared=true`).
16. **T16 CASCADE on parent item delete** — DELETE of `The Giver` catalogue item drops the linked copy (before=1, after=0).
17. **T17 pg_constraint catalog readout** confirms both FK delete actions: `lib_catalogue_copies_catalogue_item_id_fkey` is `c` (CASCADE), `lib_catalogue_copies_location_id_fkey` is `n` (SET NULL).

ROLLBACK at the end of the smoke leaves `tenant_demo` in pristine state (the 3 lib\_\* tables are still present and empty, ready for Step 4 seed).

Idempotent re-provision verified on `tenant_demo` (zero new applies on the second run; tenant base table count stable at 178). Both `tenant_demo` and `tenant_test` provisioned cleanly on the first attempt.

**Step 1 verified end-to-end. Ready for Step 2 (Circulation Schema — Policies + Checkouts + Holds + Fines).**

---

## Step 2 — Circulation Schema (Policies + Checkouts + Holds + Fines)

**Status:** DONE. Migration applied cleanly to `tenant_demo` and `tenant_test` on 2026-05-05. Idempotent re-provision verified (zero new applies on a third pass; tenant base table count stable at 182). Splitter trap **caught + fixed pre-provision** — Python state-machine audit flagged 1 stray `;` inside a `COMMENT ON TABLE ... IS '...'` string in the first draft (rewritten with a period before any provision attempt). Sixteenth migration in a row to clear the trap on first provision attempt **after audit** (Cycles 4–12 unbroken streak — the audit-then-provision discipline is what keeps the streak alive).

**Migration:** `packages/database/prisma/tenant/migrations/044_lib_circulation.sql` (per the Step 1 renumbering — slot 042 was taken by the Cycle 11.1 fix migration so Cycle 12 uses 043 / 044 / 045).

**Tables (4):**

1. **`lib_checkout_policies`** — Per-school per-patron-type loan policy. `school_id UUID NOT NULL` (soft to `platform.schools(id)` per ADR-001/020), `patron_type TEXT NOT NULL` 2-value CHECK `STUDENT / STAFF`, `max_checkouts INT NOT NULL >= 0` CHECK, `loan_period_days INT NOT NULL >= 0` CHECK, `renewals_allowed INT NOT NULL >= 0` CHECK, `overdue_fine_per_day NUMERIC(4,2) NOT NULL DEFAULT 0 >= 0` CHECK (0 marks a fine-free school; the column accommodates up to 99.99 per day in school local currency). UNIQUE INDEX `(school_id, patron_type)` so each school carries exactly one policy per patron type. The Step 6 CheckoutService reads this on every checkout to compute `due_date = checkout_date + loan_period_days`, gate on `max_checkouts`, and stamp the policy reference into the auto-fine calculation on return.

2. **`lib_checkouts`** — One row per (copy, patron) borrow event. `copy_id UUID NOT NULL FK to lib_catalogue_copies(id) NO ACTION` (financial-audit guard — refuses copy delete while checkouts exist; the librarian flips the copy to LOST or removes the parent catalogue item via the Step 1 CASCADE chain only after archiving the history), `patron_id UUID NOT NULL` (soft cross-schema ref to `platform.iam_person(id)` per ADR-001/020 — covers students and staff uniformly via the ADR-055 person model), `checkout_date DATE NOT NULL`, `due_date DATE NOT NULL` with `dates_chk: due_date >= checkout_date`, `returned_at TIMESTAMPTZ` nullable, `renewal_count INT NOT NULL DEFAULT 0 >= 0` CHECK, `status TEXT NOT NULL DEFAULT 'ACTIVE'` 4-value CHECK `ACTIVE / RETURNED / OVERDUE / LOST`. **Multi-column `returned_chk` keystone**: `((status IN ('ACTIVE','OVERDUE','LOST') AND returned_at IS NULL) OR (status='RETURNED' AND returned_at IS NOT NULL))` — pins returned_at to NULL across every working state and to NOT NULL on RETURNED. The Step 6 CheckoutService.return path stamps both columns atomically inside one tx. **3 indexes:** `(patron_id, checkout_date DESC)` for the my-checkouts view; partial INDEX `(copy_id) WHERE returned_at IS NULL` for the active-checkouts hot path the per-item availability check uses; partial INDEX `(due_date) WHERE status='OVERDUE'` for the overdue dashboard. The Step 6 service walks the OVERDUE flip in a periodic sweep when `due_date < today AND returned_at IS NULL`, then on return computes `days_overdue = return_date - due_date` and INSERTs a fine when positive.

3. **`lib_holds`** — Hold queue. `catalogue_item_id UUID NOT NULL FK to lib_catalogue_items(id) ON DELETE CASCADE` (queue rows have no value once the parent item is hard-deleted; the soft-delete path is `is_available=false` on copies), `patron_id UUID NOT NULL` (soft to `platform.iam_person(id)`), `placed_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `expires_at TIMESTAMPTZ` nullable with `window_chk: expires_at IS NULL OR expires_at > placed_at`, `status TEXT NOT NULL DEFAULT 'PENDING'` 5-value CHECK `PENDING / READY / COLLECTED / EXPIRED / CANCELLED`, `notified_at TIMESTAMPTZ` nullable. **Multi-column `pending_chk`**: `(status <> 'PENDING' OR notified_at IS NULL)` — pins notified_at to NULL while status is PENDING; once status flips to READY, notified_at populates and persists through every later transition (CANCELLED can happen from READY with notified_at populated, which is fine — the constraint only fires on PENDING). **3 indexes:** `(catalogue_item_id, status)` for the per-item hold-queue lookup; `(patron_id, status)` for the my-holds view; partial INDEX `(catalogue_item_id, placed_at) WHERE status='PENDING'` — the keystone the Step 6 HoldService.fulfillNext uses to find the oldest PENDING hold on a return (oldest-first via `ORDER BY placed_at ASC LIMIT 1`).

4. **`lib_fines`** — Outstanding fines. `checkout_id UUID NOT NULL FK to lib_checkouts(id) NO ACTION` (financial-audit guard mirroring lib_checkouts.copy_id — refuses checkout delete while a fine references it), `patron_id UUID NOT NULL` (soft to `platform.iam_person(id)`), `fine_type TEXT NOT NULL` 3-value CHECK `OVERDUE / LOST / DAMAGE`, `amount NUMERIC(6,2) NOT NULL >= 0` CHECK (up to 9999.99 in school currency — accommodates a full-replacement-value LOST fine), `days_overdue INT` nullable with `IS NULL OR >= 0` CHECK (populated for OVERDUE fines, nullable for LOST and DAMAGE), `status TEXT NOT NULL DEFAULT 'OUTSTANDING'` 3-value CHECK `OUTSTANDING / PAID / WAIVED`, `invoice_id UUID` nullable (soft cross-tenant ref to `pay_invoices(id)` for the future Cycle 6 payment integration consumer that will materialise a `pay_invoices` row when the school enables the integration; no DB-enforced FK because the consumer flow may flag a fine as payable without immediately creating the invoice — e.g. patron in a payment plan or manual review). **2 indexes:** `(patron_id, status)` for the my-fines view; `(checkout_id)` for the per-checkout fine lookup. The Step 6 FineService emits `lib.fine.issued` on INSERT with `status='OUTSTANDING'` for the future Cycle 6 payment integration consumer.

**Soft cross-schema refs per ADR-001 / ADR-020:**

- `lib_checkout_policies.school_id → platform.schools(id)`
- `lib_checkouts.patron_id → platform.iam_person(id)`
- `lib_holds.patron_id → platform.iam_person(id)`
- `lib_fines.patron_id → platform.iam_person(id)`
- `lib_fines.invoice_id → pay_invoices(id)` (soft, optional, populated by future Cycle 6 consumer)

**FK summary — 3 new intra-tenant DB-enforced FKs:**

| FK                                                      | Action    |
| ------------------------------------------------------- | --------- |
| `lib_checkouts.copy_id → lib_catalogue_copies(id)`      | NO ACTION |
| `lib_holds.catalogue_item_id → lib_catalogue_items(id)` | CASCADE   |
| `lib_fines.checkout_id → lib_checkouts(id)`             | NO ACTION |

0 cross-schema FKs.

**Tenant logical base table count after Step 2:** 178 → **182** (4 new logical base tables). **Cycle 12 schema phase running tally: 7 lib\_\* tables, 5 intra-tenant FKs (2 + 3).**

**Smoke results (live on `tenant_demo`, single BEGIN…ROLLBACK transaction with savepoints, 30 assertions, all green):**

1. **T1 happy-path policies** — INSERT 2 policies (STUDENT 5/14d/2/$0.25 + STAFF 20/30d/5/$0) succeed.
2. **T2 patron_type_chk** rejects `BOGUS`.
3. **T3 max_checkouts_chk** rejects `-1`.
4. **T4 fine_chk** rejects `-0.50`.
5. **T5 UNIQUE(school_id, patron_type)** rejects 2nd STUDENT row in the same school.
6. **T6 happy-path checkout** — INSERT ACTIVE row with `returned_at=NULL`.
7. **T7 returned_chk** rejects ACTIVE with `returned_at` populated.
8. **T8 returned_chk** rejects RETURNED without `returned_at`.
9. **T9 returned_chk** rejects OVERDUE with `returned_at` populated.
10. **T10 returned_chk happy path** — UPDATE ACTIVE → RETURNED with `returned_at=now()` succeeds atomically.
11. **T11 checkouts status_chk** rejects `BOGUS`.
12. **T12 dates_chk** rejects `due_date < checkout_date`.
13. **T13 renewal_chk** rejects `renewal_count=-1`.
14. **T14 FK rejection** on bogus `lib_checkouts.copy_id`.
15. **T15 happy-path hold** — PENDING with `notified_at=NULL`.
16. **T16 holds status_chk** rejects `BOGUS`.
17. **T17 pending_chk** rejects PENDING with `notified_at` populated.
18. **T18 pending_chk happy path** — READY with `notified_at` populated succeeds.
19. **T19 window_chk** rejects `expires_at < placed_at`.
20. **T20 happy-path fine** — OUTSTANDING OVERDUE $0.50 with days_overdue=2.
21. **T21 fine_type_chk** rejects `BOGUS`.
22. **T22 fine status_chk** rejects `BOGUS`.
23. **T23 amount_chk** rejects `-1.00`.
24. **T24 days_chk** rejects `days_overdue=-3`.
25. **T25 fine status round-trip** OUTSTANDING → PAID → WAIVED both UPDATEs accepted.
26. **T26 NO ACTION on lib_checkouts.copy_id** — DELETE of the copy with an active checkout REJECTED with the FK violation message ("Key (id) is still referenced from table lib_checkouts").
27. **T27 NO ACTION on lib_fines.checkout_id** — DELETE of the checkout with a fine REJECTED with the FK violation message.
28. **T28 CASCADE on lib_holds.catalogue_item_id** — DELETE of the parent catalogue item drops 2 holds → 0 in one statement (after first cleaning up the fines + checkouts).
29. **T29 EXPLAIN** confirms the partial INDEX `lib_holds_pending_placed_idx` is used by the planner for the Step 6 fulfillNext lookup query (`Index Scan using lib_holds_pending_placed_idx on lib_holds`).
30. **T30 pg_constraint catalog readout** confirms all 3 FK delete actions: `lib_checkouts_copy_id_fkey` is `a` (NO ACTION), `lib_fines_checkout_id_fkey` is `a` (NO ACTION), `lib_holds_catalogue_item_id_fkey` is `c` (CASCADE).

ROLLBACK at the end of the smoke leaves `tenant_demo` in pristine state (the 7 lib\_\* tables are still present and empty, ready for Step 4 seed).

**Iteration issue caught + fixed pre-provision:** the audit script flagged 1 stray `;` inside the `COMMENT ON TABLE lib_checkout_policies IS '...'` string ("STAFF and STUDENT are the two patron classes today; if the M80..."). Rewritten with a period before any provision attempt so the splitter never tripped. Sixteenth migration in a row to clear the trap on first provision attempt **after audit** (Cycles 4–12 unbroken streak — the audit-then-provision discipline is the load-bearing rule).

Idempotent re-provision verified on `tenant_demo` and `tenant_test` (zero new applies on the third pass; tenant base table count stable at 182). Both tenants provisioned cleanly.

**Step 2 verified end-to-end. Ready for Step 3 (Reading + Reviews schema — programmes + reading_logs + programme_progress + programme_completions + reading_lists + reading_list_items + reviews — 7 tables completing the Cycle 12 schema phase at 14 tables total).**

---

## Step 3 — Reading + Reviews Schema

**Status:** DONE. Migration applied cleanly to `tenant_demo` and `tenant_test` on 2026-05-05. Idempotent re-provision verified (zero new applies on the third pass; tenant base table count stable at 189). Splitter trap **caught + fixed pre-provision** — Python audit flagged 2 stray `;` instances inside a `lib_reviews` block-comment description ("means each student gets one review per item;..." and "via is_approved=false (soft hide; preserves the row...)"). Both rewritten with periods and split-clause restructure before any provision attempt. **Seventeenth migration in a row to clear the trap on first provision attempt after audit** (Cycles 4–12 unbroken streak).

**Migration:** `packages/database/prisma/tenant/migrations/045_lib_reading_reviews.sql` — the largest schema migration of Cycle 12 (7 tables in one file).

**Tables (7):**

1. **`lib_reading_programmes`** — Reading programme definition. `school_id UUID NOT NULL` (soft to `platform.schools(id)`), `academic_year_id UUID FK to sis_academic_years(id) NO ACTION` (nullable for evergreen programmes; programmes carry audit value beyond a year being archived), `target_books INT` and `target_pages INT` both nullable + non-negative CHECKs (a programme can use either or both metrics for its completion rule), `start_date DATE` and `end_date DATE` both nullable with `dates_chk: end_date >= start_date when both set`, `is_active BOOLEAN NOT NULL DEFAULT true`, `target_audience_type TEXT NOT NULL DEFAULT 'SCHOOL_WIDE'` 4-value CHECK `SCHOOL_WIDE / YEAR_GROUP / CLASS / CUSTOM`, `target_id UUID` nullable (soft polymorphic — `sis_classes(id)` for CLASS, year-group label encoded as UUID for YEAR_GROUP, NULL for SCHOOL_WIDE, resolved app-side for CUSTOM). 2 indexes: `(school_id, is_active)` for the active-programmes browse + partial INDEX `(academic_year_id) WHERE academic_year_id IS NOT NULL` for per-year programme rollups.

2. **`lib_reading_logs`** — **THE SECOND STUDENT-INPUT SURFACE in CampusOS after Cycle 11.1 wellbeing check-ins.** `student_id UUID NOT NULL FK to sis_students(id) ON DELETE CASCADE` (reading logs are personal student data and follow the student through deletion), `catalogue_item_id UUID NOT NULL FK to lib_catalogue_items(id) NO ACTION` (refuses hard-delete of a catalogue item while logs reference it — preserves the personal reading history), `started_date DATE` and `completed_date DATE` both nullable with `dates_chk`, `pages_read INT` nullable with `pages_chk: pages_read IS NULL OR pages_read >= 0`, `rating SMALLINT` nullable with `rating_chk: rating IS NULL OR rating BETWEEN 1 AND 5`, `review_text TEXT` nullable. 2 indexes: `(student_id, completed_date DESC)` for the my-history hot path + `(catalogue_item_id)` for per-item engagement metrics. The Step 7 `ReadingLogService` is the canonical writer; on `completed_date` set it auto-upserts the matching `lib_programme_progress` row when an active programme covers the student.

3. **`lib_programme_progress`** — Per-(programme, student) running totals. `programme_id UUID NOT NULL FK to lib_reading_programmes(id) ON DELETE CASCADE`, `student_id UUID NOT NULL FK to sis_students(id) ON DELETE CASCADE`, `books_read INT NOT NULL DEFAULT 0 >= 0` CHECK, `pages_read INT NOT NULL DEFAULT 0 >= 0` CHECK, `last_updated_at TIMESTAMPTZ` nullable, `is_complete BOOLEAN NOT NULL DEFAULT false`. UNIQUE INDEX `(programme_id, student_id)` so each student has exactly one progress row per programme. INDEX `(programme_id, is_complete)` for the leaderboard rollup. The Step 7 service emits `lib.programme.completed` on the flip to `is_complete=true` (Kafka emit deferred to a future cycle along with the corresponding TaskWorker auto-task rule for the certificate-generation worker).

4. **`lib_programme_completions`** — Award record. `programme_id UUID NOT NULL FK to lib_reading_programmes(id) NO ACTION` (preserves the award even when a programme is removed — the audit outlives the programme), `student_id UUID NOT NULL FK to sis_students(id) ON DELETE CASCADE` (awards follow the student), `completed_at TIMESTAMPTZ NOT NULL`, `books_read INT NOT NULL >= 0` CHECK, `pages_read INT NOT NULL >= 0` CHECK (both NOT NULL because the row captures the snapshot at award time — a later edit on `lib_programme_progress` does not retroactively change the award), `certificate_s3_key TEXT` nullable (until the future certificate-generation worker materialises the PDF), `awarded_by UUID FK to hr_employees(id) ON DELETE SET NULL` (audit outlives the awarding librarian), `achievement_id UUID` nullable (soft optional ref to a future `pfl_achievements` table). UNIQUE INDEX `(programme_id, student_id)` one award per student per programme. INDEX `(student_id, completed_at DESC)` for the my-awards view.

5. **`lib_reading_lists`** — Curated booklist. `school_id UUID NOT NULL` (soft), `list_type TEXT NOT NULL` 5-value CHECK `CLASS / YEAR_GROUP / CURRICULUM_UNIT / GENERAL / NEW_ARRIVALS`, `created_by UUID NOT NULL FK to hr_employees(id) NO ACTION` (list authorship has audit value beyond the creator leaving), `target_class_id UUID` nullable (soft to `sis_classes(id)` — populated when `list_type=CLASS`; no DB FK because the soft ref pattern follows ADR-001/020 for tenant tables that may target deactivated classes through their lifetime), `academic_year_id UUID FK to sis_academic_years(id) NO ACTION` nullable (for evergreen lists), `is_published BOOLEAN NOT NULL DEFAULT false`, `published_at TIMESTAMPTZ` nullable. **Multi-column `published_chk` keystone**: `((is_published=true AND published_at IS NOT NULL) OR (is_published=false AND published_at IS NULL))` — the Step 7 service stamps both atomically on publish and clears both atomically on unpublish. **UNIQUE INDEX `(school_id, name, COALESCE(academic_year_id, '00000000-0000-0000-0000-000000000000'::uuid))`** — the COALESCE-sentinel pattern matches Cycle 6 `enr_intake_capacities` and Cycle 5 `sch_periods` because Postgres treats `NULL != NULL` in UNIQUE by default and we want exactly one row per (school, name, NULL year). 3 indexes: the school-name-year UNIQUE + `(school_id, is_published)` for the published-lists browse + partial INDEX `(target_class_id) WHERE target_class_id IS NOT NULL` for the per-class-list reverse lookup.

6. **`lib_reading_list_items`** — Items inside a reading list. `reading_list_id UUID NOT NULL FK to lib_reading_lists(id) ON DELETE CASCADE` (list items are meaningless without their list), `catalogue_item_id UUID NOT NULL FK to lib_catalogue_items(id) NO ACTION` (refuses item delete while lists reference it — same pattern as `lib_reading_logs`), `item_type TEXT NOT NULL DEFAULT 'RECOMMENDED'` 4-value CHECK `REQUIRED / RECOMMENDED / EXTENSION / REFERENCE`, `sort_order INT NOT NULL DEFAULT 0 >= 0` CHECK, `added_by UUID NOT NULL FK to hr_employees(id) NO ACTION` (audit ref). UNIQUE INDEX `(reading_list_id, catalogue_item_id)` so an item appears at most once per list. 2 indexes: `(reading_list_id, sort_order)` for the ordered render + `(catalogue_item_id)` for the per-item reverse lookup ("which lists include this item?" rendered on the catalogue detail page).

7. **`lib_reviews`** — Student book reviews. `item_id UUID NOT NULL FK to lib_catalogue_items(id) NO ACTION` (refuses item delete while reviews reference it; soft-hide via `is_approved=false` is the supported moderation path), `student_id UUID NOT NULL FK to sis_students(id) ON DELETE CASCADE` (reviews are personal student data), `rating INT NOT NULL` with `rating_chk: rating BETWEEN 1 AND 5` (required and not nullable since a review without a rating is incomplete data), `review_text TEXT` nullable, `is_approved BOOLEAN NOT NULL DEFAULT true`. UNIQUE INDEX `(item_id, student_id)` — each student gets one review per item; the Step 7 service uses PATCH rather than re-POST for edits. INDEX `(item_id, is_approved)` for the per-item public review listing (filtered to `is_approved=true`).

**Soft cross-schema refs per ADR-001 / ADR-020:**

- `lib_reading_programmes.school_id → platform.schools(id)`
- `lib_reading_programmes.target_id → polymorphic by target_audience_type`
- `lib_reading_lists.school_id → platform.schools(id)`
- `lib_reading_lists.target_class_id → sis_classes(id)` (optional)
- `lib_programme_completions.achievement_id → future pfl_achievements(id)` (optional)

**FK summary — 15 new intra-tenant DB-enforced FKs:**

| FK                                                                    | Action    |
| --------------------------------------------------------------------- | --------- |
| `lib_reading_programmes.academic_year_id → sis_academic_years(id)`    | NO ACTION |
| `lib_reading_logs.student_id → sis_students(id)`                      | CASCADE   |
| `lib_reading_logs.catalogue_item_id → lib_catalogue_items(id)`        | NO ACTION |
| `lib_programme_progress.programme_id → lib_reading_programmes(id)`    | CASCADE   |
| `lib_programme_progress.student_id → sis_students(id)`                | CASCADE   |
| `lib_programme_completions.programme_id → lib_reading_programmes(id)` | NO ACTION |
| `lib_programme_completions.student_id → sis_students(id)`             | CASCADE   |
| `lib_programme_completions.awarded_by → hr_employees(id)`             | SET NULL  |
| `lib_reading_lists.created_by → hr_employees(id)`                     | NO ACTION |
| `lib_reading_lists.academic_year_id → sis_academic_years(id)`         | NO ACTION |
| `lib_reading_list_items.reading_list_id → lib_reading_lists(id)`      | CASCADE   |
| `lib_reading_list_items.catalogue_item_id → lib_catalogue_items(id)`  | NO ACTION |
| `lib_reading_list_items.added_by → hr_employees(id)`                  | NO ACTION |
| `lib_reviews.item_id → lib_catalogue_items(id)`                       | NO ACTION |
| `lib_reviews.student_id → sis_students(id)`                           | CASCADE   |

**Distribution: CASCADE × 6, NO ACTION × 8, SET NULL × 1.** 0 cross-schema FKs.

**Tenant logical base table count after Step 3:** 182 → **189** (7 new logical base tables). **Cycle 12 schema phase complete: 14 lib\_\* tables across 3 migrations (043 + 044 + 045), 20 intra-tenant FKs (2 + 3 + 15), 0 cross-schema FKs.**

**Smoke results (live on `tenant_demo`, single BEGIN…ROLLBACK transaction with savepoints, 35 assertions, all green):**

1. **T1 happy-path programme** — SCHOOL_WIDE programme with target_books=10 inserted.
2. **T2 audience_chk** rejects `BOGUS`.
3. **T3 target_books_chk** rejects `-1`.
4. **T4 dates_chk** rejects `end_date < start_date`.
5. **T5 happy-path reading log** — Maya logs The Giver completed with rating=4 (the second student-input surface verified end-to-end).
6. **T6 rating_chk** rejects `0`.
7. **T7 rating_chk** rejects `6`.
8. **T8 pages_chk** rejects `-5`.
9. **T9 dates_chk** rejects `completed_date < started_date`.
10. **T10 happy-path programme_progress** — 1 book, 240 pages.
11. **T11 UNIQUE(programme, student)** on progress rejects duplicate.
12. **T12 books_chk** on progress rejects `-1`.
13. **T13 happy-path programme_completion** — 10 books, 2400 pages, completed_at populated.
14. **T14 UNIQUE(programme, student)** on completion rejects duplicate.
15. **T15 happy-path reading list (DRAFT)** — `is_published=false` with `published_at=NULL`.
16. **T16 list_type_chk** rejects `BOGUS`.
17. **T17 published_chk** rejects `is_published=true` with `published_at=NULL`.
18. **T18 published_chk** rejects `is_published=false` with `published_at` populated.
19. **T19 published_chk happy path** — UPDATE flips `is_published=true` + `published_at=now()` atomically.
20. **T20 COALESCE-sentinel UNIQUE** rejects duplicate `(school, name, NULL year)` row.
21. **T21 COALESCE-sentinel UNIQUE accepts** same `(school, name)` with a different non-NULL `academic_year_id` (2 rows total — the sentinel pattern correctly distinguishes NULL-year from named-year).
22. **T22 happy-path reading_list_item** — REQUIRED item inserted.
23. **T23 list_items item_type_chk** rejects `BOGUS`.
24. **T24 UNIQUE(list, item)** rejects duplicate.
25. **T25 sort_chk** rejects `-1`.
26. **T26 happy-path review** — Maya rates The Giver 4/5 with review text.
27. **T27 reviews rating_chk** rejects `0`.
28. **T28 reviews rating_chk** rejects `6`.
29. **T29 UNIQUE(item, student)** on reviews rejects 2nd review by Maya on the same item.
30. **T30 NO ACTION on lib_reading_logs.catalogue_item_id** — DELETE of the catalogue item with reading logs REJECTED with the FK violation message.
31. **T32 CASCADE on lib_reading_lists** — DELETE of the parent list drops the linked list_item (1 → 0).
32. **T33 CASCADE on lib_reading_programmes** — DELETE of the parent programme drops the linked progress row (1 → 0; cleaned up the completions row first to avoid the NO ACTION block).
33. **T34 NO ACTION on lib_programme_completions.programme_id** — DELETE of a programme with a completion REJECTED.
34. **T35 pg_constraint catalog readout** confirms all 15 FK delete actions exactly: CASCADE × 6 (logs.student_id, progress.programme_id, progress.student_id, completions.student_id, list_items.reading_list_id, reviews.student_id); NO ACTION × 8 (programmes.academic_year_id, logs.catalogue_item_id, completions.programme_id, lists.created_by, lists.academic_year_id, list_items.catalogue_item_id, list_items.added_by, reviews.item_id); SET NULL × 1 (completions.awarded_by).

ROLLBACK at the end of the smoke leaves `tenant_demo` in pristine state — all 14 lib\_\* tables present and empty, ready for Step 4 seed.

**Iteration issues caught + fixed during smoke:** the first draft used `sis_students.first_name='Maya'` to pick the test student, but `sis_students` is a tenant projection that does NOT carry `first_name` directly — identity flows through `platform_students.person_id → iam_person.first_name` (cross-schema). The smoke fixed this by switching to `sis_students.student_number='S-1001'` and `'S-1002'` which are tenant-local identifiers seeded by `seed-sis`. Pattern noted for future Cycle 12 / 13 smokes — never join through cross-schema for student name lookup when the tenant-local `student_number` is sufficient.

Idempotent re-provision verified on `tenant_demo` and `tenant_test` (zero new applies on the third pass; tenant base table count stable at 189). Both tenants provisioned cleanly.

**Step 3 verified end-to-end. Cycle 12 schema phase complete: 14 tables, 20 intra-tenant FKs, 0 cross-schema FKs across 3 migrations. Ready for Step 4 (seed data + LIB-001..003 IAM grants).**

---

## Step 4 — Seed Data + LIB-001..003 IAM Grants

**Status:** DONE. New `packages/database/src/seed-library.ts` (idempotent, gated on `lib_locations` row count for the demo school) wired as `seed:library` in `package.json`. `seed-iam.ts` extended with LIB-001..003 grants across Teacher / Parent / Student / Staff. Live verification on `tenant_demo` 2026-05-05 — seed planted cleanly, idempotent re-run is a no-op, IAM cache rebuilt with the new grants reflected.

**Seed sections (12 covering all 14 lib\_\* tables, 35 rows total):**

A. **3 lib_locations rows** — "Fiction Shelves" (SHELF, sort=0), "Non-Fiction Shelves" (SHELF, sort=1), "New Arrivals Display" (DISPLAY, sort=2). All three rows feed the where-is-this-copy tracking in section C.

B. **5 lib_catalogue_items rows** — The Giver by Lois Lowry (ISBN 978-0544336261, Fiction, Dewey 813.54), Charlotte's Web by E. B. White, Number the Stars by Lois Lowry, Holes by Louis Sachar, Wonder by R. J. Palacio. Each carries author + ISBN + publisher + publish_year + category + dewey_decimal + cover_image_url placeholder. The GIN full-text index (Step 1 keystone) now backs `plainto_tsquery('english', 'Lowry')` returning 2 rows (The Giver + Number the Stars) and `'Sachar'` returning 1 row (Holes).

C. **11 lib_catalogue_copies rows** — 3 copies of The Giver (LIB-FIC-001 GOOD CHECKED_OUT, LIB-FIC-002 NEW available, LIB-FIC-003 FAIR available) + 2 each of Charlotte's Web (LIB-FIC-101/102) + Number the Stars (LIB-FIC-201/202) + Holes (LIB-FIC-301/302) + Wonder (LIB-FIC-401/402 on the New Arrivals Display). 3 + 2×4 = 11. (The plan's "12 copies" header in `docs/campusos-cycle12-implementation-plan.html` is an arithmetic typo — we ship 11 to match what the section actually plants. LIB-FIC-001 is the active checkout and is the only `is_available=false / location_status=CHECKED_OUT` row at seed time; the Step 6 CheckoutService will write the next state transitions.)

D. **2 lib_checkout_policies rows** — STUDENT (`max_checkouts=5, loan_period_days=14, renewals_allowed=2, overdue_fine_per_day=$0.25`) + STAFF (`max_checkouts=20, loan_period_days=30, renewals_allowed=5, overdue_fine_per_day=$0`). The seed exercises both rows of the UNIQUE(school_id, patron_type) keystone from Step 2.

E. **3 lib_checkouts rows** demonstrating all 3 working lifecycle states:

- **(1) Maya ACTIVE The Giver copy LIB-FIC-001** — checkout_date=today-5, due_date=today+9, returned_at=NULL, status=ACTIVE. 14-day loan from policy. The matching copy row from section C is `is_available=false / location_status=CHECKED_OUT`.
- **(2) Ethan RETURNED Charlotte's Web copy LIB-FIC-101** on time — checkout_date=today-17, due_date=today-3, returned_at=today-3, status=RETURNED. No fine (returned on or before due_date).
- **(3) Maya RETURNED Holes copy LIB-FIC-301 2 days overdue** — checkout_date=today-23, due_date=today-9, returned_at=today-7, status=RETURNED. Generates the OVERDUE fine in section G.

F. **1 lib_holds row** — Ethan PENDING on The Giver (placed today-2). Demonstrates the queue-when-no-copies-available state. The Step 6 HoldService.fulfillNext walks this row when LIB-FIC-001 is returned via the partial INDEX `(catalogue_item_id, placed_at) WHERE status='PENDING'`.

G. **1 lib_fines row** — Maya OUTSTANDING $0.50 OVERDUE on the Holes return: 2 days × $0.25/day = $0.50. Status=OUTSTANDING. Linked to the section E (3) checkout. The Step 6 FineService will emit `lib.fine.issued` on real-runtime fine creation; the seed bypasses Kafka emits for historical data setup.

H. **1 lib_reading_programmes row** — "Summer Reading Challenge 2026" SCHOOL_WIDE, `target_books=10`, ACTIVE, runs today-30 → today+180. The Step 7 ReadingProgrammeService dashboard lists this programme as the active school-wide challenge.

I. **1 lib_programme_progress row** for Maya — `books_read=2, pages_read=313, is_complete=false` (Holes 233 pages + Charlotte's Web 80 pages so far). UNIQUE(programme_id, student_id) keystone from Step 3 means Maya has exactly one progress row per programme.

J. **2 lib_reading_logs rows** for Maya (the SECOND STUDENT-INPUT SURFACE):

- **Holes COMPLETED** — started=today-23, completed=today-7, pages_read=233, rating=4, review text.
- **Charlotte's Web IN PROGRESS** — started=today-3, pages_read=80, completed_date=NULL (the Step 7 student UI renders these as the in-progress card). No rating until completion.

K. **1 lib_reading_lists row + 3 lib_reading_list_items rows** — "Grade 5 Fiction Essentials" CLASS type, created_by=Mitchell, `is_published=true` with `published_at` populated atomically per the multi-column `published_chk` keystone from Step 3. 3 items in sort_order: The Giver REQUIRED (sort=0), Charlotte's Web RECOMMENDED (sort=1), Number the Stars EXTENSION (sort=2). UNIQUE(reading_list_id, catalogue_item_id) means each item appears at most once per list.

L. **1 lib_reviews row** — Maya rates Holes 4/5 with review_text "A really clever story...". `is_approved=true` (the librarian moderation soft-hide path is `is_approved=false`). UNIQUE(item_id, student_id) means Maya gets exactly one review per item — the Step 7 ReviewService PATCH endpoint is the edit path.

**`seed-iam.ts` extensions (4 role updates; catalogue total stays at 450 — LIB-001..003 already exist in `permissions.json`):**

- **Teacher** gains `LIB-001:read` + `LIB-002:read` + `LIB-003:write` (3 new perms; total 47 → 50). Comment explains: teachers browse the catalogue + see own staff checkouts/holds/fines + create or curate reading lists. Teachers do NOT receive `LIB-001:write` (only librarian adds items + copies) or `LIB-002:write` (only librarian processes checkout/return/renew).
- **Parent** gains `LIB-001:read` (1 new perm; total 23 → 24). Comment explains: parents browse the catalogue so they can see what their child is reading. Parents do NOT receive LIB-002:read in this cycle — child checkout/hold/fine visibility is a future polish (parent UI on `/children/[id]/library` once that surface ships).
- **Student** gains `LIB-001:read` + `LIB-002:read` + `LIB-003:read+write` (4 new perms; total 20 → 24). Comment marks **`LIB-003:read+write` as the SECOND STUDENT-INPUT PERMISSION in CampusOS after Cycle 11.1 wellbeing's COU-004:read** — students log reading + write reviews; row scope at the Step 7 ReadingLogService + ReviewService binds them to their own `student_id`.
- **Staff** gains `LIB-001:read+write` + `LIB-002:read+write` + `LIB-003:write` (5 new perms; total 49 → 54). Comment explains: Staff covers the librarian (and any other staff who help at the circulation desk). LIB-001 read+write for catalogue + locations + copies management. LIB-002 read+write for checkout/return/renew/hold-fulfil + fine management. LIB-003 write for programme + reading list + review moderation. School Admin and Platform Admin pick up the admin tier (catalogue-import, hard-delete, library analytics dashboard) via the `everyFunction` grant.

**Live LIB grant distribution** verified via direct query against `iam_effective_access_cache`:

| persona                   | lib-001:read | lib-001:write | lib-002:read | lib-002:write | lib-003:read | lib-003:write |
| ------------------------- | ------------ | ------------- | ------------ | ------------- | ------------ | ------------- |
| admin@ (Platform Admin)   | ✓            | ✓             | ✓            | ✓             | ✓            | ✓             |
| principal@ (School Admin) | ✓            | ✓             | ✓            | ✓             | ✓            | ✓             |
| vp@ (Staff)               | ✓            | ✓             | ✓            | ✓             | —            | ✓             |
| counsellor@ (Staff)       | ✓            | ✓             | ✓            | ✓             | —            | ✓             |
| teacher@                  | ✓            | —             | ✓            | —             | —            | ✓             |
| **student@**              | ✓            | —             | ✓            | —             | **✓**        | **✓**         |
| parent@                   | ✓            | —             | —            | —             | —            | —             |

(Student `lib-003:read` is the second student-input read permission. Student `lib-003:write` lets them log books + write reviews — server-side row scope at Step 7 binds writes to own `student_id`.)

**IAM cache rebuilt:** 7 account-scope pairs — admin/principal **450**, teacher **50** (+3), parent **24** (+1), student **24** (+4), vp/counsellor **54** (+5).

**Live row counts on `tenant_demo` after seed:** locations=3, items=5, copies=11 (1 CHECKED_OUT), policies=2, checkouts=3 (1 ACTIVE / 2 RETURNED), holds=1 (1 PENDING), fines=1 (1 OUTSTANDING), programmes=1 (1 ACTIVE), programme_progress=1 (Maya 2/10 books), programme_completions=0 (Maya not yet at target), reading_logs=2 (1 completed + 1 in-progress), reading_lists=1 (1 published), reading_list_items=3 (REQUIRED + RECOMMENDED + EXTENSION), reviews=1 (1 approved). All match the plan exactly.

**Idempotent re-run** logs `lib_locations already populated for demo school — skipping` with no INSERTs. `tenant_test` stays empty by convention (the seed targets `tenant_demo` only, matching the seed-classroom / seed-messaging / seed-counselling / seed-wellbeing precedent).

**Iteration issues caught + fixed during seed:** plan said "12 copies" but the math (3 of The Giver + 2 each of the 4 other titles) is 11. Section header on `console.log` corrected to "11 copies"; block comment header notes the discrepancy. No data integrity impact — the seed plants the 11 rows the math supports.

Tenant base table count unchanged at 189 (data only — no DDL in Step 4). Cycle 12 seeded surface: **35 rows across 14 lib\_\* tables + 13 new role-permission rows** (3+1+4+5).

**Step 4 verified end-to-end. Ready for Step 5 (Catalogue NestJS Module — LocationService + CatalogueItemService + CopyService + the keystone `GET /library/copies/barcode/:barcode` lookup + the GIN-backed catalogue search).**

---

## Step 5 — Catalogue NestJS Module

**Status:** DONE. New module at `apps/api/src/library/` with 3 services + 3 controllers + DTO module + LibraryModule wired into AppModule between WellbeingModule and the global guards. **12 endpoints** total under the `/library` URL prefix. Build clean (`pnpm --filter @campusos/api build` → `nest build` succeeds). Live verification on `tenant_demo` 2026-05-05 — 8 scenarios all green covering the GIN search keystone, the barcode lookup keystone, all 5 personas across the read paths, and the librarian-only write paths.

**Module structure:**

```
apps/api/src/library/
├── dto/library.dto.ts                # 3 enum const arrays + 12 DTO classes
├── location.service.ts               # lib_locations CRUD
├── location.controller.ts            # 4 endpoints
├── catalogue-item.service.ts         # GIN search + getById with rollups
├── catalogue-item.controller.ts      # 5 endpoints
├── copy.service.ts                   # barcode lookup keystone + CRUD
├── copy.controller.ts                # 3 endpoints
└── library.module.ts                 # Wires TenantModule + IamModule
```

**12 endpoints (all under `/library/` prefix):**

| Verb  | Path                        | Permission      | Notes                                                                        |
| ----- | --------------------------- | --------------- | ---------------------------------------------------------------------------- |
| GET   | `/locations`                | `lib-001:read`  | Active locations only by default; `?includeInactive=true` shows deactivated. |
| GET   | `/locations/:id`            | `lib-001:read`  | Single location lookup.                                                      |
| POST  | `/locations`                | `lib-001:write` | Librarian / admin. UNIQUE(school, name) catch.                               |
| PATCH | `/locations/:id`            | `lib-001:write` | Update name / type / sort / `is_active`.                                     |
| GET   | `/catalogue`                | `lib-001:read`  | **GIN full-text search keystone** — `?q=` via plainto_tsquery + ts_rank.     |
| GET   | `/catalogue/:id`            | `lib-001:read`  | With copies inlined + rollups (totalCopies / available / activeHolds / avg). |
| GET   | `/catalogue/:id/copies`     | `lib-001:read`  | Per-item copy list with location_name joined.                                |
| POST  | `/catalogue`                | `lib-001:write` | Librarian / admin creates a catalogue item.                                  |
| PATCH | `/catalogue/:id`            | `lib-001:write` | Locks the row inside one tenant tx + dynamic SET-clause builder.             |
| GET   | `/copies/barcode/:barcode`  | `lib-001:read`  | **BARCODE LOOKUP KEYSTONE** — copy + item + activeCheckout + pendingHolds.   |
| POST  | `/catalogue/:itemId/copies` | `lib-001:write` | Add a copy under a catalogue item. UNIQUE(barcode) + FK catches.             |
| PATCH | `/copies/:id`               | `lib-001:write` | Update condition / location / availability / replacement value.              |

**Service contracts:**

- **`LocationService`** — admin OR holds `lib-001:write` for writes; reads gated only by the controller's `lib-001:read` decorator. UNIQUE(school_id, name) violation surfaces "A library location named '<name>' already exists in this school" with 400. PATCH locks the row inside `executeInTenantTransaction` + dynamic SET-clause builder. Reads are tenant-scoped — `WHERE school_id = $1::uuid` is added unconditionally.

- **`CatalogueItemService`** — `search(q, category, author, limit)` is the GIN keystone. When `q` is supplied, the WHERE clause adds `to_tsvector('english', i.title || ' ' || COALESCE(i.author, '')) @@ plainto_tsquery('english', $q)` and the ORDER BY uses `ts_rank` against the same expression. Without `q`, the result is alphabetical by title. `category` filter is exact-match; `author` filter is `ILIKE '%<author>%'` for substring match. Limit defaults to 50, capped at 200. Each search hit row carries `totalCopies` + `availableCopies` + `averageRating` + `reviewCount` computed by sub-selects against the live circulation + reviews state. `getById` adds `activeHoldsCount` + the full inlined copies array (joined to `lib_locations` for `locationName`).

- **`CopyService`** — **`lookupByBarcode(barcode)` keystone** runs three round-trips: (1) `lib_catalogue_copies` JOIN `lib_locations` JOIN `lib_catalogue_items` to find the copy in this tenant; (2) `CatalogueItemService.loadItemOrFail` to get the parent item with rollups; (3) a LEFT JOIN against `lib_checkouts` + `platform.iam_person` to find the active checkout (if any) with patron name + days_until_due. Throws 404 with the barcode in the message when no copy matches. The Step 6 CheckoutService will call this same path on every scan to validate availability before flipping the copy state. `create` validates the parent item exists in this tenant (via `loadItemOrFail`), then INSERTs with `is_available=true / location_status='ON_SHELF'` defaults; UNIQUE(barcode) catch surfaces 400 + a clear FK rejection message on bogus `locationId`. `patch` locks the row inside `executeInTenantTransaction` + dynamic SET-clause builder; the Step 6 service is the canonical writer of `is_available` + `location_status` during the checkout / return / hold-fulfil lifecycle, but the librarian PATCH path is the manual-override route.

**Live verification on `tenant_demo` 2026-05-05 (8 scenarios across R1–R8 all green; ~25 individual assertions):**

- **R1 locations browse — all 5 personas (admin / principal / teacher / student / parent) see 3 locations** via `lib-001:read`.
- **R2 GIN search keystone:** `?q=Lowry` returns `['Number the Stars', 'The Giver']` (both Lois Lowry titles); `?q=Giver` returns `['The Giver']`; `?q=Sachar` returns `['Holes']` (author surname hit); `?q=Tolkien` returns `[]` (miss); `?q=Wonder` returns `['Wonder']`. The browse path returns 5 titles alphabetically.
- **R3 getById with rollups + copies inlined:** `The Giver` reports `totalCopies=3, availableCopies=2, activeHoldsCount=1, reviewCount=0, averageRating=null`; all 3 copies inlined with `locationName='Fiction Shelves'` joined; LIB-FIC-001 shows `CHECKED_OUT / available=False`, the other 2 ON_SHELF / available.
- **R4 barcode lookup KEYSTONE:** `LIB-FIC-001` resolves with `copy + item + activeCheckout=Maya Chen + dueDate=2026-05-14 + daysUntilDue=9 + pendingHolds=1` in one round-trip; `LIB-FIC-002` returns `activeCheckout=None`; `BOGUS-123` returns 404; **student and parent both 200** on the barcode endpoint (lib-001:read is public to authenticated users).
- **R5 per-item /copies endpoint:** principal sees the 3 Giver copies with location_name joined and live `is_available` flags.
- **R6 librarian-only writes:** student POST /locations → **403**; parent POST /catalogue → **403**; teacher POST /catalogue → **403** (lib-001:write is librarian-only); principal POST /catalogue → **201**; principal POST /catalogue/:id/copies → **201**; principal POST same barcode → **400** UNIQUE catch ("A copy with barcode 'LIB-SMOKE-001' already exists"); principal POST bogus `locationId` → **400** FK catch; student PATCH copy → **403**; principal PATCH copy → **200**.
- **R7 GIN sees the new write through:** `?q=Smoke` immediately returns the new "Smoke Test Book" row (Postgres maintains the GIN INDEX on every INSERT/UPDATE that touches title or author); barcode lookup LIB-SMOKE-001 resolves cleanly.
- **R8 cleanup:** smoke residue dropped via `DELETE FROM lib_catalogue_copies WHERE barcode='LIB-SMOKE-001'; DELETE FROM lib_catalogue_items WHERE title='Smoke Test Book'`. Tenant restored to seed shape (items=5, copies=11, locations=3).

**Iteration issues caught + fixed during smoke:**

1. **`ParseIntPipe({ optional: true })` returns 400 instead of passing undefined through.** First draft on `CatalogueItemController.search` had `@Query('limit', new ParseIntPipe({ optional: true })) limit?: number` which produced `Validation failed (numeric string is expected)` whenever `?limit=` was missing. Switched to a hand-roll: `@Query('limit') limit?: string` then `Number(limit)` with `isNaN` guard in the controller body. Pattern noted for any future endpoint that wants an optional integer query param — `ParseIntPipe` with `optional:true` doesn't behave consistently across NestJS versions.

2. **The host had two stale `node apps/api/dist/main.js` processes from earlier session work** holding port 4000 — `pkill -f "node apps/api/dist/main.js"` plus an explicit `kill -9 <pid>` against the LISTEN PID surfaced by `ss -tnlp` cleared them. Booting a fresh instance with `nohup ... > log 2>&1 &` + `disown` + an `until curl ... | grep -q 200` readiness loop is the canonical smoke pattern.

**No backend changes outside `apps/api/src/library/`** — Step 5 sits entirely on the schema from Steps 1 + 2 + 3 and the seed from Step 4. No Kafka emits this step (those land in Step 6 with `lib.fine.issued`).

**Step 5 verified end-to-end. Ready for Step 6 (Circulation NestJS Module — CheckoutService + HoldService + FineService with the checkout-by-barcode keystone, auto-fine calculation on return, hold-queue PENDING → READY reassignment, and the `lib.fine.issued` Kafka emit).**

---

## Step 6 — Circulation NestJS Module

**Status:** DONE. New surface at `apps/api/src/library/` extends LibraryModule with 3 more services + 3 more controllers + 16 new endpoints + 1 Kafka emit topic (`lib.fine.issued`). Cycle 12 endpoint count after Step 6: **28** (12 from Step 5 + 16). Build clean (`pnpm --filter @campusos/api build` → `nest build` succeeds). Live verification on `tenant_demo` 2026-05-05 — 11 scenarios across R1–R11 all green covering the keystone checkout-by-barcode flow, max_checkouts enforcement, renewal limit, return + auto-fine + hold reassignment, fine pay/waive, and the full 5-persona row-scope contract. **`lib.fine.issued` ADR-057 wire envelope captured live** on `dev.lib.fine.issued`.

**Module additions:**

```
apps/api/src/library/
├── checkout.service.ts           # NEW — keystone checkout + return + renew
├── checkout.controller.ts        # NEW — 7 endpoints
├── hold.service.ts               # NEW — placeHold + cancel + collect
├── hold.controller.ts            # NEW — 5 endpoints
├── fine.service.ts               # NEW — list + pay + waive
├── fine.controller.ts            # NEW — 4 endpoints
├── dto/library.dto.ts            # extended with circulation enums + 7 DTO classes
└── library.module.ts             # registers the 3 new services + 3 controllers + KafkaModule
```

**16 new endpoints (cycle running total: 28):**

| Verb  | Path                            | Permission      | Notes                                                                                                                                                                                                               |
| ----- | ------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET   | `/library/checkout-policies`    | `lib-002:read`  | List policies (one per patron type) for the patron-facing loan-window display.                                                                                                                                      |
| GET   | `/library/checkouts`            | `lib-002:read`  | Patron sees own (row-scoped); librarian sees all. Optional `status` / `patronId` / `onlyActive` filters.                                                                                                            |
| GET   | `/library/checkouts/overdue`    | `lib-002:read`  | Librarian dashboard. Service-layer 403 for non-librarians.                                                                                                                                                          |
| GET   | `/library/checkouts/:id`        | `lib-002:read`  | Single checkout lookup.                                                                                                                                                                                             |
| POST  | `/library/checkouts`            | `lib-002:write` | **CHECKOUT-BY-BARCODE KEYSTONE** — accept barcode or copyId + patronId; locks copy, validates max_checkouts policy, creates checkout, flips copy state in one tx.                                                   |
| POST  | `/library/checkouts/:id/return` | `lib-002:write` | **RETURN KEYSTONE** — stamps returned_at + auto-fine if overdue + hold-queue reassignment + emits `lib.fine.issued` when fine > 0.                                                                                  |
| POST  | `/library/checkouts/:id/renew`  | `lib-002:write` | Validates renewal_count < policy.renewals_allowed; extends due_date by policy.loan_period_days; clears OVERDUE status.                                                                                              |
| GET   | `/library/holds`                | `lib-002:read`  | Patron sees own (row-scoped); librarian sees all.                                                                                                                                                                   |
| GET   | `/library/holds/:id`            | `lib-002:read`  | Single hold with queue position when `status=PENDING`.                                                                                                                                                              |
| POST  | `/library/holds`                | `lib-002:read`  | **SELF-SERVICE** — gated on lib-002:read because hold placement is patron-driven. Defaults patronId to `actor.personId`; librarians can pass an explicit patronId via the service-layer `hasLibrarianScope` branch. |
| PATCH | `/library/holds/:id/cancel`     | `lib-002:read`  | Patron cancels own (service-layer row-scope); librarian cancels any.                                                                                                                                                |
| PATCH | `/library/holds/:id/collect`    | `lib-002:write` | Librarian-only. Hold must be `READY`; flips to `COLLECTED`. Does not auto-create a checkout.                                                                                                                        |
| GET   | `/library/fines`                | `lib-002:read`  | Patron sees own (row-scoped); librarian sees all (default OUTSTANDING-first sort).                                                                                                                                  |
| GET   | `/library/fines/:id`            | `lib-002:read`  | Single fine; non-owner patrons get 404 don't-leak-existence.                                                                                                                                                        |
| PATCH | `/library/fines/:id/pay`        | `lib-002:write` | Librarian / admin marks PAID. Refused on non-OUTSTANDING.                                                                                                                                                           |
| PATCH | `/library/fines/:id/waive`      | `lib-002:admin` | School admin only — financial write-off authority. Reason required.                                                                                                                                                 |

**Service contracts:**

- **`CheckoutService`** is the keystone module. **`checkout(input, actor)`** — librarian-or-admin only via `hasLibrarianScope` (admin OR holds `lib-002:write`); `resolvePatronType(personId)` joins through `platform.platform_students` first then `hr_employees` to determine patron class; `loadPolicy(patronType)` reads the matching `lib_checkout_policies` row + throws a friendly 400 when no policy is configured for that patron class; the flow runs entirely inside `executeInTenantTransaction` with `SELECT … FOR UPDATE` on the copy row to serialise concurrent scans, validates `is_available=true` + counts active checkouts vs `policy.maxCheckouts`, INSERTs the checkout with `due_date = CURRENT_DATE + (policy.loanPeriodDays || ' days')::interval`, and UPDATEs the copy to `is_available=false / location_status='CHECKED_OUT'` atomically. `loanPeriodDays` accepts an optional override on the request DTO for short-loan reading-room copies. **`returnCheckout(id, actor)`** locks the checkout row + computes `days_overdue = GREATEST(CURRENT_DATE - due_date, 0)::int`, stamps `returned_at + status='RETURNED'`, and when `days_overdue > 0 AND policy.overdueFinePerDay > 0` INSERTs an OVERDUE fine row with `amount = round(days × rate × 100)/100` to dodge floating-point imprecision; then walks the hold queue — `SELECT … FROM lib_holds WHERE catalogue_item_id = $1 AND status='PENDING' ORDER BY placed_at ASC LIMIT 1 FOR UPDATE` finds the oldest waiting hold; if found, the hold flips to `READY` with `notified_at=now()` and the copy walks to `ON_HOLD_SHELF / is_available=false`; otherwise the copy returns to `ON_SHELF / is_available=true`. **`lib.fine.issued` emits AFTER the tx commits** so a Kafka hiccup can't roll back the patron's return; the future Cycle 6 payment-integration consumer will subscribe to materialise a `pay_invoices` row when the school enables the integration. **`renew(id, actor)`** locks the row, validates ACTIVE or OVERDUE status + renewal_count < policy.renewalsAllowed, then extends due_date by `policy.loanPeriodDays || ' days'` and resets status to ACTIVE (so renewing an OVERDUE checkout clears the OVERDUE flag).

- **`HoldService`** — `placeHold(input, actor)` defaults `patronId` to `actor.personId` for self-service; if an explicit `patronId !== actor.personId` is supplied, `hasLibrarianScope` is the access gate. Validates the catalogue item exists in this tenant + has at least one copy. Refuses to stack a duplicate `PENDING` or `READY` hold by the same patron on the same item (no schema-side UNIQUE — service-layer pre-check is sufficient because schools may legitimately re-place a CANCELLED or EXPIRED hold). `cancel(id, actor)` locks the row, refuses terminal states, and gates the row-scope check via `hasLibrarianScope OR row.patron_id === actor.personId`. `collect(id, actor)` is librarian-only (the patron picks up at the desk; the librarian taps Collect). The hold-queue reassignment logic lives inside `CheckoutService.returnCheckout` rather than as a separate `fulfillNextHold` helper because it always runs inside the same locked tx.

- **`FineService`** — `list(actor, args)` row-scopes patrons to own + librarians to all (default OUTSTANDING-first sort by SQL CASE). `getById(id, actor)` returns 404 don't-leak-existence to non-owner patrons. `pay(id, actor)` is `hasLibrarianScope`-gated; refused on non-OUTSTANDING fines. **`waive(id, body, actor)` is `actor.isSchoolAdmin`-gated** — the financial-write-off decision belongs to admin authority, not the librarian; reason is required.

**`lib.fine.issued` Kafka payload (ADR-057 envelope captured live):**

```json
{
  "event_type": "lib.fine.issued",
  "source_module": "library",
  "tenant_id": "<schoolId>",
  "payload": {
    "fineId": "<lib_fines.id>",
    "checkoutId": "<lib_checkouts.id>",
    "patronId": "<iam_person.id>",
    "fineType": "OVERDUE",
    "amount": 0.75,
    "daysOverdue": 3,
    "status": "OUTSTANDING",
    "sourceRefId": "<lib_fines.id>"
  }
}
```

**Live verification on `tenant_demo` 2026-05-05 (11 scenarios across R1–R11 all green):**

- **R1 list policies** — admin sees both STUDENT (5/14d/2/$0.25) + STAFF (20/30d/5/$0) policies.
- **R2 patron self-service list (row-scope)** — student sees own 2 checkouts (LIB-FIC-001 ACTIVE Maya / LIB-FIC-301 RETURNED Maya); parent 403 (no `lib-002:read`); admin sees all 3.
- **R3 librarian-only writes** — student POST /checkouts 403; teacher POST /checkouts 403 (controller `lib-002:write` gate AND service-layer `hasLibrarianScope`).
- **R4 KEYSTONE checkout-by-barcode** — principal POST /checkouts barcode=`LIB-FIC-002` patronId=Ethan returns 201 with `itemTitle=The Giver / dueDate=today+14 / daysUntilDue=14 / status=ACTIVE`; copy state immediately reflects `is_available=false / location_status=CHECKED_OUT / activeCheckout.patronName=Ethan Rodriguez`.
- **R5 max_checkouts enforcement** — Maya already had 1 ACTIVE seed checkout; principal checks out 4 more cleanly (LIB-FIC-003 / 102 / 201 / 302); the 5th attempt LIB-FIC-401 returns 400 ("Patron has reached the maximum of 5 active checkouts for STUDENT patrons. Return a book before checking out another."); 6th attempt LIB-FIC-402 also 400 with the same message.
- **R6 renewal limit** — Maya's seed checkout LIB-FIC-001 starts with renewal_count=0; renew #1 → 200, renewalCount=1, dueDate extended +14d; renew #2 → 200, renewalCount=2, dueDate extended again; renew #3 → 400 ("Renewal limit reached (2 for STUDENT patrons). The patron must return the book.").
- **R7 student self-service holds** — student POST /holds for Number the Stars → 201 with `status=PENDING / queuePosition=1`; duplicate attempt → 400 ("Patron already has a PENDING or READY hold on this item — Cancel it before placing another"); attempt to place hold for someone else → 403 service-layer (`hasLibrarianScope` branch); student PATCH /holds/:own/cancel → 200 status=CANCELLED; student PATCH /holds/:other/cancel → 403 ("You can only cancel your own holds"); student PATCH /holds/:own/collect → 403 (lib-002:write librarian-only).
- **R8 KEYSTONE return + auto-fine + hold reassignment** — backdated Maya's seed LIB-FIC-001 checkout to be 3 days overdue via SQL; principal POST /checkouts/:id/return → 201 status=RETURNED; the OVERDUE fine auto-creates with `amount=$0.75 / daysOverdue=3`; Ethan's seeded PENDING hold on The Giver flips to `READY` with `notifiedAt` populated; copy LIB-FIC-001 walks to `locationStatus=ON_HOLD_SHELF / isAvailable=false` exactly as designed.
- **R9 fine pay/waive** — student PATCH /fines/:id/pay → 403 (lib-002:write librarian-only); principal PATCH /fines/:id/pay → 200 status=PAID; principal (school admin) PATCH /fines/:id/waive → 200 status=WAIVED with reason captured.
- **R10 Kafka envelope captured live** on `dev.lib.fine.issued` with `event_type='lib.fine.issued' / source_module='library' / tenant_id` populated + `payload.fineType=OVERDUE / amount=$0.75 / daysOverdue=3 / status=OUTSTANDING`.
- **R11 cleanup** — wholesale `DELETE FROM lib_*` in dependency order + `seed:library` re-run restores the post-Step-4 seed shape exactly: items=5, copies=11, checkouts=3, holds=1, fines=1, programmes=1, progress=1, completions=0, reading_logs=2, reading_lists=1, list_items=3, reviews=1.

**Iteration issues caught + fixed during smoke:**

1. **Hold-placement IAM tension.** First draft of `HoldController.create` was gated on `lib-002:write`; smoke showed students 403 on self-service hold placement. The plan's narrative is "patron places hold" but the seed grants Student only `lib-002:read`. Resolved by gating POST /library/holds + PATCH /:id/cancel on `lib-002:read` instead — the service-layer `hasLibrarianScope` check is the actual gate for cross-patron operations (placing on behalf, cancelling someone else's hold), and the row-scope check on `actor.personId` keeps patrons bound to their own holds. Pattern noted: when a controller's "write-shaped" operation is actually self-service, gate on `:read` and let the service-layer row-scope be the enforcement boundary. (Same pattern Cycle 1 attendance used for `att-001:write` self-service.)

2. **Cleanup script DELETE ordering.** First draft DELETEd `lib_catalogue_items` before `lib_reading_list_items` and the FK from `lib_reading_list_items.catalogue_item_id` (NO ACTION per Step 3 schema) blocked it. Fixed by deleting reading-list-items + reviews + reading-logs FIRST, then catalogue-copies + items + locations + policies. The cleanup script in this handoff documents the canonical order.

3. **Stale API processes from prior smoke runs** — same pattern as Step 5, cleared via `pkill -f` + explicit `kill -9` against the LISTEN PID surfaced by `ss -tnlp`.

**Step 6 verified end-to-end. Ready for Step 7 (Reading + Reviews NestJS module — `ReadingProgrammeService` + `ReadingLogService` + `ReadingListService` + `ReviewService` with the **second student-input surface in CampusOS** — students log reading entries + write book reviews; row scope at the service layer binds them to their own `student_id`).**

---

## Step 7 — Reading + Reviews NestJS Module

**Status:** DONE. New surface at `apps/api/src/library/` extends LibraryModule with **4 more services + 4 controllers + 18 new endpoints**. Cycle 12 endpoint count after Step 7: **46** (28 from Steps 5+6 + 18). Build clean (`pnpm --filter @campusos/api build` → `nest build` succeeds). Live verification on `tenant_demo` 2026-05-05 — 8 scenarios all green covering the **second student-input surface in CampusOS** (Maya logs Wonder + writes a review; programme_progress auto-upserts via the SCHOOL_WIDE / CLASS audience-matching SQL inside the same tx).

**Module additions:**

```
apps/api/src/library/
├── reading-programme.service.ts      # NEW — list / get / leaderboard / create / patch
├── reading-programme.controller.ts   # NEW — 5 endpoints
├── reading-log.service.ts            # NEW — STUDENT-INPUT KEYSTONE
├── reading-log.controller.ts         # NEW — 4 endpoints
├── reading-list.service.ts           # NEW — multi-column published_chk lockstep on PATCH
├── reading-list.controller.ts        # NEW — 6 endpoints
├── review.service.ts                 # NEW — UNIQUE(item, student) catch + soft-hide
├── review.controller.ts              # NEW — 5 endpoints (list / create / patch / hide / unhide)
├── dto/library.dto.ts                # extended with reading + reviews enums + 18 DTO classes
└── library.module.ts                 # registers the 4 new services + 4 controllers
```

**18 new endpoints (cycle running total: 46):**

| Verb   | Path                                  | Permission      | Notes                                                                                                                                                                |
| ------ | ------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/library/programmes`                 | `lib-003:read`  | List active programmes; STUDENT callers receive myProgress inlined per row.                                                                                          |
| GET    | `/library/programmes/:id`             | `lib-003:read`  | Single programme with myProgress for STUDENT actors.                                                                                                                 |
| GET    | `/library/programmes/:id/leaderboard` | `lib-003:read`  | Top readers — `ORDER BY books_read DESC, pages_read DESC, last_updated_at ASC NULLS LAST`. Default 25 / max 200.                                                     |
| POST   | `/library/programmes`                 | `lib-003:write` | Writer-only (admin OR non-STUDENT STAFF). The `personType=STUDENT` guard prevents student programme creation.                                                        |
| PATCH  | `/library/programmes/:id`             | `lib-003:write` | Writer-only. Locks row inside tx + dynamic SET-clause builder.                                                                                                       |
| GET    | `/library/reading-log`                | `lib-003:read`  | STUDENT sees own; STAFF / ADMIN must pass `?studentId=` (the librarian student-detail view).                                                                         |
| GET    | `/library/reading-log/:id`            | `lib-003:read`  | Single entry; STUDENT non-owner gets 404 don't-leak-existence.                                                                                                       |
| POST   | `/library/reading-log`                | `lib-003:write` | **STUDENT-INPUT KEYSTONE** — student logs a book; `completedDate` triggers programme-progress auto-upsert.                                                           |
| PATCH  | `/library/reading-log/:id`            | `lib-003:write` | STUDENT edits own only; transitioning from in-progress to completed retriggers the auto-upsert.                                                                      |
| GET    | `/library/reading-lists`              | `lib-003:read`  | Published only by default; `?includeUnpublished=true` reveals drafts to writers (librarian / teacher / admin).                                                       |
| GET    | `/library/reading-lists/:id`          | `lib-003:read`  | With items inlined (joined to `lib_catalogue_items` for title / author / cover_image_url). Drafts 404 for non-writers.                                               |
| POST   | `/library/reading-lists`              | `lib-003:write` | Writer-only. Defaults `is_published=false`. UNIQUE(school, name, year) catches name collisions.                                                                      |
| PATCH  | `/library/reading-lists/:id`          | `lib-003:write` | **Multi-column `published_chk` lockstep** — when `is_published` flips, service stamps `published_at` atomically.                                                     |
| POST   | `/library/reading-lists/:id/items`    | `lib-003:write` | Add catalogue item to list. UNIQUE(list, item) refuses duplicate.                                                                                                    |
| PATCH  | `/library/reading-list-items/:id`     | `lib-003:write` | Update item_type / sort_order / notes.                                                                                                                               |
| DELETE | `/library/reading-list-items/:id`     | `lib-003:write` | 204 on success. Hard-delete safe — no audit value to preserve at the row level.                                                                                      |
| GET    | `/library/catalogue/:id/reviews`      | `lib-001:read`  | Catalogue-read surface — gated on lib-001:read so all personas (Teacher / Parent / Student / Staff / Admin) see reviews. Only `is_approved=true` for non-moderators. |
| POST   | `/library/catalogue/:id/reviews`      | `lib-003:write` | **STUDENT-INPUT** — student submits review. UNIQUE(item, student) → 400 with PATCH guidance.                                                                         |
| PATCH  | `/library/reviews/:id`                | `lib-003:write` | Student edits own; moderator can edit anyone (typo correction).                                                                                                      |
| PATCH  | `/library/reviews/:id/hide`           | `lib-003:write` | Moderator-only — sets `is_approved=false` (soft-hide preserves row for audit).                                                                                       |
| PATCH  | `/library/reviews/:id/unhide`         | `lib-003:write` | Moderator-only — restores `is_approved=true`.                                                                                                                        |

(Reviews controller has 5 endpoints not 4 — added an `/unhide` companion to the `/hide` path so a hidden review can be restored without raw PATCH. The Step 7 plan's "list / submit / patch own / hide" count is 4 + the unhide companion.)

**Service contracts:**

- **`ReadingProgrammeService`** — `hasWriterScope`: `isSchoolAdmin OR (personType !== 'STUDENT' AND holds lib-003:write)`. The personType guard is the load-bearing rule because Student holds `lib-003:write` per the seed (for log + review submission); without the guard, students could create programmes. `list(actor, args)` filters to active by default; for STUDENT callers it follows up with a single SELECT against `lib_programme_progress` keyed on the resolved `sis_students.id` and inlines `myProgress` per programme. `getById` does the same shape for a single programme. `getLeaderboard` joins `lib_programme_progress` + `sis_students` + `platform_students` + `iam_person` for the patron-name display, sorted by `books_read DESC, pages_read DESC, last_updated_at ASC NULLS LAST`. `create`/`patch` are writer-only with locked-row patches and dynamic SET-clause.

- **`ReadingLogService`** is the **STUDENT-INPUT KEYSTONE**. `resolveCallerStudentId(actor)` joins `actor.personId → platform_students → sis_students` for STUDENT actors. **`log(input, actor)`** runs entirely inside `executeInTenantTransaction`: validates the catalogue item exists in this tenant; INSERTs the log row; if `completedDate` is set, calls `upsertProgrammeProgress(tx, studentId, pagesRead)` which walks every active programme via the **SCHOOL_WIDE / CLASS audience-matching SQL** — `SCHOOL_WIDE` matches all students unconditionally; `CLASS` matches via `EXISTS (SELECT 1 FROM sis_enrollments WHERE student_id=$studentId AND class_id=p.target_id AND status='ACTIVE')` — and for each match performs an `INSERT … ON CONFLICT (programme_id, student_id) DO UPDATE SET books_read += 1, pages_read += pagesRead, last_updated_at = now()`, then a follow-up `UPDATE` recomputing `is_complete` against the programme's `target_books` + `target_pages` thresholds. YEAR_GROUP + CUSTOM audiences are deferred (the schema accepts them but the seed doesn't exercise them). **`patch(id, input, actor)`** locks the row + verifies student-owner; if the PATCH transitions the entry from in-progress to completed (`completedDate` flips from null to a value), the auto-upsert re-fires.

- **`ReadingListService`** — `hasWriterScope` mirrors the programme service (admin OR non-student STAFF holding `lib-003:write`). `list(actor, args)` defaults to published-only; `?includeUnpublished=true` reveals drafts to writers via the controller flag. `create` validates `actor.employeeId` (lists must have an `hr_employees`-backed author); UNIQUE(school, name, COALESCE(academic_year_id, sentinel)) collision is caught + surfaced as a friendly 400. **`patch(id, input, actor)` is the multi-column `published_chk` keystone** — when `isPublished` flips, the service stamps `published_at = now()` on publish OR clears `published_at = NULL` on unpublish atomically inside the locked tx so the schema CHECK never sees a half-state. `addItem` validates the parent item exists in this tenant; UNIQUE(reading_list_id, catalogue_item_id) refuses duplicates with a friendly 400. `removeItem` hard-deletes safely — the row carries no audit value beyond the parent list, and the parent CASCADE handles full-list cleanup.

- **`ReviewService`** — `listForItem(itemId, actor)` is gated on `lib-001:read` at the controller (catalogue-read surface) and filters non-moderator readers to `is_approved=true`. `create(itemId, input, actor)` requires `personType=STUDENT`, resolves `studentId`, validates the parent item exists in this tenant; UNIQUE(item_id, student_id) → friendly 400 with PATCH guidance. `patch(id, input, actor)` allows student-owner OR moderator (rarely used; most moderator action is the `/hide` endpoint). **`setApproval(id, isApproved, actor)`** is the moderator-only soft-hide path — `is_approved=false` preserves the row for audit while filtering it out of public listings; `/unhide` restores. The `hasModeratorScope` check guards both `/hide` and `/unhide`, also with the `personType=STUDENT` guard.

**Live verification on `tenant_demo` 2026-05-05 (8 scenarios across R1–R8, all green):**

- **R1 programme list (everyone with lib-003:read)** — admin sees Summer Reading Challenge 2026 (SCHOOL_WIDE / target_books=10 / active); student sees the same with `myProgress=(books=2 / pages=313 / isComplete=False)` inlined; parent 403 (no lib-003:read).
- **R2 leaderboard** — `Maya Chen books=2 pages=313 complete=False` returned with the platform.iam_person joined name.
- **R3 reading log row scope** — student GET /reading-log returns own 2 entries (Holes COMPLETED + Charlotte's Web in-progress); admin GET without studentId → 400 ("Staff readers must specify ?studentId="); admin GET with studentId=Maya → 200, count=2.
- **R4 STUDENT-INPUT KEYSTONE — Maya logs Wonder with `completedDate=today, pages=235, rating=5`** → 201; Maya's programme progress immediately reflects `books_read 2 → 3, pages_read 313 → 548, isComplete=false` (target_books=10 not yet reached) — the auto-upsert SQL fires inside the same tx as the INSERT, exactly as designed.
- **R5 log permissions** — teacher POST /reading-log → 403 ("Only students can log their own reading entries").
- **R6 review flow** — student POST review on Wonder → 201 (rating=5, isApproved=true); duplicate POST → 400 ("You have already reviewed this book. PATCH /library/reviews/:id to edit your existing review."); student PATCH own → 200 (rating updated to 4); teacher GET /catalogue/Wonder/reviews → 200 with 1 visible (now reachable on lib-001:read after the controller-gate fix); principal hide → isApproved=false; teacher GET hidden review → filtered out (count drops from 1 to 0); admin sees all (moderator view) → count=1 with isApproved=false; principal unhide → isApproved=true.
- **R7 reading list lifecycle** — POST creates draft (`isPublished=false / publishedAt=null`); default GET filters drafts out for non-writers; teacher with `?includeUnpublished=true` sees the draft; add Wonder REQUIRED + Holes RECOMMENDED; duplicate Wonder → 400 UNIQUE catch; PATCH publish → 200 with `publishedAt` populated atomically; default GET now shows the published list to all readers; PATCH unpublish → 200 with `publishedAt=NULL` (lockstep cleared); GET detail with items inlined returns 2 items in sort order.
- **R8 permission denials** — student POST /programmes → **403** ("Only librarians, teachers, or admins can create reading programmes" — the personType guard); student POST /reading-lists → 403; student PATCH /reviews/:id/hide → 403 ("Only librarians, teachers, or admins can hide / unhide reviews"); parent GET /catalogue/Wonder/reviews → 403 (no lib-001:read at the gate? Actually parent has `lib-001:read` per the IAM seed, so this is a 200 + filtered to is_approved=true rows — verified live).

Cleanup restores `tenant_demo` to seed shape exactly: items=5, copies=11, checkouts=3, holds=1, fines=1, programmes=1, **progress=1 (Maya 2/313 — restored from the +1/+235 the keystone produced)**, reading_logs=2, reading_lists=1, list_items=3, reviews=1.

**Iteration issues caught + fixed during smoke:**

1. **Student created a programme — IAM gate insufficient.** First draft of `ReadingProgrammeService.hasWriterScope` checked only `lib-003:write` permission; but Student has that permission per the seed (for self-service log + review submission). Smoke caught the bug — student POST /programmes returned 201 instead of 403. Fixed by adding `if (actor.personType === 'STUDENT') return false` to the writer-scope check. Same fix applied to `ReadingListService.hasWriterScope` and `ReviewService.hasModeratorScope`. Pattern: when a write-shaped permission is shared between librarian + student self-service, the personType guard is the actual access boundary (not the IAM check alone).

2. **Teacher GET /reviews 403.** The first draft gated `listForItem` on `lib-003:read`; teacher holds `lib-003:write` per the seed but NOT `lib-003:read`. Reviews are conceptually a catalogue-read surface (the user reads them on the catalogue detail page), so switched the controller decorator to `lib-001:read` (held by all 5 personas including Teacher / Parent). Service-layer non-moderator filtering still hides `is_approved=false` rows from non-moderator readers.

**No backend changes outside `apps/api/src/library/`** — Step 7 sits entirely on the schema from Steps 1 + 2 + 3 and the seed from Step 4. No Kafka emits this step (the planned `lib.programme.completed` emit on `is_complete=true` flip is deferred — schema is ready, future polish).

**Step 7 verified end-to-end. Cycle 12 backend phase complete: 46 endpoints across 10 services + 10 controllers + 1 Kafka emit.** Ready for Step 8 (Library UI — Catalogue + Circulation).

---

## Step 8 — Library UI: Catalogue + Circulation

**Status:** DONE.

5 routes shipped. Web build clean, 7/7 API tests pass, prettier clean.

**Foundation:**

- `apps/web/src/components/shell/icons.tsx` — added `BookIcon` (Heroicons book-open).
- `apps/web/src/components/shell/apps.tsx` — `library` AppKey + tile gated on `lib-001:read` (every persona) with persona-aware description; `routePrefix: '/library'` keeps tile lit on every nested route.
- `apps/web/src/lib/library-format.ts` — const arrays + label maps (LIBRARY_COPY_CONDITION_LABELS, LIBRARY_COPY_LOCATION_STATUS_LABELS, LIBRARY_CHECKOUT_STATUS_LABELS, LIBRARY_HOLD_STATUS_LABELS, LIBRARY_FINE_TYPE_LABELS, LIBRARY_FINE_STATUS_LABELS, LIBRARY_AUDIENCE_TYPE_LABELS) + pill class maps (CHECKOUT_STATUS_PILL, COPY_LOCATION_STATUS_PILL, HOLD_STATUS_PILL, FINE_STATUS_PILL, FINE_TYPE_PILL, COPY_CONDITION_PILL) + helpers (formatDate, formatCurrency, formatDaysUntilDue, isOverdue, formatRelative, isCheckoutLive).
- `apps/web/src/hooks/use-library.ts` — React Query hooks for every Library endpoint shipped in Steps 5–7: locations, catalogue search + item + copies, checkouts (mine + barcode lookup + create + return + renew), holds (mine + place + cancel + collect), fines (list + pay + waive), reading programmes + my-progress, reading log, reading lists + items, item reviews + submit + update + hide/unhide.
- `apps/web/src/lib/types.ts` — appended ~300 lines of Library DTOs (LibraryAudienceType / LibraryCopyCondition / LibraryCopyLocationStatus / LibraryCheckoutStatus / LibraryHoldStatus / LibraryFineStatus / LibraryFineType / LibraryReadingProgrammeStatus / LibraryReadingLogStatus / LibraryReadingListVisibility / LibraryReadingListSource / LibraryReviewStatus + 24 DTO + payload interfaces).

**5 pages:**

- `/library` — persona-aware. `LibrarianDashboard` (admin / `lib-001:write`): `BarcodeScanCard` with auto-focus input that on Enter runs `useBarcodeLookup` and routes to `/library/circulation?barcode=…`; 4-stat tiles (active checkouts / overdue / pending holds / open fines); recent active-checkouts list. `PatronDashboard` (student / parent / teacher fallback): my checkouts (live filtered with overdue tinting), my holds (with Cancel button when PENDING), my open fines.
- `/library/catalogue` — search bar + author filter input + dynamic category facet chips derived from current result set; calls `useCatalogueSearch({q, category, author})` with React Query 30s staleTime so the GIN-backed search ranks live. Result cards show cover placeholder / title / author / Dewey decimal / availability colour-coded (emerald when ≥1 / rose when 0) / `★ rating (count)`. Cards link to `/library/catalogue/:id`.
- `/library/catalogue/[id]` — `ItemHeader` (cover + title + author + category pill) + about grid + Availability aside (`PlaceHoldButton` shows only when `availableCopies===0`) + Reader-rating aside (when reviews exist) + `CopiesTable` (barcode / condition / location / status pills) + `ReviewsSection` with `SubmitReviewForm` (5-button 1–5 star + textarea, students only — `personType==='STUDENT'` gates render, service-layer keystone is the actual access boundary) and `myReview` short-circuit when student already submitted; teacher / admin / librarian get inline Hide / Unhide buttons on each review (calls `useHideReview` / `useUnhideReview`).
- `/library/circulation` — librarian-only page (gated client-side on `sch-001:admin OR lib-001:write`; non-librarians get a redirect-message card pointing at `/library`). 3 sections: `CheckoutScanner` (auto-focused barcode input + patron id input + Lookup button calling `useBarcodeLookup` + 3 action buttons Checkout / Return / Renew with the active-checkout panel showing patron + due date + status); `ReadyHoldsBoard` (lists READY holds with patron + ready-since + "Mark collected" button via `useCollectHold`); `CheckoutHistory` (5 status filter chips All / Active / Overdue / Returned / Lost + table with status + days-until-due + per-row Return + Renew on active rows).
- `/library/fines` — librarian + patron view. 3-stat header (Outstanding total in rose / Outstanding count / Total fines). 4 status filter chips (Outstanding / Paid / Waived / All). Per-row: item title + fine-type pill + status pill + patron + days-overdue + amount; librarian sees Mark-paid button (calls `usePayFine`); admin additionally sees Waive button that opens `WaiveForm` Modal with required reason (1–2000 chars) calling `useWaiveFine`.

**Navigation:** Library tile lights up on `/library/*` via `routePrefix: '/library'`.

**Build sizes** (web, all 5 routes):

- `/library` 6.38 kB / 116 kB First Load JS
- `/library/catalogue` 3.61 kB / 113 kB
- `/library/catalogue/[id]` 7.35 kB / 117 kB
- `/library/circulation` 6.93 kB / 116 kB
- `/library/fines` 6.29 kB / 116 kB

**Iteration issues caught + fixed during build:**

1. Top-level `reviews` and `reviewsQ` declarations on `/library/catalogue/[id]/page.tsx` were unused (the `ReviewsSection` child component does its own fetch via `useItemReviews`); ESLint TS2322 flagged. Removed both, kept `const item = itemQ.data;` since it's used throughout the page.
2. `FineRow` typed `fine` via `ReturnType<typeof useFines>['data'] extends Array<infer T> ? T : never` — TypeScript can't infer through `T[] | undefined`, resolved to `never`. Switched to importing `LibraryFineDto` directly.

No backend changes — Step 8 sits entirely on the 36-endpoint surface from Steps 5–7. **Live verification deferred to Step 10 CAT** — page wiring matches the controller contracts already verified end-to-end in each module's smoke runs.

---

## Step 9 — Library UI: Reading + Reviews + Student Portal

**Status:** DONE.

5 new web routes shipped on the Cycle 12 backend (Steps 5–7, no API changes). Web build clean, 7/7 API tests pass, prettier clean.

- **`/library/programmes`** — Reading programme list. Each card shows the programme name + audience pill (school-wide / year group / class / custom) + start→end dates + goal pills (target books / target pages). Students see their own progress bar inlined per card via the Step 7 backend's `myProgress` field. Librarians + admins (`sch-001:admin OR lib-003:write`) can toggle `Show inactive` and open the New-programme Modal — name + description + 4 audience types + target books OR target pages OR both + start/end dates with at-least-one-target client-side validation.
- **`/library/programmes/[id]`** — programme detail. Header card with name + audience + status pills + 4-cell metadata grid (target books / target pages / status / last updated). Emerald "My progress" card for students showing books-read / pages-read / completion status with a deep-link to the reading log. Leaderboard table joining `programme_progress + sis_students + iam_person` sorted by `books_read DESC`, with rank #N + student name + books + pages + Complete pill (sourced from the Step 7 ReadingProgrammeService leaderboard endpoint). Librarians get an Edit Modal (name / description / target books / target pages / start / end / `isActive` toggle) that PATCHes the differential set so unchanged fields don't fire on the UPDATE.
- **`/library/reading-log`** — **THE STUDENT-INPUT KEYSTONE web surface** (the second student-input surface in CampusOS after Cycle 11.1 wellbeing). Non-students see an amber redirect-message card pointing back to `/library`. Students see 3-stat header (books completed / in progress / pages read), Log-a-book button opening a Modal, then two grouped sections (In progress + Completed) with per-card title + author + dates + 5-star rating render + line-clamped notes + Edit button. The Log Modal embeds catalogue search powered by the Step 5 GIN-backed `useCatalogueSearch(q)` (debounced ≥2 chars), then renders started / completed / pages / 5-button rating picker / 2000-char notes textarea. Submit POSTs to the Step 7 ReadingLogService — which validates the catalogue item exists then INSERTs the log row, and on `completedDate` set runs the **programme-progress auto-upsert** via SCHOOL_WIDE / CLASS audience-matching SQL with `INSERT ... ON CONFLICT (programme_id, student_id) DO UPDATE` and a follow-up recompute of `is_complete` against programme thresholds, all inside one tenant tx. Edit Modal reuses the same form layout with the catalogue lookup short-circuited to the existing entry.
- **`/library/reading-lists`** — Curated reading list browse. Drafts hidden by default; librarians + admins toggle `Show drafts` (the Step 7 backend's `?includeUnpublished=true`) and create new lists via the New Modal (name + 5-value list type + description). On successful create, route to the new list's detail page so the librarian can immediately add books before publishing. Per-card: name + Draft pill (when `!isPublished`) + list-type pill + book-count + line-clamped description + curator + relative published-at.
- **`/library/reading-lists/[id]`** — list detail with the curated book table. Header card with name + Draft pill + list-type pill + curator + published date + writer-only Publish/Unpublish button hitting the Step 7 multi-column `published_chk` lockstep keystone (service stamps both atomically on publish + clears both on unpublish). Books section sorted by `sortOrder` ASC with cover placeholder + title (links to `/library/catalogue/<id>`) + author + 4-value item-type pill (REQUIRED rose / RECOMMENDED emerald / EXTENSION sky / REFERENCE violet) + notes + writer-only Remove button with confirm guard. Add-book Modal embeds the same catalogue search + 4-value type select + notes textarea.
- **`/library/my`** — student-only combined library landing. Non-students see an amber redirect card pointing back to `/library`. Students see a 5-stat header (checked out / on hold / owed / books read / pages read), then per-section: Reading programmes (top 4 active with mini progress bars), Currently reading (top 4 in-progress entries), My active checkouts (overdue-tinted), My holds, and Outstanding fines (rose-tinted, only when present).
- **Reviews stayed inline on `/library/catalogue/[id]` from Step 8** — the `ReviewsSection` child component there already drives `useItemReviews(itemId)` + `useSubmitReview` + `useHideReview`/`useUnhideReview`. The plan's Step 9 bullet 4 was already covered by Step 8.

**Navigation wiring:** `/library` page extended with a `QuickNav` row right under `SearchBar` that adds chip-links per persona — Catalogue / Reading programmes / Reading lists for everyone; My reading log + My library for students; Circulation desk + Fines for librarians.

**Build sizes** (web, all 5 new routes ship; values include format-pass):

- `/library/programmes` 6.99 kB / 117 kB First Load JS
- `/library/programmes/[id]` 7.17 kB / 117 kB
- `/library/reading-log` 7.31 kB / 117 kB
- `/library/reading-lists` 6.37 kB / 116 kB
- `/library/reading-lists/[id]` 6.97 kB / 117 kB
- `/library/my` 5.66 kB / 116 kB

**Iteration issues caught + fixed during build:**

1. Wrong DTO type name. First draft typed selected catalogue search results as `CatalogueItemDto` but the actual DTO returned by `useCatalogueSearch` is `LibraryCatalogueItemSearchHitDto`. Caught on both `/library/reading-log/page.tsx` and `/library/reading-lists/[id]/page.tsx`. Fixed.
2. Unescaped apostrophe in JSX. `you've` in the `CreateForm` reading-list Modal hint triggered ESLint's `react/no-unescaped-entities`. Replaced with `&apos;`.

**No backend changes** — Step 9 sits entirely on the 36-endpoint surface from Steps 5–7. **Live verification deferred to Step 10 CAT** — page wiring matches the controller contracts already verified end-to-end in each module's smoke runs.

---

## Step 10 — Vertical Slice Integration Test

**Status:** DONE. CAT script at `docs/cycle12-cat-script.md` — 8-check schema preamble + 10 plan scenarios verified live on `tenant_demo` 2026-05-05 against the Step 9 build (commit `84527b5` on `main`). One ADR-057 wire envelope captured live on `dev.lib.fine.issued`. All scenarios pass. Cleanup script restores tenant to post-Step-4 seed shape exactly.

**Live verification 2026-05-05** (10 plan scenarios all green):

- **S1 Catalogue lifecycle + GIN search** — Sarah adds Bridge to Terabithia + 2 copies (LIB-CAT-101 NEW + LIB-CAT-102 GOOD on Fiction Shelves). Search `?q=Terabithia` (title hit) and `?q=Paterson` (author surname hit via `COALESCE(author, '')` concatenation) both rank live. Item rollups: totalCopies=2, availableCopies=2, activeHoldsCount=0.
- **S2 Checkout + max_checkouts enforcement** — Barcode lookup returns copy + item + activeCheckout=None in one round-trip. Principal scans LIB-CAT-101 for Maya → status=ACTIVE, dueDate=today+14d. Three more spare-copy checkouts bring Maya to the STUDENT max=5; the 6th attempt returns 400 "Patron has reached the maximum of 5 active checkouts for STUDENT patrons." Teacher POST /checkouts → 403 (lib-002:write controller gate).
- **S3 Hold queue** — Sarah checks out LIB-CAT-102 to herself (STAFF patron — `resolvePatronType` joins hr_employees first when platform_students misses). Bridge availability now 0/2. Principal places PENDING hold on Bridge for Ethan → queuePosition=1, patronName="Ethan Rodriguez". Item rollups: activeHoldsCount=1.
- **S4 Return + auto-fine + hold reassignment KEYSTONE** — Backdate Maya's LIB-CAT-101 to 2 days overdue. Return inside one tenant tx: status=RETURNED, returnedAt populated; OVERDUE fine auto-creates `amount=$0.50, days_overdue=2, status=OUTSTANDING`; Ethan's PENDING hold flips to READY with `notified_at` populated; copy LIB-CAT-101 walks to ON_HOLD_SHELF / is_available=false. **Wire envelope captured live on `dev.lib.fine.issued`** with full ADR-057 shape (event_id UUIDv7, source_module=library, tenant_id, payload.fineType=OVERDUE / amount=0.5 / daysOverdue=2 / status=OUTSTANDING / sourceRefId=fineId).
- **S5 Renewal limit enforcement** — STUDENT policy renewals_allowed=2. Renew #1 → renewalCount=1 dueDate +14d; renew #2 → renewalCount=2; renew #3 → 400 "Renewal limit reached (2 for STUDENT patrons). The patron must return the book."
- **S6 Reading programme auto-upsert KEYSTONE (student-input)** — Pre-state: Maya progress books_read=2, pages_read=313, is_complete=false. Maya POSTs reading log for Bridge with completedDate=today + pagesRead=128 + rating=5. Inside the same tenant tx the auto-upsert runs `INSERT ... ON CONFLICT DO UPDATE` against every active SCHOOL_WIDE / CLASS audience-matching programme. Post-state: books_read=3, pages_read=441 (313+128), is_complete=false (3/10 books).
- **S7 Student review + UNIQUE catch** — Maya submits 5★ review on Bridge. Duplicate POST → 400 "You have already reviewed this book. PATCH /library/reviews/:id to edit your existing review." Teacher GETs reviews via `/library/catalogue/:id/reviews` which is gated on lib-001:read (catalogue surface) so teachers — who hold lib-003:write but not lib-003:read — see the review.
- **S8 Reading list lifecycle + published_chk lockstep KEYSTONE** — Teacher creates "Grade 5 Adventure Reads" GENERAL DRAFT (isPublished=false, publishedAt=null). Student GET (drafts hidden by default) shows only the seed list. Teacher adds Bridge as REQUIRED. Teacher PATCHes isPublished=true → service stamps `is_published=true AND published_at=now()` atomically per the multi-column lockstep. Student GET now returns 2 lists.
- **S9 Visibility model across 5 personas** — Maya GETs /checkouts → 6 own rows; /holds → 0 own; /fines → 2 own (seed Holes + new Bridge); /reading-log → 3 own (2 seed + 1 from S6). Parent GETs /fines → **403 INSUFFICIENT_PERMISSIONS required=[lib-002:read]** (no lib-002 in the seed). Parent + teacher both 403 on POST /checkouts. Student tries `?patronId=<Ethan>` query param — silently scoped back to own (6 rows, all Maya).
- **S10 Fine management lifecycle** — Student PATCH pay → 403 (lib-002:write required). Principal marks Bridge fine PAID. School-admin waives the seeded Holes fine with required reason. Re-pay attempt on the PAID fine → 400 "Cannot pay a fine in status PAID — only OUTSTANDING."

**Cleanup verified**: wholesale `DELETE FROM lib_*` in dependency order + `pnpm seed:library` re-run restores the post-Step-4 seed shape exactly (locations=3, items=5, copies=11, checkouts=3, holds=1, fines=1, programmes=1, progress=1 (Maya 2/313), logs=2, lists=1, list_items=3, reviews=1).

**Reviewer attention items** (non-blocking, Phase 2 polish — listed in the CAT script):

1. `lib.fine.issued` has no consumer. Emit lands cleanly with full ADR-057 envelope; no Cycle 6 PaymentService consumer subscribes today. Wiring is a polish item gated on a school-config `payment_integration_enabled` flag.
2. Librarian role is the school-admin tier today. Real schools want a dedicated Librarian role; joins the Wave 2 Phase 2 punch list with the Counsellor / Nurse / Lead-counsellor splits from Cycles 9–11.
3. Self-service hold placement gated on `lib-002:read` at the controller (not `:write`) because students hold `:read` only; `hasLibrarianScope` is the actual access boundary for cross-patron operations (mirrors Cycle 1 att-001:write self-service pattern).
4. 6 deferred ERD tables — `lib_recommendations`, `lib_class_set_checkouts`, `lib_interlibrary_loans`, `lib_catalogue_import_jobs`, `lib_scan_sessions`, `lib_space_*` — park as Cycle 12.1 / Wave 3.
5. `lib.programme.completed` Kafka emit + completion certificate worker — schema is ready, no service writes to it today.
6. Parent visibility on `/children/[id]/library` — parents currently hold only `lib-001:read` (catalogue browse). Child-checkout visibility surface is a polish item.

---

## Cycle 12 Completion Criteria

1. Tenant schema: 14 new tables (3 catalogue + 4 circulation + 7 reading/reviews). Tenant table count: 175 → ~189.
2. Library API: ~40 endpoints with full-text catalogue search + barcode checkout.
3. Circulation engine: checkout by barcode → due date from policy → renewal → return → auto-fine.
4. Hold queue: PENDING → READY on return → COLLECTED on pickup. Copy reassignment.
5. Fine tracking with `lib.fine.issued` Kafka emit for future payment integration.
6. Reading programmes with student progress tracking + completion awards.
7. Student-facing reading log + book reviews (second student-input surface).
8. Curated reading lists with publish/unpublish workflow.
9. HANDOFF-CYCLE12.md and CLAUDE.md updated. CI green.

---
