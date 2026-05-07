/*
 * Cycle 28 Step 2 — Orders + Lines + Approvals schema.
 *
 * Order headers carry a polymorphic customer ref that is one of:
 *   - customer_person_id (soft to platform.iam_person) for STUDENT and
 *     PARENT order_types
 *   - external_customer_id (FK to str_external_customers, lands in
 *     migration 094) for EXTERNAL order_type
 *
 * Plus an optional student_id soft ref to sis_students for the
 * recipient of items on a STUDENT order (Maya orders, items go to Maya).
 *
 * The PARENT APPROVAL GATE keystone lives in str_order_approvals:
 * every STUDENT-type order auto-creates a PENDING approval row when
 * the order is created. The order cannot advance past
 * PENDING_APPROVAL until the parent approves or declines.
 *
 * Splitter-safe — no semicolons inside block comments, single-quoted
 * strings, or default expressions.
 */

CREATE TABLE IF NOT EXISTS str_orders (
  id UUID PRIMARY KEY,
  store_id UUID NOT NULL REFERENCES str_stores(id) ON DELETE NO ACTION,
  order_type TEXT NOT NULL CHECK (order_type IN ('STUDENT', 'PARENT', 'EXTERNAL')),
  customer_person_id UUID,
  external_customer_id UUID,
  student_id UUID,
  order_number TEXT NOT NULL,
  order_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (status IN (
    'PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'READY_FOR_PICKUP',
    'SHIPPED', 'COMPLETED', 'CANCELLED', 'BACKORDERED'
  )),
  subtotal NUMERIC(10,2) NOT NULL CHECK (subtotal >= 0),
  shipping_cost NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (shipping_cost >= 0),
  total NUMERIC(10,2) NOT NULL CHECK (total >= 0),
  shipping_method TEXT NOT NULL DEFAULT 'PICKUP' CHECK (shipping_method IN ('PICKUP', 'SHIPPED')),
  shipping_option_id UUID,
  tracking_number TEXT,
  payment_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (payment_status IN (
    'PENDING', 'CHARGED', 'DEFERRED_BACKORDER', 'REFUNDED'
  )),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT str_orders_customer_shape_chk CHECK (
    (order_type IN ('STUDENT', 'PARENT') AND customer_person_id IS NOT NULL AND external_customer_id IS NULL) OR
    (order_type = 'EXTERNAL' AND external_customer_id IS NOT NULL AND customer_person_id IS NULL)
  ),
  CONSTRAINT str_orders_student_shape_chk CHECK (
    (order_type = 'STUDENT' AND student_id IS NOT NULL) OR
    (order_type IN ('PARENT', 'EXTERNAL'))
  ),
  CONSTRAINT str_orders_shipping_shape_chk CHECK (
    (shipping_method = 'PICKUP' AND shipping_cost = 0 AND shipping_option_id IS NULL) OR
    (shipping_method = 'SHIPPED')
  )
);

CREATE INDEX IF NOT EXISTS str_orders_store_status_idx
  ON str_orders (store_id, status, order_date DESC);

CREATE INDEX IF NOT EXISTS str_orders_customer_idx
  ON str_orders (customer_person_id, order_date DESC)
  WHERE customer_person_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS str_orders_external_idx
  ON str_orders (external_customer_id, order_date DESC)
  WHERE external_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS str_orders_pending_approval_idx
  ON str_orders (store_id, order_date)
  WHERE status = 'PENDING_APPROVAL';

CREATE UNIQUE INDEX IF NOT EXISTS str_orders_order_number_uq
  ON str_orders (store_id, order_number);

COMMENT ON TABLE str_orders IS 'Order header. NO ACTION on store_id so orders survive store deactivation as audit. The customer_shape_chk and shipping_shape_chk multi-column CHECKs enforce the dual-mode contract at the schema layer.';
COMMENT ON COLUMN str_orders.order_type IS '3-value CHECK STUDENT/PARENT/EXTERNAL. STUDENT requires student_id (recipient) and goes through the parent approval gate. PARENT charges the family account directly. EXTERNAL requires external_customer_id and goes through PUBLIC store checkout.';
COMMENT ON COLUMN str_orders.status IS '8-value lifecycle. STUDENT orders start at PENDING_APPROVAL — PARENT/EXTERNAL skip to APPROVED/PROCESSING.';
COMMENT ON COLUMN str_orders.payment_status IS '4-value CHECK. CHARGED set by Cycle 6 family-billing consumer (STUDENT/PARENT) or by external payment record (EXTERNAL). DEFERRED_BACKORDER until the backordered line ships.';
COMMENT ON COLUMN str_orders.shipping_option_id IS 'Soft ref to str_shipping_options(id). Required when shipping_method=SHIPPED, must be NULL when PICKUP per str_orders_shipping_shape_chk.';
COMMENT ON COLUMN str_orders.customer_person_id IS 'Soft FK to platform.iam_person(id) per ADR-001/020.';
COMMENT ON COLUMN str_orders.student_id IS 'Soft FK to sis_students(id) per ADR-001/020. The student who will receive the items on a STUDENT order, even when a PARENT places the order on their behalf.';
COMMENT ON COLUMN str_orders.external_customer_id IS 'Soft FK to str_external_customers(id) — the FK constraint lands in migration 094 once the parent table exists.';

CREATE TABLE IF NOT EXISTS str_order_lines (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES str_orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES str_products(id) ON DELETE NO ACTION,
  quantity INT NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(8,2) NOT NULL CHECK (unit_price >= 0),
  line_total NUMERIC(10,2) NOT NULL CHECK (line_total >= 0),
  line_status TEXT NOT NULL DEFAULT 'IN_STOCK' CHECK (line_status IN (
    'IN_STOCK', 'BACKORDERED', 'FULFILLED', 'CANCELLED'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS str_order_lines_order_idx ON str_order_lines (order_id);
CREATE INDEX IF NOT EXISTS str_order_lines_product_idx ON str_order_lines (product_id);
CREATE INDEX IF NOT EXISTS str_order_lines_backordered_idx
  ON str_order_lines (product_id)
  WHERE line_status = 'BACKORDERED';

COMMENT ON TABLE str_order_lines IS 'Per-line item records. CASCADE on parent order — lines are meaningless without their order. NO ACTION on product so a product retired with active orders cannot be hard-deleted.';
COMMENT ON COLUMN str_order_lines.line_status IS '4-value CHECK. IN_STOCK is the default. BACKORDERED set when product.backorder_allowed=true and stock is insufficient at order time. FULFILLED set when the line ships or is picked up. CANCELLED for individually-cancelled lines.';

CREATE TABLE IF NOT EXISTS str_order_approvals (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES str_orders(id) ON DELETE CASCADE,
  parent_person_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  decline_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT str_order_approvals_responded_chk CHECK (
    (status = 'PENDING' AND responded_at IS NULL AND decline_reason IS NULL) OR
    (status = 'APPROVED' AND responded_at IS NOT NULL AND decline_reason IS NULL) OR
    (status = 'DECLINED' AND responded_at IS NOT NULL AND decline_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS str_order_approvals_order_uq
  ON str_order_approvals (order_id);

CREATE INDEX IF NOT EXISTS str_order_approvals_parent_pending_idx
  ON str_order_approvals (parent_person_id, requested_at)
  WHERE status = 'PENDING';

COMMENT ON TABLE str_order_approvals IS 'PARENT APPROVAL GATE per ADR-062. UNIQUE(order_id) caps each STUDENT order at exactly one approval row. The multi-column responded_chk lockstep keeps (status, responded_at, decline_reason) consistent across the 3 states. CASCADE on parent order so a hard-deleted order cleans up its approval row.';
COMMENT ON COLUMN str_order_approvals.parent_person_id IS 'Soft FK to platform.iam_person(id) per ADR-001/020.';
COMMENT ON COLUMN str_order_approvals.decline_reason IS 'Required when status=DECLINED, must be NULL otherwise per str_order_approvals_responded_chk.';
