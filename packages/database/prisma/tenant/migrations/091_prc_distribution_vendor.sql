/* ============================================================
 * Cycle 27 — Step 3: Budget Commitments + Distribution +
 *                    Returns + Vendor Performance + Settings
 * ============================================================
 *
 * Step 3 lands 6 logical base tables completing the M86
 * Procurement schema phase.
 *
 *   - prc_budget_commitments: lightweight encumbrance tracking.
 *     On PO ISSUED the Step 6 PurchaseOrderService creates this
 *     row AND increments fin_budget_lines.encumbered_amount in
 *     the same tenant tx (the BUDGET COMMITMENT KEYSTONE per
 *     ADR-061). 3-value status CHECK COMMITTED /
 *     PARTIALLY_RELEASED / RELEASED. Soft budget_line_id ref
 *     to fin_budget_lines (the Cycle 26 service-layer
 *     FinanceValidationService is what asserts the line resolves
 *     to a real, active row before the PO can issue).
 *
 *   - prc_distributions: routing record for received items
 *     handed off to a destination operational module. 8-value
 *     destination_module CHECK matches the 8 operational modules
 *     (tech, trn, fds, lib, ath, ext, fac, str) — the Step 7
 *     DistributionService emits prc.distribution.completed AFTER
 *     the tx commits with a payload that the destination
 *     module's inventory worker (Phase 2) consumes.
 *
 *   - prc_distribution_lines: per-line distribution detail.
 *     CASCADE on parent distribution since lines have no value
 *     without their header.
 *
 *   - prc_returns: return / warranty claim. 3-value return_type
 *     CHECK DAMAGED / DEFECTIVE / WARRANTY_CLAIM. 4-value status
 *     CHECK INITIATED / SHIPPED_TO_VENDOR / RESOLVED / CANCELLED.
 *     resolution is nullable 3-value REPLACED / REFUNDED /
 *     CREDITED — populated only when status=RESOLVED. The
 *     multi-column resolved_chk lockstep keeps resolution
 *     consistent with status.
 *
 *   - prc_vendor_performance: per-(vendor, school) running
 *     scorecard. UNIQUE(vendor_id, school_id) caps at one row
 *     per pair. The Step 6 GoodsReceiptService updates this row
 *     atomically inside the same tenant tx as every receipt.
 *
 *   - prc_procurement_settings: per-school configuration.
 *     UNIQUE(school_id) caps at one row per school. PO number
 *     prefix + sequence + default payment terms + auto-PO
 *     thresholds. The Step 6 PurchaseOrderService reads this
 *     row to allocate the next po_number.
 *
 * 5 new intra-tenant DB-enforced FKs (CASCADE × 3 on the
 * distribution chain + receipt-line, NO ACTION × 1 on PO,
 * NO ACTION × 1 on vendor, NO ACTION × 1 on receipt-line for
 * the returns row). 0 cross-schema DB-enforced FKs — the
 * fin_budget_lines ref stays soft per ADR-001 / 020.
 * ============================================================ */

CREATE TABLE IF NOT EXISTS prc_budget_commitments (
  id UUID PRIMARY KEY,
  purchase_order_id UUID NOT NULL,
  budget_line_id UUID NOT NULL,
  committed_amount NUMERIC(12,2) NOT NULL,
  released_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'COMMITTED',
  released_at TIMESTAMPTZ,
  released_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prc_bc_status_chk CHECK (status IN ('COMMITTED', 'PARTIALLY_RELEASED', 'RELEASED')),
  CONSTRAINT prc_bc_committed_chk CHECK (committed_amount >= 0),
  CONSTRAINT prc_bc_released_chk CHECK (released_amount >= 0),
  CONSTRAINT prc_bc_released_within_committed_chk CHECK (released_amount <= committed_amount)
);

CREATE INDEX IF NOT EXISTS prc_bc_po_idx
  ON prc_budget_commitments (purchase_order_id);
CREATE INDEX IF NOT EXISTS prc_bc_budget_line_idx
  ON prc_budget_commitments (budget_line_id, status);

COMMENT ON TABLE prc_budget_commitments IS 'Lightweight encumbrance row created on PO ISSUED. Increments fin_budget_lines.encumbered_amount in the same tx (the BUDGET COMMITMENT KEYSTONE per ADR-061). Released on PO CLOSED.';
COMMENT ON COLUMN prc_budget_commitments.budget_line_id IS 'Soft FK to fin_budget_lines(id) per ADR-001 / 020. Step 6 service pre-flights via FinanceValidationService.assertActiveAccount on the line account.';

CREATE TABLE IF NOT EXISTS prc_distributions (
  id UUID PRIMARY KEY,
  receipt_id UUID NOT NULL,
  distributed_by UUID NOT NULL,
  distributed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  destination_module TEXT NOT NULL,
  destination_department TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prc_dist_dest_chk CHECK (destination_module IN (
    'tech', 'trn', 'fds', 'lib', 'ath', 'ext', 'fac', 'str'
  ))
);

CREATE INDEX IF NOT EXISTS prc_dist_receipt_idx
  ON prc_distributions (receipt_id, distributed_at DESC);
CREATE INDEX IF NOT EXISTS prc_dist_dest_idx
  ON prc_distributions (destination_module, distributed_at DESC);

COMMENT ON TABLE prc_distributions IS 'Cross-module distribution event. The Step 7 DistributionService emits prc.distribution.completed AFTER tx commits — 8 destination modules each have a worker that consumes and creates inventory rows.';
COMMENT ON COLUMN prc_distributions.distributed_by IS 'Soft FK to hr_employees(id). Stamped at distribution time.';

CREATE TABLE IF NOT EXISTS prc_distribution_lines (
  id UUID PRIMARY KEY,
  distribution_id UUID NOT NULL,
  receipt_line_id UUID NOT NULL,
  quantity_distributed INT NOT NULL,
  item_description TEXT NOT NULL,
  unit_cost NUMERIC(10,2),
  line_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prc_dl_qty_chk CHECK (quantity_distributed > 0),
  CONSTRAINT prc_dl_unit_cost_chk CHECK (unit_cost IS NULL OR unit_cost >= 0)
);

CREATE INDEX IF NOT EXISTS prc_dl_dist_idx
  ON prc_distribution_lines (distribution_id, line_order);
CREATE INDEX IF NOT EXISTS prc_dl_receipt_line_idx
  ON prc_distribution_lines (receipt_line_id);

CREATE TABLE IF NOT EXISTS prc_returns (
  id UUID PRIMARY KEY,
  receipt_line_id UUID NOT NULL,
  return_type TEXT NOT NULL,
  quantity_returned INT NOT NULL,
  return_reference TEXT,
  vendor_rma_number TEXT,
  status TEXT NOT NULL DEFAULT 'INITIATED',
  resolution TEXT,
  resolution_notes TEXT,
  initiated_by UUID NOT NULL,
  initiated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prc_ret_type_chk CHECK (return_type IN ('DAMAGED', 'DEFECTIVE', 'WARRANTY_CLAIM')),
  CONSTRAINT prc_ret_status_chk CHECK (status IN ('INITIATED', 'SHIPPED_TO_VENDOR', 'RESOLVED', 'CANCELLED')),
  CONSTRAINT prc_ret_resolution_chk CHECK (resolution IS NULL OR resolution IN ('REPLACED', 'REFUNDED', 'CREDITED')),
  CONSTRAINT prc_ret_qty_chk CHECK (quantity_returned > 0),
  CONSTRAINT prc_ret_resolved_chk CHECK (
    (status <> 'RESOLVED' AND resolution IS NULL AND resolved_at IS NULL AND resolved_by IS NULL)
    OR (status = 'RESOLVED' AND resolution IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS prc_ret_receipt_line_idx
  ON prc_returns (receipt_line_id);
CREATE INDEX IF NOT EXISTS prc_ret_status_idx
  ON prc_returns (status, initiated_at DESC);

COMMENT ON TABLE prc_returns IS 'Return / warranty claim. 4-value status lifecycle. resolution populated only when status=RESOLVED via the multi-column resolved_chk lockstep.';
COMMENT ON COLUMN prc_returns.initiated_by IS 'Soft FK to hr_employees(id).';
COMMENT ON COLUMN prc_returns.resolved_by IS 'Soft FK to hr_employees(id).';

CREATE TABLE IF NOT EXISTS prc_vendor_performance (
  id UUID PRIMARY KEY,
  vendor_id UUID NOT NULL,
  school_id UUID NOT NULL,
  total_orders INT NOT NULL DEFAULT 0,
  on_time_deliveries INT NOT NULL DEFAULT 0,
  late_deliveries INT NOT NULL DEFAULT 0,
  accepted_count INT NOT NULL DEFAULT 0,
  rejected_count INT NOT NULL DEFAULT 0,
  average_quality_score NUMERIC(5,4),
  average_delivery_score NUMERIC(5,4),
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prc_vp_total_chk CHECK (total_orders >= 0),
  CONSTRAINT prc_vp_on_time_chk CHECK (on_time_deliveries >= 0),
  CONSTRAINT prc_vp_late_chk CHECK (late_deliveries >= 0),
  CONSTRAINT prc_vp_accepted_chk CHECK (accepted_count >= 0),
  CONSTRAINT prc_vp_rejected_chk CHECK (rejected_count >= 0),
  CONSTRAINT prc_vp_quality_chk CHECK (average_quality_score IS NULL OR (average_quality_score >= 0 AND average_quality_score <= 1)),
  CONSTRAINT prc_vp_delivery_chk CHECK (average_delivery_score IS NULL OR (average_delivery_score >= 0 AND average_delivery_score <= 1)),
  CONSTRAINT prc_vp_vendor_school_uq UNIQUE (vendor_id, school_id)
);

COMMENT ON TABLE prc_vendor_performance IS 'Per-(vendor, school) running scorecard. The Step 6 GoodsReceiptService updates this row atomically inside the receipt tx — quality_score = accepted / (accepted+rejected) and delivery_score = on_time / total_orders. Stored as 0.00..1.00 fractions, the UI renders as percentages.';

CREATE TABLE IF NOT EXISTS prc_procurement_settings (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  auto_po_threshold NUMERIC(12,2),
  default_payment_terms TEXT NOT NULL DEFAULT 'NET_30',
  po_number_prefix TEXT NOT NULL DEFAULT 'PO',
  po_number_next_seq INT NOT NULL DEFAULT 1,
  require_three_quotes_above NUMERIC(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prc_ps_seq_chk CHECK (po_number_next_seq >= 1),
  CONSTRAINT prc_ps_threshold_chk CHECK (auto_po_threshold IS NULL OR auto_po_threshold >= 0),
  CONSTRAINT prc_ps_three_quotes_chk CHECK (require_three_quotes_above IS NULL OR require_three_quotes_above >= 0),
  CONSTRAINT prc_ps_school_uq UNIQUE (school_id)
);

COMMENT ON TABLE prc_procurement_settings IS 'Per-school procurement configuration. UNIQUE(school_id) caps at one row per school. The Step 6 PurchaseOrderService reads + atomically increments po_number_next_seq under FOR UPDATE to allocate the next po_number.';

/* DB-enforced FKs. Idempotent DROP IF EXISTS + ADD pattern. */

ALTER TABLE prc_budget_commitments DROP CONSTRAINT IF EXISTS prc_bc_po_fk;
ALTER TABLE prc_budget_commitments ADD CONSTRAINT prc_bc_po_fk
  FOREIGN KEY (purchase_order_id) REFERENCES prc_purchase_orders(id) ON DELETE NO ACTION;

ALTER TABLE prc_distributions DROP CONSTRAINT IF EXISTS prc_dist_receipt_fk;
ALTER TABLE prc_distributions ADD CONSTRAINT prc_dist_receipt_fk
  FOREIGN KEY (receipt_id) REFERENCES prc_goods_receipts(id) ON DELETE CASCADE;

ALTER TABLE prc_distribution_lines DROP CONSTRAINT IF EXISTS prc_dl_dist_fk;
ALTER TABLE prc_distribution_lines ADD CONSTRAINT prc_dl_dist_fk
  FOREIGN KEY (distribution_id) REFERENCES prc_distributions(id) ON DELETE CASCADE;

ALTER TABLE prc_distribution_lines DROP CONSTRAINT IF EXISTS prc_dl_receipt_line_fk;
ALTER TABLE prc_distribution_lines ADD CONSTRAINT prc_dl_receipt_line_fk
  FOREIGN KEY (receipt_line_id) REFERENCES prc_goods_receipt_lines(id) ON DELETE NO ACTION;

ALTER TABLE prc_returns DROP CONSTRAINT IF EXISTS prc_ret_receipt_line_fk;
ALTER TABLE prc_returns ADD CONSTRAINT prc_ret_receipt_line_fk
  FOREIGN KEY (receipt_line_id) REFERENCES prc_goods_receipt_lines(id) ON DELETE NO ACTION;

ALTER TABLE prc_vendor_performance DROP CONSTRAINT IF EXISTS prc_vp_vendor_fk;
ALTER TABLE prc_vendor_performance ADD CONSTRAINT prc_vp_vendor_fk
  FOREIGN KEY (vendor_id) REFERENCES fin_suppliers(id) ON DELETE NO ACTION;
