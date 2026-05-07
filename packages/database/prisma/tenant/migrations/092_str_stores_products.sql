/*
 * Cycle 28 Step 1 — Stores + Products + Inventory schema.
 *
 * M67 School Store, dual-mode per ADR-062:
 *   - STUDENT store: students browse and order, parent approval gate
 *     before payment, family-account billing
 *   - PUBLIC store: external customers (alumni, community), shipping,
 *     direct payment
 *
 * 3 base tables in this migration. Steps 2 and 3 land orders + lines +
 * approvals + external customers + shipping + revenue.
 *
 * Splitter-safe — no semicolons inside block comments, single-quoted
 * strings, or default expressions.
 */

CREATE TABLE IF NOT EXISTS str_stores (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  store_type TEXT NOT NULL CHECK (store_type IN ('STUDENT', 'PUBLIC')),
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS str_stores_school_type_uq
  ON str_stores (school_id, store_type);

COMMENT ON TABLE str_stores IS 'M67 School Store registry. UNIQUE(school_id, store_type) caps each school at one STUDENT store and one PUBLIC store per ADR-062.';
COMMENT ON COLUMN str_stores.store_type IS '2-value CHECK STUDENT (parent approval gate, family-account billing) or PUBLIC (external customers, shipping, direct payment).';
COMMENT ON COLUMN str_stores.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020.';

CREATE TABLE IF NOT EXISTS str_products (
  id UUID PRIMARY KEY,
  store_id UUID NOT NULL REFERENCES str_stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  sku TEXT,
  category TEXT,
  price NUMERIC(8,2) NOT NULL CHECK (price >= 0),
  cost NUMERIC(8,2) CHECK (cost IS NULL OR cost >= 0),
  image_s3_keys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  is_active BOOLEAN NOT NULL DEFAULT true,
  backorder_allowed BOOLEAN NOT NULL DEFAULT false,
  preferred_supplier_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS str_products_store_cat_idx
  ON str_products (store_id, category, is_active);

CREATE INDEX IF NOT EXISTS str_products_store_active_idx
  ON str_products (store_id, is_active);

COMMENT ON TABLE str_products IS 'Per-store product catalogue. SKU + category are free-form strings, intentional — schools set their own conventions.';
COMMENT ON COLUMN str_products.cost IS 'Per-unit cost used by StoreRevenueWorker to compute gross margin. Nullable when cost is unknown or irrelevant.';
COMMENT ON COLUMN str_products.image_s3_keys IS 'Array of S3 keys for product images. Soft refs per ADR-001/020.';
COMMENT ON COLUMN str_products.preferred_supplier_id IS 'Soft ref to fin_suppliers(id) per ADR-001/020. Carried in str.inventory.reorder_needed payload so the Cycle 27 procurement consumer can pre-fill the requisition vendor.';

CREATE TABLE IF NOT EXISTS str_product_inventory (
  id UUID PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES str_products(id) ON DELETE CASCADE,
  location_type TEXT NOT NULL CHECK (location_type IN ('BUILDING', 'DISTRICT')),
  location_id UUID NOT NULL,
  quantity_on_hand INT NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  quantity_reserved INT NOT NULL DEFAULT 0 CHECK (quantity_reserved >= 0),
  reorder_point INT NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
  reorder_quantity INT NOT NULL DEFAULT 0 CHECK (reorder_quantity >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS str_inv_product_loc_uq
  ON str_product_inventory (product_id, location_type, location_id);

CREATE INDEX IF NOT EXISTS str_inv_reorder_idx
  ON str_product_inventory (product_id)
  WHERE quantity_on_hand <= reorder_point AND reorder_point > 0;

COMMENT ON TABLE str_product_inventory IS 'Per-(product, location) stock with reservation tracking. UNIQUE(product, location_type, location_id) prevents duplicate inventory rows for the same physical location. The partial INDEX backs the reorder-alert dashboard.';
COMMENT ON COLUMN str_product_inventory.quantity_reserved IS 'Reserved by PENDING_APPROVAL + APPROVED + PROCESSING orders. Decremented when the order is CANCELLED OR when the order completes (decrement reserved + decrement on_hand together inside the same tx).';
COMMENT ON COLUMN str_product_inventory.location_id IS 'Soft polymorphic ref. When location_type=BUILDING resolves to a building, when DISTRICT resolves to a district scope. Per ADR-001/020 no DB-enforced FK.';
