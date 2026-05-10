/* 123_pay_financial_aid
 *
 * Phase 2 Cycle 6 (P2-6) Step 1 — Financial Aid.
 *
 * Plan reference — docs/campusos-p2c6-payments-advanced.html Step 1.
 *
 * 3 new tables for the M84 .1 financial aid surface that Cycle 6
 * deferred:
 *
 *   pay_financial_aid_programs      — per-school programme catalogue.
 *                                     A programme has an optional total
 *                                     fund cap, with fund_remaining
 *                                     materialised as total minus the
 *                                     SUM of active awards. Null
 *                                     total_fund_amount means uncapped.
 *                                     reduction_type is PERCENTAGE or
 *                                     FIXED_AMOUNT and reduction_value
 *                                     is interpreted by the read side.
 *   pay_financial_aid_awards        — one row per (student, programme,
 *                                     academic_year). UNIQUE on the
 *                                     triple so a student cannot hold
 *                                     two awards from the same
 *                                     programme in the same year.
 *                                     award_amount is the fixed dollar
 *                                     decrement against the parent
 *                                     programme fund pool. The
 *                                     FinancialAidService is the sole
 *                                     writer and the decrement is
 *                                     atomic with the INSERT inside one
 *                                     locked tenant tx.
 *   pay_financial_aid_applications  — parent application surface.
 *                                     household_income_band is the
 *                                     coarse 5-bucket need indicator
 *                                     BAND_A through BAND_E. The
 *                                     supporting_documents JSONB array
 *                                     references signed S3 keys
 *                                     uploaded via the signed URL
 *                                     pattern from Cycle 4. status
 *                                     follows DRAFT until SUBMITTED
 *                                     until UNDER_REVIEW until APPROVED
 *                                     or REJECTED or WITHDRAWN.
 *                                     award_id is populated on APPROVED
 *                                     and points back at the row in
 *                                     pay_financial_aid_awards that the
 *                                     review created.
 *
 * Splitter rules — no semicolons inside any block comment header,
 * single-quoted string, or COMMENT ON ... text. Use commas, em
 * dashes, or "and" in narrative text instead.
 */

CREATE TABLE IF NOT EXISTS pay_financial_aid_programs (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    reduction_type TEXT NOT NULL,
    reduction_value NUMERIC(8,2) NOT NULL,
    total_fund_amount NUMERIC(12,2),
    fund_remaining NUMERIC(12,2),
    academic_year_id UUID REFERENCES sis_academic_years(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_fin_aid_programs_school_name_uq UNIQUE (school_id, name),
    CONSTRAINT pay_fin_aid_programs_reduction_type_chk
      CHECK (reduction_type IN ('PERCENTAGE', 'FIXED_AMOUNT')),
    CONSTRAINT pay_fin_aid_programs_reduction_value_chk
      CHECK (reduction_value > 0),
    CONSTRAINT pay_fin_aid_programs_fund_chk
      CHECK (
        (total_fund_amount IS NULL AND fund_remaining IS NULL)
        OR (total_fund_amount IS NOT NULL AND fund_remaining IS NOT NULL
            AND fund_remaining >= 0 AND fund_remaining <= total_fund_amount)
      )
);

CREATE INDEX IF NOT EXISTS pay_fin_aid_programs_school_idx
  ON pay_financial_aid_programs(school_id) WHERE is_active = true;

COMMENT ON COLUMN pay_financial_aid_programs.reduction_type IS
  'PERCENTAGE means reduction_value is a percentage of the invoice total. FIXED_AMOUNT means reduction_value is a flat dollar amount applied as a credit.';

COMMENT ON COLUMN pay_financial_aid_programs.fund_remaining IS
  'Materialised running balance. Decremented atomically by FinancialAidService.approveApplication inside a locked tenant tx so the fund pool cannot oversell.';

COMMENT ON COLUMN pay_financial_aid_programs.academic_year_id IS
  'Optional FK to sis_academic_years(id). When set the programme is scoped to that year. SET NULL on year removal so the historical programme survives.';

CREATE TABLE IF NOT EXISTS pay_financial_aid_awards (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    student_id UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
    program_id UUID NOT NULL REFERENCES pay_financial_aid_programs(id),
    academic_year_id UUID NOT NULL REFERENCES sis_academic_years(id),
    award_amount NUMERIC(10,2) NOT NULL,
    approved_by UUID NOT NULL,
    effective_from DATE NOT NULL,
    effective_to DATE,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_fin_aid_awards_student_program_year_uq
      UNIQUE (student_id, program_id, academic_year_id),
    CONSTRAINT pay_fin_aid_awards_amount_chk CHECK (award_amount > 0),
    CONSTRAINT pay_fin_aid_awards_status_chk
      CHECK (status IN ('ACTIVE', 'EXPIRED', 'REVOKED')),
    CONSTRAINT pay_fin_aid_awards_dates_chk
      CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS pay_fin_aid_awards_student_idx
  ON pay_financial_aid_awards(student_id, academic_year_id) WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS pay_fin_aid_awards_program_idx
  ON pay_financial_aid_awards(program_id) WHERE status = 'ACTIVE';

COMMENT ON COLUMN pay_financial_aid_awards.approved_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020 — the finance admin who approved the award. Authorisation is a precondition of INSERT.';

COMMENT ON COLUMN pay_financial_aid_awards.award_amount IS
  'Fixed dollar amount of the aid for the academic year. Decrements pay_financial_aid_programs.fund_remaining atomically inside the same tenant tx that issues the award.';

CREATE TABLE IF NOT EXISTS pay_financial_aid_applications (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    student_id UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
    program_id UUID NOT NULL REFERENCES pay_financial_aid_programs(id),
    guardian_id UUID NOT NULL REFERENCES sis_guardians(id),
    academic_year_id UUID NOT NULL REFERENCES sis_academic_years(id),
    household_income_band TEXT,
    supporting_documents JSONB NOT NULL DEFAULT '[]'::jsonb,
    application_statement TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    submitted_at TIMESTAMPTZ,
    reviewed_by UUID,
    reviewed_at TIMESTAMPTZ,
    reviewer_notes TEXT,
    award_id UUID REFERENCES pay_financial_aid_awards(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_fin_aid_apps_status_chk
      CHECK (status IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
    CONSTRAINT pay_fin_aid_apps_band_chk
      CHECK (household_income_band IS NULL OR household_income_band IN ('BAND_A','BAND_B','BAND_C','BAND_D','BAND_E')),
    CONSTRAINT pay_fin_aid_apps_submitted_chk
      CHECK (
        (status = 'DRAFT' AND submitted_at IS NULL)
        OR (status <> 'DRAFT' AND submitted_at IS NOT NULL)
      ),
    CONSTRAINT pay_fin_aid_apps_reviewed_chk
      CHECK (
        (status IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'WITHDRAWN')
          AND reviewed_at IS NULL AND reviewed_by IS NULL)
        OR (status IN ('APPROVED', 'REJECTED')
          AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
      ),
    CONSTRAINT pay_fin_aid_apps_award_chk
      CHECK (
        (status = 'APPROVED' AND award_id IS NOT NULL)
        OR (status <> 'APPROVED')
      )
);

CREATE INDEX IF NOT EXISTS pay_fin_aid_apps_school_year_status_idx
  ON pay_financial_aid_applications(school_id, academic_year_id, status);

CREATE INDEX IF NOT EXISTS pay_fin_aid_apps_guardian_idx
  ON pay_financial_aid_applications(guardian_id);

CREATE INDEX IF NOT EXISTS pay_fin_aid_apps_student_idx
  ON pay_financial_aid_applications(student_id);

COMMENT ON COLUMN pay_financial_aid_applications.supporting_documents IS
  'JSONB array of objects with shape s3Key string and label string. Files uploaded via the signed-S3-URL pattern from Cycle 4 hr_employee_documents.';

COMMENT ON COLUMN pay_financial_aid_applications.reviewed_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020 — the finance admin who reviewed the application. Populated together with reviewed_at on APPROVED or REJECTED transitions, enforced by the multi-column reviewed_chk lockstep.';

COMMENT ON COLUMN pay_financial_aid_applications.award_id IS
  'Populated on APPROVED status. Links back to the pay_financial_aid_awards row that the approval created. SET NULL on award removal so the audit trail of the application survives.';
