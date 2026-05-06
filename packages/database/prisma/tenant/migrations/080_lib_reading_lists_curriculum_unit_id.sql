/* ============================================================
 * Cycle 23 — Step 9: lib_reading_lists.curriculum_unit_id
 * ============================================================
 *
 * Adds the cross-cycle soft FK column the Cycle 12 plan
 * anticipated. Soft FK to cur_units(id) per ADR-001/020 — no DB
 * FK because cur_units lives in the same tenant schema but the
 * cross-cycle convention keeps these as soft refs to allow
 * decoupled deletes + the broader app-layer validation pattern.
 *
 * Splitter-safe — no semicolons inside string literals.
 * Idempotent — re-runs are a no-op.
 * ============================================================ */

ALTER TABLE lib_reading_lists
  ADD COLUMN IF NOT EXISTS curriculum_unit_id UUID;

CREATE INDEX IF NOT EXISTS lib_lists_curriculum_unit_idx
  ON lib_reading_lists (curriculum_unit_id) WHERE curriculum_unit_id IS NOT NULL;

COMMENT ON COLUMN lib_reading_lists.curriculum_unit_id IS
  'Cycle 23 cross-cycle integration. Soft FK to cur_units(id) per ADR-001/020. Resolves the curriculum unit a CURRICULUM_UNIT-type reading list supports.';
