/* P2C4 sub-cycle b — Recruitment domain (M80 .1).

   8 new tenant base tables in one migration. Plan-level migration
   number was 103 but the slot was taken by a Cycle 6 visitor
   migration so this slice uses 114. The plan's vertical slice:
   admin posts a job, candidates apply (creating an iam_person if
   the email is new), screening + interview panels evaluate, an
   offer is extended and accepted, and the OfferService auto-
   creates an hr_employees row + primary position assignment.

   Splitter notes — block comments and string literals carry zero
   semicolons here. Section headers use slash-star block comments
   so the provisioner does not silently drop the CREATE TABLE that
   follows.

   Cross-module / cross-cycle:
     - person_id soft refs land on iam_person via ADR-001/020. The
       offer-accept flow promotes the person to a hire by writing
       hr_employees + hr_employee_positions atomically.
     - Posting + offer events publish to platform_outbox via
       OutboxService.enqueueInTx so the Cycle 31 publisher delivers
       hr.job.posted + hr.offer.accepted durably. */

/* 1. hr_job_postings — admin-authored req. status drives the public job board */
CREATE TABLE IF NOT EXISTS hr_job_postings (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    position_title TEXT NOT NULL,
    department TEXT,
    description TEXT NOT NULL,
    qualifications_required TEXT,
    salary_range_low NUMERIC(10,2),
    salary_range_high NUMERIC(10,2),
    employment_type TEXT NOT NULL,
    application_deadline DATE,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    posted_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_job_postings_employment_type_chk
      CHECK (employment_type IN ('FULL_TIME', 'PART_TIME', 'TEMPORARY', 'LONG_TERM_SUBSTITUTE')),
    CONSTRAINT hr_job_postings_status_chk
      CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'LIVE', 'CLOSED', 'CANCELLED')),
    CONSTRAINT hr_job_postings_salary_range_chk
      CHECK (
        (salary_range_low IS NULL AND salary_range_high IS NULL)
        OR
        (
          salary_range_low IS NOT NULL
          AND salary_range_high IS NOT NULL
          AND salary_range_low >= 0
          AND salary_range_high >= salary_range_low
        )
      ),
    CONSTRAINT hr_job_postings_lifecycle_chk
      CHECK (
        (status NOT IN ('LIVE', 'CLOSED', 'CANCELLED') AND posted_at IS NULL)
        OR
        (status IN ('LIVE', 'CLOSED', 'CANCELLED') AND posted_at IS NOT NULL)
      ),
    CONSTRAINT hr_job_postings_closed_chk
      CHECK (
        (status NOT IN ('CLOSED', 'CANCELLED') AND closed_at IS NULL)
        OR
        (status IN ('CLOSED', 'CANCELLED') AND closed_at IS NOT NULL)
      )
);
CREATE INDEX IF NOT EXISTS hr_job_postings_school_status_idx
  ON hr_job_postings(school_id, status);
CREATE INDEX IF NOT EXISTS hr_job_postings_live_idx
  ON hr_job_postings(school_id, application_deadline) WHERE status = 'LIVE';

/* 2. hr_applications — one row per (posting, person). lifecycle covers screening, interview, offer */
CREATE TABLE IF NOT EXISTS hr_applications (
    id UUID PRIMARY KEY,
    posting_id UUID NOT NULL REFERENCES hr_job_postings(id) ON DELETE CASCADE,
    person_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'SUBMITTED',
    cover_letter_s3_key TEXT,
    resume_s3_key TEXT,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    not_selected_reason TEXT,
    withdrawn_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_applications_posting_person_uq UNIQUE (posting_id, person_id),
    CONSTRAINT hr_applications_status_chk
      CHECK (status IN (
        'SUBMITTED',
        'UNDER_REVIEW',
        'SCREENING',
        'INTERVIEW_SCHEDULED',
        'INTERVIEW_COMPLETED',
        'OFFER_EXTENDED',
        'OFFER_ACCEPTED',
        'OFFER_DECLINED',
        'NOT_SELECTED',
        'WITHDRAWN'
      ))
);
CREATE INDEX IF NOT EXISTS hr_applications_posting_status_idx
  ON hr_applications(posting_id, status);
CREATE INDEX IF NOT EXISTS hr_applications_person_idx
  ON hr_applications(person_id, submitted_at DESC);

/* 3. hr_interview_panels — admin-defined interview committee per posting */
CREATE TABLE IF NOT EXISTS hr_interview_panels (
    id UUID PRIMARY KEY,
    posting_id UUID NOT NULL REFERENCES hr_job_postings(id) ON DELETE CASCADE,
    panel_name TEXT NOT NULL,
    notes TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_interview_panels_posting_name_uq UNIQUE (posting_id, panel_name)
);

/* 4. hr_interview_panel_members — link of panel to evaluating staff */
CREATE TABLE IF NOT EXISTS hr_interview_panel_members (
    id UUID PRIMARY KEY,
    panel_id UUID NOT NULL REFERENCES hr_interview_panels(id) ON DELETE CASCADE,
    panelist_person_id UUID NOT NULL,
    role_in_panel TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_interview_panel_members_panel_person_uq UNIQUE (panel_id, panelist_person_id)
);
CREATE INDEX IF NOT EXISTS hr_interview_panel_members_person_idx
  ON hr_interview_panel_members(panelist_person_id);

/* 5. hr_interviews — scheduled candidate session */
CREATE TABLE IF NOT EXISTS hr_interviews (
    id UUID PRIMARY KEY,
    application_id UUID NOT NULL REFERENCES hr_applications(id) ON DELETE CASCADE,
    panel_id UUID NOT NULL REFERENCES hr_interview_panels(id) ON DELETE CASCADE,
    scheduled_at TIMESTAMPTZ NOT NULL,
    duration_minutes INT,
    location TEXT,
    meeting_url TEXT,
    status TEXT NOT NULL DEFAULT 'SCHEDULED',
    notes TEXT,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    cancellation_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_interviews_status_chk
      CHECK (status IN ('SCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED')),
    CONSTRAINT hr_interviews_completed_chk
      CHECK (
        (status <> 'COMPLETED' AND completed_at IS NULL)
        OR
        (status = 'COMPLETED' AND completed_at IS NOT NULL)
      ),
    CONSTRAINT hr_interviews_cancelled_chk
      CHECK (
        (
          status <> 'CANCELLED'
          AND cancelled_at IS NULL
          AND cancellation_reason IS NULL
        )
        OR
        (
          status = 'CANCELLED'
          AND cancelled_at IS NOT NULL
          AND cancellation_reason IS NOT NULL
          AND length(trim(cancellation_reason)) > 0
        )
      ),
    CONSTRAINT hr_interviews_duration_chk
      CHECK (duration_minutes IS NULL OR duration_minutes > 0)
);
CREATE INDEX IF NOT EXISTS hr_interviews_application_idx
  ON hr_interviews(application_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS hr_interviews_panel_idx
  ON hr_interviews(panel_id, scheduled_at DESC);

/* 6. hr_interview_evaluations — one row per (interview, evaluator) */
CREATE TABLE IF NOT EXISTS hr_interview_evaluations (
    id UUID PRIMARY KEY,
    interview_id UUID NOT NULL REFERENCES hr_interviews(id) ON DELETE CASCADE,
    evaluator_id UUID NOT NULL,
    rating TEXT NOT NULL,
    strengths TEXT,
    concerns TEXT,
    notes TEXT,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_interview_evaluations_interview_evaluator_uq
      UNIQUE (interview_id, evaluator_id),
    CONSTRAINT hr_interview_evaluations_rating_chk
      CHECK (rating IN ('STRONG_HIRE', 'HIRE', 'NEUTRAL', 'NO_HIRE', 'STRONG_NO_HIRE'))
);

/* 7. hr_offers — UNIQUE(application_id) so a candidate carries at most one active offer */
CREATE TABLE IF NOT EXISTS hr_offers (
    id UUID PRIMARY KEY,
    application_id UUID NOT NULL UNIQUE REFERENCES hr_applications(id) ON DELETE CASCADE,
    school_id UUID NOT NULL,
    position_title TEXT NOT NULL,
    salary NUMERIC(10,2) NOT NULL,
    start_date DATE NOT NULL,
    contract_type TEXT NOT NULL,
    conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
    acceptance_deadline DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    extended_by UUID,
    extended_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at TIMESTAMPTZ,
    response_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_offers_contract_type_chk
      CHECK (contract_type IN ('ANNUAL', 'MULTI_YEAR', 'AT_WILL', 'TEMPORARY')),
    CONSTRAINT hr_offers_status_chk
      CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN')),
    CONSTRAINT hr_offers_salary_chk CHECK (salary >= 0),
    CONSTRAINT hr_offers_responded_chk
      CHECK (
        (status = 'PENDING' AND responded_at IS NULL)
        OR
        (status IN ('ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN') AND responded_at IS NOT NULL)
      ),
    CONSTRAINT hr_offers_dates_chk
      CHECK (acceptance_deadline >= extended_at::date)
);
CREATE INDEX IF NOT EXISTS hr_offers_school_status_idx
  ON hr_offers(school_id, status);
CREATE INDEX IF NOT EXISTS hr_offers_pending_deadline_idx
  ON hr_offers(acceptance_deadline) WHERE status = 'PENDING';

/* 8. hr_job_alerts — candidate self-service notification preferences */
CREATE TABLE IF NOT EXISTS hr_job_alerts (
    id UUID PRIMARY KEY,
    person_id UUID NOT NULL,
    school_id UUID,
    subject_area TEXT,
    grade_level TEXT,
    employment_type TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_notified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_job_alerts_employment_type_chk
      CHECK (
        employment_type IS NULL
        OR employment_type IN ('FULL_TIME', 'PART_TIME', 'TEMPORARY', 'LONG_TERM_SUBSTITUTE')
      )
);
CREATE INDEX IF NOT EXISTS hr_job_alerts_person_idx
  ON hr_job_alerts(person_id);
CREATE INDEX IF NOT EXISTS hr_job_alerts_active_idx
  ON hr_job_alerts(is_active) WHERE is_active = true;

COMMENT ON TABLE hr_job_postings IS 'P2C4 — admin-authored job requisition. status=LIVE drives the public /hr/jobs board. Multi-column lifecycle CHECKs keep posted_at + closed_at in lockstep with status.';
COMMENT ON TABLE hr_applications IS 'P2C4 — one row per (posting, person). status walks the recruitment Kanban from SUBMITTED to OFFER_ACCEPTED. UNIQUE(posting_id, person_id) so a candidate cannot apply to the same posting twice.';
COMMENT ON TABLE hr_interview_panels IS 'P2C4 — admin-defined interview committee per posting. UNIQUE(posting_id, panel_name) per ADR-001 naming convention.';
COMMENT ON TABLE hr_interview_panel_members IS 'P2C4 — links a panel to its evaluating staff. UNIQUE(panel_id, panelist_person_id) so a panelist appears at most once per panel.';
COMMENT ON TABLE hr_interviews IS 'P2C4 — scheduled candidate session. CANCELLED requires non-empty cancellation_reason — same lockstep pattern as P2C3 hlth_telehealth_sessions.';
COMMENT ON TABLE hr_interview_evaluations IS 'P2C4 — one row per (interview, evaluator). 5-value rating CHECK STRONG_HIRE through STRONG_NO_HIRE.';
COMMENT ON TABLE hr_offers IS 'P2C4 — UNIQUE(application_id) so a candidate carries at most one offer record. responded_chk keeps responded_at in lockstep with terminal statuses. The OfferService.respond ACCEPTED branch auto-creates hr_employees + hr_employee_positions atomically and emits hr.offer.accepted via OutboxService.enqueueInTx.';
COMMENT ON TABLE hr_job_alerts IS 'P2C4 — candidate self-service notification preferences. soft person_id ref to platform.iam_person per ADR-001.';
