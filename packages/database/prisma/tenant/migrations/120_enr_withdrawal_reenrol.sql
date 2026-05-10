/* 120_enr_withdrawal_reenrol
 *
 * Phase 2 Cycle 5 (P2-5) Step 2 — Withdrawal + Re-enrolment + Mid-Year Admission.
 *
 * Plan reference — docs/campusos-p2c5-enrolment-advanced.html Step 2.
 *
 * 4 tables completing the M81 enrolment lifecycle bookends the Cycle 16
 * pipeline did not cover:
 *
 *   enr_withdrawal_requests           — head row of a formal student
 *                                       withdrawal. 4-value status CHECK
 *                                       drives the WithdrawalService
 *                                       state machine. Multi-column
 *                                       completed_chk lockstep keeps
 *                                       (status, completed_at, completed_by)
 *                                       in sync. hold_chk pins
 *                                       re_enrollment_hold_reason when
 *                                       re_enrollment_hold_placed is
 *                                       true so an admin who blocks
 *                                       a student from re-applying
 *                                       must justify the block.
 *   enr_withdrawal_exit_tasks         — auto-created exit checklist
 *                                       per the configurable template.
 *                                       6-value task_category CHECK
 *                                       routes a task to the matching
 *                                       department staff. 4-value
 *                                       status CHECK plus multi-column
 *                                       completed_chk keeps the COMPLETED
 *                                       and WAIVED audit fields populated
 *                                       atomically. Withdrawal cannot
 *                                       transition to COMPLETED until
 *                                       every task is COMPLETED, WAIVED,
 *                                       or NOT_APPLICABLE.
 *   enr_reenrollment_confirmations    — per-(student, academic_year)
 *                                       returning-family confirmation.
 *                                       UNIQUE(student_id, academic_year_id)
 *                                       caps at one row per student per
 *                                       year. reason_chk enforces a
 *                                       non-empty withdrawal_reason
 *                                       when confirmed_continuing is
 *                                       false so the auto-initiated
 *                                       withdrawal carries the family
 *                                       narrative through.
 *   enr_mid_year_admission_requests   — out-of-cycle admission request
 *                                       outside an open enrolment period.
 *                                       6-value admission_reason CHECK,
 *                                       6-value status CHECK,
 *                                       linked_application_id soft FK
 *                                       to enr_applications closes the
 *                                       loop when the EO promotes the
 *                                       request into the Cycle 16 pipeline.
 *
 * Splitter rules — no semicolons inside any block comment header,
 * single-quoted string, or COMMENT ON ... text. Use commas, em
 * dashes, or "and" in narrative text instead.
 */

CREATE TABLE IF NOT EXISTS enr_withdrawal_requests (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    student_id UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
    initiated_by TEXT NOT NULL,
    requested_by UUID NOT NULL,
    withdrawal_reason_category TEXT NOT NULL,
    withdrawal_reason_detail TEXT,
    last_attendance_date DATE NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    destination_school_name TEXT,
    destination_school_country TEXT,
    records_release_consented BOOLEAN NOT NULL DEFAULT false,
    records_sent_at DATE,
    status TEXT NOT NULL DEFAULT 'REQUESTED',
    completed_at TIMESTAMPTZ,
    completed_by UUID,
    re_enrollment_hold_placed BOOLEAN NOT NULL DEFAULT false,
    re_enrollment_hold_reason TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT enr_wr_initiated_chk
      CHECK (initiated_by IN ('FAMILY', 'SCHOOL')),
    CONSTRAINT enr_wr_reason_chk
      CHECK (withdrawal_reason_category IN (
        'FAMILY_RELOCATION',
        'TRANSFER_TO_OTHER_SCHOOL',
        'HOME_EDUCATION',
        'EXCLUSION',
        'MEDICAL',
        'FEE_DEFAULT',
        'SAFEGUARDING',
        'GRADUATION',
        'DECEASED',
        'OTHER'
      )),
    CONSTRAINT enr_wr_status_chk
      CHECK (status IN ('REQUESTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
    CONSTRAINT enr_wr_completed_chk
      CHECK (
        (status = 'COMPLETED'
          AND completed_at IS NOT NULL
          AND completed_by IS NOT NULL)
        OR (status <> 'COMPLETED'
          AND completed_at IS NULL
          AND completed_by IS NULL)
      ),
    CONSTRAINT enr_wr_hold_chk
      CHECK (
        (re_enrollment_hold_placed = true
          AND re_enrollment_hold_reason IS NOT NULL
          AND length(trim(re_enrollment_hold_reason)) > 0)
        OR (re_enrollment_hold_placed = false
          AND re_enrollment_hold_reason IS NULL)
      )
);

CREATE INDEX IF NOT EXISTS enr_wr_school_status_idx
  ON enr_withdrawal_requests(school_id, status);

CREATE INDEX IF NOT EXISTS enr_wr_student_idx
  ON enr_withdrawal_requests(student_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS enr_wr_hold_idx
  ON enr_withdrawal_requests(student_id)
  WHERE re_enrollment_hold_placed = true;

COMMENT ON COLUMN enr_withdrawal_requests.requested_by IS
  'Tenant-local soft reference to platform.iam_person(id) per ADR-001/020. Either the family member who initiated the withdrawal or the school admin acting on the family.';

COMMENT ON COLUMN enr_withdrawal_requests.completed_by IS
  'Tenant-local soft reference to platform.iam_person(id) per ADR-001/020. The admin who completed the workflow once every exit task is COMPLETED, WAIVED, or NOT_APPLICABLE.';

COMMENT ON COLUMN enr_withdrawal_requests.re_enrollment_hold_placed IS
  'When true the family is blocked from submitting a re-enrolment confirmation or new application for this student. The hold_chk constraint requires re_enrollment_hold_reason populated.';

CREATE TABLE IF NOT EXISTS enr_withdrawal_exit_tasks (
    id UUID PRIMARY KEY,
    withdrawal_id UUID NOT NULL REFERENCES enr_withdrawal_requests(id) ON DELETE CASCADE,
    task_name TEXT NOT NULL,
    task_category TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    completed_by UUID,
    completed_at TIMESTAMPTZ,
    notes TEXT,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT enr_wet_category_chk
      CHECK (task_category IN (
        'ADMINISTRATIVE',
        'FINANCE',
        'IT',
        'FACILITIES',
        'TRANSPORT',
        'RECORDS'
      )),
    CONSTRAINT enr_wet_status_chk
      CHECK (status IN ('PENDING', 'COMPLETED', 'WAIVED', 'NOT_APPLICABLE')),
    CONSTRAINT enr_wet_completed_chk
      CHECK (
        (status IN ('COMPLETED', 'WAIVED')
          AND completed_at IS NOT NULL
          AND completed_by IS NOT NULL)
        OR (status IN ('PENDING', 'NOT_APPLICABLE')
          AND completed_at IS NULL
          AND completed_by IS NULL)
      )
);

CREATE INDEX IF NOT EXISTS enr_wet_withdrawal_idx
  ON enr_withdrawal_exit_tasks(withdrawal_id, sort_order);

CREATE INDEX IF NOT EXISTS enr_wet_pending_idx
  ON enr_withdrawal_exit_tasks(withdrawal_id)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS enr_wet_category_idx
  ON enr_withdrawal_exit_tasks(task_category, status);

COMMENT ON COLUMN enr_withdrawal_exit_tasks.completed_by IS
  'Tenant-local soft reference to platform.iam_person(id) per ADR-001/020. The department staff member who closed the task. NULL while status remains PENDING or NOT_APPLICABLE.';

CREATE TABLE IF NOT EXISTS enr_reenrollment_confirmations (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    student_id UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
    academic_year_id UUID NOT NULL REFERENCES sis_academic_years(id) ON DELETE RESTRICT,
    submitted_by UUID NOT NULL,
    confirmed_continuing BOOLEAN NOT NULL,
    withdrawal_reason TEXT,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_by UUID,
    processed_at TIMESTAMPTZ,
    linked_withdrawal_id UUID REFERENCES enr_withdrawal_requests(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT enr_reenrol_student_year_uq UNIQUE (student_id, academic_year_id),
    CONSTRAINT enr_reenrol_reason_chk
      CHECK (
        (confirmed_continuing = true AND withdrawal_reason IS NULL)
        OR (confirmed_continuing = false
          AND withdrawal_reason IS NOT NULL
          AND length(trim(withdrawal_reason)) > 0)
      ),
    CONSTRAINT enr_reenrol_processed_chk
      CHECK (
        (processed_at IS NULL AND processed_by IS NULL)
        OR (processed_at IS NOT NULL AND processed_by IS NOT NULL)
      )
);

CREATE INDEX IF NOT EXISTS enr_reenrol_school_year_idx
  ON enr_reenrollment_confirmations(school_id, academic_year_id, confirmed_continuing);

CREATE INDEX IF NOT EXISTS enr_reenrol_continuing_idx
  ON enr_reenrollment_confirmations(school_id, academic_year_id)
  WHERE confirmed_continuing = false AND processed_at IS NULL;

COMMENT ON COLUMN enr_reenrollment_confirmations.submitted_by IS
  'Tenant-local soft reference to platform.iam_person(id) per ADR-001/020. The guardian who submitted the confirmation.';

COMMENT ON COLUMN enr_reenrollment_confirmations.linked_withdrawal_id IS
  'Set by the ReenrolmentService when confirmed_continuing is false and the auto-initiated withdrawal lands inside the same tx. SET NULL on withdrawal removal so the historical confirmation survives.';

CREATE TABLE IF NOT EXISTS enr_mid_year_admission_requests (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    requested_by UUID NOT NULL,
    student_first_name TEXT NOT NULL,
    student_last_name TEXT NOT NULL,
    student_date_of_birth DATE NOT NULL,
    applying_for_grade_level TEXT NOT NULL,
    requested_start_date DATE NOT NULL,
    admission_reason TEXT NOT NULL,
    admission_reason_detail TEXT,
    previous_school_name TEXT,
    previous_school_country TEXT,
    records_requested BOOLEAN NOT NULL DEFAULT false,
    status TEXT NOT NULL DEFAULT 'RECEIVED',
    capacity_available BOOLEAN,
    capacity_checked_at TIMESTAMPTZ,
    capacity_checked_by UUID,
    linked_application_id UUID REFERENCES enr_applications(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT enr_myar_reason_chk
      CHECK (admission_reason IN (
        'FAMILY_RELOCATION',
        'TRANSFER_FROM_OTHER_SCHOOL',
        'RETURNING_FROM_ABROAD',
        'HOME_EDUCATION_ENDING',
        'LOOKED_AFTER_CHILD',
        'OTHER'
      )),
    CONSTRAINT enr_myar_status_chk
      CHECK (status IN (
        'RECEIVED',
        'CAPACITY_CHECKED',
        'OFFER_MADE',
        'ENROLLED',
        'DECLINED',
        'WITHDRAWN'
      )),
    CONSTRAINT enr_myar_capacity_chk
      CHECK (
        (capacity_available IS NULL
          AND capacity_checked_at IS NULL
          AND capacity_checked_by IS NULL)
        OR (capacity_available IS NOT NULL
          AND capacity_checked_at IS NOT NULL
          AND capacity_checked_by IS NOT NULL)
      )
);

CREATE INDEX IF NOT EXISTS enr_myar_school_status_idx
  ON enr_mid_year_admission_requests(school_id, status, requested_start_date);

CREATE INDEX IF NOT EXISTS enr_myar_linked_app_idx
  ON enr_mid_year_admission_requests(linked_application_id)
  WHERE linked_application_id IS NOT NULL;

COMMENT ON COLUMN enr_mid_year_admission_requests.requested_by IS
  'Tenant-local soft reference to platform.iam_person(id) per ADR-001/020. The guardian or EO who submitted the request.';

COMMENT ON COLUMN enr_mid_year_admission_requests.capacity_checked_by IS
  'Tenant-local soft reference to platform.iam_person(id) per ADR-001/020. The EO who ran the capacity check against enr_capacity_summary.';
