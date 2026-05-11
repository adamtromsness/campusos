/*
 * 135_fds_preorders.sql — Phase 2 Cycle 10 sub-cycle b (P2-10b).
 *
 * M63 Food Service Advanced — Pre-Orders + Production Planning.
 * 4 new base tables plus 1 ALTER on the Cycle 20 fds_production_records.
 *
 *   fds_preorder_windows               per-school per-(date, meal_type)
 *                                      open-and-close window that gates
 *                                      when students and parents may
 *                                      submit pre-orders for a future
 *                                      service date.
 *   fds_meal_preorders                 student order header. allergen
 *                                      cross-check result captured in
 *                                      allergen_check_passed BOOLEAN
 *                                      so the POS line can read the
 *                                      pre-flight outcome directly.
 *                                      3-value status lifecycle
 *                                      PENDING / CONFIRMED / CANCELLED.
 *   fds_meal_preorder_items            order line items. UNIQUE on
 *                                      (preorder_id, menu_item_id) so
 *                                      a single order cannot list the
 *                                      same menu item twice.
 *   fds_preorder_production_reports    aggregated production planning
 *                                      report generated from confirmed
 *                                      preorders. UNIQUE on
 *                                      (school_id, service_date,
 *                                      meal_type). report_data JSONB
 *                                      carries item totals and dietary
 *                                      breakdown.
 *
 * Plus a forward-compat ALTER on the Cycle 20 fds_production_records
 * adding recipe_id nullable referencing fds_recipes(id) ON DELETE SET
 * NULL so a USDA production record can link back to the canonical
 * recipe that produced the served meal. Existing rows ship without a
 * recipe link and the seed backfills one row to demonstrate the
 * linkage.
 *
 * Cycle 20 (migration 070) already shipped fds_eligibility_applications,
 * fds_eligibility_determinations, fds_usda_reimbursement_claims, and
 * fds_production_records. The original P2-10b plan described an
 * alternative shape for these tables but the Cycle 20 shapes are the
 * canonical home — P2-10b leaves them untouched and adds the recipe_id
 * link column on production records as the only schema delta.
 *
 * The Cycle 20 AllergyAlertConsumer (REVIEW-FINAL-2026-05-07 MAJ-5.1)
 * already subscribes to dev.hlth.allergy_alert.changed and upserts
 * fds_student_allergen_alerts. P2-10b's pre-order allergen cross-check
 * reads from that read model — no new consumer needed.
 *
 * No semicolons inside string literals or block comments. The tenant
 * provisioner splits the migration on every semicolon character
 * without quoting context.
 */

CREATE TABLE IF NOT EXISTS fds_preorder_windows (
  id              UUID PRIMARY KEY,
  school_id       UUID NOT NULL,
  service_date    DATE NOT NULL,
  meal_type       TEXT NOT NULL,
  opens_at        TIMESTAMPTZ NOT NULL,
  closes_at       TIMESTAMPTZ NOT NULL,
  notes           TEXT,
  created_by      UUID NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_preorder_window_meal_chk CHECK (
    meal_type IN ('BREAKFAST','LUNCH','DINNER','SNACK')
  ),
  CONSTRAINT fds_preorder_window_window_chk CHECK (closes_at > opens_at),
  CONSTRAINT fds_preorder_window_uq UNIQUE (school_id, service_date, meal_type)
);

CREATE INDEX IF NOT EXISTS fds_preorder_window_school_date_idx
  ON fds_preorder_windows (school_id, service_date DESC);

CREATE INDEX IF NOT EXISTS fds_preorder_window_open_idx
  ON fds_preorder_windows (school_id, opens_at, closes_at);

COMMENT ON TABLE fds_preorder_windows IS
  'Per-school per-(service_date, meal_type) open and close window for student or parent pre-orders. UNIQUE caps to one window per slot. window_chk enforces closes_at > opens_at. The PreorderService gate consults opens_at <= now() <= closes_at against this row before accepting a POST /preorders.';

CREATE TABLE IF NOT EXISTS fds_meal_preorders (
  id                          UUID PRIMARY KEY,
  school_id                   UUID NOT NULL,
  student_id                  UUID NOT NULL,
  preorder_window_id          UUID NOT NULL REFERENCES fds_preorder_windows(id) ON DELETE RESTRICT,
  ordered_by                  UUID NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'PENDING',
  allergen_check_passed       BOOLEAN NOT NULL DEFAULT true,
  blocking_allergens          TEXT[] NOT NULL DEFAULT '{}',
  warning_allergens           TEXT[] NOT NULL DEFAULT '{}',
  confirmed_at                TIMESTAMPTZ,
  cancelled_at                TIMESTAMPTZ,
  cancellation_reason         TEXT,
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_meal_preorder_status_chk CHECK (
    status IN ('PENDING','CONFIRMED','CANCELLED')
  ),
  CONSTRAINT fds_meal_preorder_uq UNIQUE (student_id, preorder_window_id),
  CONSTRAINT fds_meal_preorder_status_dates_chk CHECK (
    (status = 'PENDING' AND confirmed_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'CONFIRMED' AND confirmed_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS fds_meal_preorder_student_idx
  ON fds_meal_preorders (student_id, created_at DESC);

CREATE INDEX IF NOT EXISTS fds_meal_preorder_window_idx
  ON fds_meal_preorders (preorder_window_id, status);

CREATE INDEX IF NOT EXISTS fds_meal_preorder_school_status_idx
  ON fds_meal_preorders (school_id, status);

CREATE INDEX IF NOT EXISTS fds_meal_preorder_blocked_idx
  ON fds_meal_preorders (school_id, allergen_check_passed)
  WHERE allergen_check_passed = false;

COMMENT ON TABLE fds_meal_preorders IS
  'Student meal pre-order header. UNIQUE(student_id, preorder_window_id) keeps the row 1-to-1 with the (student, window) pair. The allergen cross-check result is captured directly on the row — allergen_check_passed=false blocks the order at confirmation and the blocking_allergens TEXT[] surfaces the offending codes to the UI. status_dates_chk multi-column CHECK keeps confirmed_at and cancelled_at in lockstep with status. RESTRICT on preorder_window_id prevents accidental hard-delete of a window that has historical orders attached.';

CREATE TABLE IF NOT EXISTS fds_meal_preorder_items (
  id              UUID PRIMARY KEY,
  preorder_id     UUID NOT NULL REFERENCES fds_meal_preorders(id) ON DELETE CASCADE,
  menu_item_id    UUID NOT NULL REFERENCES fds_menu_items(id) ON DELETE RESTRICT,
  quantity        INT NOT NULL DEFAULT 1,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_meal_preorder_item_qty_chk CHECK (quantity > 0),
  CONSTRAINT fds_meal_preorder_item_uq UNIQUE (preorder_id, menu_item_id)
);

CREATE INDEX IF NOT EXISTS fds_meal_preorder_item_preorder_idx
  ON fds_meal_preorder_items (preorder_id);

CREATE INDEX IF NOT EXISTS fds_meal_preorder_item_menu_item_idx
  ON fds_meal_preorder_items (menu_item_id);

COMMENT ON TABLE fds_meal_preorder_items IS
  'Pre-order line items. CASCADE on parent preorder so order cancellation drops the lines. RESTRICT on menu_item_id forbids hard-delete of a menu item that has historical preorder lines attached — admin retires the item via is_active=false. UNIQUE(preorder_id, menu_item_id) caps to one line per item per order with a quantity column rather than duplicate rows.';

CREATE TABLE IF NOT EXISTS fds_preorder_production_reports (
  id                  UUID PRIMARY KEY,
  school_id           UUID NOT NULL,
  service_date        DATE NOT NULL,
  meal_type           TEXT NOT NULL,
  total_orders        INT NOT NULL DEFAULT 0,
  total_items         INT NOT NULL DEFAULT 0,
  report_data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_by        UUID NOT NULL,
  generated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_preorder_report_meal_chk CHECK (
    meal_type IN ('BREAKFAST','LUNCH','DINNER','SNACK')
  ),
  CONSTRAINT fds_preorder_report_counts_chk CHECK (
    total_orders >= 0 AND total_items >= 0
  ),
  CONSTRAINT fds_preorder_report_uq UNIQUE (school_id, service_date, meal_type)
);

CREATE INDEX IF NOT EXISTS fds_preorder_report_school_date_idx
  ON fds_preorder_production_reports (school_id, service_date DESC);

COMMENT ON TABLE fds_preorder_production_reports IS
  'Production planning report aggregated from CONFIRMED pre-orders. UNIQUE(school_id, service_date, meal_type) caps to one report per slot — regeneration UPDATEs the existing row inside the same tenant tx. report_data JSONB carries per-menu-item totals and a dietary-restriction breakdown produced by the PreorderService aggregator. The FSM consumes this report to drive recipe scaling and ingredient pull from inventory.';

/*
 * Forward-compat ALTER on the Cycle 20 fds_production_records — add a
 * recipe_id column linking the production record to the fds_recipes
 * row that produced the served meal. Nullable because historical rows
 * predate P2-10a recipes. SET NULL on recipe delete preserves the
 * production audit even if a recipe is retired.
 */
ALTER TABLE fds_production_records
  ADD COLUMN IF NOT EXISTS recipe_id UUID;

ALTER TABLE fds_production_records
  DROP CONSTRAINT IF EXISTS fds_prod_recipe_fk;

ALTER TABLE fds_production_records
  ADD CONSTRAINT fds_prod_recipe_fk
  FOREIGN KEY (recipe_id) REFERENCES fds_recipes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS fds_prod_recipe_idx
  ON fds_production_records (recipe_id)
  WHERE recipe_id IS NOT NULL;

COMMENT ON COLUMN fds_production_records.recipe_id IS
  'Optional link to the fds_recipes row that produced this served meal. Nullable so historical rows that predate P2-10a recipes still validate. SET NULL on recipe delete preserves the USDA audit row.';
