/* 133_sub_assignments
 *
 * Phase 2 Cycle 9 (P2-9) sub-cycle a — Sub Marketplace step 3.
 *
 * Plan reference — docs/campusos-p2c9-sub-marketplace.html step 3.
 * Plan migration number was 120 but slot 120 is taken (enr_withdrawal_reenrol).
 * Used 133 per the established convention of taking the next available
 * slot when the planned number is occupied.
 *
 * 5 new tenant base tables completing the M82 Sub Marketplace tenant
 * surface. Combined with the 4 step 2 tables that brings P2-9 tenant total
 * to 9 tables — matching the plan.
 *
 *   sub_assignments              — Per-job assignment record. UNIQUE(job_id)
 *                                  one assignment per job. status 5-value
 *                                  CHECK CONFIRMED, CHECKED_IN, CHECKED_OUT,
 *                                  NO_SHOW, CANCELLED. Multi-column
 *                                  cancelled_chk lockstep keeps
 *                                  cancelled_at populated only on
 *                                  CANCELLED + NO_SHOW. The Step 7
 *                                  AssignmentService stamps check_in_at
 *                                  and check_out_at atomically with the
 *                                  status flip. is_late_cancellation
 *                                  is set by the service layer when
 *                                  cancellation falls within the school's
 *                                  configured late_window_hours window.
 *
 *   sub_ratings                  — Bidirectional rating row.
 *                                  rater_type 2-value CHECK SCHOOL_RATES_SUB,
 *                                  SUB_RATES_SCHOOL. UNIQUE(assignment_id,
 *                                  rater_type) enforces one row per
 *                                  direction per assignment so the
 *                                  RatingService cannot stack duplicates.
 *                                  Service layer re-materialises
 *                                  platform_substitute_profiles.overall_rating
 *                                  on every SCHOOL_RATES_SUB insert.
 *
 *   sub_session_notes            — Per-(assignment) handover note.
 *                                  UNIQUE(assignment_id) one note per
 *                                  assignment. is_visible_to_teacher
 *                                  flag drives the returning teacher
 *                                  notification chain — when true the
 *                                  Step 7 SessionNoteService emits a
 *                                  task to the absent teacher's task
 *                                  list via the Cycle 7 TaskWorker.
 *
 *   sub_pay_rates                — Per-substitute or school-default rate.
 *                                  EXCLUDE USING gist enforces no
 *                                  overlapping date ranges per
 *                                  (school_id, substitute_id, job_type)
 *                                  tuple. The sentinel UUID
 *                                  '00000000-0000-0000-0000-000000000000'
 *                                  on substitute_id marks the school
 *                                  default — per-substitute rows
 *                                  override at the service layer.
 *                                  rate_type 3-value CHECK HOURLY,
 *                                  DAILY, HALF_DAY.
 *
 *   sub_cancellation_policies    — Per-school cancellation policy.
 *                                  UNIQUE(school_id) one policy per
 *                                  school. consequence 4-value CHECK
 *                                  WARNING_ONLY, TEMPORARY_POOL_SUSPENSION,
 *                                  PERMANENT_POOL_REMOVAL, RATING_PENALTY.
 *                                  TEMPORARY_POOL_SUSPENSION must carry
 *                                  suspension_duration_days populated
 *                                  per the multi-column suspension_chk
 *                                  lockstep. The Step 7
 *                                  CancellationPolicyWorker reads this
 *                                  policy on sub.assignment.late_cancelled.
 *
 * 5 new intra-tenant DB-enforced FKs:
 *   sub_assignments.job_id              -> sub_job_postings(id)        CASCADE
 *   sub_ratings.assignment_id           -> sub_assignments(id)         CASCADE
 *   sub_ratings.rated_by                -> hr_employees(id)            SET NULL
 *   sub_session_notes.assignment_id     -> sub_assignments(id)         CASCADE
 *   sub_cancellation_policies.updated_by-> hr_employees(id)            SET NULL
 *
 * 0 cross-schema FKs.
 *
 * Splitter rules per Cycles 4 onwards: no semicolons inside any block
 * comment header, single-quoted string, or COMMENT ON ... text.
 */

CREATE TABLE IF NOT EXISTS sub_assignments (
    id UUID PRIMARY KEY,
    job_id UUID NOT NULL UNIQUE REFERENCES sub_job_postings(id) ON DELETE CASCADE,
    substitute_id UUID NOT NULL,
    confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    check_in_at TIMESTAMPTZ,
    check_out_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'CONFIRMED',
    cancelled_at TIMESTAMPTZ,
    cancelled_by_type TEXT,
    cancellation_reason TEXT,
    is_late_cancellation BOOLEAN NOT NULL DEFAULT false,
    late_cancellation_consequence_applied BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT sub_assignments_status_chk CHECK (status IN ('CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW', 'CANCELLED')),
    CONSTRAINT sub_assignments_cancelled_by_chk CHECK (cancelled_by_type IS NULL OR cancelled_by_type IN ('SCHOOL', 'SUBSTITUTE')),
    CONSTRAINT sub_assignments_cancelled_chk CHECK (
        (status NOT IN ('CANCELLED', 'NO_SHOW') AND cancelled_at IS NULL AND cancelled_by_type IS NULL)
        OR (status IN ('CANCELLED', 'NO_SHOW') AND cancelled_at IS NOT NULL)
    ),
    CONSTRAINT sub_assignments_check_in_chk CHECK (
        (status = 'CONFIRMED' AND check_in_at IS NULL)
        OR (status IN ('CHECKED_IN', 'CHECKED_OUT') AND check_in_at IS NOT NULL)
        OR (status IN ('NO_SHOW', 'CANCELLED'))
    ),
    CONSTRAINT sub_assignments_check_out_chk CHECK (
        (status <> 'CHECKED_OUT' AND check_out_at IS NULL)
        OR (status = 'CHECKED_OUT' AND check_out_at IS NOT NULL AND check_in_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS sub_assignments_substitute_idx ON sub_assignments(substitute_id);
CREATE INDEX IF NOT EXISTS sub_assignments_status_idx ON sub_assignments(status);
CREATE INDEX IF NOT EXISTS sub_assignments_late_cancel_idx ON sub_assignments(substitute_id) WHERE is_late_cancellation = true;

COMMENT ON TABLE sub_assignments IS 'P2-9 — Per-job substitute assignment. UNIQUE on job_id ensures one assignment per job. status lifecycle CONFIRMED -> CHECKED_IN -> CHECKED_OUT happy path — CANCELLED + NO_SHOW are terminal alternates. Multi-column check_in_chk and check_out_chk keep timestamps in lockstep with the status across the 5 values. cancelled_chk requires cancelled_at populated atomically on the CANCELLED or NO_SHOW transition. is_late_cancellation is computed by the Step 7 AssignmentService on cancel by comparing now() against job_date + start_time minus the school cancellation policy late_window_hours.';
COMMENT ON COLUMN sub_assignments.substitute_id IS 'Soft FK to platform.platform_substitute_profiles(id) per ADR-001/020.';


CREATE TABLE IF NOT EXISTS sub_ratings (
    id UUID PRIMARY KEY,
    assignment_id UUID NOT NULL REFERENCES sub_assignments(id) ON DELETE CASCADE,
    rater_type TEXT NOT NULL,
    overall_score NUMERIC(2,1),
    professionalism NUMERIC(2,1),
    punctuality NUMERIC(2,1),
    comments TEXT,
    rated_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
    rated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT sub_ratings_rater_type_chk CHECK (rater_type IN ('SCHOOL_RATES_SUB', 'SUB_RATES_SCHOOL')),
    CONSTRAINT sub_ratings_overall_chk CHECK (overall_score IS NULL OR (overall_score >= 1.0 AND overall_score <= 5.0)),
    CONSTRAINT sub_ratings_prof_chk CHECK (professionalism IS NULL OR (professionalism >= 1.0 AND professionalism <= 5.0)),
    CONSTRAINT sub_ratings_punct_chk CHECK (punctuality IS NULL OR (punctuality >= 1.0 AND punctuality <= 5.0)),
    CONSTRAINT sub_ratings_assignment_rater_uq UNIQUE (assignment_id, rater_type)
);

CREATE INDEX IF NOT EXISTS sub_ratings_assignment_idx ON sub_ratings(assignment_id);

COMMENT ON TABLE sub_ratings IS 'P2-9 — Bidirectional rating row. UNIQUE(assignment_id, rater_type) enforces one row per direction per assignment so the RatingService cannot stack duplicates. SCHOOL_RATES_SUB rows feed the platform_substitute_profiles.overall_rating materialisation. SUB_RATES_SCHOOL rows are stored for school-side reputation but not currently materialised onto a school-level metric (Phase 2 backlog). 1.0-5.0 score range on all three numeric columns.';


CREATE TABLE IF NOT EXISTS sub_session_notes (
    id UUID PRIMARY KEY,
    assignment_id UUID NOT NULL UNIQUE REFERENCES sub_assignments(id) ON DELETE CASCADE,
    notes_text TEXT NOT NULL,
    homework_set TEXT,
    is_visible_to_teacher BOOLEAN NOT NULL DEFAULT true,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sub_session_notes_visibility_idx ON sub_session_notes(is_visible_to_teacher);

COMMENT ON TABLE sub_session_notes IS 'P2-9 — Per-assignment handover note. UNIQUE(assignment_id) caps each assignment at one note. is_visible_to_teacher gates whether the absent teacher receives the returning-teacher notification on Step 7 SessionNoteService.create. notes_text is mandatory — no point logging an empty note. homework_set is optional.';


CREATE TABLE IF NOT EXISTS sub_pay_rates (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    substitute_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    job_type TEXT NOT NULL DEFAULT 'FULL_DAY',
    rate NUMERIC(8,2) NOT NULL,
    rate_type TEXT NOT NULL DEFAULT 'DAILY',
    effective_from DATE NOT NULL,
    effective_to DATE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT sub_pay_rates_type_chk CHECK (rate_type IN ('HOURLY', 'DAILY', 'HALF_DAY')),
    CONSTRAINT sub_pay_rates_job_type_chk CHECK (job_type IN ('FULL_DAY', 'HALF_DAY', 'SPECIFIC_PERIODS')),
    CONSTRAINT sub_pay_rates_rate_chk CHECK (rate >= 0),
    CONSTRAINT sub_pay_rates_dates_chk CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT sub_pay_rates_no_overlap EXCLUDE USING gist (
        school_id WITH =,
        substitute_id WITH =,
        job_type WITH =,
        daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[)') WITH &&
    )
);

CREATE INDEX IF NOT EXISTS sub_pay_rates_school_sub_idx ON sub_pay_rates(school_id, substitute_id);
CREATE INDEX IF NOT EXISTS sub_pay_rates_active_idx ON sub_pay_rates(school_id) WHERE effective_to IS NULL;

COMMENT ON TABLE sub_pay_rates IS 'P2-9 — Per-substitute or school-default pay rate. The substitute_id sentinel UUID 00000000-0000-0000-0000-000000000000 marks a school-default row (applies to any substitute). Per-substitute rows override the default at the Step 7 PayRateService.computePay layer. EXCLUDE USING gist on (school_id, substitute_id, job_type, daterange) prevents two rows for the same combination from carrying overlapping effective date ranges. SQLSTATE 23P01 on violation — service translates to 409 Conflict matching the Cycle 5 sch_timetable_slots EXCLUSION precedent.';
COMMENT ON CONSTRAINT sub_pay_rates_no_overlap ON sub_pay_rates IS 'EXCLUDE USING gist — two rows for the same (school, substitute, job_type) cannot have overlapping effective date ranges. SQLSTATE 23P01 on violation, translated to 409 Conflict at the service layer.';


CREATE TABLE IF NOT EXISTS sub_cancellation_policies (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL UNIQUE,
    late_window_hours INT NOT NULL DEFAULT 2,
    consequence TEXT NOT NULL DEFAULT 'WARNING_ONLY',
    suspension_duration_days INT,
    repeat_offence_threshold INT NOT NULL DEFAULT 3,
    rating_penalty_amount NUMERIC(2,1),
    notes TEXT,
    updated_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT sub_cancellation_policies_consequence_chk CHECK (consequence IN ('WARNING_ONLY', 'TEMPORARY_POOL_SUSPENSION', 'PERMANENT_POOL_REMOVAL', 'RATING_PENALTY')),
    CONSTRAINT sub_cancellation_policies_window_chk CHECK (late_window_hours > 0),
    CONSTRAINT sub_cancellation_policies_threshold_chk CHECK (repeat_offence_threshold > 0),
    CONSTRAINT sub_cancellation_policies_suspension_chk CHECK (
        (consequence <> 'TEMPORARY_POOL_SUSPENSION' AND suspension_duration_days IS NULL)
        OR (consequence = 'TEMPORARY_POOL_SUSPENSION' AND suspension_duration_days IS NOT NULL AND suspension_duration_days > 0)
    ),
    CONSTRAINT sub_cancellation_policies_penalty_chk CHECK (
        (consequence <> 'RATING_PENALTY' AND rating_penalty_amount IS NULL)
        OR (consequence = 'RATING_PENALTY' AND rating_penalty_amount IS NOT NULL AND rating_penalty_amount > 0)
    )
);

COMMENT ON TABLE sub_cancellation_policies IS 'P2-9 — Per-school cancellation policy. UNIQUE(school_id) one policy per school. The Step 7 AssignmentService.cancel reads late_window_hours to decide is_late_cancellation, and the CancellationPolicyWorker reads consequence and the matching detail column (suspension_duration_days for TEMPORARY_POOL_SUSPENSION, rating_penalty_amount for RATING_PENALTY) on every sub.assignment.late_cancelled emit. The multi-column suspension_chk plus penalty_chk lockstep enforces the matching detail field is populated for the chosen consequence.';
