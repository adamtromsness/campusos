/*
 * Tenant migration 101 — hr_positions.reports_to_id (additive).
 *
 * Adds a self-FK column on hr_positions so the Configuration Admin
 * Step 4 org-chart endpoint can build the position tree. The column
 * is nullable. Top-level positions (Principal / Head of School) leave
 * it NULL. ON DELETE SET NULL preserves the audit chain when a parent
 * position is removed without orphaning its children.
 *
 * Idempotent — re-runs on a tenant whose column already exists are a
 * no-op (the splitter cuts on every semicolon, but plain SQL with
 * IF NOT EXISTS on the column add is safe).
 */

ALTER TABLE hr_positions
  ADD COLUMN IF NOT EXISTS reports_to_id UUID;

ALTER TABLE hr_positions
  DROP CONSTRAINT IF EXISTS hr_positions_reports_to_fk;

ALTER TABLE hr_positions
  ADD CONSTRAINT hr_positions_reports_to_fk
  FOREIGN KEY (reports_to_id) REFERENCES hr_positions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS hr_positions_reports_to_idx
  ON hr_positions(reports_to_id) WHERE reports_to_id IS NOT NULL;

COMMENT ON COLUMN hr_positions.reports_to_id
  IS 'Self-referential reports-to chain. NULL for top-level positions. Used by the Configuration Admin org-chart at /admin/configuration/positions.';
