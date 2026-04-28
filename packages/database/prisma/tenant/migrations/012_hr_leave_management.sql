/* 012_hr_leave_management.sql
 * Cycle 4 Step 2 — HR Leave Management.
 *
 * Three tables:
 *   hr_leave_types     — per-school leave catalogue (Sick, Personal, etc).
 *                         is_paid, accrual_rate (days/year), max_balance cap.
 *   hr_leave_balances  — per-(employee, type, academic year) balance row.
 *                         accrued / used / pending in days, derived by the
 *                         approval workflow that lands in Step 7.
 *   hr_leave_requests  — request lifecycle. PENDING -> APPROVED / REJECTED
 *                         / CANCELLED. Half-day support via NUMERIC(4,1)
 *                         days_requested. is_hr_initiated when HR writes a
 *                         leave on the employee behalf (e.g. mandatory PD).
 *
 * Approval flow (implemented in Step 7 LeaveService, schema-level here):
 *   - submit  -> status=PENDING, balance pending += days_requested
 *   - approve -> status=APPROVED, balance pending -= days_requested,
 *                                  balance used += days_requested
 *                Kafka emit hr.leave.approved (consumed by Cycle 5
 *                scheduling for class-coverage planning)
 *   - reject  -> status=REJECTED, balance pending -= days_requested
 *   - cancel  -> status=CANCELLED, same reversal as reject
 *
 * DB-enforced FKs: hr_leave_balances + hr_leave_requests both reference
 * hr_employees ON DELETE CASCADE. sis_academic_years is referenced from
 * balances (non-cascade) since deleting an academic year while balances
 * exist is a data-integrity concern that should fail loudly.
 *
 * Block-comment style required per the splitter quirk. No semicolons inside
 * any string literal or block comment — splitter cuts on every semicolon.
 * Idempotent — safe to re-run.
 */
CREATE TABLE IF NOT EXISTS hr_leave_types (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    is_paid BOOLEAN NOT NULL DEFAULT true,
    accrual_rate NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    max_balance NUMERIC(5,2),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_leave_types_school_name_uq UNIQUE (school_id, name),
    CONSTRAINT hr_leave_types_accrual_chk CHECK (accrual_rate >= 0),
    CONSTRAINT hr_leave_types_max_balance_chk CHECK (max_balance IS NULL OR max_balance >= 0)
);
CREATE INDEX IF NOT EXISTS hr_leave_types_school_active_idx ON hr_leave_types(school_id) WHERE is_active = true;
COMMENT ON COLUMN hr_leave_types.accrual_rate IS 'Days accrued per academic year. 0 means non-accruing (e.g. Bereavement, Unpaid).';
COMMENT ON COLUMN hr_leave_types.max_balance IS 'Optional cap on accrued days. NULL means uncapped.';
CREATE TABLE IF NOT EXISTS hr_leave_balances (
    id UUID PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    leave_type_id UUID NOT NULL REFERENCES hr_leave_types(id),
    academic_year_id UUID NOT NULL REFERENCES sis_academic_years(id),
    accrued NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    used NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    pending NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_leave_balances_employee_type_year_uq UNIQUE (employee_id, leave_type_id, academic_year_id),
    CONSTRAINT hr_leave_balances_accrued_chk CHECK (accrued >= 0),
    CONSTRAINT hr_leave_balances_used_chk CHECK (used >= 0),
    CONSTRAINT hr_leave_balances_pending_chk CHECK (pending >= 0)
);
CREATE INDEX IF NOT EXISTS hr_leave_balances_employee_year_idx ON hr_leave_balances(employee_id, academic_year_id);
CREATE INDEX IF NOT EXISTS hr_leave_balances_type_idx ON hr_leave_balances(leave_type_id);
COMMENT ON COLUMN hr_leave_balances.accrued IS 'Total days accrued this academic year — set at year-start by accrual run, may be topped up if accrual_rate changes mid-year.';
COMMENT ON COLUMN hr_leave_balances.used IS 'Days consumed by APPROVED requests.';
COMMENT ON COLUMN hr_leave_balances.pending IS 'Days held by PENDING requests — decremented on approve/reject/cancel.';
CREATE TABLE IF NOT EXISTS hr_leave_requests (
    id UUID PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    leave_type_id UUID NOT NULL REFERENCES hr_leave_types(id),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    days_requested NUMERIC(4,1) NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    reason TEXT,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at TIMESTAMPTZ,
    reviewed_by UUID,
    review_notes TEXT,
    cancelled_at TIMESTAMPTZ,
    is_hr_initiated BOOLEAN NOT NULL DEFAULT false,
    hr_initiated_by UUID,
    hr_initiated_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_leave_requests_status_chk CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
    CONSTRAINT hr_leave_requests_dates_chk CHECK (end_date >= start_date),
    CONSTRAINT hr_leave_requests_days_chk CHECK (days_requested > 0),
    CONSTRAINT hr_leave_requests_hr_initiated_chk CHECK (
        (is_hr_initiated = false AND hr_initiated_by IS NULL AND hr_initiated_reason IS NULL)
        OR
        (is_hr_initiated = true AND hr_initiated_by IS NOT NULL AND hr_initiated_reason IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS hr_leave_requests_employee_status_idx ON hr_leave_requests(employee_id, status);
CREATE INDEX IF NOT EXISTS hr_leave_requests_status_dates_idx ON hr_leave_requests(status, start_date) WHERE status IN ('PENDING','APPROVED');
CREATE INDEX IF NOT EXISTS hr_leave_requests_type_idx ON hr_leave_requests(leave_type_id);
COMMENT ON COLUMN hr_leave_requests.reviewed_by IS 'Soft FK to platform.platform_users(id) — the admin who approved or rejected. Audit-only.';
COMMENT ON COLUMN hr_leave_requests.hr_initiated_by IS 'Soft FK to platform.platform_users(id). Set when an HR admin records a leave on behalf of the employee (e.g. mandatory training day).';
