/* ============================================================
 * Cycle 26 — Step 1: Chart of Accounts + Funds + Periods (Tenant)
 * ============================================================
 *
 * The M83 Finance and Accounting module is the financial system of
 * record for a school. Cycle 26 ships all 14 in-scope tables across
 * three migrations. This first migration lands the accounting
 * foundation: the hierarchical chart of accounts, the GASB fund
 * classifications, and the fiscal period controls with permanent
 * LOCK capability. Opens Wave 6 (Finance and Commerce).
 *
 * Step 1 lands 3 logical base tables:
 *
 *   - fin_chart_of_accounts: hierarchical per-school chart with a
 *     5-value account_type CHECK (ASSET, LIABILITY, EQUITY,
 *     REVENUE, EXPENSE) and a 2-value normal_balance CHECK
 *     (DEBIT, CREDIT) capturing whether a debit increases or
 *     decreases the account. parent_account_id is a self-FK with
 *     NO ACTION on delete so admins must reassign children before
 *     removing a parent. is_system flags protected control
 *     accounts (Cash, AR, AP) that the Step 5 service refuses to
 *     deactivate. UNIQUE(school_id, account_code).
 *
 *   - fin_funds: per-school catalogue of fund classifications.
 *     6-value fund_type CHECK covers the GASB fund taxonomy
 *     (GENERAL, SPECIAL_REVENUE, CAPITAL_PROJECTS, DEBT_SERVICE,
 *     PERMANENT, ENTERPRISE) that government-funded school
 *     reporting requires. UNIQUE(school_id, fund_code).
 *
 *   - fin_accounting_periods: fiscal period controls. 4-value
 *     status CHECK (FUTURE, OPEN, CLOSED, LOCKED). Multi-column
 *     dates_chk enforces end_date greater than or equal to
 *     start_date. UNIQUE(school_id, fiscal_year, period_number).
 *     The LOCKED status is permanent — the Step 5 PeriodService
 *     refuses any transition out of LOCKED, and the Step 6
 *     PostingService refuses any entry where the target period
 *     is CLOSED or LOCKED.
 *
 * 2 new intra-tenant DB-enforced FKs (1 self-FK on the chart and
 * 1 cross-table FK on the chart pointing at the fund catalogue,
 * both NO ACTION for audit preservation). 0 cross-schema FKs —
 * the school_id refs are kept soft per ADR-001/020.
 * ============================================================ */

CREATE TABLE IF NOT EXISTS fin_chart_of_accounts (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  account_code TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_type TEXT NOT NULL,
  normal_balance TEXT NOT NULL,
  parent_account_id UUID,
  fund_id UUID,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fin_accounts_type_chk CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  CONSTRAINT fin_accounts_normal_balance_chk CHECK (normal_balance IN ('DEBIT', 'CREDIT')),
  CONSTRAINT fin_accounts_school_code_uq UNIQUE (school_id, account_code)
);

CREATE INDEX IF NOT EXISTS fin_accounts_school_type_active_idx
  ON fin_chart_of_accounts (school_id, account_type, is_active);
CREATE INDEX IF NOT EXISTS fin_accounts_parent_idx
  ON fin_chart_of_accounts (parent_account_id) WHERE parent_account_id IS NOT NULL;

COMMENT ON TABLE fin_chart_of_accounts IS 'Per-school chart of accounts. Hierarchical via parent_account_id self-FK NO ACTION. is_system flag protects Cash, AR, AP control accounts from deactivation.';
COMMENT ON COLUMN fin_chart_of_accounts.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020.';
COMMENT ON COLUMN fin_chart_of_accounts.fund_id IS 'Soft FK to fin_funds(id) declared as a real DB FK below for delete-time safety.';
COMMENT ON COLUMN fin_chart_of_accounts.is_system IS 'Protected control account flag. Cash, AR, and AP cannot be deactivated by the Step 5 service when is_system=true.';

CREATE TABLE IF NOT EXISTS fin_funds (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  fund_code TEXT NOT NULL,
  fund_name TEXT NOT NULL,
  fund_type TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fin_funds_type_chk CHECK (fund_type IN ('GENERAL', 'SPECIAL_REVENUE', 'CAPITAL_PROJECTS', 'DEBT_SERVICE', 'PERMANENT', 'ENTERPRISE')),
  CONSTRAINT fin_funds_school_code_uq UNIQUE (school_id, fund_code)
);

CREATE INDEX IF NOT EXISTS fin_funds_school_active_idx
  ON fin_funds (school_id, is_active);

COMMENT ON TABLE fin_funds IS 'Per-school catalogue of fund classifications. The 6-value fund_type CHECK covers the GASB fund taxonomy that government-funded school reporting requires.';

CREATE TABLE IF NOT EXISTS fin_accounting_periods (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  fiscal_year TEXT NOT NULL,
  period_number INT NOT NULL,
  period_name TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'FUTURE',
  closed_at TIMESTAMPTZ,
  closed_by UUID,
  locked_at TIMESTAMPTZ,
  locked_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fin_periods_status_chk CHECK (status IN ('FUTURE', 'OPEN', 'CLOSED', 'LOCKED')),
  CONSTRAINT fin_periods_dates_chk CHECK (end_date >= start_date),
  CONSTRAINT fin_periods_period_chk CHECK (period_number > 0),
  CONSTRAINT fin_periods_school_year_period_uq UNIQUE (school_id, fiscal_year, period_number)
);

CREATE INDEX IF NOT EXISTS fin_periods_school_status_idx
  ON fin_accounting_periods (school_id, status);
CREATE INDEX IF NOT EXISTS fin_periods_school_dates_idx
  ON fin_accounting_periods (school_id, start_date, end_date);

COMMENT ON TABLE fin_accounting_periods IS 'Fiscal period controls. LOCKED is permanent — the Step 5 PeriodService refuses any transition out of LOCKED and the Step 6 PostingService refuses any entry targeting a CLOSED or LOCKED period.';
COMMENT ON COLUMN fin_accounting_periods.status IS 'FUTURE planned but not yet open. OPEN accepting entries. CLOSED reopen by CFO until LOCKED. LOCKED permanent — irreversible.';
COMMENT ON COLUMN fin_accounting_periods.closed_by IS 'Soft FK to hr_employees(id). Stamped when status flips to CLOSED.';
COMMENT ON COLUMN fin_accounting_periods.locked_by IS 'Soft FK to hr_employees(id). Stamped when status flips to LOCKED — irreversible.';

/* Self-FK + cross-table FK on the chart of accounts. Both NO ACTION
 * to preserve audit and force admins to reassign children before
 * deleting a parent. Idempotent DROP IF EXISTS + ADD pattern so
 * re-provision is a no-op. */

ALTER TABLE fin_chart_of_accounts DROP CONSTRAINT IF EXISTS fin_accounts_parent_fk;
ALTER TABLE fin_chart_of_accounts ADD CONSTRAINT fin_accounts_parent_fk
  FOREIGN KEY (parent_account_id) REFERENCES fin_chart_of_accounts(id) ON DELETE NO ACTION;

ALTER TABLE fin_chart_of_accounts DROP CONSTRAINT IF EXISTS fin_accounts_fund_fk;
ALTER TABLE fin_chart_of_accounts ADD CONSTRAINT fin_accounts_fund_fk
  FOREIGN KEY (fund_id) REFERENCES fin_funds(id) ON DELETE NO ACTION;
