/* ============================================================
 * Cycle 22 — Step 1: Asset + Assignment + Documents
 * ============================================================
 *
 * 4 logical base tables for the M62 IT Infrastructure asset
 * registry:
 *
 *   - tech_asset_categories — per-school catalogue with
 *     depreciation + maintenance interval metadata.
 *   - tech_assets — device fleet with asset tags, warranty
 *     tracking, and a 5-state lifecycle CHECK.
 *   - tech_asset_assignments — device-to-person assignment record
 *     with condition recording at both ends and a multi-column
 *     returned_chk lockstep keeping returned_at + condition_at_return
 *     consistent.
 *   - tech_asset_documents — invoice / warranty / insurance / manual
 *     PDFs by signed S3 key.
 *
 * tech_assets.procurement_order_id is intentionally a soft ref
 * (no DB FK) because the procurement order may not exist yet when
 * the asset is registered — admin can register an asset standalone
 * and link to an order later.
 *
 * Splitter-safe — no semicolons inside string literals or block
 * comments. Idempotent — re-runs are a no-op.
 * ============================================================ */

CREATE TABLE IF NOT EXISTS tech_asset_categories (
  id                            UUID PRIMARY KEY,
  school_id                     UUID NOT NULL,
  name                          TEXT NOT NULL,
  description                   TEXT,
  depreciation_years            INT,
  maintenance_interval_months   INT,
  is_active                     BOOLEAN NOT NULL DEFAULT true,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tech_cat_dep_chk CHECK (depreciation_years IS NULL OR depreciation_years > 0),
  CONSTRAINT tech_cat_maint_chk CHECK (
    maintenance_interval_months IS NULL OR maintenance_interval_months > 0
  ),
  CONSTRAINT tech_cat_uq UNIQUE (school_id, name)
);

CREATE INDEX IF NOT EXISTS tech_cat_school_active_idx
  ON tech_asset_categories (school_id, is_active);

COMMENT ON TABLE tech_asset_categories IS
  'Per-school IT asset category catalogue. UNIQUE(school_id, name) so the category name is the stable handle (Chromebook / iPad / Document Camera). depreciation_years drives the future asset-value rollups, and maintenance_interval_months drives reminder alerts. is_active=false soft-deactivates a retired category while preserving historical assets.';

CREATE TABLE IF NOT EXISTS tech_assets (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  category_id              UUID NOT NULL,
  asset_tag                TEXT NOT NULL,
  serial_number            TEXT,
  make                     TEXT,
  model                    TEXT,
  purchase_date            DATE,
  purchase_cost            NUMERIC(10,2),
  status                   TEXT NOT NULL DEFAULT 'AVAILABLE',
  warranty_expiry          DATE,
  procurement_order_id     UUID,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tech_asset_status_chk CHECK (
    status IN ('AVAILABLE', 'ASSIGNED', 'REPAIR', 'RETIRED', 'LOST')
  ),
  CONSTRAINT tech_asset_cost_chk CHECK (purchase_cost IS NULL OR purchase_cost >= 0),
  CONSTRAINT tech_asset_uq UNIQUE (school_id, asset_tag),
  CONSTRAINT tech_asset_category_fk FOREIGN KEY (category_id)
    REFERENCES tech_asset_categories(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS tech_asset_school_status_idx
  ON tech_assets (school_id, status);

CREATE INDEX IF NOT EXISTS tech_asset_warranty_idx
  ON tech_assets (warranty_expiry)
  WHERE warranty_expiry IS NOT NULL;

CREATE INDEX IF NOT EXISTS tech_asset_serial_idx
  ON tech_assets (school_id, serial_number)
  WHERE serial_number IS NOT NULL;

COMMENT ON TABLE tech_assets IS
  'IT device fleet registry. UNIQUE(school_id, asset_tag) — the scannable tag is the stable handle for inventory + audit. 5-value status CHECK (AVAILABLE / ASSIGNED / REPAIR / RETIRED / LOST). NO ACTION on category_id preserves historical assets when an admin deactivates a category. procurement_order_id is a soft ref to tech_procurement_orders that ships in Step 3 — an asset may be registered standalone before a procurement order exists, hence no DB FK.';

COMMENT ON COLUMN tech_assets.procurement_order_id IS
  'Soft ref to tech_procurement_orders(id) per ADR-001/020. NOT a DB-enforced FK because the order may not exist when the asset is registered.';

CREATE TABLE IF NOT EXISTS tech_asset_assignments (
  id                       UUID PRIMARY KEY,
  asset_id                 UUID NOT NULL,
  assigned_to_id           UUID NOT NULL,
  assigned_by              UUID NOT NULL,
  assigned_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  returned_at              TIMESTAMPTZ,
  condition_at_assign      TEXT NOT NULL,
  condition_at_return      TEXT,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tech_assign_cond_assign_chk CHECK (
    condition_at_assign IN ('EXCELLENT', 'GOOD', 'FAIR', 'DAMAGED')
  ),
  CONSTRAINT tech_assign_cond_return_chk CHECK (
    condition_at_return IS NULL
    OR condition_at_return IN ('EXCELLENT', 'GOOD', 'FAIR', 'DAMAGED')
  ),
  CONSTRAINT tech_assign_returned_chk CHECK (
    (returned_at IS NULL AND condition_at_return IS NULL)
    OR (returned_at IS NOT NULL AND condition_at_return IS NOT NULL)
  ),
  CONSTRAINT tech_assign_dates_chk CHECK (
    returned_at IS NULL OR returned_at >= assigned_at
  ),
  CONSTRAINT tech_assign_asset_fk FOREIGN KEY (asset_id)
    REFERENCES tech_assets(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS tech_assign_active_idx
  ON tech_asset_assignments (assigned_to_id)
  WHERE returned_at IS NULL;

CREATE INDEX IF NOT EXISTS tech_assign_asset_active_idx
  ON tech_asset_assignments (asset_id)
  WHERE returned_at IS NULL;

CREATE INDEX IF NOT EXISTS tech_assign_history_idx
  ON tech_asset_assignments (asset_id, assigned_at DESC);

COMMENT ON TABLE tech_asset_assignments IS
  'Per-(asset, person) assignment record with condition tracking at both ends. 4-value condition CHECK on both ends. Multi-column returned_chk keeps returned_at + condition_at_return all-set or all-null together — an active assignment has both NULL, a returned assignment has both populated. Partial active_idx surfaces a person s currently-held devices at constant cost. NO ACTION on asset_id preserves the assignment audit trail past a wipe of historical assets (use tech_assets.status=RETIRED instead). assigned_to_id is a soft FK to platform.platform_users per ADR-001/020.';

CREATE TABLE IF NOT EXISTS tech_asset_documents (
  id                  UUID PRIMARY KEY,
  asset_id            UUID NOT NULL,
  document_type       TEXT NOT NULL,
  s3_key              TEXT NOT NULL,
  file_name           TEXT,
  uploaded_by         UUID NOT NULL,
  uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tech_doc_type_chk CHECK (
    document_type IN ('INVOICE', 'WARRANTY', 'INSURANCE', 'MANUAL')
  ),
  CONSTRAINT tech_doc_asset_fk FOREIGN KEY (asset_id)
    REFERENCES tech_assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tech_doc_asset_type_idx
  ON tech_asset_documents (asset_id, document_type);

COMMENT ON TABLE tech_asset_documents IS
  'Per-asset PDF attachments via signed S3 URL. 4-value document_type CHECK (INVOICE / WARRANTY / INSURANCE / MANUAL). CASCADE on parent asset since documents are meaningless without their asset (the warranty PDF is for THIS specific Chromebook). uploaded_by is a soft FK to platform.platform_users per ADR-001/020.';
