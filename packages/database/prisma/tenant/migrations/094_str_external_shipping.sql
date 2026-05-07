/*
 * Cycle 28 Step 3 — External customers + shipping options + revenue.
 *
 * Closes the M67 School Store schema phase:
 *   - str_external_customers: non-CampusOS PUBLIC store buyers
 *     (alumni, community members)
 *   - str_shipping_options: per-store flat-rate shipping methods
 *   - str_store_revenue: materialised periodic revenue summaries
 *     maintained by StoreRevenueWorker
 *
 * Splitter-safe — no semicolons inside block comments, single-quoted
 * strings, or default expressions.
 */

CREATE TABLE IF NOT EXISTS str_external_customers (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  shipping_address TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS str_ext_customers_email_idx
  ON str_external_customers (school_id, email);

COMMENT ON TABLE str_external_customers IS 'Non-CampusOS users (alumni, community members) who purchase from the PUBLIC store. Email is required so the school can send order confirmations and shipping updates. Soft school_id ref per ADR-001/020.';
COMMENT ON COLUMN str_external_customers.shipping_address IS 'Free-form full address. Stored as a single TEXT field this cycle to simplify the public checkout form. Phase 2 polish: split into structured address fields when the volume warrants it.';

/*
  Add the deferred FK from str_orders.external_customer_id now that the
  parent table exists. The schema-level shape CHECK on str_orders
  (customer_shape_chk in migration 093) already validates that
  external_customer_id is set when order_type=EXTERNAL. This FK is the
  DB-enforced existence-and-tenant-locking belt-and-braces.
*/
ALTER TABLE str_orders DROP CONSTRAINT IF EXISTS str_orders_external_customer_fk;
ALTER TABLE str_orders ADD CONSTRAINT str_orders_external_customer_fk
  FOREIGN KEY (external_customer_id) REFERENCES str_external_customers(id) ON DELETE NO ACTION;

CREATE TABLE IF NOT EXISTS str_shipping_options (
  id UUID PRIMARY KEY,
  store_id UUID NOT NULL REFERENCES str_stores(id) ON DELETE CASCADE,
  method_name TEXT NOT NULL,
  estimated_days INT CHECK (estimated_days IS NULL OR estimated_days >= 0),
  flat_rate NUMERIC(8,2) NOT NULL CHECK (flat_rate >= 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS str_shipping_store_active_idx
  ON str_shipping_options (store_id, is_active);

COMMENT ON TABLE str_shipping_options IS 'Per-store flat-rate shipping methods. CASCADE on parent store. Only applies to PUBLIC store orders with shipping_method=SHIPPED.';
COMMENT ON COLUMN str_shipping_options.flat_rate IS 'Single flat shipping fee for the method. Phase 2 polish: weight/distance-based shipping rules.';

/*
  Add the deferred soft FK from str_orders.shipping_option_id. DB
  enforcement so a shipping option retired with active orders cannot
  be hard-deleted, SET NULL preserves the order audit when the option
  IS removed.
*/
ALTER TABLE str_orders DROP CONSTRAINT IF EXISTS str_orders_shipping_option_fk;
ALTER TABLE str_orders ADD CONSTRAINT str_orders_shipping_option_fk
  FOREIGN KEY (shipping_option_id) REFERENCES str_shipping_options(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS str_store_revenue (
  id UUID PRIMARY KEY,
  store_id UUID NOT NULL REFERENCES str_stores(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  total_orders INT NOT NULL DEFAULT 0 CHECK (total_orders >= 0),
  total_revenue NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total_revenue >= 0),
  total_cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
  gross_margin NUMERIC(12,2) NOT NULL DEFAULT 0,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT str_store_revenue_period_chk CHECK (period_end >= period_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS str_store_revenue_period_uq
  ON str_store_revenue (store_id, period_start, period_end);

COMMENT ON TABLE str_store_revenue IS 'Materialised periodic revenue summary maintained by StoreRevenueWorker per ADR-018. UNIQUE(store_id, period_start, period_end) makes the worker idempotent — a re-run for the same period UPSERTs into the same row instead of duplicating.';
COMMENT ON COLUMN str_store_revenue.gross_margin IS 'gross_margin = total_revenue - total_cost. Stored not derived so reads do not pay the math cost on every dashboard query. Allowed negative when cost exceeds revenue.';
