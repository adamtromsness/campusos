/*
 * 068_fds_menus.sql — Cycle 20 Step 1.
 *
 * M63 Food Service domain 1: rotating menu cycles, food item catalogue
 * with structured allergen codes for the POS cross-check, daily menus,
 * and daily menu item assignments with prepared/served/wasted tracking.
 *
 * Soft FKs to platform.iam_person and platform.platform_users per
 * ADR-001 / ADR-020. The fds_menu_items.allergen_codes TEXT[] is the
 * machine-readable structured surface used by the Step 6 POS service
 * to cross-check against fds_student_allergen_alerts. allergens TEXT[]
 * is the free-text display surface and is not used for safety logic.
 *
 * GIN INDEX on (school_id, allergen_codes) backs the allergen
 * cross-reference query (the && array-overlap operator) on the POS
 * checkout hot path.
 *
 * No semicolons inside string literals or block comments — the tenant
 * provisioner splits on the semicolon character regardless of context.
 */

CREATE TABLE IF NOT EXISTS fds_menu_cycles (
  id                  UUID PRIMARY KEY,
  school_id           UUID NOT NULL,
  name                TEXT NOT NULL,
  description         TEXT,
  cycle_length_days   INT NOT NULL DEFAULT 5,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_by          UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_cycles_length_chk CHECK (cycle_length_days > 0),
  CONSTRAINT fds_cycles_uq UNIQUE (school_id, name)
);

CREATE INDEX IF NOT EXISTS fds_cycles_school_active_idx
  ON fds_menu_cycles (school_id, is_active);

COMMENT ON TABLE fds_menu_cycles IS
  'Rotating menu cycle definition. cycle_length_days drives the day count in the rotation (typical values 5 for a school week or 10 for a fortnight). UNIQUE(school, name) caps to one cycle per name per school. The Step 5 DailyMenuService.generateFromCycle uses the cycle to bulk-generate daily menus over a date range.';

CREATE TABLE IF NOT EXISTS fds_menu_items (
  id                  UUID PRIMARY KEY,
  school_id           UUID NOT NULL,
  name                TEXT NOT NULL,
  description         TEXT,
  category            TEXT NOT NULL,
  unit_cost           NUMERIC(5,2),
  calories            INT,
  allergens           TEXT[] NOT NULL DEFAULT '{}',
  allergen_codes      TEXT[] NOT NULL DEFAULT '{}',
  is_vegetarian       BOOLEAN NOT NULL DEFAULT false,
  is_vegan            BOOLEAN NOT NULL DEFAULT false,
  is_gluten_free      BOOLEAN NOT NULL DEFAULT false,
  is_preorderable     BOOLEAN NOT NULL DEFAULT true,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_by          UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_items_category_chk CHECK (
    category IN ('MAIN', 'SIDE', 'DESSERT', 'DRINK', 'SNACK')
  ),
  CONSTRAINT fds_items_cost_chk CHECK (unit_cost IS NULL OR unit_cost >= 0),
  CONSTRAINT fds_items_calories_chk CHECK (calories IS NULL OR calories >= 0)
);

CREATE INDEX IF NOT EXISTS fds_items_school_category_idx
  ON fds_menu_items (school_id, category);

CREATE INDEX IF NOT EXISTS fds_items_allergen_codes_gin
  ON fds_menu_items USING GIN (allergen_codes);

CREATE INDEX IF NOT EXISTS fds_items_school_active_idx
  ON fds_menu_items (school_id, is_active);

COMMENT ON TABLE fds_menu_items IS
  'Food item catalogue. allergen_codes TEXT[] carries machine-readable codes (MILK, EGG, FISH, SHELLFISH, TREE_NUTS, PEANUTS, WHEAT, SOYBEANS, SESAME) used by the Step 6 POS allergen cross-check against fds_student_allergen_alerts. allergens TEXT[] is the free-text display column. GIN INDEX(allergen_codes) backs the array-overlap query on the POS hot path.';

CREATE TABLE IF NOT EXISTS fds_daily_menus (
  id                  UUID PRIMARY KEY,
  school_id           UUID NOT NULL,
  menu_date           DATE NOT NULL,
  cycle_id            UUID,
  meal_type           TEXT NOT NULL,
  notes               TEXT,
  created_by          UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_daily_menus_meal_chk CHECK (
    meal_type IN ('BREAKFAST', 'LUNCH', 'DINNER', 'SNACK')
  ),
  CONSTRAINT fds_daily_menus_uq UNIQUE (school_id, menu_date, meal_type),
  CONSTRAINT fds_daily_menus_cycle_fk FOREIGN KEY (cycle_id)
    REFERENCES fds_menu_cycles(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS fds_daily_menus_school_date_idx
  ON fds_daily_menus (school_id, menu_date);

COMMENT ON TABLE fds_daily_menus IS
  'Per-(school, date, meal_type) menu slot. UNIQUE(school, menu_date, meal_type) caps to one menu per slot. cycle_id SET NULL on cycle delete preserves historical menus when a cycle is retired.';

CREATE TABLE IF NOT EXISTS fds_daily_menu_items (
  id                  UUID PRIMARY KEY,
  daily_menu_id       UUID NOT NULL,
  menu_item_id        UUID NOT NULL,
  quantity_prepared   INT,
  quantity_served     INT,
  quantity_wasted     INT,
  is_available        BOOLEAN NOT NULL DEFAULT true,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_dmi_prep_chk CHECK (quantity_prepared IS NULL OR quantity_prepared >= 0),
  CONSTRAINT fds_dmi_served_chk CHECK (quantity_served IS NULL OR quantity_served >= 0),
  CONSTRAINT fds_dmi_wasted_chk CHECK (quantity_wasted IS NULL OR quantity_wasted >= 0),
  CONSTRAINT fds_dmi_uq UNIQUE (daily_menu_id, menu_item_id),
  CONSTRAINT fds_dmi_menu_fk FOREIGN KEY (daily_menu_id)
    REFERENCES fds_daily_menus(id) ON DELETE CASCADE,
  CONSTRAINT fds_dmi_item_fk FOREIGN KEY (menu_item_id)
    REFERENCES fds_menu_items(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS fds_dmi_menu_idx
  ON fds_daily_menu_items (daily_menu_id);

COMMENT ON TABLE fds_daily_menu_items IS
  'Daily menu slot. CASCADE on parent daily menu — a slot is meaningless without its menu. NO ACTION on menu_item_id preserves historical record-keeping when an item is retired (admin must remove from active menus first or use is_active=false on the item).';
