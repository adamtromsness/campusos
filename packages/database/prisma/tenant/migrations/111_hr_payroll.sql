/* P2C4 sub-cycle a — Payroll domain (M80 .1).

   9 new logical base tables under the hr_ prefix from Cycle 4 — the
   plan called for 10 but hr_employee_documents already shipped in
   Cycle 4 migration 011 with a richer document_type_id +
   hr_document_types catalogue model than the 8-value CHECK column
   the plan describes. The existing table covers the same intent
   (signed-S3-URL pattern, expiry tracking, audit on uploaded_by) so
   re-creating it under a different shape would only fragment the
   employee-document surface. Documented in HANDOFF-P2C4.md.

   Migration number: plan said 102 but slot taken by Cycle 6 visitor
   management. Used 111 — same pattern as P2C3 109. Not splitter-trap
   compatible if the block-comment header carries a stray semicolon
   mid-sentence — audit clean before first provision. */

/* 1. hr_pay_grades — per-school catalogue of pay grades (band labels) */
CREATE TABLE IF NOT EXISTS hr_pay_grades (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    grade_name TEXT NOT NULL,
    description TEXT,
    min_salary NUMERIC(10,2),
    max_salary NUMERIC(10,2),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_pay_grades_school_name_uq UNIQUE (school_id, grade_name),
    CONSTRAINT hr_pay_grades_salary_chk
      CHECK (
        (min_salary IS NULL AND max_salary IS NULL)
        OR
        (min_salary IS NOT NULL AND max_salary IS NOT NULL AND min_salary >= 0 AND max_salary >= min_salary)
      )
);
CREATE INDEX IF NOT EXISTS hr_pay_grades_school_active_idx
  ON hr_pay_grades(school_id) WHERE is_active = true;

/* 2. hr_salary_scales — step-based salary progression within a grade */
CREATE TABLE IF NOT EXISTS hr_salary_scales (
    id UUID PRIMARY KEY,
    pay_grade_id UUID NOT NULL REFERENCES hr_pay_grades(id) ON DELETE CASCADE,
    step INT NOT NULL,
    annual_salary NUMERIC(10,2) NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_salary_scales_grade_step_uq UNIQUE (pay_grade_id, step),
    CONSTRAINT hr_salary_scales_step_chk CHECK (step > 0),
    CONSTRAINT hr_salary_scales_amount_chk CHECK (annual_salary >= 0)
);

/* 3. hr_pay_periods — bi-weekly / monthly payroll cycles */
CREATE TABLE IF NOT EXISTS hr_pay_periods (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    period_label TEXT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    pay_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    processed_at TIMESTAMPTZ,
    processed_by UUID,
    paid_at TIMESTAMPTZ,
    paid_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_pay_periods_school_start_uq UNIQUE (school_id, start_date),
    CONSTRAINT hr_pay_periods_status_chk
      CHECK (status IN ('OPEN', 'PROCESSING', 'PAID', 'CLOSED')),
    CONSTRAINT hr_pay_periods_dates_chk CHECK (end_date >= start_date),
    CONSTRAINT hr_pay_periods_pay_date_chk CHECK (pay_date >= start_date)
);
CREATE INDEX IF NOT EXISTS hr_pay_periods_school_status_idx
  ON hr_pay_periods(school_id, status);

/* 4. hr_payroll_records — per-(employee, period) computed payslip header */
CREATE TABLE IF NOT EXISTS hr_payroll_records (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    pay_period_id UUID NOT NULL REFERENCES hr_pay_periods(id) ON DELETE CASCADE,
    salary_scale_id UUID REFERENCES hr_salary_scales(id) ON DELETE SET NULL,
    gross_pay NUMERIC(10,2) NOT NULL,
    total_deductions NUMERIC(10,2) NOT NULL DEFAULT 0,
    total_adjustments NUMERIC(10,2) NOT NULL DEFAULT 0,
    net_pay NUMERIC(10,2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_payroll_records_employee_period_uq UNIQUE (employee_id, pay_period_id),
    CONSTRAINT hr_payroll_records_status_chk
      CHECK (status IN ('DRAFT', 'APPROVED', 'PAID')),
    CONSTRAINT hr_payroll_records_amounts_chk
      CHECK (
        gross_pay >= 0
        AND total_deductions >= 0
        AND net_pay >= 0
      )
);
CREATE INDEX IF NOT EXISTS hr_payroll_records_period_status_idx
  ON hr_payroll_records(pay_period_id, status);
CREATE INDEX IF NOT EXISTS hr_payroll_records_employee_idx
  ON hr_payroll_records(employee_id, pay_period_id);

/* 5. hr_payroll_deductions — per-payroll-record line items */
CREATE TABLE IF NOT EXISTS hr_payroll_deductions (
    id UUID PRIMARY KEY,
    payroll_record_id UUID NOT NULL REFERENCES hr_payroll_records(id) ON DELETE CASCADE,
    deduction_type TEXT NOT NULL,
    description TEXT,
    amount NUMERIC(10,2) NOT NULL,
    is_pretax BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_payroll_deductions_type_chk
      CHECK (deduction_type IN (
        'FEDERAL_TAX',
        'STATE_TAX',
        'SOCIAL_SECURITY',
        'MEDICARE',
        'HEALTH_INSURANCE',
        'RETIREMENT',
        'OTHER'
      )),
    CONSTRAINT hr_payroll_deductions_amount_chk CHECK (amount >= 0)
);
CREATE INDEX IF NOT EXISTS hr_payroll_deductions_record_idx
  ON hr_payroll_deductions(payroll_record_id);

/* 6. hr_payroll_adjustments — bonuses, retroactive pay, overpayment recovery */
CREATE TABLE IF NOT EXISTS hr_payroll_adjustments (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    effective_pay_period_id UUID REFERENCES hr_pay_periods(id) ON DELETE SET NULL,
    adjustment_type TEXT NOT NULL,
    amount NUMERIC(10,2) NOT NULL,
    reason TEXT NOT NULL,
    requested_by UUID,
    approved_by UUID,
    approved_at TIMESTAMPTZ,
    applied_to_record_id UUID REFERENCES hr_payroll_records(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_payroll_adjustments_type_chk
      CHECK (adjustment_type IN (
        'RETROACTIVE_PAY',
        'BONUS',
        'BACK_PAY',
        'OVERPAYMENT_RECOVERY',
        'SIGNING_BONUS',
        'SEVERANCE',
        'OTHER'
      )),
    CONSTRAINT hr_payroll_adjustments_status_chk
      CHECK (status IN ('PENDING', 'APPROVED', 'APPLIED', 'REJECTED')),
    CONSTRAINT hr_payroll_adjustments_approved_chk
      CHECK (
        (status IN ('PENDING', 'REJECTED') AND approved_by IS NULL AND approved_at IS NULL)
        OR
        (status IN ('APPROVED', 'APPLIED') AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
      )
);
CREATE INDEX IF NOT EXISTS hr_payroll_adjustments_employee_idx
  ON hr_payroll_adjustments(employee_id, effective_pay_period_id);
CREATE INDEX IF NOT EXISTS hr_payroll_adjustments_status_idx
  ON hr_payroll_adjustments(school_id, status);

/* 7. hr_salary_review_requests — DH-initiated salary review routed via wsk */
CREATE TABLE IF NOT EXISTS hr_salary_review_requests (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    requested_by UUID NOT NULL,
    review_type TEXT NOT NULL,
    current_salary NUMERIC(10,2),
    recommended_salary NUMERIC(10,2),
    effective_date DATE,
    justification TEXT NOT NULL,
    linked_approval_id UUID,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    decision_notes TEXT,
    decided_by UUID,
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_salary_review_type_chk
      CHECK (review_type IN (
        'ANNUAL_INCREMENT',
        'PROMOTION',
        'MARKET_ADJUSTMENT',
        'PERFORMANCE_BONUS',
        'RETENTION'
      )),
    CONSTRAINT hr_salary_review_status_chk
      CHECK (status IN (
        'DRAFT',
        'SUBMITTED',
        'UNDER_REVIEW',
        'APPROVED',
        'REJECTED',
        'WITHDRAWN'
      )),
    CONSTRAINT hr_salary_review_decided_chk
      CHECK (
        (status IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'WITHDRAWN') AND decided_by IS NULL AND decided_at IS NULL)
        OR
        (status IN ('APPROVED', 'REJECTED') AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
      ),
    CONSTRAINT hr_salary_review_amounts_chk
      CHECK (
        (current_salary IS NULL OR current_salary >= 0)
        AND (recommended_salary IS NULL OR recommended_salary >= 0)
      )
);
CREATE INDEX IF NOT EXISTS hr_salary_review_school_status_idx
  ON hr_salary_review_requests(school_id, status);
CREATE INDEX IF NOT EXISTS hr_salary_review_employee_idx
  ON hr_salary_review_requests(employee_id, created_at DESC);

/* 8. hr_employee_tax_info — withholding profile per employee (PII) */
CREATE TABLE IF NOT EXISTS hr_employee_tax_info (
    id UUID PRIMARY KEY,
    employee_id UUID NOT NULL UNIQUE REFERENCES hr_employees(id) ON DELETE CASCADE,
    filing_status TEXT,
    federal_allowances INT NOT NULL DEFAULT 0,
    state_allowances INT NOT NULL DEFAULT 0,
    additional_withholding NUMERIC(10,2) NOT NULL DEFAULT 0,
    state_code TEXT,
    notes TEXT,
    updated_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_employee_tax_info_filing_chk
      CHECK (
        filing_status IS NULL
        OR filing_status IN ('SINGLE', 'MARRIED_JOINT', 'MARRIED_SEPARATE', 'HEAD_OF_HOUSEHOLD')
      ),
    CONSTRAINT hr_employee_tax_info_allowances_chk
      CHECK (federal_allowances >= 0 AND state_allowances >= 0 AND additional_withholding >= 0)
);

/* 9. hr_employee_benefits — per-employee benefit enrolment with effective dates */
CREATE TABLE IF NOT EXISTS hr_employee_benefits (
    id UUID PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    benefit_type TEXT NOT NULL,
    plan_name TEXT,
    employee_contribution NUMERIC(10,2) NOT NULL DEFAULT 0,
    employer_contribution NUMERIC(10,2) NOT NULL DEFAULT 0,
    effective_from DATE NOT NULL,
    effective_to DATE,
    is_active BOOLEAN NOT NULL DEFAULT true,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_employee_benefits_type_chk
      CHECK (benefit_type IN ('HEALTH', 'DENTAL', 'VISION', 'LIFE', 'RETIREMENT')),
    CONSTRAINT hr_employee_benefits_amounts_chk
      CHECK (employee_contribution >= 0 AND employer_contribution >= 0),
    CONSTRAINT hr_employee_benefits_dates_chk
      CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS hr_employee_benefits_employee_type_idx
  ON hr_employee_benefits(employee_id, benefit_type);
CREATE INDEX IF NOT EXISTS hr_employee_benefits_active_idx
  ON hr_employee_benefits(employee_id) WHERE is_active = true;

COMMENT ON TABLE hr_pay_grades IS 'P2C4 — per-school pay-grade catalogue. Schools assign employees to a grade and each grade carries N salary scales (steps).';
COMMENT ON TABLE hr_salary_scales IS 'P2C4 — step-based salary progression within a grade. (pay_grade_id, step) UNIQUE so two rows cannot share the same step within a grade.';
COMMENT ON TABLE hr_pay_periods IS 'P2C4 — payroll cycles. status lifecycle OPEN to PROCESSING to PAID with optional CLOSED terminator.';
COMMENT ON TABLE hr_payroll_records IS 'P2C4 — per-(employee, period) computed payslip header. UNIQUE(employee_id, pay_period_id) so the worker is idempotent under retry.';
COMMENT ON TABLE hr_payroll_deductions IS 'P2C4 — per-payroll-record deduction line items. CASCADE on parent record.';
COMMENT ON TABLE hr_payroll_adjustments IS 'P2C4 — bonuses, retroactive pay, overpayment recovery. Multi-column approved_chk keeps approved_by + approved_at in lockstep with status.';
COMMENT ON TABLE hr_salary_review_requests IS 'P2C4 — DH-initiated salary review request, optionally linked to a wsk_approval_requests row via linked_approval_id (soft ref per ADR-001).';
COMMENT ON TABLE hr_employee_tax_info IS 'P2C4 — withholding profile per employee. UNIQUE(employee_id) so each employee carries at most one tax info row. PII — encryption at rest is a Phase 3 ops task and current dev mode stores plaintext.';
COMMENT ON TABLE hr_employee_benefits IS 'P2C4 — per-employee benefit enrolment with effective date range. Schools track employee + employer contributions separately for the GL split.';
