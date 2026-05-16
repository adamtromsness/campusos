/* ============================================================
 * Phase 2 Cycle 29 sub-cycle a (P2-29a) — Procurement Advanced
 *                                          + Finance Extensions
 * ============================================================
 *
 * Ships 9 logical base tables across two functional bundles:
 *
 *  Procurement Advanced (M86.1):
 *   - prc_vendor_catalogues: per-(vendor, school) pre-negotiated
 *     pricing catalogue. UNIQUE(vendor_id, school_id, catalogue_name).
 *   - prc_catalogue_items: per-(catalogue, item_code) negotiated
 *     line items. UNIQUE(catalogue_id, item_code). Requisitions
 *     from a catalogue auto-populate pricing.
 *   - prc_contracts: vendor contract lifecycle. 5-value status
 *     CHECK (DRAFT, ACTIVE, EXPIRING, RENEWED, TERMINATED).
 *     ContractExpiryWorker nightly checks end_date minus
 *     renewal_reminder_days and flips ACTIVE to EXPIRING.
 *   - prc_contract_amendments: per-contract numbered amendment
 *     trail. UNIQUE(contract_id, amendment_number).
 *   - prc_spending_analytics: materialised monthly rollup by
 *     (vendor, category, department). Maintained by
 *     ProcurementAnalyticsWorker from prc_purchase_orders and
 *     prc_goods_receipts.
 *
 *  Finance Extensions (M83/84.1):
 *   - fin_departmental_budgets: per-(school, year, dept, category)
 *     allocation with committed + spent + available NUMERIC(12,2)
 *     tracking. 6-value budget_category CHECK (PERSONNEL,
 *     SUPPLIES, EQUIPMENT, CONTRACTED_SERVICES, TRAVEL, OTHER).
 *     On prc.po.issued committed_amount increments — on
 *     pay.payment.received against the vendor committed releases
 *     and spent increments. The Step 2 service-layer
 *     BudgetTransferService runs the from-decrement and
 *     to-increment in one tenant tx so available_amount stays
 *     consistent across both rows.
 *   - fin_budget_transfers: inter-department transfer request +
 *     approval. 3-value status CHECK (PENDING, APPROVED,
 *     REJECTED). CHECK(from_budget_id != to_budget_id) prevents
 *     same-budget transfers. CHECK(amount > 0). On APPROVED the
 *     Step 2 service atomically decrements from-budget allocation
 *     and increments to-budget allocation in a single
 *     executeInTenantTransaction.
 *   - fin_journal_entry_batches: admin manual GL adjustment
 *     batch. 3-value status CHECK (DRAFT, POSTED, VOIDED).
 *     total_debits + total_credits + is_balanced materialised
 *     in app code on every line add/remove. The Step 2
 *     JournalBatchService.post path validates is_balanced=true
 *     before creating fin_gl_entries for each line — rejects
 *     unbalanced batches at the service layer. Cycle 26
 *     fin_journal_batches is the AUTO posting path from
 *     pay.* events — this new table is the MANUAL admin-edit
 *     batch path the operational ops dashboard surfaces.
 *   - fin_journal_entry_lines: per-batch debit OR credit line
 *     (never both). CHECK(debit >= 0 AND credit >= 0) +
 *     CHECK(debit = 0 OR credit = 0) — a line is single-sided.
 *
 * 8 new intra-tenant DB-enforced FKs:
 *   - prc_catalogue_items.catalogue_id CASCADE on parent
 *     catalogue. Line items are meaningless without their
 *     catalogue.
 *   - prc_contract_amendments.contract_id CASCADE. Amendments
 *     belong to one contract.
 *   - prc_vendor_catalogues.vendor_id NO ACTION on fin_suppliers
 *     to preserve audit when a supplier is deactivated.
 *   - prc_contracts.vendor_id NO ACTION on fin_suppliers same
 *     reason.
 *   - fin_budget_transfers.from_budget_id + to_budget_id both
 *     NO ACTION on fin_departmental_budgets so historical
 *     transfers survive a budget being archived.
 *   - fin_journal_entry_lines.batch_id CASCADE on parent batch.
 *   - fin_journal_entry_lines.account_id NO ACTION on
 *     fin_chart_of_accounts so historical entries preserve audit
 *     and the service layer blocks deactivation as the user-facing
 *     gate.
 *
 * 0 cross-schema FKs. All cross-tenant refs (school_id,
 * created_by, requested_by, approved_by, posted_by, vendor_id
 * via fin_suppliers which is tenant-scoped) follow ADR-001/020.
 * ============================================================ */

CREATE TABLE IF NOT EXISTS prc_vendor_catalogues (
  id UUID PRIMARY KEY,
  vendor_id UUID NOT NULL,
  school_id UUID NOT NULL,
  catalogue_name TEXT NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prc_vc_dates_chk CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT prc_vc_vendor_school_name_uq UNIQUE (vendor_id, school_id, catalogue_name)
);

CREATE INDEX IF NOT EXISTS prc_vc_school_active_idx
  ON prc_vendor_catalogues (school_id, is_active, effective_from);

COMMENT ON TABLE prc_vendor_catalogues IS 'Per-(vendor, school) pre-negotiated pricing catalogue. RequisitionService catalogue-based path auto-populates negotiated_price from prc_catalogue_items.';
COMMENT ON COLUMN prc_vendor_catalogues.vendor_id IS 'DB-enforced FK to fin_suppliers(id). NO ACTION on supplier deactivation so historical catalogues survive.';

CREATE TABLE IF NOT EXISTS prc_catalogue_items (
  id UUID PRIMARY KEY,
  catalogue_id UUID NOT NULL,
  item_code TEXT NOT NULL,
  description TEXT NOT NULL,
  unit TEXT,
  negotiated_price NUMERIC(10,2) NOT NULL,
  category TEXT,
  min_order_qty INT NOT NULL DEFAULT 1,
  lead_time_days INT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prc_ci_price_chk CHECK (negotiated_price >= 0),
  CONSTRAINT prc_ci_min_qty_chk CHECK (min_order_qty > 0),
  CONSTRAINT prc_ci_lead_time_chk CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  CONSTRAINT prc_ci_catalogue_code_uq UNIQUE (catalogue_id, item_code)
);

CREATE INDEX IF NOT EXISTS prc_ci_catalogue_active_idx
  ON prc_catalogue_items (catalogue_id, is_active);
CREATE INDEX IF NOT EXISTS prc_ci_category_idx
  ON prc_catalogue_items (category) WHERE category IS NOT NULL;

COMMENT ON TABLE prc_catalogue_items IS 'Per-(catalogue, item_code) negotiated-price line. CASCADE on parent catalogue since items are meaningless without their catalogue.';

CREATE TABLE IF NOT EXISTS prc_contracts (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  vendor_id UUID NOT NULL,
  contract_number TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  total_value NUMERIC(12,2),
  spent_to_date NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  document_s3_key TEXT,
  renewal_reminder_days INT NOT NULL DEFAULT 90,
  notes TEXT,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prc_contracts_status_chk CHECK (status IN ('DRAFT', 'ACTIVE', 'EXPIRING', 'RENEWED', 'TERMINATED')),
  CONSTRAINT prc_contracts_dates_chk CHECK (end_date >= start_date),
  CONSTRAINT prc_contracts_value_chk CHECK (total_value IS NULL OR total_value >= 0),
  CONSTRAINT prc_contracts_spent_chk CHECK (spent_to_date >= 0),
  CONSTRAINT prc_contracts_reminder_chk CHECK (renewal_reminder_days >= 0),
  CONSTRAINT prc_contracts_school_number_uq UNIQUE (school_id, contract_number)
);

CREATE INDEX IF NOT EXISTS prc_contracts_school_status_end_idx
  ON prc_contracts (school_id, status, end_date);
CREATE INDEX IF NOT EXISTS prc_contracts_vendor_status_idx
  ON prc_contracts (vendor_id, status);
CREATE INDEX IF NOT EXISTS prc_contracts_renewal_alert_idx
  ON prc_contracts (school_id, end_date) WHERE status = 'ACTIVE';

COMMENT ON TABLE prc_contracts IS 'Vendor contract lifecycle DRAFT to ACTIVE to EXPIRING to RENEWED or TERMINATED. ContractExpiryWorker runs nightly and transitions ACTIVE rows whose end_date minus renewal_reminder_days is now or past into EXPIRING + emits prc.contract.expiring.';
COMMENT ON COLUMN prc_contracts.vendor_id IS 'DB-enforced FK to fin_suppliers(id). NO ACTION preserves audit.';
COMMENT ON COLUMN prc_contracts.created_by IS 'Soft FK to hr_employees(id) per ADR-055.';

CREATE TABLE IF NOT EXISTS prc_contract_amendments (
  id UUID PRIMARY KEY,
  contract_id UUID NOT NULL,
  amendment_number INT NOT NULL,
  description TEXT NOT NULL,
  value_change NUMERIC(12,2) NOT NULL DEFAULT 0,
  new_end_date DATE,
  document_s3_key TEXT,
  approved_by UUID,
  effective_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prc_ca_amendment_chk CHECK (amendment_number > 0),
  CONSTRAINT prc_ca_contract_number_uq UNIQUE (contract_id, amendment_number)
);

CREATE INDEX IF NOT EXISTS prc_ca_contract_idx
  ON prc_contract_amendments (contract_id, effective_date DESC);

COMMENT ON TABLE prc_contract_amendments IS 'Per-contract numbered amendment trail. On value_change non-zero the Step 2 ContractService.amend path applies the delta to prc_contracts.total_value inside one tenant tx.';
COMMENT ON COLUMN prc_contract_amendments.approved_by IS 'Soft FK to hr_employees(id).';

CREATE TABLE IF NOT EXISTS prc_spending_analytics (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  period DATE NOT NULL,
  vendor_id UUID,
  category TEXT,
  department TEXT,
  total_spend NUMERIC(12,2) NOT NULL DEFAULT 0,
  po_count INT NOT NULL DEFAULT 0,
  avg_lead_time_days NUMERIC(5,1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prc_sa_spend_chk CHECK (total_spend >= 0),
  CONSTRAINT prc_sa_count_chk CHECK (po_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS prc_sa_period_dims_uq
  ON prc_spending_analytics (
    school_id,
    period,
    COALESCE(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(category, ''),
    COALESCE(department, '')
  );

CREATE INDEX IF NOT EXISTS prc_sa_school_period_idx
  ON prc_spending_analytics (school_id, period DESC);

COMMENT ON TABLE prc_spending_analytics IS 'Monthly materialised spending rollup by (vendor, category, department). Maintained by ProcurementAnalyticsWorker from prc_purchase_orders + prc_goods_receipts. COALESCE sentinel UNIQUE lets the rollup carry NULL vendor or NULL category dimensions.';
COMMENT ON COLUMN prc_spending_analytics.period IS 'Month anchor — always the first of the month (e.g. 2026-05-01).';

CREATE TABLE IF NOT EXISTS fin_departmental_budgets (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  academic_year_id UUID NOT NULL,
  department TEXT NOT NULL,
  budget_category TEXT NOT NULL,
  allocated_amount NUMERIC(12,2) NOT NULL,
  committed_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  spent_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes TEXT,
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fin_dept_budgets_category_chk CHECK (budget_category IN ('PERSONNEL', 'SUPPLIES', 'EQUIPMENT', 'CONTRACTED_SERVICES', 'TRAVEL', 'OTHER')),
  CONSTRAINT fin_dept_budgets_allocated_chk CHECK (allocated_amount >= 0),
  CONSTRAINT fin_dept_budgets_committed_chk CHECK (committed_amount >= 0),
  CONSTRAINT fin_dept_budgets_spent_chk CHECK (spent_amount >= 0),
  CONSTRAINT fin_dept_budgets_uq UNIQUE (school_id, academic_year_id, department, budget_category)
);

CREATE INDEX IF NOT EXISTS fin_dept_budgets_school_year_idx
  ON fin_departmental_budgets (school_id, academic_year_id, department);

COMMENT ON TABLE fin_departmental_budgets IS 'Per-(school, year, department, budget_category) allocation. available_amount is computed in service code as allocated - committed - spent so it can go negative when overspent (which the variance dashboard wants to surface). On prc.po.issued committed_amount increments. On pay.payment.received against the vendor the committed releases and spent increments.';
COMMENT ON COLUMN fin_departmental_budgets.academic_year_id IS 'Soft FK to sis_academic_years(id).';
COMMENT ON COLUMN fin_departmental_budgets.approved_by IS 'Soft FK to hr_employees(id).';

CREATE TABLE IF NOT EXISTS fin_budget_transfers (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  from_budget_id UUID NOT NULL,
  to_budget_id UUID NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  reason TEXT NOT NULL,
  requested_by UUID NOT NULL,
  approved_by UUID,
  status TEXT NOT NULL DEFAULT 'PENDING',
  transferred_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fin_bt_status_chk CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  CONSTRAINT fin_bt_amount_chk CHECK (amount > 0),
  CONSTRAINT fin_bt_different_budgets_chk CHECK (from_budget_id <> to_budget_id),
  CONSTRAINT fin_bt_approved_chk CHECK (
    (status = 'PENDING' AND transferred_at IS NULL AND approved_by IS NULL)
    OR (status = 'APPROVED' AND transferred_at IS NOT NULL AND approved_by IS NOT NULL)
    OR (status = 'REJECTED')
  )
);

CREATE INDEX IF NOT EXISTS fin_bt_school_status_idx
  ON fin_budget_transfers (school_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS fin_bt_from_idx
  ON fin_budget_transfers (from_budget_id);
CREATE INDEX IF NOT EXISTS fin_bt_to_idx
  ON fin_budget_transfers (to_budget_id);

COMMENT ON TABLE fin_budget_transfers IS 'Inter-department budget transfer request. CRITICAL: the Step 2 BudgetTransferService.approve path runs the from-decrement + to-increment in one executeInTenantTransaction so allocated_amount stays consistent across both rows. CHECK(from_budget_id != to_budget_id) is the schema-side belt and braces.';
COMMENT ON COLUMN fin_budget_transfers.requested_by IS 'Soft FK to hr_employees(id).';
COMMENT ON COLUMN fin_budget_transfers.approved_by IS 'Soft FK to hr_employees(id).';

CREATE TABLE IF NOT EXISTS fin_journal_entry_batches (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  batch_name TEXT NOT NULL,
  description TEXT,
  entry_count INT NOT NULL DEFAULT 0,
  total_debits NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_credits NUMERIC(14,2) NOT NULL DEFAULT 0,
  is_balanced BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  created_by UUID NOT NULL,
  posted_by UUID,
  posted_at TIMESTAMPTZ,
  voided_by UUID,
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fin_jeb_status_chk CHECK (status IN ('DRAFT', 'POSTED', 'VOIDED')),
  CONSTRAINT fin_jeb_count_chk CHECK (entry_count >= 0),
  CONSTRAINT fin_jeb_debits_chk CHECK (total_debits >= 0),
  CONSTRAINT fin_jeb_credits_chk CHECK (total_credits >= 0),
  CONSTRAINT fin_jeb_posted_chk CHECK (
    (status = 'DRAFT' AND posted_at IS NULL AND posted_by IS NULL)
    OR (status = 'POSTED' AND posted_at IS NOT NULL AND posted_by IS NOT NULL)
    OR (status = 'VOIDED' AND voided_at IS NOT NULL AND voided_by IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS fin_jeb_school_status_idx
  ON fin_journal_entry_batches (school_id, status, created_at DESC);

COMMENT ON TABLE fin_journal_entry_batches IS 'Admin manual GL adjustment batch — distinct from Cycle 26 fin_journal_batches which is the AUTO posting path from pay.* events. CRITICAL: the Step 2 JournalBatchService.post validates is_balanced=true (total_debits = total_credits) before creating fin_gl_entries for each line. Unbalanced batches are rejected at the service layer with the entire post tx rolling back.';
COMMENT ON COLUMN fin_journal_entry_batches.is_balanced IS 'Materialised flag re-evaluated on every line add/remove in the Step 2 service. Equivalent to total_debits = total_credits AND entry_count > 0.';
COMMENT ON COLUMN fin_journal_entry_batches.created_by IS 'Soft FK to hr_employees(id).';
COMMENT ON COLUMN fin_journal_entry_batches.posted_by IS 'Soft FK to hr_employees(id).';

CREATE TABLE IF NOT EXISTS fin_journal_entry_lines (
  id UUID PRIMARY KEY,
  batch_id UUID NOT NULL,
  account_id UUID NOT NULL,
  debit NUMERIC(14,2) NOT NULL DEFAULT 0,
  credit NUMERIC(14,2) NOT NULL DEFAULT 0,
  description TEXT,
  line_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fin_jel_debit_chk CHECK (debit >= 0),
  CONSTRAINT fin_jel_credit_chk CHECK (credit >= 0),
  CONSTRAINT fin_jel_one_side_chk CHECK (debit = 0 OR credit = 0),
  CONSTRAINT fin_jel_entry_chk CHECK (debit > 0 OR credit > 0)
);

CREATE INDEX IF NOT EXISTS fin_jel_batch_idx
  ON fin_journal_entry_lines (batch_id, line_order);
CREATE INDEX IF NOT EXISTS fin_jel_account_idx
  ON fin_journal_entry_lines (account_id);

COMMENT ON TABLE fin_journal_entry_lines IS 'Per-batch debit OR credit line. CHECK(debit = 0 OR credit = 0) enforces single-sided lines so a row is either a debit or a credit, never both. CHECK(debit > 0 OR credit > 0) rejects all-zero rows.';

/* DB-enforced FKs. Idempotent DROP IF EXISTS + ADD pattern so
 * re-provision is a no-op. */

ALTER TABLE prc_vendor_catalogues DROP CONSTRAINT IF EXISTS prc_vc_vendor_fk;
ALTER TABLE prc_vendor_catalogues ADD CONSTRAINT prc_vc_vendor_fk
  FOREIGN KEY (vendor_id) REFERENCES fin_suppliers(id) ON DELETE NO ACTION;

ALTER TABLE prc_catalogue_items DROP CONSTRAINT IF EXISTS prc_ci_catalogue_fk;
ALTER TABLE prc_catalogue_items ADD CONSTRAINT prc_ci_catalogue_fk
  FOREIGN KEY (catalogue_id) REFERENCES prc_vendor_catalogues(id) ON DELETE CASCADE;

ALTER TABLE prc_contracts DROP CONSTRAINT IF EXISTS prc_contracts_vendor_fk;
ALTER TABLE prc_contracts ADD CONSTRAINT prc_contracts_vendor_fk
  FOREIGN KEY (vendor_id) REFERENCES fin_suppliers(id) ON DELETE NO ACTION;

ALTER TABLE prc_contract_amendments DROP CONSTRAINT IF EXISTS prc_ca_contract_fk;
ALTER TABLE prc_contract_amendments ADD CONSTRAINT prc_ca_contract_fk
  FOREIGN KEY (contract_id) REFERENCES prc_contracts(id) ON DELETE CASCADE;

ALTER TABLE fin_budget_transfers DROP CONSTRAINT IF EXISTS fin_bt_from_fk;
ALTER TABLE fin_budget_transfers ADD CONSTRAINT fin_bt_from_fk
  FOREIGN KEY (from_budget_id) REFERENCES fin_departmental_budgets(id) ON DELETE NO ACTION;

ALTER TABLE fin_budget_transfers DROP CONSTRAINT IF EXISTS fin_bt_to_fk;
ALTER TABLE fin_budget_transfers ADD CONSTRAINT fin_bt_to_fk
  FOREIGN KEY (to_budget_id) REFERENCES fin_departmental_budgets(id) ON DELETE NO ACTION;

ALTER TABLE fin_journal_entry_lines DROP CONSTRAINT IF EXISTS fin_jel_batch_fk;
ALTER TABLE fin_journal_entry_lines ADD CONSTRAINT fin_jel_batch_fk
  FOREIGN KEY (batch_id) REFERENCES fin_journal_entry_batches(id) ON DELETE CASCADE;

ALTER TABLE fin_journal_entry_lines DROP CONSTRAINT IF EXISTS fin_jel_account_fk;
ALTER TABLE fin_journal_entry_lines ADD CONSTRAINT fin_jel_account_fk
  FOREIGN KEY (account_id) REFERENCES fin_chart_of_accounts(id) ON DELETE NO ACTION;
