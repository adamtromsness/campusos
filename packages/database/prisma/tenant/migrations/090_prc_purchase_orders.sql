/* ============================================================
 * Cycle 27 — Step 2: Purchase Orders + Goods Receipt (Tenant)
 * ============================================================
 *
 * Step 2 lands 4 logical base tables:
 *
 *   - prc_purchase_orders: formal PO header issued to a
 *     fin_suppliers vendor. UNIQUE(school_id, po_number) so
 *     each school's number sequence is independent. 8-value
 *     status CHECK DRAFT to CANCELLED covers the full PO
 *     lifecycle. requisition_id FK SET NULL since standalone
 *     POs without a parent requisition are valid (admin
 *     hand-creates a PO without going through the requisition
 *     workflow). vendor_id NO ACTION on fin_suppliers — a
 *     vendor with active POs cannot be hard-deleted.
 *
 *   - prc_purchase_order_lines: per-PO line items linked
 *     optionally to a parent requisition_line. CASCADE on PO
 *     since lines have no value without their header. Soft
 *     gl_account_id ref to fin_chart_of_accounts for GL coding
 *     when the line is later posted via the AP / receipt path.
 *     Same 9-value destination_module CHECK as requisition
 *     lines.
 *
 *   - prc_goods_receipts: header for a receiving event. 3-value
 *     inspection_outcome CHECK ACCEPTED / ACCEPTED_WITH_DISCREPANCY
 *     / REJECTED. CASCADE on PO since receipts have no value
 *     without their PO.
 *
 *   - prc_goods_receipt_lines: per-line receipt detail. Multi-
 *     column quantity_chk enforces accepted + rejected =
 *     received so the header inspection_outcome stays
 *     trustworthy. 3-value condition CHECK GOOD / DAMAGED /
 *     DEFECTIVE. po_line_id FK CASCADE.
 *
 * 5 new intra-tenant DB-enforced FKs (CASCADE × 4 + SET NULL
 * × 1 + NO ACTION × 1). 0 cross-schema FKs (vendor_id is
 * declared as a real DB FK to fin_suppliers in the same tenant
 * schema, while iam_person refs stay soft).
 * ============================================================ */

CREATE TABLE IF NOT EXISTS prc_purchase_orders (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  po_number TEXT NOT NULL,
  vendor_id UUID NOT NULL,
  requisition_id UUID,
  delivery_address TEXT NOT NULL,
  expected_delivery_date DATE,
  payment_terms TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  total_amount NUMERIC(12,2) NOT NULL,
  notes TEXT,
  issued_by UUID,
  issued_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancelled_by UUID,
  cancel_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prc_po_status_chk CHECK (status IN (
    'DRAFT', 'ISSUED', 'ACKNOWLEDGED', 'SHIPPED',
    'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'
  )),
  CONSTRAINT prc_po_total_chk CHECK (total_amount >= 0),
  CONSTRAINT prc_po_school_number_uq UNIQUE (school_id, po_number)
);

CREATE INDEX IF NOT EXISTS prc_po_school_status_idx
  ON prc_purchase_orders (school_id, status, issued_at DESC);
CREATE INDEX IF NOT EXISTS prc_po_vendor_idx
  ON prc_purchase_orders (vendor_id, status);

COMMENT ON TABLE prc_purchase_orders IS 'Formal POs issued to fin_suppliers vendors. po_number is school-scoped sequential. 8-value status covers the full PO lifecycle. issued_at + issued_by stamped on the DRAFT → ISSUED transition.';
COMMENT ON COLUMN prc_purchase_orders.issued_by IS 'Soft FK to hr_employees(id). Stamped on the DRAFT → ISSUED transition.';
COMMENT ON COLUMN prc_purchase_orders.cancelled_by IS 'Soft FK to hr_employees(id). Stamped on the * → CANCELLED transition.';

CREATE TABLE IF NOT EXISTS prc_purchase_order_lines (
  id UUID PRIMARY KEY,
  purchase_order_id UUID NOT NULL,
  requisition_line_id UUID,
  item_description TEXT NOT NULL,
  quantity_ordered INT NOT NULL,
  unit_cost NUMERIC(10,2) NOT NULL,
  line_total NUMERIC(12,2) NOT NULL,
  gl_account_id UUID,
  destination_module TEXT NOT NULL,
  line_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prc_pol_qty_chk CHECK (quantity_ordered > 0),
  CONSTRAINT prc_pol_unit_cost_chk CHECK (unit_cost >= 0),
  CONSTRAINT prc_pol_total_chk CHECK (line_total >= 0),
  CONSTRAINT prc_pol_dest_chk CHECK (destination_module IN (
    'tech', 'trn', 'fds', 'lib', 'ath', 'ext', 'fac', 'str', 'general'
  ))
);

CREATE INDEX IF NOT EXISTS prc_pol_po_idx
  ON prc_purchase_order_lines (purchase_order_id, line_order);

COMMENT ON COLUMN prc_purchase_order_lines.gl_account_id IS 'Soft FK to fin_chart_of_accounts(id). Used when the AP / receipt path posts to the GL.';

CREATE TABLE IF NOT EXISTS prc_goods_receipts (
  id UUID PRIMARY KEY,
  purchase_order_id UUID NOT NULL,
  received_by UUID NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  inspection_outcome TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prc_gr_outcome_chk CHECK (inspection_outcome IN (
    'ACCEPTED', 'ACCEPTED_WITH_DISCREPANCY', 'REJECTED'
  ))
);

CREATE INDEX IF NOT EXISTS prc_gr_po_idx
  ON prc_goods_receipts (purchase_order_id, received_at DESC);

COMMENT ON TABLE prc_goods_receipts IS 'Receiving event header. The Step 6 GoodsReceiptService writes one row per inspection event — multiple receipts per PO support partial deliveries.';
COMMENT ON COLUMN prc_goods_receipts.received_by IS 'Soft FK to hr_employees(id). Stamped at receipt time.';

CREATE TABLE IF NOT EXISTS prc_goods_receipt_lines (
  id UUID PRIMARY KEY,
  receipt_id UUID NOT NULL,
  po_line_id UUID NOT NULL,
  quantity_received INT NOT NULL,
  quantity_accepted INT NOT NULL,
  quantity_rejected INT NOT NULL DEFAULT 0,
  condition TEXT NOT NULL DEFAULT 'GOOD',
  discrepancy_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prc_grl_qty_received_chk CHECK (quantity_received > 0),
  CONSTRAINT prc_grl_qty_accepted_chk CHECK (quantity_accepted >= 0),
  CONSTRAINT prc_grl_qty_rejected_chk CHECK (quantity_rejected >= 0),
  CONSTRAINT prc_grl_qty_balance_chk CHECK (quantity_accepted + quantity_rejected = quantity_received),
  CONSTRAINT prc_grl_condition_chk CHECK (condition IN ('GOOD', 'DAMAGED', 'DEFECTIVE'))
);

CREATE INDEX IF NOT EXISTS prc_grl_receipt_idx
  ON prc_goods_receipt_lines (receipt_id);
CREATE INDEX IF NOT EXISTS prc_grl_po_line_idx
  ON prc_goods_receipt_lines (po_line_id);

COMMENT ON TABLE prc_goods_receipt_lines IS 'Per-line receipt detail. The qty_balance_chk multi-column CHECK enforces accepted + rejected = received so header inspection_outcome stays trustworthy.';

/* DB-enforced FKs. Idempotent DROP IF EXISTS + ADD pattern. */

ALTER TABLE prc_purchase_orders DROP CONSTRAINT IF EXISTS prc_po_vendor_fk;
ALTER TABLE prc_purchase_orders ADD CONSTRAINT prc_po_vendor_fk
  FOREIGN KEY (vendor_id) REFERENCES fin_suppliers(id) ON DELETE NO ACTION;

ALTER TABLE prc_purchase_orders DROP CONSTRAINT IF EXISTS prc_po_req_fk;
ALTER TABLE prc_purchase_orders ADD CONSTRAINT prc_po_req_fk
  FOREIGN KEY (requisition_id) REFERENCES prc_requisitions(id) ON DELETE SET NULL;

ALTER TABLE prc_purchase_order_lines DROP CONSTRAINT IF EXISTS prc_pol_po_fk;
ALTER TABLE prc_purchase_order_lines ADD CONSTRAINT prc_pol_po_fk
  FOREIGN KEY (purchase_order_id) REFERENCES prc_purchase_orders(id) ON DELETE CASCADE;

ALTER TABLE prc_purchase_order_lines DROP CONSTRAINT IF EXISTS prc_pol_req_line_fk;
ALTER TABLE prc_purchase_order_lines ADD CONSTRAINT prc_pol_req_line_fk
  FOREIGN KEY (requisition_line_id) REFERENCES prc_requisition_lines(id) ON DELETE SET NULL;

ALTER TABLE prc_goods_receipts DROP CONSTRAINT IF EXISTS prc_gr_po_fk;
ALTER TABLE prc_goods_receipts ADD CONSTRAINT prc_gr_po_fk
  FOREIGN KEY (purchase_order_id) REFERENCES prc_purchase_orders(id) ON DELETE CASCADE;

ALTER TABLE prc_goods_receipt_lines DROP CONSTRAINT IF EXISTS prc_grl_receipt_fk;
ALTER TABLE prc_goods_receipt_lines ADD CONSTRAINT prc_grl_receipt_fk
  FOREIGN KEY (receipt_id) REFERENCES prc_goods_receipts(id) ON DELETE CASCADE;

ALTER TABLE prc_goods_receipt_lines DROP CONSTRAINT IF EXISTS prc_grl_po_line_fk;
ALTER TABLE prc_goods_receipt_lines ADD CONSTRAINT prc_grl_po_line_fk
  FOREIGN KEY (po_line_id) REFERENCES prc_purchase_order_lines(id) ON DELETE NO ACTION;
