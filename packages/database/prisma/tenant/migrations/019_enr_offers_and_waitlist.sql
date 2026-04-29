/* 019_enr_offers_and_waitlist.sql
 * Cycle 6 Step 2 — Offer lifecycle and waitlist management.
 *
 * Two tables that ride on top of Step 1's enrollment + application
 * foundation. The offer lifecycle is intentionally separate from the
 * application status enum — an offer can be EXPIRED while the parent
 * application stays ACCEPTED, an offer can be WITHDRAWN by the school
 * after issuance, and a parent can DEFER an offer to a future academic
 * year. Modelling offers in their own table keeps the application
 * status enum clean.
 *
 *   enr_offers           — at most one offer per application (UNIQUE on
 *                          application_id, ON DELETE CASCADE so killing
 *                          the parent application drops its offer).
 *                          Supports UNCONDITIONAL and CONDITIONAL
 *                          offer_types. CONDITIONAL offers carry a
 *                          non-empty offer_conditions TEXT[] and a
 *                          tri-state conditions_met BOOLEAN. Multi-
 *                          column conditions_chk enforces the shape:
 *                          UNCONDITIONAL means both columns are NULL,
 *                          CONDITIONAL means offer_conditions has at
 *                          least one entry. The 6-status enum tracks
 *                          ISSUED -> ACCEPTED / DECLINED / EXPIRED /
 *                          WITHDRAWN / CONDITIONS_NOT_MET.
 *                          family_response captures the parent action
 *                          (ACCEPTED / DECLINED / DEFERRED) with a
 *                          multi-column CHECK that family_response and
 *                          family_responded_at are all-set or all-null
 *                          together. DEFERRED requires
 *                          deferral_target_year_id to be set.
 *                          response_deadline > issued_at CHECK keeps
 *                          the timeline sane. Partial INDEX on
 *                          response_deadline WHERE status='ISSUED'
 *                          drives the future expiry sweep job.
 *   enr_waitlist_entries — per-(period, grade) waitlist queue. UNIQUE
 *                          on (period, application) means a single
 *                          application is waitlisted at most once per
 *                          period. priority_score is NUMERIC(5,2)
 *                          allowing decimals like 87.50 for sibling
 *                          weights. Multi-column CHECK that OFFERED
 *                          means offered_at is set.
 *
 * Four new intra-tenant DB-enforced FKs:
 *   enr_offers.application_id              CASCADE
 *   enr_offers.deferral_target_year_id     no cascade (nullable)
 *   enr_waitlist_entries.enrollment_period_id  CASCADE
 *   enr_waitlist_entries.application_id        CASCADE
 *
 * All four intra-tenant. Cross-schema refs (school_id) stay soft per
 * ADR-001/020. No PG ENUM types — TEXT plus CHECK in lockstep with the
 * application DTOs. Block-comment style and no semicolons inside any
 * string literal or block comment per the splitter trap.
 *
 * Idempotent — safe to re-run.
 */
CREATE TABLE IF NOT EXISTS enr_offers (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    application_id UUID NOT NULL UNIQUE REFERENCES enr_applications(id) ON DELETE CASCADE,
    offer_type TEXT NOT NULL DEFAULT 'UNCONDITIONAL',
    offer_conditions TEXT[],
    conditions_met BOOLEAN,
    offer_letter_s3_key TEXT,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    response_deadline TIMESTAMPTZ NOT NULL,
    family_response TEXT,
    family_responded_at TIMESTAMPTZ,
    deferral_target_year_id UUID REFERENCES sis_academic_years(id),
    status TEXT NOT NULL DEFAULT 'ISSUED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT enr_offers_offer_type_chk CHECK (offer_type IN ('UNCONDITIONAL','CONDITIONAL')),
    CONSTRAINT enr_offers_status_chk CHECK (status IN ('ISSUED','ACCEPTED','DECLINED','EXPIRED','WITHDRAWN','CONDITIONS_NOT_MET')),
    CONSTRAINT enr_offers_family_response_chk CHECK (family_response IS NULL OR family_response IN ('ACCEPTED','DECLINED','DEFERRED')),
    CONSTRAINT enr_offers_deadline_chk CHECK (response_deadline > issued_at),
    CONSTRAINT enr_offers_response_pair_chk CHECK (
        (family_response IS NULL AND family_responded_at IS NULL)
        OR
        (family_response IS NOT NULL AND family_responded_at IS NOT NULL)
    ),
    CONSTRAINT enr_offers_conditions_chk CHECK (
        (offer_type = 'UNCONDITIONAL' AND offer_conditions IS NULL AND conditions_met IS NULL)
        OR
        (offer_type = 'CONDITIONAL' AND offer_conditions IS NOT NULL AND cardinality(offer_conditions) > 0)
    ),
    CONSTRAINT enr_offers_deferred_chk CHECK (
        family_response IS DISTINCT FROM 'DEFERRED' OR deferral_target_year_id IS NOT NULL
    )
);
CREATE INDEX IF NOT EXISTS enr_offers_school_status_idx ON enr_offers(school_id, status);
CREATE INDEX IF NOT EXISTS enr_offers_response_deadline_open_idx ON enr_offers(response_deadline) WHERE status = 'ISSUED';
COMMENT ON COLUMN enr_offers.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020.';
COMMENT ON COLUMN enr_offers.offer_type IS 'UNCONDITIONAL is a clean offer the parent can accept directly. CONDITIONAL ties the acceptance to a non-empty offer_conditions list (e.g. final transcript) — admin flips conditions_met to true once verified, which gates the parent ACCEPT path.';
COMMENT ON COLUMN enr_offers.offer_conditions IS 'TEXT[] of human-readable condition strings. Required non-empty when offer_type=CONDITIONAL, must be NULL when offer_type=UNCONDITIONAL — enforced by enr_offers_conditions_chk.';
COMMENT ON COLUMN enr_offers.conditions_met IS 'NULL until admin verifies. true unlocks parent ACCEPT. false transitions status to CONDITIONS_NOT_MET. Required NULL when offer_type=UNCONDITIONAL.';
COMMENT ON COLUMN enr_offers.deferral_target_year_id IS 'Soft FK to sis_academic_years(id). Required when family_response=DEFERRED. Nullable otherwise. Enforced by enr_offers_deferred_chk.';
COMMENT ON COLUMN enr_offers.status IS 'Lifecycle. ISSUED is the initial state, ACCEPTED gates the enr.student.enrolled emit, DECLINED is a terminal parent-rejection, EXPIRED is set by the deadline sweep job when response_deadline passes without family_response, WITHDRAWN is admin-initiated cancellation, CONDITIONS_NOT_MET is set when admin flips conditions_met to false on a CONDITIONAL offer.';
CREATE TABLE IF NOT EXISTS enr_waitlist_entries (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    enrollment_period_id UUID NOT NULL REFERENCES enr_enrollment_periods(id) ON DELETE CASCADE,
    application_id UUID NOT NULL REFERENCES enr_applications(id) ON DELETE CASCADE,
    grade_level TEXT NOT NULL,
    priority_score NUMERIC(5,2) NOT NULL DEFAULT 0,
    position INT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    offered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT enr_waitlist_entries_period_app_uq UNIQUE (enrollment_period_id, application_id),
    CONSTRAINT enr_waitlist_entries_status_chk CHECK (status IN ('ACTIVE','OFFERED','ENROLLED','EXPIRED','WITHDRAWN')),
    CONSTRAINT enr_waitlist_entries_priority_chk CHECK (priority_score >= 0),
    CONSTRAINT enr_waitlist_entries_position_chk CHECK (position > 0),
    CONSTRAINT enr_waitlist_entries_offered_chk CHECK (
        status <> 'OFFERED' OR offered_at IS NOT NULL
    )
);
CREATE INDEX IF NOT EXISTS enr_waitlist_entries_school_period_grade_position_idx ON enr_waitlist_entries(school_id, enrollment_period_id, grade_level, position);
CREATE INDEX IF NOT EXISTS enr_waitlist_entries_period_active_idx ON enr_waitlist_entries(enrollment_period_id, grade_level, position) WHERE status = 'ACTIVE';
COMMENT ON COLUMN enr_waitlist_entries.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020.';
COMMENT ON COLUMN enr_waitlist_entries.priority_score IS 'NUMERIC(5,2) so schools can use decimals for sibling weights, donor weights, lottery seeds, etc. Higher means earlier offer when capacity opens up. Application service is responsible for the score formula.';
COMMENT ON COLUMN enr_waitlist_entries.position IS 'Queue position within (period, grade). Maintained by the WaitlistService — not auto-incremented because admins can re-order on a manual override (sibling priority bump, etc).';
COMMENT ON COLUMN enr_waitlist_entries.status IS 'Lifecycle. ACTIVE is the default queue state, OFFERED means the WaitlistService has issued an offer (offered_at set), ENROLLED is the terminal success state, EXPIRED is set by the cleanup job when the period closes, WITHDRAWN means the family asked to be removed from the queue.';
/* Idempotent fix-up: an earlier dev iteration of this migration used
 * array_length(offer_conditions, 1) > 0 which returns NULL (not false)
 * on empty arrays — empty CONDITIONAL conditions arrays slipped through.
 * cardinality() returns 0 for empty arrays, never NULL, so the CHECK
 * rejects empty-array CONDITIONAL offers correctly. The DROP IF EXISTS
 * + ADD pair is a no-op-then-recreate on tenants that already have the
 * correct constraint inline from CREATE TABLE.
 */
ALTER TABLE enr_offers DROP CONSTRAINT IF EXISTS enr_offers_conditions_chk;
ALTER TABLE enr_offers ADD CONSTRAINT enr_offers_conditions_chk CHECK (
    (offer_type = 'UNCONDITIONAL' AND offer_conditions IS NULL AND conditions_met IS NULL)
    OR
    (offer_type = 'CONDITIONAL' AND offer_conditions IS NOT NULL AND cardinality(offer_conditions) > 0)
);
