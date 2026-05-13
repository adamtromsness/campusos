/* 164_lib_classsets_listfields.sql
 * Phase 2 Cycle 25 Step 1 — M24 Library Advanced reading lists +
 * class set bulk checkouts.
 *
 * The plan-text Step 1 lists three tables (lib_reading_lists,
 * lib_reading_list_items, lib_class_set_checkouts). Two of those
 * already ship from Cycle 12 migration 045 with the matching
 * 5-value list_type CHECK and 4-value item_type CHECK. The actual
 * delta here is additive:
 *
 *   1. ALTER lib_reading_lists ADD COLUMN target_grade_level TEXT
 *      so a list can target a grade band without a specific class.
 *   2. ALTER lib_reading_lists ADD COLUMN curriculum_unit_id UUID
 *      soft ref to Cycle 23 cur_units(id) per ADR-001/020. NULL for
 *      the legacy four list_type values. Populated for CURRICULUM_UNIT
 *      lists driving the cur_units cross-link in the Step 6 web UI.
 *   3. CREATE INDEX (school_id, list_type, is_published) for the
 *      Step 6 librarian filter "show me all published CLASS lists".
 *      The Cycle 12 (school_id, is_published) index handles the
 *      coarser browse path — the new index is the type-filtered hot
 *      path the advanced UI hits per-chip.
 *   4. CREATE TABLE lib_class_set_checkouts — bulk-checkout
 *      coordination row that spawns N individual lib_checkouts on
 *      INSERT. The Step 4 service is the canonical writer.
 *   5. ALTER lib_checkouts ADD COLUMN class_set_checkout_id UUID
 *      FK to lib_class_set_checkouts(id) ON DELETE SET NULL. The
 *      schema-side SET NULL preserves the individual checkout
 *      audit row even if the parent class set is hard-deleted
 *      (which the service layer refuses, but the schema is
 *      defence in depth).
 *
 *   lib_class_set_checkouts  — One row per teacher class-set
 *                              checkout coordination event. The Step
 *                              4 ClassSetService.create is the
 *                              canonical writer. On INSERT, the
 *                              service spawns copy_count individual
 *                              lib_checkouts rows linking specific
 *                              barcodes via class_set_checkout_id —
 *                              both INSERTs and the
 *                              lib_catalogue_copies state flip live
 *                              inside one tenant tx so a partial
 *                              failure rolls every row back. The
 *                              status enum is a 4-value CHECK
 *                              ACTIVE, PARTIALLY_RETURNED, RETURNED,
 *                              OVERDUE. The Step 4 return path
 *                              increments returned_count and walks
 *                              the state machine: returned_count =
 *                              copy_count → RETURNED. 0 <
 *                              returned_count < copy_count →
 *                              PARTIALLY_RETURNED. The Step 4
 *                              ClassSetOverdueWorker runs nightly and
 *                              flips ACTIVE / PARTIALLY_RETURNED rows
 *                              past due_date to OVERDUE.
 *
 *                              teacher_patron_id is a soft UUID ref
 *                              to platform.iam_person(id) per ADR-001
 *                              /020 covering staff patrons. The
 *                              schema does not enforce that the
 *                              teacher is an hr_employees row — the
 *                              Step 4 service validates that before
 *                              creating the row.
 *
 *                              class_id is a soft UUID ref to
 *                              sis_classes(id) per ADR-001/020. A
 *                              class set may be checked out by a
 *                              teacher for general use without
 *                              binding to a specific class so the
 *                              column is nullable.
 *
 *                              copy_count is a positive INT enforced
 *                              by CHECK. The schema permits any
 *                              positive integer — the Step 4 service
 *                              validates copy_count <= available
 *                              copies of the parent catalogue item
 *                              before INSERTing the class set + its
 *                              children.
 *
 *                              dates_chk keeps due_date >=
 *                              checkout_date so a class set cannot be
 *                              created with a returned-before-issued
 *                              window.
 *
 *                              returned_chk keeps 0 <=
 *                              returned_count <= copy_count so the
 *                              return flow cannot over-record.
 *
 * Soft cross-schema refs per ADR-001 / ADR-020:
 *   lib_class_set_checkouts.school_id         -> platform.schools(id)
 *   lib_class_set_checkouts.teacher_patron_id -> platform.iam_person(id)
 *   lib_reading_lists.curriculum_unit_id      -> cur_units(id) optional
 *   lib_reading_lists.target_grade_level      -> free-form grade label
 *
 * DB-enforced intra-tenant FKs (2 logical):
 *   lib_class_set_checkouts.catalogue_item_id -> lib_catalogue_items(id) NO ACTION
 *     A class set is a financial-audit record. Refuse hard-delete of
 *     a catalogue item while a class set references it.
 *   lib_checkouts.class_set_checkout_id       -> lib_class_set_checkouts(id) SET NULL
 *     A class set hard-delete clears the link from individual
 *     checkouts so the checkout history survives. The Step 4
 *     service does not expose a hard-delete path on class sets —
 *     this is defence-in-depth.
 *
 * 0 cross-schema FKs.
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * ALTER TABLE ADD COLUMN IF NOT EXISTS for the lib_reading_lists +
 * lib_checkouts additions so re-running the migration on a partially
 * applied tenant is a no-op. Block comment header, no semicolons
 * inside any string literal or comment per the splitter trap from
 * Cycles 4 onwards.
 */

ALTER TABLE lib_reading_lists
  ADD COLUMN IF NOT EXISTS target_grade_level TEXT;

ALTER TABLE lib_reading_lists
  ADD COLUMN IF NOT EXISTS curriculum_unit_id UUID;

CREATE INDEX IF NOT EXISTS lib_lists_school_type_published_idx
  ON lib_reading_lists (school_id, list_type, is_published);

CREATE INDEX IF NOT EXISTS lib_lists_curriculum_unit_idx
  ON lib_reading_lists (curriculum_unit_id)
  WHERE curriculum_unit_id IS NOT NULL;

COMMENT ON COLUMN lib_reading_lists.target_grade_level IS
  'Free-form grade label for list_type=YEAR_GROUP. NULL for the other four list_type values. The Step 6 web UI surfaces a per-grade filter chip and matches on this column.';

COMMENT ON COLUMN lib_reading_lists.curriculum_unit_id IS
  'Soft UUID ref to cur_units(id) per ADR-001/020. Populated when list_type=CURRICULUM_UNIT — the librarian builds a booklist tied to a specific curriculum unit (e.g. Grade 5 ELA US History). NULL for the other four list_type values. No DB-enforced FK because cur_units is a Cycle 23 table that may be soft-deleted independently of the reading list lifecycle.';

CREATE TABLE IF NOT EXISTS lib_class_set_checkouts (
  id                    UUID         PRIMARY KEY,
  school_id             UUID         NOT NULL,
  catalogue_item_id     UUID         NOT NULL REFERENCES lib_catalogue_items(id),
  teacher_patron_id     UUID         NOT NULL,
  class_id              UUID,
  copy_count            INT          NOT NULL,
  checkout_date         DATE         NOT NULL,
  due_date              DATE         NOT NULL,
  returned_count        INT          NOT NULL DEFAULT 0,
  status                TEXT         NOT NULL DEFAULT 'ACTIVE',
  notes                 TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT lib_class_set_status_chk
    CHECK (status IN ('ACTIVE', 'PARTIALLY_RETURNED', 'RETURNED', 'OVERDUE')),
  CONSTRAINT lib_class_set_copy_count_chk
    CHECK (copy_count > 0),
  CONSTRAINT lib_class_set_dates_chk
    CHECK (due_date >= checkout_date),
  CONSTRAINT lib_class_set_returned_chk
    CHECK (returned_count >= 0 AND returned_count <= copy_count)
);

CREATE INDEX IF NOT EXISTS lib_class_set_school_status_idx
  ON lib_class_set_checkouts (school_id, status);

CREATE INDEX IF NOT EXISTS lib_class_set_teacher_date_idx
  ON lib_class_set_checkouts (teacher_patron_id, checkout_date DESC);

CREATE INDEX IF NOT EXISTS lib_class_set_item_idx
  ON lib_class_set_checkouts (catalogue_item_id);

COMMENT ON TABLE lib_class_set_checkouts IS
  'Phase 2 Cycle 25 — Bulk-checkout coordination row that spawns N individual lib_checkouts on INSERT. The Step 4 ClassSetService.create is the canonical writer. On INSERT the service validates copy_count <= available copies, then atomically INSERTs copy_count individual lib_checkouts rows linking specific barcodes via class_set_checkout_id and flips the lib_catalogue_copies state for each. Status walks ACTIVE → PARTIALLY_RETURNED (0 < returned_count < copy_count) → RETURNED (returned_count = copy_count). ClassSetOverdueWorker flips past-due rows to OVERDUE nightly.';

COMMENT ON COLUMN lib_class_set_checkouts.teacher_patron_id IS
  'Soft UUID ref to platform.iam_person(id) per ADR-001/020 covering staff patrons. The Step 4 service validates the teacher has an hr_employees row in this tenant before creating the class set.';

COMMENT ON COLUMN lib_class_set_checkouts.class_id IS
  'Soft UUID ref to sis_classes(id) per ADR-001/020. Optional — a class set may be checked out by a teacher for general use without binding to a specific class.';

COMMENT ON COLUMN lib_class_set_checkouts.copy_count IS
  'Positive INT enforced by CHECK. The Step 4 service validates copy_count <= available copies of the parent catalogue item before INSERTing — the schema CHECK is the safety net against a future direct-SQL bypass.';

ALTER TABLE lib_checkouts
  ADD COLUMN IF NOT EXISTS class_set_checkout_id UUID;

ALTER TABLE lib_checkouts
  DROP CONSTRAINT IF EXISTS lib_checkouts_class_set_fkey;

ALTER TABLE lib_checkouts
  ADD CONSTRAINT lib_checkouts_class_set_fkey
  FOREIGN KEY (class_set_checkout_id)
  REFERENCES lib_class_set_checkouts(id)
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS lib_checkouts_class_set_idx
  ON lib_checkouts (class_set_checkout_id)
  WHERE class_set_checkout_id IS NOT NULL;

COMMENT ON COLUMN lib_checkouts.class_set_checkout_id IS
  'Phase 2 Cycle 25 — Soft FK to lib_class_set_checkouts(id) populated when this checkout was spawned by a class-set bulk checkout. NULL for the canonical single-patron checkout path. SET NULL on parent class-set delete so the individual checkout audit row survives if the parent is hard-deleted. The Step 4 ClassSetService.create populates this column when fanning out individual checkouts under one tenant tx.';
