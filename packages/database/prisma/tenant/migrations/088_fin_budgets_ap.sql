/* ============================================================
 * Cycle 26 — Step 3: Budgets + AP + Reconciliation + Board
 *                    Reports + Grants + Suppliers (Tenant)
 * ============================================================
 *
 * The largest migration of Cycle 26. Step 3 lands 9 logical base
 * tables completing the M83 Finance and Accounting schema phase:
 * suppliers and supplier contacts (the tables that ADR-051
 * documented as pre-staged from Wave 1 but ship freshly here as
 * the FK targets of fin_ap_vouchers), budgets and budget lines,
 * accounts-payable vouchers and payments, bank reconciliation
 * runs, board-ready financial report snapshots, and grants.
 *
 * Step 3 lands 9 logical base tables:
 *
 *   - fin_suppliers + fin_supplier_contacts: per-school supplier
 *     directory. supplier_type 4-value CHECK (VENDOR, CONTRACTOR,
 *     UTILITY, OTHER). UNIQUE(school_id, supplier_code). Contacts
 *     CASCADE on parent supplier with at-most-one is_primary
 *     contact via partial UNIQUE INDEX.
 *
 *   - fin_budgets: per-(school, fiscal_year, fund, name) header.
 *     3-value status CHECK (DRAFT, APPROVED, AMENDED). UNIQUE
 *     across the tuple.
 *
 *   - fin_budget_lines: per-(budget, account) line. 3 NUMERIC
 *     amount columns budgeted, actual, encumbered, all
 *     non-negative. The Step 7 BudgetService computes remaining
 *     in app code rather than as a generated column so the value
 *     can be negative when actuals overrun budgeted, which is the
 *     exact case the variance dashboard cares about. UNIQUE
 *     (budget_id, account_id).
 *
 *   - fin_ap_vouchers: invoice from a supplier. 5-value status
 *     CHECK (PENDING, APPROVED, PAID, VOIDED, ON_HOLD). multi-
 *     column dates_chk enforces due_date greater than or equal to
 *     invoice_date. UNIQUE(school, voucher_number).
 *     supplier_id NO ACTION since suppliers preserve audit beyond
 *     the supplier being deactivated.
 *
 *   - fin_ap_payments: payment record per voucher. 4-value
 *     payment_method CHECK (CHECK, ACH, WIRE, CREDIT_CARD).
 *     amount NUMERIC(12,2) positive CHECK. Soft journal_batch_id
 *     ref points at the GL posting that the Step 7 APPaymentService
 *     creates inline.
 *
 *   - fin_reconciliation_runs: bank reconciliation for an account
 *     and period. 3-value status CHECK (IN_PROGRESS, RECONCILED,
 *     VARIANCE_FLAGGED). multi-column reconciled_chk keeps
 *     reconciled_by + reconciled_at in lockstep with the
 *     RECONCILED status. outstanding_items JSONB carries the
 *     unmatched items free-form.
 *
 *   - fin_board_report_snapshots: IMMUTABLE per ADR-010 — the
 *     Step 7 BoardReportService is the sole writer and exposes no
 *     UPDATE / DELETE methods. report_data JSONB is the frozen
 *     numbers at generation time. 4-value report_type CHECK
 *     (BALANCE_SHEET, INCOME_STATEMENT, BUDGET_VS_ACTUAL,
 *     CASH_FLOW).
 *
 *   - fin_grants: grant tracking. 3-value status CHECK (ACTIVE,
 *     CLOSED, REPORTING). award and drawn amounts non-negative.
 *     fund_id NO ACTION since grants typically pin to a SPECIAL
 *     REVENUE fund that should not be deleted while the grant is
 *     active.
 *
 * 11 new intra-tenant DB-enforced FKs covering the full graph —
 * supplier_contacts to supplier CASCADE, budget to fund NO
 * ACTION, budget_lines to budget CASCADE, budget_lines to chart
 * NO ACTION, ap_voucher to supplier NO ACTION, ap_voucher to
 * chart NO ACTION, ap_voucher to fund NO ACTION, ap_payment to
 * voucher CASCADE, ap_payment to journal_batch NO ACTION,
 * reconciliation_run to chart NO ACTION, reconciliation_run to
 * period NO ACTION, and grant to fund NO ACTION. 0 cross-schema
 * FKs.
 * ============================================================ */

CREATE TABLE IF NOT EXISTS fin_suppliers (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  supplier_code TEXT NOT NULL,
  supplier_name TEXT NOT NULL,
  supplier_type TEXT NOT NULL DEFAULT 'VENDOR',
  tax_id TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  region TEXT,
  postal_code TEXT,
  country TEXT,
  payment_terms TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fin_suppliers_type_chk CHECK (supplier_type IN ('VENDOR', 'CONTRACTOR', 'UTILITY', 'OTHER')),
  CONSTRAINT fin_suppliers_school_code_uq UNIQUE (school_id, supplier_code)
);

CREATE INDEX IF NOT EXISTS fin_suppliers_school_active_idx
  ON fin_suppliers (school_id, is_active);

COMMENT ON TABLE fin_suppliers IS 'Per-school supplier directory. ADR-051 originally documented this table as pre-staged in Wave 1 — it ships freshly in Cycle 26 Step 3 as the FK target of fin_ap_vouchers.';

CREATE TABLE IF NOT EXISTS fin_supplier_contacts (
  id UUID PRIMARY KEY,
  supplier_id UUID NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  role TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fin_supplier_contacts_supplier_idx
  ON fin_supplier_contacts (supplier_id);
CREATE UNIQUE INDEX IF NOT EXISTS fin_supplier_contacts_primary_uq
  ON fin_supplier_contacts (supplier_id) WHERE is_primary = true;

COMMENT ON INDEX fin_supplier_contacts_primary_uq IS 'Partial UNIQUE — at most one is_primary contact per supplier.';

CREATE TABLE IF NOT EXISTS fin_budgets (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  fiscal_year TEXT NOT NULL,
  fund_id UUID NOT NULL,
  name TEXT NOT NULL,
  total_revenue NUMERIC(12,2) DEFAULT 0,
  total_expense NUMERIC(12,2) DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fin_budgets_status_chk CHECK (status IN ('DRAFT', 'APPROVED', 'AMENDED')),
  CONSTRAINT fin_budgets_school_year_fund_name_uq UNIQUE (school_id, fiscal_year, fund_id, name)
);

CREATE INDEX IF NOT EXISTS fin_budgets_school_year_idx
  ON fin_budgets (school_id, fiscal_year, status);

COMMENT ON COLUMN fin_budgets.approved_by IS 'Soft FK to hr_employees(id). Stamped when status flips to APPROVED.';

CREATE TABLE IF NOT EXISTS fin_budget_lines (
  id UUID PRIMARY KEY,
  budget_id UUID NOT NULL,
  account_id UUID NOT NULL,
  budgeted_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  actual_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  encumbered_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fin_budget_lines_budgeted_chk CHECK (budgeted_amount >= 0),
  CONSTRAINT fin_budget_lines_actual_chk CHECK (actual_amount >= 0),
  CONSTRAINT fin_budget_lines_encumbered_chk CHECK (encumbered_amount >= 0),
  CONSTRAINT fin_budget_lines_budget_account_uq UNIQUE (budget_id, account_id)
);

CREATE INDEX IF NOT EXISTS fin_budget_lines_account_idx
  ON fin_budget_lines (account_id);

COMMENT ON TABLE fin_budget_lines IS 'Per-(budget, account) line. The Step 7 BudgetService computes remaining = budgeted - actual - encumbered in app code. Negative remaining flags an over-budget line on the variance dashboard.';

CREATE TABLE IF NOT EXISTS fin_ap_vouchers (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  supplier_id UUID NOT NULL,
  voucher_number TEXT NOT NULL,
  invoice_number TEXT,
  invoice_date DATE NOT NULL,
  due_date DATE NOT NULL,
  total_amount NUMERIC(12,2) NOT NULL,
  description TEXT,
  gl_account_id UUID,
  fund_id UUID,
  approval_request_id UUID,
  status TEXT NOT NULL DEFAULT 'PENDING',
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ,
  voided_by UUID,
  void_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fin_ap_status_chk CHECK (status IN ('PENDING', 'APPROVED', 'PAID', 'VOIDED', 'ON_HOLD')),
  CONSTRAINT fin_ap_amount_chk CHECK (total_amount > 0),
  CONSTRAINT fin_ap_dates_chk CHECK (due_date >= invoice_date),
  CONSTRAINT fin_ap_voided_chk CHECK (
    (status <> 'VOIDED' AND voided_at IS NULL)
    OR (status = 'VOIDED' AND voided_at IS NOT NULL)
  ),
  CONSTRAINT fin_ap_school_voucher_uq UNIQUE (school_id, voucher_number)
);

CREATE INDEX IF NOT EXISTS fin_ap_school_status_due_idx
  ON fin_ap_vouchers (school_id, status, due_date);
CREATE INDEX IF NOT EXISTS fin_ap_supplier_idx
  ON fin_ap_vouchers (supplier_id, status);

COMMENT ON COLUMN fin_ap_vouchers.approved_by IS 'Soft FK to hr_employees(id).';
COMMENT ON COLUMN fin_ap_vouchers.approval_request_id IS 'Soft FK to wsk_approval_requests(id) per ADR-035 — future workflow integration for vouchers above a threshold.';

CREATE TABLE IF NOT EXISTS fin_ap_payments (
  id UUID PRIMARY KEY,
  voucher_id UUID NOT NULL,
  payment_method TEXT NOT NULL,
  payment_reference TEXT,
  amount NUMERIC(12,2) NOT NULL,
  paid_at TIMESTAMPTZ NOT NULL,
  paid_by UUID NOT NULL,
  journal_batch_id UUID,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fin_ap_pay_method_chk CHECK (payment_method IN ('CHECK', 'ACH', 'WIRE', 'CREDIT_CARD')),
  CONSTRAINT fin_ap_pay_amount_chk CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS fin_ap_pay_voucher_idx
  ON fin_ap_payments (voucher_id);

COMMENT ON COLUMN fin_ap_payments.journal_batch_id IS 'Soft ref to fin_journal_batches(id) — declared as a real DB FK below for delete-time safety.';
COMMENT ON COLUMN fin_ap_payments.paid_by IS 'Soft FK to hr_employees(id).';

CREATE TABLE IF NOT EXISTS fin_reconciliation_runs (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  account_id UUID NOT NULL,
  period_id UUID NOT NULL,
  gl_balance NUMERIC(12,2) NOT NULL,
  bank_balance NUMERIC(12,2) NOT NULL,
  difference NUMERIC(12,2) NOT NULL,
  outstanding_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  reconciled_by UUID,
  reconciled_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fin_recon_status_chk CHECK (status IN ('IN_PROGRESS', 'RECONCILED', 'VARIANCE_FLAGGED')),
  CONSTRAINT fin_recon_reconciled_chk CHECK (
    (status <> 'RECONCILED' AND reconciled_at IS NULL AND reconciled_by IS NULL)
    OR (status = 'RECONCILED' AND reconciled_at IS NOT NULL AND reconciled_by IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS fin_recon_school_period_idx
  ON fin_reconciliation_runs (school_id, period_id);

COMMENT ON COLUMN fin_reconciliation_runs.reconciled_by IS 'Soft FK to hr_employees(id).';

CREATE TABLE IF NOT EXISTS fin_board_report_snapshots (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  report_type TEXT NOT NULL,
  period_id UUID,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_by UUID NOT NULL,
  report_data JSONB NOT NULL,
  s3_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fin_report_type_chk CHECK (report_type IN ('BALANCE_SHEET', 'INCOME_STATEMENT', 'BUDGET_VS_ACTUAL', 'CASH_FLOW'))
);

CREATE INDEX IF NOT EXISTS fin_report_school_type_idx
  ON fin_board_report_snapshots (school_id, report_type, generated_at DESC);

COMMENT ON TABLE fin_board_report_snapshots IS 'IMMUTABLE per ADR-010 — the Step 7 BoardReportService is the sole writer and exposes no UPDATE or DELETE methods. report_data is the frozen JSONB snapshot at generation time.';
COMMENT ON COLUMN fin_board_report_snapshots.generated_by IS 'Soft FK to hr_employees(id).';

CREATE TABLE IF NOT EXISTS fin_grants (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  fund_id UUID,
  grant_name TEXT NOT NULL,
  grantor TEXT NOT NULL,
  grant_number TEXT,
  award_amount NUMERIC(12,2) NOT NULL,
  drawn_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  reporting_due_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fin_grants_status_chk CHECK (status IN ('ACTIVE', 'CLOSED', 'REPORTING')),
  CONSTRAINT fin_grants_award_chk CHECK (award_amount > 0),
  CONSTRAINT fin_grants_drawn_chk CHECK (drawn_amount >= 0),
  CONSTRAINT fin_grants_drawn_within_award_chk CHECK (drawn_amount <= award_amount),
  CONSTRAINT fin_grants_dates_chk CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS fin_grants_school_status_idx
  ON fin_grants (school_id, status);

/* DB-enforced FKs. Idempotent DROP IF EXISTS + ADD pattern so
 * re-provision is a no-op. */

ALTER TABLE fin_supplier_contacts DROP CONSTRAINT IF EXISTS fin_supplier_contacts_supplier_fk;
ALTER TABLE fin_supplier_contacts ADD CONSTRAINT fin_supplier_contacts_supplier_fk
  FOREIGN KEY (supplier_id) REFERENCES fin_suppliers(id) ON DELETE CASCADE;

ALTER TABLE fin_budgets DROP CONSTRAINT IF EXISTS fin_budgets_fund_fk;
ALTER TABLE fin_budgets ADD CONSTRAINT fin_budgets_fund_fk
  FOREIGN KEY (fund_id) REFERENCES fin_funds(id) ON DELETE NO ACTION;

ALTER TABLE fin_budget_lines DROP CONSTRAINT IF EXISTS fin_budget_lines_budget_fk;
ALTER TABLE fin_budget_lines ADD CONSTRAINT fin_budget_lines_budget_fk
  FOREIGN KEY (budget_id) REFERENCES fin_budgets(id) ON DELETE CASCADE;

ALTER TABLE fin_budget_lines DROP CONSTRAINT IF EXISTS fin_budget_lines_account_fk;
ALTER TABLE fin_budget_lines ADD CONSTRAINT fin_budget_lines_account_fk
  FOREIGN KEY (account_id) REFERENCES fin_chart_of_accounts(id) ON DELETE NO ACTION;

ALTER TABLE fin_ap_vouchers DROP CONSTRAINT IF EXISTS fin_ap_supplier_fk;
ALTER TABLE fin_ap_vouchers ADD CONSTRAINT fin_ap_supplier_fk
  FOREIGN KEY (supplier_id) REFERENCES fin_suppliers(id) ON DELETE NO ACTION;

ALTER TABLE fin_ap_vouchers DROP CONSTRAINT IF EXISTS fin_ap_account_fk;
ALTER TABLE fin_ap_vouchers ADD CONSTRAINT fin_ap_account_fk
  FOREIGN KEY (gl_account_id) REFERENCES fin_chart_of_accounts(id) ON DELETE NO ACTION;

ALTER TABLE fin_ap_vouchers DROP CONSTRAINT IF EXISTS fin_ap_fund_fk;
ALTER TABLE fin_ap_vouchers ADD CONSTRAINT fin_ap_fund_fk
  FOREIGN KEY (fund_id) REFERENCES fin_funds(id) ON DELETE NO ACTION;

ALTER TABLE fin_ap_payments DROP CONSTRAINT IF EXISTS fin_ap_payments_voucher_fk;
ALTER TABLE fin_ap_payments ADD CONSTRAINT fin_ap_payments_voucher_fk
  FOREIGN KEY (voucher_id) REFERENCES fin_ap_vouchers(id) ON DELETE CASCADE;

ALTER TABLE fin_ap_payments DROP CONSTRAINT IF EXISTS fin_ap_payments_batch_fk;
ALTER TABLE fin_ap_payments ADD CONSTRAINT fin_ap_payments_batch_fk
  FOREIGN KEY (journal_batch_id) REFERENCES fin_journal_batches(id) ON DELETE NO ACTION;

ALTER TABLE fin_reconciliation_runs DROP CONSTRAINT IF EXISTS fin_recon_account_fk;
ALTER TABLE fin_reconciliation_runs ADD CONSTRAINT fin_recon_account_fk
  FOREIGN KEY (account_id) REFERENCES fin_chart_of_accounts(id) ON DELETE NO ACTION;

ALTER TABLE fin_reconciliation_runs DROP CONSTRAINT IF EXISTS fin_recon_period_fk;
ALTER TABLE fin_reconciliation_runs ADD CONSTRAINT fin_recon_period_fk
  FOREIGN KEY (period_id) REFERENCES fin_accounting_periods(id) ON DELETE NO ACTION;

ALTER TABLE fin_grants DROP CONSTRAINT IF EXISTS fin_grants_fund_fk;
ALTER TABLE fin_grants ADD CONSTRAINT fin_grants_fund_fk
  FOREIGN KEY (fund_id) REFERENCES fin_funds(id) ON DELETE NO ACTION;
