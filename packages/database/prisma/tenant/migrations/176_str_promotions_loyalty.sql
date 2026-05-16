/* ============================================================
 * Phase 2 Cycle 29 sub-cycle b (P2-29b) — Store Advanced
 * ============================================================
 *
 * Ships 10 logical base tables plus 1 ALTER on the Cycle 28
 * str_products row, completing the M67.1 Store Advanced surface
 * (the second half of the Commerce .1 bundle).
 *
 *  Store Advanced (M67.1):
 *   - str_inventory_adjustments: audit trail for stock movements
 *     outside the normal sales pipeline. 5-value adjustment_type
 *     CHECK (RECOUNT, DAMAGE, THEFT, RETURN_TO_STOCK, WRITE_OFF).
 *     Service layer drives the corresponding str_product_inventory
 *     row mutation inside the same tenant tx as the audit insert.
 *     Schema-side numeric CHECK keeps quantity_delta non-zero so
 *     no-op adjustments cannot bloat the audit log.
 *   - str_promotions: per-store promo with date range plus
 *     4-value discount_type CHECK (PERCENTAGE, FLAT_AMOUNT, BOGO,
 *     FREE_SHIPPING). Partial UNIQUE(store_id, promo_code) WHERE
 *     promo_code IS NOT NULL so multiple silent (code-less)
 *     promotions can coexist while named promo codes are unique
 *     per store. CHECK(ends_at > starts_at) window invariant.
 *     The Step 4 PromotionService.applyPromoCode path is the
 *     authoritative max_uses gate via an atomic UPDATE … WHERE
 *     current_uses < max_uses RETURNING — zero rows returned
 *     means the cap fired.
 *   - str_promotion_products: junction. UNIQUE(promotion_id,
 *     product_id). Empty for a promotion means it applies to
 *     every product on the parent store.
 *   - str_loyalty_config: per-store programme parameters. UNIQUE
 *     on store_id — one config row per store. points_per_dollar
 *     and redemption_rate_cents drive the earn + redeem maths,
 *     min_redemption_points caps low-value redemptions, and
 *     is_enabled is the master kill switch the service layer
 *     checks before any loyalty operation.
 *   - str_loyalty_transactions: append-only ledger of EARNED /
 *     REDEEMED / ADJUSTMENT rows. Customer balance is computed
 *     in service code as SUM(points) where transaction_type IN
 *     (EARNED, ADJUSTMENT) MINUS SUM(points) WHERE
 *     transaction_type = REDEEMED — no balance denormalisation
 *     so the ledger is the canonical source of truth. CHECK on
 *     points > 0 prevents zero-point rows.
 *   - str_gift_cards: gift card head row. UNIQUE(card_code) for
 *     scannable redemption. current_balance_cents non-negative
 *     CHECK is the schema-side belt-and-braces against under-
 *     redemption (the Step 4 service layer is the actual gate
 *     via atomic decrement). status 3-value CHECK (ACTIVE,
 *     DEPLETED, CANCELLED).
 *   - str_gift_card_transactions: append-only ledger of PURCHASE
 *     / REDEMPTION / TOP_UP rows. Drives the audit log + reverse-
 *     scan history of every dollar in / out.
 *   - str_wishlists: per-(customer, product) wishlist row.
 *     UNIQUE(customer_person_id, product_id) so re-adding is a
 *     no-op. notify_on_restock=true joined by the Cycle 28
 *     inventory-reorder consumer chain (future) to fan out a
 *     restock notification when stock crosses 0.
 *   - str_price_schedules: per-product scheduled price change.
 *     effective_from required, effective_to nullable for an
 *     open-ended new price. The Step 4 PriceScheduleWorker
 *     applies scheduled rows when effective_from arrives and
 *     reverts at effective_to if set.
 *   - str_category_hierarchy: self-referential category tree.
 *     parent_category_id nullable — null = top-level. UNIQUE
 *     (store_id, name, COALESCE(parent_category_id, sentinel))
 *     pattern so a sibling collision is caught while the root
 *     and any sub-tree can both carry the same name. sort_order
 *     drives the category list order.
 *
 *  ALTER on Cycle 28 str_products:
 *   - ADD COLUMN category_id UUID nullable + DB-enforced FK to
 *     str_category_hierarchy ON DELETE SET NULL so a category
 *     removal leaves products defensible (they fall back to the
 *     uncategorised bucket). The original free-form text
 *     str_products.category column stays untouched for
 *     backwards-compat (the Step 4 service layer is the
 *     authoritative writer for new product rows and prefers the
 *     hierarchy column).
 *
 * 12 new intra-tenant DB-enforced FKs:
 *   - str_inventory_adjustments.product_id CASCADE on str_products
 *   - str_inventory_adjustments.inventory_id CASCADE on
 *     str_product_inventory
 *   - str_promotions.store_id CASCADE on str_stores
 *   - str_promotion_products.promotion_id CASCADE on str_promotions
 *   - str_promotion_products.product_id CASCADE on str_products
 *   - str_loyalty_config.store_id CASCADE on str_stores
 *   - str_loyalty_transactions.store_id CASCADE on str_stores
 *   - str_gift_cards.store_id CASCADE on str_stores
 *   - str_gift_card_transactions.card_id CASCADE on str_gift_cards
 *   - str_wishlists.product_id CASCADE on str_products
 *   - str_price_schedules.product_id CASCADE on str_products
 *   - str_category_hierarchy.parent_category_id NO ACTION
 *     self-FK (admin must reparent children before removing
 *     a non-leaf row — see CategoryHierarchyService.remove)
 *
 * Plus 1 ALTER FK on str_products.category_id SET NULL.
 *
 * 0 cross-schema FKs. All cross-tenant refs (store_id,
 * customer_person_id, purchased_by, recipient_email,
 * adjusted_by, requested_by, order_id) follow ADR-001/020.
 * ============================================================ */

CREATE TABLE IF NOT EXISTS str_inventory_adjustments (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  product_id UUID NOT NULL,
  inventory_id UUID NOT NULL,
  adjustment_type TEXT NOT NULL,
  quantity_delta INT NOT NULL,
  reason TEXT NOT NULL,
  adjusted_by UUID NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT str_ia_type_chk CHECK (
    adjustment_type IN ('RECOUNT', 'DAMAGE', 'THEFT', 'RETURN_TO_STOCK', 'WRITE_OFF')
  ),
  CONSTRAINT str_ia_delta_chk CHECK (quantity_delta <> 0),
  CONSTRAINT str_ia_reason_chk CHECK (length(trim(reason)) >= 5)
);

CREATE INDEX IF NOT EXISTS str_ia_product_idx
  ON str_inventory_adjustments (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS str_ia_school_idx
  ON str_inventory_adjustments (school_id, created_at DESC);
CREATE INDEX IF NOT EXISTS str_ia_inventory_idx
  ON str_inventory_adjustments (inventory_id, created_at DESC);

COMMENT ON TABLE str_inventory_adjustments IS 'Audit trail for stock movements outside the normal sales pipeline — RECOUNT, DAMAGE, THEFT, RETURN_TO_STOCK, WRITE_OFF. Service layer drives the corresponding str_product_inventory mutation inside the same tenant tx.';
COMMENT ON COLUMN str_inventory_adjustments.quantity_delta IS 'Signed integer. Positive increments quantity_on_hand on the linked inventory row, negative decrements. CHECK <> 0 rejects no-op rows.';
COMMENT ON COLUMN str_inventory_adjustments.inventory_id IS 'DB-enforced FK to str_product_inventory(id). CASCADE on inventory delete so the audit chain follows the row.';
COMMENT ON COLUMN str_inventory_adjustments.adjusted_by IS 'Soft ref to hr_employees(id) per ADR-001/020. Captured at adjust time.';

CREATE TABLE IF NOT EXISTS str_promotions (
  id UUID PRIMARY KEY,
  store_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  discount_type TEXT NOT NULL,
  discount_value NUMERIC(10,2) NOT NULL,
  min_order_amount NUMERIC(10,2),
  promo_code TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  max_uses INT,
  current_uses INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT str_promo_type_chk CHECK (
    discount_type IN ('PERCENTAGE', 'FLAT_AMOUNT', 'BOGO', 'FREE_SHIPPING')
  ),
  CONSTRAINT str_promo_value_chk CHECK (discount_value >= 0),
  CONSTRAINT str_promo_pct_chk CHECK (
    discount_type <> 'PERCENTAGE' OR discount_value <= 100
  ),
  CONSTRAINT str_promo_window_chk CHECK (ends_at > starts_at),
  CONSTRAINT str_promo_min_chk CHECK (min_order_amount IS NULL OR min_order_amount >= 0),
  CONSTRAINT str_promo_uses_chk CHECK (current_uses >= 0),
  CONSTRAINT str_promo_max_chk CHECK (max_uses IS NULL OR max_uses > 0),
  CONSTRAINT str_promo_cap_chk CHECK (max_uses IS NULL OR current_uses <= max_uses)
);

CREATE UNIQUE INDEX IF NOT EXISTS str_promo_code_uq
  ON str_promotions (store_id, promo_code)
  WHERE promo_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS str_promo_store_window_idx
  ON str_promotions (store_id, starts_at, ends_at)
  WHERE is_active = true;

COMMENT ON TABLE str_promotions IS 'Per-store discount promotion with 4-value discount_type CHECK and atomic max_uses enforcement via UPDATE … WHERE current_uses < max_uses RETURNING in the Step 4 PromotionService.';
COMMENT ON COLUMN str_promotions.promo_code IS 'Optional case-sensitive promo code. Partial UNIQUE(store_id, promo_code) WHERE promo_code IS NOT NULL so multiple silent promotions can coexist while named codes are unique per store.';
COMMENT ON COLUMN str_promotions.max_uses IS 'Optional cap on total redemptions across all customers. NULL means unlimited. The schema-side str_promo_cap_chk is the belt-and-braces — the service layer enforces the cap atomically.';
COMMENT ON COLUMN str_promotions.discount_value IS 'For PERCENTAGE this is 0-100 (CHECK pct_chk). For FLAT_AMOUNT this is the cash discount. For BOGO and FREE_SHIPPING the value column is ignored by the application layer.';

CREATE TABLE IF NOT EXISTS str_promotion_products (
  id UUID PRIMARY KEY,
  promotion_id UUID NOT NULL,
  product_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT str_pp_uq UNIQUE (promotion_id, product_id)
);

CREATE INDEX IF NOT EXISTS str_pp_product_idx
  ON str_promotion_products (product_id);
CREATE INDEX IF NOT EXISTS str_pp_promo_idx
  ON str_promotion_products (promotion_id);

COMMENT ON TABLE str_promotion_products IS 'Junction. UNIQUE(promotion, product). Empty for a promotion means it applies to every product on the parent store.';

CREATE TABLE IF NOT EXISTS str_loyalty_config (
  id UUID PRIMARY KEY,
  store_id UUID NOT NULL UNIQUE,
  points_per_dollar INT NOT NULL DEFAULT 1,
  redemption_rate_cents INT NOT NULL DEFAULT 1,
  min_redemption_points INT NOT NULL DEFAULT 100,
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT str_lc_ppd_chk CHECK (points_per_dollar > 0),
  CONSTRAINT str_lc_rate_chk CHECK (redemption_rate_cents > 0),
  CONSTRAINT str_lc_min_chk CHECK (min_redemption_points > 0)
);

COMMENT ON TABLE str_loyalty_config IS 'Per-store loyalty programme parameters. UNIQUE on store_id — one config per store. is_enabled is the master kill switch the LoyaltyService checks before any earn or redeem.';
COMMENT ON COLUMN str_loyalty_config.points_per_dollar IS 'Points earned per dollar spent (integer multiplier). Default 1 = 1 point per dollar.';
COMMENT ON COLUMN str_loyalty_config.redemption_rate_cents IS 'Discount in cents per point redeemed. Default 1 = 1 point worth 1 cent (100 points = 1 dollar discount).';

CREATE TABLE IF NOT EXISTS str_loyalty_transactions (
  id UUID PRIMARY KEY,
  store_id UUID NOT NULL,
  customer_person_id UUID NOT NULL,
  transaction_type TEXT NOT NULL,
  points INT NOT NULL,
  order_id UUID,
  description TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT str_lt_type_chk CHECK (transaction_type IN ('EARNED', 'REDEEMED', 'ADJUSTMENT')),
  CONSTRAINT str_lt_points_chk CHECK (points > 0)
);

CREATE INDEX IF NOT EXISTS str_lt_customer_idx
  ON str_loyalty_transactions (customer_person_id, created_at DESC);
CREATE INDEX IF NOT EXISTS str_lt_store_idx
  ON str_loyalty_transactions (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS str_lt_order_idx
  ON str_loyalty_transactions (order_id)
  WHERE order_id IS NOT NULL;

COMMENT ON TABLE str_loyalty_transactions IS 'Append-only loyalty ledger. Customer balance computed as SUM(points WHERE type IN (EARNED, ADJUSTMENT)) MINUS SUM(points WHERE type=REDEEMED). No balance denormalisation — the ledger is the canonical source of truth.';
COMMENT ON COLUMN str_loyalty_transactions.points IS 'Always positive integer. The transaction_type column determines whether the row contributes positively (EARNED, ADJUSTMENT) or negatively (REDEEMED) to the customer balance.';
COMMENT ON COLUMN str_loyalty_transactions.customer_person_id IS 'Soft ref to platform.iam_person per ADR-001/020. Matches the customer_person_id pattern on str_orders.';

CREATE TABLE IF NOT EXISTS str_gift_cards (
  id UUID PRIMARY KEY,
  store_id UUID NOT NULL,
  card_code TEXT NOT NULL UNIQUE,
  initial_balance_cents INT NOT NULL,
  current_balance_cents INT NOT NULL,
  purchased_by UUID,
  recipient_email TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  expires_at DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT str_gc_status_chk CHECK (status IN ('ACTIVE', 'DEPLETED', 'CANCELLED')),
  CONSTRAINT str_gc_initial_chk CHECK (initial_balance_cents > 0),
  CONSTRAINT str_gc_balance_chk CHECK (current_balance_cents >= 0),
  CONSTRAINT str_gc_cap_chk CHECK (current_balance_cents <= initial_balance_cents + 100000000),
  CONSTRAINT str_gc_depleted_chk CHECK (
    status <> 'DEPLETED' OR current_balance_cents = 0
  )
);

CREATE INDEX IF NOT EXISTS str_gc_store_idx
  ON str_gift_cards (store_id, status);
CREATE INDEX IF NOT EXISTS str_gc_recipient_idx
  ON str_gift_cards (recipient_email)
  WHERE recipient_email IS NOT NULL;

COMMENT ON TABLE str_gift_cards IS 'Gift card head row. UNIQUE(card_code) for scannable redemption. current_balance_cents non-negative CHECK is the schema-side belt-and-braces against under-redemption — the Step 4 GiftCardService.redeem path is the actual atomic gate via UPDATE … WHERE current_balance_cents >= amount RETURNING.';
COMMENT ON COLUMN str_gift_cards.card_code IS 'Scannable card code. Generated by Step 4 GiftCardService via 16-character upper-case alphanumeric (excluding ambiguous I/O/0/1). UNIQUE across tenant.';
COMMENT ON COLUMN str_gift_cards.current_balance_cents IS 'Current remaining balance in cents. Decremented atomically on REDEMPTION, incremented on TOP_UP. status flips to DEPLETED when balance hits zero (multi-column lockstep CHECK str_gc_depleted_chk).';
COMMENT ON COLUMN str_gift_cards.purchased_by IS 'Soft ref to platform.iam_person of the buyer. Nullable for admin-issued promotional cards.';

CREATE TABLE IF NOT EXISTS str_gift_card_transactions (
  id UUID PRIMARY KEY,
  card_id UUID NOT NULL,
  transaction_type TEXT NOT NULL,
  amount_cents INT NOT NULL,
  order_id UUID,
  performed_by UUID,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT str_gct_type_chk CHECK (transaction_type IN ('PURCHASE', 'REDEMPTION', 'TOP_UP')),
  CONSTRAINT str_gct_amount_chk CHECK (amount_cents > 0)
);

CREATE INDEX IF NOT EXISTS str_gct_card_idx
  ON str_gift_card_transactions (card_id, created_at DESC);
CREATE INDEX IF NOT EXISTS str_gct_order_idx
  ON str_gift_card_transactions (order_id)
  WHERE order_id IS NOT NULL;

COMMENT ON TABLE str_gift_card_transactions IS 'Append-only ledger of PURCHASE / REDEMPTION / TOP_UP rows. Drives the audit log of every dollar in and out. The Step 4 GiftCardService.redeem path writes the ledger row inside the same tenant tx as the atomic current_balance_cents decrement.';

CREATE TABLE IF NOT EXISTS str_wishlists (
  id UUID PRIMARY KEY,
  customer_person_id UUID NOT NULL,
  product_id UUID NOT NULL,
  notify_on_restock BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT str_wl_uq UNIQUE (customer_person_id, product_id)
);

CREATE INDEX IF NOT EXISTS str_wl_product_notify_idx
  ON str_wishlists (product_id)
  WHERE notify_on_restock = true;
CREATE INDEX IF NOT EXISTS str_wl_customer_idx
  ON str_wishlists (customer_person_id);

COMMENT ON TABLE str_wishlists IS 'Per-(customer, product) wishlist. UNIQUE(customer, product) so re-adding is a no-op. The partial INDEX on notify_on_restock=true backs the future RestockNotificationWorker fan-out when stock crosses 0.';

CREATE TABLE IF NOT EXISTS str_price_schedules (
  id UUID PRIMARY KEY,
  product_id UUID NOT NULL,
  scheduled_price NUMERIC(8,2) NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ,
  reason TEXT,
  applied_at TIMESTAMPTZ,
  reverted_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT str_ps_price_chk CHECK (scheduled_price >= 0),
  CONSTRAINT str_ps_window_chk CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX IF NOT EXISTS str_ps_product_idx
  ON str_price_schedules (product_id, effective_from);
CREATE INDEX IF NOT EXISTS str_ps_ripe_idx
  ON str_price_schedules (effective_from)
  WHERE applied_at IS NULL;
CREATE INDEX IF NOT EXISTS str_ps_revert_idx
  ON str_price_schedules (effective_to)
  WHERE applied_at IS NOT NULL AND reverted_at IS NULL AND effective_to IS NOT NULL;

COMMENT ON TABLE str_price_schedules IS 'Per-product scheduled price change. The Step 4 PriceScheduleWorker applies rows when effective_from arrives (stamps applied_at) and reverts the product price at effective_to if set (stamps reverted_at). Partial INDEX str_ps_ripe_idx backs the apply sweep, str_ps_revert_idx backs the revert sweep.';
COMMENT ON COLUMN str_price_schedules.applied_at IS 'Set by the worker when the scheduled price has been written to str_products.price. Until then the row is a pending future change.';
COMMENT ON COLUMN str_price_schedules.reverted_at IS 'Set by the worker when effective_to passes and the previous price is restored. Only meaningful for time-bounded schedules.';

CREATE TABLE IF NOT EXISTS str_category_hierarchy (
  id UUID PRIMARY KEY,
  store_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  parent_category_id UUID,
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT str_ch_sort_chk CHECK (sort_order >= 0),
  CONSTRAINT str_ch_no_self_parent_chk CHECK (parent_category_id IS NULL OR parent_category_id <> id)
);

CREATE UNIQUE INDEX IF NOT EXISTS str_ch_name_uq
  ON str_category_hierarchy (
    store_id,
    name,
    COALESCE(parent_category_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS str_ch_parent_idx
  ON str_category_hierarchy (parent_category_id);
CREATE INDEX IF NOT EXISTS str_ch_store_idx
  ON str_category_hierarchy (store_id, sort_order)
  WHERE is_active = true;

COMMENT ON TABLE str_category_hierarchy IS 'Self-referential category tree per store. UNIQUE(store_id, name, COALESCE(parent_category_id, sentinel)) catches sibling-name collisions while letting the root and any sub-tree carry the same name. CHECK str_ch_no_self_parent_chk prevents a row from pointing at itself.';
COMMENT ON COLUMN str_category_hierarchy.parent_category_id IS 'Nullable self-FK to str_category_hierarchy(id). NULL means a root-level category. NO ACTION on delete forces the Step 4 CategoryHierarchyService.remove to reparent or remove children first.';
COMMENT ON COLUMN str_category_hierarchy.sort_order IS 'Display ordering within siblings. Lower values render first. Defaults to 0 so a stable name-based fallback is the default.';

ALTER TABLE str_products ADD COLUMN IF NOT EXISTS category_id UUID;

CREATE INDEX IF NOT EXISTS str_products_category_idx
  ON str_products (category_id)
  WHERE category_id IS NOT NULL;

COMMENT ON COLUMN str_products.category_id IS 'Optional category placement in the str_category_hierarchy tree. SET NULL on category delete so a product survives a category removal — falls back to the original free-form str_products.category text column.';

/* DB-enforced FKs. Idempotent DROP IF EXISTS + ADD pattern so
 * re-provision is a no-op. */

ALTER TABLE str_inventory_adjustments DROP CONSTRAINT IF EXISTS str_ia_product_fk;
ALTER TABLE str_inventory_adjustments ADD CONSTRAINT str_ia_product_fk
  FOREIGN KEY (product_id) REFERENCES str_products(id) ON DELETE CASCADE;

ALTER TABLE str_inventory_adjustments DROP CONSTRAINT IF EXISTS str_ia_inventory_fk;
ALTER TABLE str_inventory_adjustments ADD CONSTRAINT str_ia_inventory_fk
  FOREIGN KEY (inventory_id) REFERENCES str_product_inventory(id) ON DELETE CASCADE;

ALTER TABLE str_promotions DROP CONSTRAINT IF EXISTS str_promo_store_fk;
ALTER TABLE str_promotions ADD CONSTRAINT str_promo_store_fk
  FOREIGN KEY (store_id) REFERENCES str_stores(id) ON DELETE CASCADE;

ALTER TABLE str_promotion_products DROP CONSTRAINT IF EXISTS str_pp_promo_fk;
ALTER TABLE str_promotion_products ADD CONSTRAINT str_pp_promo_fk
  FOREIGN KEY (promotion_id) REFERENCES str_promotions(id) ON DELETE CASCADE;

ALTER TABLE str_promotion_products DROP CONSTRAINT IF EXISTS str_pp_product_fk;
ALTER TABLE str_promotion_products ADD CONSTRAINT str_pp_product_fk
  FOREIGN KEY (product_id) REFERENCES str_products(id) ON DELETE CASCADE;

ALTER TABLE str_loyalty_config DROP CONSTRAINT IF EXISTS str_lc_store_fk;
ALTER TABLE str_loyalty_config ADD CONSTRAINT str_lc_store_fk
  FOREIGN KEY (store_id) REFERENCES str_stores(id) ON DELETE CASCADE;

ALTER TABLE str_loyalty_transactions DROP CONSTRAINT IF EXISTS str_lt_store_fk;
ALTER TABLE str_loyalty_transactions ADD CONSTRAINT str_lt_store_fk
  FOREIGN KEY (store_id) REFERENCES str_stores(id) ON DELETE CASCADE;

ALTER TABLE str_gift_cards DROP CONSTRAINT IF EXISTS str_gc_store_fk;
ALTER TABLE str_gift_cards ADD CONSTRAINT str_gc_store_fk
  FOREIGN KEY (store_id) REFERENCES str_stores(id) ON DELETE CASCADE;

ALTER TABLE str_gift_card_transactions DROP CONSTRAINT IF EXISTS str_gct_card_fk;
ALTER TABLE str_gift_card_transactions ADD CONSTRAINT str_gct_card_fk
  FOREIGN KEY (card_id) REFERENCES str_gift_cards(id) ON DELETE CASCADE;

ALTER TABLE str_wishlists DROP CONSTRAINT IF EXISTS str_wl_product_fk;
ALTER TABLE str_wishlists ADD CONSTRAINT str_wl_product_fk
  FOREIGN KEY (product_id) REFERENCES str_products(id) ON DELETE CASCADE;

ALTER TABLE str_price_schedules DROP CONSTRAINT IF EXISTS str_ps_product_fk;
ALTER TABLE str_price_schedules ADD CONSTRAINT str_ps_product_fk
  FOREIGN KEY (product_id) REFERENCES str_products(id) ON DELETE CASCADE;

ALTER TABLE str_category_hierarchy DROP CONSTRAINT IF EXISTS str_ch_parent_fk;
ALTER TABLE str_category_hierarchy ADD CONSTRAINT str_ch_parent_fk
  FOREIGN KEY (parent_category_id) REFERENCES str_category_hierarchy(id) ON DELETE NO ACTION;

ALTER TABLE str_category_hierarchy DROP CONSTRAINT IF EXISTS str_ch_store_fk;
ALTER TABLE str_category_hierarchy ADD CONSTRAINT str_ch_store_fk
  FOREIGN KEY (store_id) REFERENCES str_stores(id) ON DELETE CASCADE;

ALTER TABLE str_products DROP CONSTRAINT IF EXISTS str_products_category_fk;
ALTER TABLE str_products ADD CONSTRAINT str_products_category_fk
  FOREIGN KEY (category_id) REFERENCES str_category_hierarchy(id) ON DELETE SET NULL;
