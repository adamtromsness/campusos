/*
 * 134_fds_recipes_inventory.sql — Phase 2 Cycle 10 sub-cycle a (P2-10a).
 *
 * M63 Food Service Advanced — Recipes + Inventory. 8 base tables.
 *
 *   fds_inventory_groups              named inventory pools per school
 *                                     (Main Kitchen, Breakfast, ...).
 *   fds_inventory_items               canonical inventory item catalogue
 *                                     with allergen_codes for cross-check.
 *   fds_inventory_levels              per-(group, item) running stock with
 *                                     non-negative CHECK on quantity_on_hand.
 *   fds_inventory_transactions        IMMUTABLE stock movement audit log.
 *                                     RANGE partition by transaction_at
 *                                     MONTHLY, composite PK (id,
 *                                     transaction_at) because the partition
 *                                     column must appear in the unique
 *                                     constraint. 7-value transaction_type.
 *                                     transfer_reference_id pairs the
 *                                     TRANSFER_OUT and TRANSFER_IN rows the
 *                                     TransferService writes on COMPLETED.
 *   fds_inventory_transfer_requests   inter-group transfer workflow with
 *                                     5-state lifecycle. On COMPLETED, the
 *                                     service writes paired transactions
 *                                     sharing a single transfer_reference_id.
 *   fds_recipes                       recipe catalogue, auto-computed
 *                                     allergens (UNION of ingredients) and
 *                                     cost_per_serving (SUM unit_cost x qty
 *                                     divided by serving_yield).
 *   fds_recipe_ingredients            ingredient lines, soft FK to
 *                                     fds_inventory_items.
 *   fds_staff_meal_accounts           employee meal account with payroll
 *                                     deduction or prepaid balance.
 *
 * Soft FKs to platform.iam_person per ADR-001 and ADR-020. Cross-cycle
 * refs to hr_employees (managed_by, performed_by, requested_by) use DB
 * enforced FK with ON DELETE SET NULL since hr_employees is in the same
 * tenant schema.
 *
 * No semicolons inside string literals or block comments. The tenant
 * provisioner splits the migration on every semicolon character without
 * quoting context.
 */

CREATE TABLE IF NOT EXISTS fds_inventory_groups (
  id                  UUID PRIMARY KEY,
  school_id           UUID NOT NULL,
  name                TEXT NOT NULL,
  group_type          TEXT NOT NULL,
  location            TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  managed_by          UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_inventory_groups_type_chk CHECK (
    group_type IN ('LUNCH','BREAKFAST','SNACK','CONCESSIONS','CATERING','OTHER')
  ),
  CONSTRAINT fds_inventory_groups_uq UNIQUE (school_id, name)
);

CREATE INDEX IF NOT EXISTS fds_inventory_groups_school_active_idx
  ON fds_inventory_groups (school_id, is_active);

COMMENT ON TABLE fds_inventory_groups IS
  'Named inventory pools per school. UNIQUE(school, name) caps to one group per name. managed_by SET NULL preserves the group when the assigned FSM employee leaves.';

CREATE TABLE IF NOT EXISTS fds_inventory_items (
  id                    UUID PRIMARY KEY,
  school_id             UUID NOT NULL,
  name                  TEXT NOT NULL,
  unit                  TEXT NOT NULL,
  category              TEXT NOT NULL,
  allergen_codes        TEXT[] NOT NULL DEFAULT '{}',
  reorder_threshold     NUMERIC(8,2),
  preferred_vendor_id   UUID,
  unit_cost             NUMERIC(8,4),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_inventory_items_category_chk CHECK (
    category IN ('PROTEIN','DAIRY','GRAIN','VEGETABLE','FRUIT','CONDIMENT','BEVERAGE','PACKAGING','OTHER')
  ),
  CONSTRAINT fds_inventory_items_reorder_chk CHECK (
    reorder_threshold IS NULL OR reorder_threshold >= 0
  ),
  CONSTRAINT fds_inventory_items_cost_chk CHECK (
    unit_cost IS NULL OR unit_cost >= 0
  ),
  CONSTRAINT fds_inventory_items_uq UNIQUE (school_id, name)
);

CREATE INDEX IF NOT EXISTS fds_inventory_items_school_category_idx
  ON fds_inventory_items (school_id, category);

CREATE INDEX IF NOT EXISTS fds_inventory_items_allergen_codes_gin
  ON fds_inventory_items USING GIN (allergen_codes);

COMMENT ON TABLE fds_inventory_items IS
  'Canonical inventory item catalogue per school. allergen_codes TEXT[] is the machine readable allergen surface, GIN indexed for the cross-check query. preferred_vendor_id is a soft UUID ref to fin_suppliers per ADR-001 — that table lives in the Procurement schema and the soft ref keeps Food Service decoupled.';

CREATE TABLE IF NOT EXISTS fds_inventory_levels (
  id                    UUID PRIMARY KEY,
  group_id              UUID NOT NULL REFERENCES fds_inventory_groups(id) ON DELETE CASCADE,
  item_id               UUID NOT NULL REFERENCES fds_inventory_items(id) ON DELETE CASCADE,
  quantity_on_hand      NUMERIC(10,3) NOT NULL DEFAULT 0,
  last_counted_at       TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_inventory_levels_qty_chk CHECK (quantity_on_hand >= 0),
  CONSTRAINT fds_inventory_levels_uq UNIQUE (group_id, item_id)
);

CREATE INDEX IF NOT EXISTS fds_inventory_levels_group_idx
  ON fds_inventory_levels (group_id);

CREATE INDEX IF NOT EXISTS fds_inventory_levels_item_idx
  ON fds_inventory_levels (item_id);

CREATE INDEX IF NOT EXISTS fds_inventory_levels_zero_idx
  ON fds_inventory_levels (group_id, quantity_on_hand) WHERE quantity_on_hand = 0;

COMMENT ON TABLE fds_inventory_levels IS
  'Per-(group, item) running stock level. Non-negative CHECK on quantity_on_hand guarantees the schema rejects any service bug that would oversubtract a USAGE. The partial INDEX on (group, qty) WHERE qty=0 backs the out-of-stock dashboard hot path. InventoryService emits fds.inventory.low after the row UPDATE crosses the parent fds_inventory_items.reorder_threshold downward.';

CREATE TABLE IF NOT EXISTS fds_inventory_transactions (
  id                      UUID NOT NULL,
  school_id               UUID NOT NULL,
  group_id                UUID NOT NULL REFERENCES fds_inventory_groups(id),
  item_id                 UUID NOT NULL REFERENCES fds_inventory_items(id),
  transaction_type        TEXT NOT NULL,
  quantity_delta          NUMERIC(10,3) NOT NULL,
  performed_by            UUID NOT NULL,
  transaction_at          TIMESTAMPTZ NOT NULL,
  transfer_reference_id   UUID,
  related_session_id      UUID,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_inventory_transactions_pk PRIMARY KEY (id, transaction_at),
  CONSTRAINT fds_inventory_transactions_type_chk CHECK (
    transaction_type IN ('RECEIPT','USAGE','WASTE','ADJUSTMENT','TRANSFER_IN','TRANSFER_OUT','STOCKTAKE')
  )
) PARTITION BY RANGE (transaction_at);

CREATE INDEX IF NOT EXISTS fds_inventory_transactions_group_item_idx
  ON fds_inventory_transactions (group_id, item_id, transaction_at DESC);

CREATE INDEX IF NOT EXISTS fds_inventory_transactions_school_idx
  ON fds_inventory_transactions (school_id, transaction_at DESC);

CREATE INDEX IF NOT EXISTS fds_inventory_transactions_transfer_idx
  ON fds_inventory_transactions (transfer_reference_id) WHERE transfer_reference_id IS NOT NULL;

COMMENT ON TABLE fds_inventory_transactions IS
  'IMMUTABLE stock movement audit log. Composite PK (id, transaction_at) because the partition column must appear in the unique constraint. NO UPDATE and NO DELETE at the service layer — corrections land as a new ADJUSTMENT or STOCKTAKE row with notes pointing at the original. transfer_reference_id pairs the TRANSFER_OUT and TRANSFER_IN rows the TransferService writes on COMPLETED. related_session_id is a soft UUID ref to fds_meal_service_sessions for tracing USAGE back to a service session.';

CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2024_08 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2024-08-01') TO ('2024-09-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2024_09 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2024-09-01') TO ('2024-10-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2024_10 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2024-10-01') TO ('2024-11-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2024_11 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2024-11-01') TO ('2024-12-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2024_12 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2024-12-01') TO ('2025-01-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2025_01 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2025_02 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2025_03 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2025-03-01') TO ('2025-04-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2025_04 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2025-04-01') TO ('2025-05-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2025_05 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2025-05-01') TO ('2025-06-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2025_06 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2025-06-01') TO ('2025-07-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2025_07 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2025-07-01') TO ('2025-08-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2025_08 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2025-08-01') TO ('2025-09-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2025_09 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2025-09-01') TO ('2025-10-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2025_10 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2025_11 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2025_12 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2026_01 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2026_02 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2026_03 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2026_04 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2026_05 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2026_06 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2026_07 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2026_08 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2026_09 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2026_10 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2026_11 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2026_12 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2027_01 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2027_02 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2027_03 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2027_04 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2027_05 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2027_06 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE IF NOT EXISTS fds_inventory_transactions_2027_07 PARTITION OF fds_inventory_transactions FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');

CREATE TABLE IF NOT EXISTS fds_inventory_transfer_requests (
  id                      UUID PRIMARY KEY,
  school_id               UUID NOT NULL,
  from_group_id           UUID NOT NULL REFERENCES fds_inventory_groups(id),
  to_group_id             UUID NOT NULL REFERENCES fds_inventory_groups(id),
  item_id                 UUID NOT NULL REFERENCES fds_inventory_items(id),
  quantity                NUMERIC(10,3) NOT NULL,
  reason                  TEXT,
  status                  TEXT NOT NULL DEFAULT 'PENDING',
  requested_by            UUID NOT NULL,
  reviewed_by             UUID,
  reviewed_at             TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  transfer_reference_id   UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_transfer_qty_chk CHECK (quantity > 0),
  CONSTRAINT fds_transfer_distinct_chk CHECK (from_group_id <> to_group_id),
  CONSTRAINT fds_transfer_status_chk CHECK (
    status IN ('PENDING','APPROVED','COMPLETED','REJECTED','CANCELLED')
  ),
  CONSTRAINT fds_transfer_reviewed_chk CHECK (
    (status = 'PENDING' AND reviewed_at IS NULL AND reviewed_by IS NULL)
    OR (status IN ('APPROVED','REJECTED') AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND completed_at IS NULL AND transfer_reference_id IS NULL)
    OR (status = 'COMPLETED' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND completed_at IS NOT NULL AND transfer_reference_id IS NOT NULL)
    OR (status = 'CANCELLED')
  )
);

CREATE INDEX IF NOT EXISTS fds_transfer_school_status_idx
  ON fds_inventory_transfer_requests (school_id, status)
  WHERE status IN ('PENDING','APPROVED');

CREATE INDEX IF NOT EXISTS fds_transfer_from_idx
  ON fds_inventory_transfer_requests (from_group_id);

CREATE INDEX IF NOT EXISTS fds_transfer_to_idx
  ON fds_inventory_transfer_requests (to_group_id);

COMMENT ON TABLE fds_inventory_transfer_requests IS
  'Inter-group transfer workflow. 5-state lifecycle PENDING/APPROVED/COMPLETED/REJECTED/CANCELLED enforced by reviewed_chk multi-column CHECK keeping reviewed/completed timestamps in lockstep. On COMPLETED, TransferService writes paired TRANSFER_OUT and TRANSFER_IN fds_inventory_transactions rows sharing a single transfer_reference_id and stamps that same UUID on the request row.';

CREATE TABLE IF NOT EXISTS fds_recipes (
  id                  UUID PRIMARY KEY,
  school_id           UUID NOT NULL,
  name                TEXT NOT NULL,
  category            TEXT NOT NULL,
  serving_yield       INT NOT NULL,
  prep_time_minutes   INT,
  cook_time_minutes   INT,
  instructions        TEXT,
  allergens           TEXT[] NOT NULL DEFAULT '{}',
  cost_per_serving    NUMERIC(6,2),
  menu_item_id        UUID REFERENCES fds_menu_items(id) ON DELETE SET NULL,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_by          UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_recipes_category_chk CHECK (
    category IN ('ENTREE','SIDE','VEGETABLE','FRUIT','GRAIN','DAIRY','BEVERAGE','SNACK','DESSERT')
  ),
  CONSTRAINT fds_recipes_yield_chk CHECK (serving_yield > 0),
  CONSTRAINT fds_recipes_prep_chk CHECK (prep_time_minutes IS NULL OR prep_time_minutes >= 0),
  CONSTRAINT fds_recipes_cook_chk CHECK (cook_time_minutes IS NULL OR cook_time_minutes >= 0),
  CONSTRAINT fds_recipes_cost_chk CHECK (cost_per_serving IS NULL OR cost_per_serving >= 0)
);

CREATE INDEX IF NOT EXISTS fds_recipes_school_category_idx
  ON fds_recipes (school_id, category);

CREATE INDEX IF NOT EXISTS fds_recipes_school_active_idx
  ON fds_recipes (school_id, is_active);

CREATE INDEX IF NOT EXISTS fds_recipes_menu_item_idx
  ON fds_recipes (menu_item_id) WHERE menu_item_id IS NOT NULL;

COMMENT ON TABLE fds_recipes IS
  'Recipe catalogue per school. allergens TEXT[] is auto-computed as UNION of fds_recipe_ingredients.allergens on every ingredient INSERT or UPDATE in the service layer. cost_per_serving auto-computed as SUM(unit_cost * quantity) divided by serving_yield. menu_item_id SET NULL on retire of a menu item preserves the recipe history.';

CREATE TABLE IF NOT EXISTS fds_recipe_ingredients (
  id                  UUID PRIMARY KEY,
  recipe_id           UUID NOT NULL REFERENCES fds_recipes(id) ON DELETE CASCADE,
  inventory_item_id   UUID REFERENCES fds_inventory_items(id) ON DELETE SET NULL,
  ingredient_name     TEXT NOT NULL,
  quantity            NUMERIC(8,3) NOT NULL,
  unit                TEXT NOT NULL,
  allergens           TEXT[] NOT NULL DEFAULT '{}',
  unit_cost           NUMERIC(6,3),
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_recipe_ingredients_qty_chk CHECK (quantity > 0),
  CONSTRAINT fds_recipe_ingredients_cost_chk CHECK (unit_cost IS NULL OR unit_cost >= 0),
  CONSTRAINT fds_recipe_ingredients_uq UNIQUE (recipe_id, ingredient_name)
);

CREATE INDEX IF NOT EXISTS fds_recipe_ingredients_recipe_idx
  ON fds_recipe_ingredients (recipe_id);

CREATE INDEX IF NOT EXISTS fds_recipe_ingredients_item_idx
  ON fds_recipe_ingredients (inventory_item_id) WHERE inventory_item_id IS NOT NULL;

COMMENT ON TABLE fds_recipe_ingredients IS
  'Recipe ingredient lines. CASCADE on parent recipe since an orphan ingredient is meaningless. inventory_item_id SET NULL preserves the line when the canonical inventory item is retired. The RecipeService recomputes the parent recipe.allergens (UNION) and recipe.cost_per_serving on every INSERT, UPDATE, or DELETE.';

CREATE TABLE IF NOT EXISTS fds_staff_meal_accounts (
  id                  UUID PRIMARY KEY,
  employee_id         UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  school_id           UUID,
  balance             NUMERIC(8,2) NOT NULL DEFAULT 0,
  deduction_method    TEXT NOT NULL DEFAULT 'PAYROLL',
  daily_limit         NUMERIC(6,2),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_staff_meal_method_chk CHECK (
    deduction_method IN ('PAYROLL','PREPAID','COMPLIMENTARY')
  ),
  CONSTRAINT fds_staff_meal_limit_chk CHECK (
    daily_limit IS NULL OR daily_limit >= 0
  ),
  CONSTRAINT fds_staff_meal_employee_uq UNIQUE (employee_id)
);

CREATE INDEX IF NOT EXISTS fds_staff_meal_school_idx
  ON fds_staff_meal_accounts (school_id);

COMMENT ON TABLE fds_staff_meal_accounts IS
  'Employee meal account. UNIQUE(employee_id) caps to one account per employee. PAYROLL deduction integrates with P2-4 payroll. PREPAID balance is decremented on each meal charge with a >= 0 service-layer check. COMPLIMENTARY accounts (free staff meals for senior leadership) bypass balance checks.';
