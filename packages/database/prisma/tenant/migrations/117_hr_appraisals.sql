/* 117_hr_appraisals
 *
 * Phase 2 Cycle 4 sub-cycle c (P2-4c) Step 9 — Appraisals + Lesson
 * Observations + Expense Claims.
 *
 * Plan reference — docs/campusos-p2c4-hr-advanced.html Step 9.
 * Adds 7 tables:
 *
 *   hr_appraisal_frameworks  — per-school rubric + competency JSONB.
 *   hr_appraisal_cycles      — annual / mid-year / probationary cycles
 *                              tied to an academic year + framework.
 *                              UNIQUE(school, year, type).
 *   hr_appraisals            — per-(cycle, employee) appraisal record.
 *                              Multi-column signed_off_chk lockstep —
 *                              the SIGNED_OFF terminal status requires
 *                              signed_off_at + signed_off_by populated
 *                              and is immutable thereafter (service-side
 *                              discipline, no DB trigger).
 *   hr_appraisal_goals       — SMART goals attached to an appraisal.
 *   hr_lesson_observations   — sensitive classroom observation records
 *                              (classes, grades, narrative). Service
 *                              gates writes on a NEW non-XXX-NNN
 *                              permission code lesson_observation:write
 *                              analogous to P2C3 student_counseling_record
 *                              — only Principal + dept-head equivalents.
 *   hr_appraisal_comments    — threaded review comments. The
 *                              is_visible_to_employee flag splits
 *                              private (between observers/HR) from
 *                              shared (employee can read).
 *   hr_expense_claims        — PD reimbursement requests. Multi-column
 *                              decided_chk lockstep on approved_by +
 *                              approved_at.
 *
 * Splitter rules — no semicolons inside any block-comment header,
 * single-quoted string, or COMMENT ON ... text.
 */

CREATE TABLE IF NOT EXISTS hr_appraisal_frameworks (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_appraisal_frameworks_school_name_uq UNIQUE (school_id, name)
);

CREATE INDEX IF NOT EXISTS hr_appraisal_frameworks_school_idx
  ON hr_appraisal_frameworks(school_id, is_active);

CREATE TABLE IF NOT EXISTS hr_appraisal_cycles (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    academic_year_id UUID NOT NULL REFERENCES sis_academic_years(id) ON DELETE NO ACTION,
    framework_id UUID NOT NULL REFERENCES hr_appraisal_frameworks(id) ON DELETE NO ACTION,
    cycle_type TEXT NOT NULL,
    name TEXT NOT NULL,
    starts_on DATE NOT NULL,
    ends_on DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_appraisal_cycles_type_chk
      CHECK (cycle_type IN ('ANNUAL', 'MID_YEAR', 'PROBATIONARY')),
    CONSTRAINT hr_appraisal_cycles_status_chk
      CHECK (status IN ('OPEN', 'CLOSED', 'ARCHIVED')),
    CONSTRAINT hr_appraisal_cycles_dates_chk
      CHECK (ends_on >= starts_on),
    CONSTRAINT hr_appraisal_cycles_school_year_type_uq
      UNIQUE (school_id, academic_year_id, cycle_type),
    CONSTRAINT hr_appraisal_cycles_closed_chk
      CHECK (
        (status IN ('CLOSED', 'ARCHIVED') AND closed_at IS NOT NULL)
        OR (status = 'OPEN' AND closed_at IS NULL)
      )
);

CREATE INDEX IF NOT EXISTS hr_appraisal_cycles_school_status_idx
  ON hr_appraisal_cycles(school_id, status);

CREATE TABLE IF NOT EXISTS hr_appraisals (
    id UUID PRIMARY KEY,
    cycle_id UUID NOT NULL REFERENCES hr_appraisal_cycles(id) ON DELETE NO ACTION,
    employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    appraiser_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
    school_id UUID NOT NULL,
    overall_rating TEXT,
    self_review TEXT,
    appraiser_review TEXT,
    development_plan TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    signed_off_at TIMESTAMPTZ,
    signed_off_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
    linked_approval_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_appraisals_rating_chk
      CHECK (
        overall_rating IS NULL
        OR overall_rating IN ('OUTSTANDING', 'GOOD', 'REQUIRES_IMPROVEMENT', 'INADEQUATE')
      ),
    CONSTRAINT hr_appraisals_status_chk
      CHECK (status IN ('DRAFT', 'IN_REVIEW', 'SIGNED_OFF')),
    CONSTRAINT hr_appraisals_cycle_employee_uq UNIQUE (cycle_id, employee_id),
    CONSTRAINT hr_appraisals_signed_off_chk
      CHECK (
        (status = 'SIGNED_OFF' AND signed_off_at IS NOT NULL AND signed_off_by IS NOT NULL)
        OR (status <> 'SIGNED_OFF' AND signed_off_at IS NULL AND signed_off_by IS NULL)
      )
);

CREATE INDEX IF NOT EXISTS hr_appraisals_employee_idx ON hr_appraisals(employee_id, cycle_id);
CREATE INDEX IF NOT EXISTS hr_appraisals_appraiser_idx
  ON hr_appraisals(appraiser_id) WHERE appraiser_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hr_appraisals_school_status_idx
  ON hr_appraisals(school_id, status);

CREATE TABLE IF NOT EXISTS hr_appraisal_goals (
    id UUID PRIMARY KEY,
    appraisal_id UUID NOT NULL REFERENCES hr_appraisals(id) ON DELETE CASCADE,
    goal_text TEXT NOT NULL,
    success_criteria TEXT,
    target_date DATE,
    progress TEXT NOT NULL DEFAULT 'NOT_STARTED',
    progress_notes TEXT,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_appraisal_goals_progress_chk
      CHECK (progress IN ('NOT_STARTED', 'IN_PROGRESS', 'ACHIEVED', 'NOT_ACHIEVED'))
);

CREATE INDEX IF NOT EXISTS hr_appraisal_goals_appraisal_idx
  ON hr_appraisal_goals(appraisal_id, sort_order);

CREATE TABLE IF NOT EXISTS hr_lesson_observations (
    id UUID PRIMARY KEY,
    appraisal_id UUID REFERENCES hr_appraisals(id) ON DELETE SET NULL,
    school_id UUID NOT NULL,
    observer_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE NO ACTION,
    observed_employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    observation_date DATE NOT NULL,
    observed_class_label TEXT NOT NULL,
    observed_class_id UUID,
    duration_minutes INT,
    overall_grade TEXT,
    strengths TEXT,
    areas_for_development TEXT,
    notes TEXT,
    is_locked BOOLEAN NOT NULL DEFAULT false,
    locked_at TIMESTAMPTZ,
    locked_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_lesson_observations_grade_chk
      CHECK (
        overall_grade IS NULL
        OR overall_grade IN ('OUTSTANDING', 'GOOD', 'REQUIRES_IMPROVEMENT', 'INADEQUATE')
      ),
    CONSTRAINT hr_lesson_observations_duration_chk
      CHECK (duration_minutes IS NULL OR duration_minutes > 0),
    CONSTRAINT hr_lesson_observations_locked_chk
      CHECK (
        (is_locked = true AND locked_at IS NOT NULL AND locked_by IS NOT NULL)
        OR (is_locked = false AND locked_at IS NULL AND locked_by IS NULL)
      )
);

CREATE INDEX IF NOT EXISTS hr_lesson_observations_observed_idx
  ON hr_lesson_observations(observed_employee_id, observation_date DESC);
CREATE INDEX IF NOT EXISTS hr_lesson_observations_observer_idx
  ON hr_lesson_observations(observer_id, observation_date DESC);
CREATE INDEX IF NOT EXISTS hr_lesson_observations_appraisal_idx
  ON hr_lesson_observations(appraisal_id) WHERE appraisal_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS hr_appraisal_comments (
    id UUID PRIMARY KEY,
    appraisal_id UUID NOT NULL REFERENCES hr_appraisals(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE NO ACTION,
    comment_text TEXT NOT NULL,
    is_visible_to_employee BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hr_appraisal_comments_appraisal_idx
  ON hr_appraisal_comments(appraisal_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hr_expense_claims (
    id UUID PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    school_id UUID NOT NULL,
    claim_title TEXT NOT NULL,
    description TEXT,
    incurred_on DATE NOT NULL,
    total_amount NUMERIC(10,2) NOT NULL,
    receipt_s3_keys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    status TEXT NOT NULL DEFAULT 'SUBMITTED',
    approved_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    rejection_reason TEXT,
    paid_at TIMESTAMPTZ,
    linked_approval_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_expense_claims_status_chk
      CHECK (status IN ('SUBMITTED', 'APPROVED', 'REJECTED', 'PAID')),
    CONSTRAINT hr_expense_claims_amount_chk CHECK (total_amount > 0),
    CONSTRAINT hr_expense_claims_decided_chk
      CHECK (
        (status IN ('APPROVED', 'PAID') AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
        OR (status = 'REJECTED' AND approved_by IS NOT NULL AND approved_at IS NOT NULL
            AND rejection_reason IS NOT NULL AND length(trim(rejection_reason)) > 0)
        OR (status = 'SUBMITTED' AND approved_by IS NULL AND approved_at IS NULL
            AND rejection_reason IS NULL)
      ),
    CONSTRAINT hr_expense_claims_paid_chk
      CHECK (
        (status = 'PAID' AND paid_at IS NOT NULL)
        OR (status <> 'PAID' AND paid_at IS NULL)
      )
);

CREATE INDEX IF NOT EXISTS hr_expense_claims_employee_idx
  ON hr_expense_claims(employee_id, status);
CREATE INDEX IF NOT EXISTS hr_expense_claims_school_status_idx
  ON hr_expense_claims(school_id, status);

COMMENT ON TABLE hr_appraisals IS
  'P2-4c — per-(cycle, employee) appraisal record. SIGNED_OFF is terminal — service refuses any update once status reaches SIGNED_OFF (immutable, mirrors P2C3 telehealth COMPLETED + Cycle 11 svc_session_notes locked). signed_off_chk multi-column lockstep enforces the at + by columns at the schema layer.';

COMMENT ON TABLE hr_lesson_observations IS
  'P2-4c — sensitive classroom observation records. Writes gated on a new non-XXX-NNN permission code lesson_observation:write granted only to School Admin / Platform Admin via everyFunction (analogous to P2C3 student_counseling_record:read). is_locked is service-side only — once locked, the observation is immutable and the staff member cannot edit further. observed_class_id is a soft ref to sis_classes per ADR-001/020.';

COMMENT ON TABLE hr_expense_claims IS
  'P2-4c — PD reimbursement requests. linked_approval_id is a soft FK to wsk_approval_requests (Cycle 7 workflow engine) for future workflow integration. decided_chk multi-column lockstep enforces approver fields populated on every terminal status, and rejection_reason populated on REJECTED.';
