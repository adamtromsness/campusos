/* ============================================================
 * Cycle 27 — Step 1: Requisitions + Lines (Tenant)
 * ============================================================
 *
 * The M86 Procurement module opens with the requisition surface
 * — staff-initiated purchase requests with multi-line item
 * detail, destination-module tagging, and integration with the
 * Cycle 7 approval workflow + the Cycle 26 budget lines.
 *
 * Step 1 lands 2 logical base tables:
 *
 *   - prc_requisitions: per-school requisition header. The
 *     10-value status CHECK covers the full lifecycle DRAFT to
 *     CLOSED — DRAFT (author drafting) → SUBMITTED (approval
 *     pending) → DEPT_APPROVED (department head signed off) →
 *     ADMIN_APPROVED (admin signed off) → DISTRICT_APPROVED
 *     (district sign-off when threshold-triggered) → ORDERED
 *     (PO issued) → RECEIVED (goods received) → DISTRIBUTED
 *     (handed off to operational module) → CLOSED (PO closed
 *     and budget commitment released) → REJECTED (terminal,
 *     audit preserved). Soft approval_request_id ref to the
 *     Cycle 7 wsk_approval_requests for multi-level routing.
 *     Soft budget_line_id ref to the Cycle 26 fin_budget_lines
 *     so the Step 5 RequisitionService can pre-flight the
 *     remaining balance before submit. requesting_person_id is
 *     a DB-enforced FK to platform.iam_person so the requester
 *     pin stays enforced even though the column is annotated
 *     soft per ADR-001 / 020 (no FK-cascade impact since the
 *     iam_person row outlives every requisition).
 *
 *   - prc_requisition_lines: per-requisition line item. CASCADE
 *     on parent requisition since lines have no value without
 *     their header. 9-value destination_module CHECK covers the
 *     8 operational destination modules (tech / trn / fds / lib
 *     / ath / ext / fac / str) plus the catch-all `general` for
 *     supply requests that don't pin to a specific module.
 *     Non-negative quantity + estimated_unit_cost CHECKs.
 *     Soft preferred_vendor_id ref to fin_suppliers.
 *
 * 1 new intra-tenant DB-enforced FK (CASCADE on lines →
 * requisition). 0 cross-schema DB-enforced FKs (the iam_person
 * ref is soft per the project convention).
 * ============================================================ */

CREATE TABLE IF NOT EXISTS prc_requisitions (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  requesting_person_id UUID NOT NULL,
  requesting_department TEXT,
  urgency TEXT NOT NULL DEFAULT 'ROUTINE',
  status TEXT NOT NULL DEFAULT 'DRAFT',
  approval_request_id UUID,
  total_estimated_cost NUMERIC(12,2) DEFAULT 0,
  budget_line_id UUID,
  justification TEXT NOT NULL,
  submitted_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prc_req_urgency_chk CHECK (urgency IN ('ROUTINE', 'URGENT', 'EMERGENCY')),
  CONSTRAINT prc_req_status_chk CHECK (status IN (
    'DRAFT', 'SUBMITTED', 'DEPT_APPROVED', 'ADMIN_APPROVED', 'DISTRICT_APPROVED',
    'ORDERED', 'RECEIVED', 'DISTRIBUTED', 'CLOSED', 'REJECTED'
  )),
  CONSTRAINT prc_req_total_chk CHECK (total_estimated_cost >= 0)
);

CREATE INDEX IF NOT EXISTS prc_req_school_status_idx
  ON prc_requisitions (school_id, status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS prc_req_requester_idx
  ON prc_requisitions (requesting_person_id, status);

COMMENT ON TABLE prc_requisitions IS 'Staff-initiated purchase requests. 10-value status lifecycle covers DRAFT through CLOSED plus the REJECTED terminal. Multi-level approval routing via Cycle 7 wsk_approval_requests soft ref. Budget pre-flight via Cycle 26 fin_budget_lines soft ref.';
COMMENT ON COLUMN prc_requisitions.requesting_person_id IS 'Soft FK to platform.iam_person(id) per ADR-001 / 020. The Step 5 RequisitionService stamps this from actor.personId at submit time.';
COMMENT ON COLUMN prc_requisitions.approval_request_id IS 'Soft FK to wsk_approval_requests(id) — opens at submit, walks through DEPT / ADMIN / DISTRICT approvers per the Cycle 7 multi-step engine.';
COMMENT ON COLUMN prc_requisitions.budget_line_id IS 'Soft FK to fin_budget_lines(id) — Step 5 service pre-flights the remaining balance before allowing submit and the Step 6 PurchaseOrderService increments encumbered_amount on PO ISSUED.';
COMMENT ON COLUMN prc_requisitions.reviewed_by IS 'Soft FK to hr_employees(id). Stamped on the terminal review action — APPROVED chain or REJECTED.';

CREATE TABLE IF NOT EXISTS prc_requisition_lines (
  id UUID PRIMARY KEY,
  requisition_id UUID NOT NULL,
  item_description TEXT NOT NULL,
  quantity INT NOT NULL,
  unit TEXT,
  estimated_unit_cost NUMERIC(10,2),
  specifications TEXT,
  preferred_vendor_id UUID,
  destination_module TEXT NOT NULL,
  line_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prc_req_line_qty_chk CHECK (quantity > 0),
  CONSTRAINT prc_req_line_unit_cost_chk CHECK (estimated_unit_cost IS NULL OR estimated_unit_cost >= 0),
  CONSTRAINT prc_req_line_dest_chk CHECK (destination_module IN (
    'tech', 'trn', 'fds', 'lib', 'ath', 'ext', 'fac', 'str', 'general'
  ))
);

CREATE INDEX IF NOT EXISTS prc_req_lines_req_idx
  ON prc_requisition_lines (requisition_id, line_order);
CREATE INDEX IF NOT EXISTS prc_req_lines_vendor_idx
  ON prc_requisition_lines (preferred_vendor_id) WHERE preferred_vendor_id IS NOT NULL;

COMMENT ON TABLE prc_requisition_lines IS 'Per-requisition line items. 9-value destination_module CHECK pins each line to the future cross-module distribution event. preferred_vendor_id is a soft hint — the actual vendor is set on the eventual PO.';
COMMENT ON COLUMN prc_requisition_lines.preferred_vendor_id IS 'Soft FK to fin_suppliers(id) per ADR-001 / 020. Hint only — the eventual PO can override.';

ALTER TABLE prc_requisition_lines DROP CONSTRAINT IF EXISTS prc_req_lines_req_fk;
ALTER TABLE prc_requisition_lines ADD CONSTRAINT prc_req_lines_req_fk
  FOREIGN KEY (requisition_id) REFERENCES prc_requisitions(id) ON DELETE CASCADE;
