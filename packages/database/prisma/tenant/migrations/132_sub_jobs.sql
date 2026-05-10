/* 132_sub_jobs
 *
 * Phase 2 Cycle 9 (P2-9) sub-cycle a — Sub Marketplace step 2.
 *
 * Plan reference — docs/campusos-p2c9-sub-marketplace.html step 2.
 * Plan migration number was 119 but slot 119 is taken (enr_tours).
 * Used 132 per the established convention of taking the next available
 * slot when the planned number is occupied. Companion platform migration
 * ships under 20260510120000_add_p2c9_sub_marketplace and lands the 4
 * platform tables (platform_substitute_profiles columns, platform_sub_credentials,
 * platform_sub_availability, platform_sub_preferences).
 *
 * 4 new tenant base tables backing the school-side of M82 Sub Marketplace.
 *
 *   sub_school_pool         — the curated list of substitutes a school
 *                             trusts. UNIQUE(school_id, substitute_id).
 *                             status 3-value CHECK ACTIVE, SUSPENDED,
 *                             REMOVED. SUSPENDED rows carry suspended_until
 *                             plus suspension_reason populated by the
 *                             P2-9b CancellationPolicyWorker on repeat
 *                             late-cancellation offences. substitute_id
 *                             is a soft UUID ref to platform_substitute_profiles
 *                             per ADR-001/020.
 *
 *   sub_job_postings        — the job posting itself. status 5-value CHECK
 *                             OPEN, FILLED, CANCELLED, EXPIRED, UNFILLED.
 *                             notification_tier 2-value CHECK POOL,
 *                             MARKETPLACE drives the JobNotificationWorker
 *                             tiered fan-out. acceptance_window_minutes is
 *                             configurable per posting and the
 *                             AcceptanceExpiryWorker uses it to flip
 *                             PENDING notifications past the window to
 *                             EXPIRED. absent_teacher_id is a real DB-
 *                             enforced FK to hr_employees per the
 *                             Cycle 4 Step 0 convention.
 *
 *   sub_job_classes         — per-(job, timetable_slot) snapshot of the
 *                             classes the substitute will cover. Snapshot
 *                             columns class_name plus room_name plus
 *                             period_label preserve the historical view
 *                             after timetable changes. timetable_slot_id
 *                             is a real DB-enforced FK to
 *                             sch_timetable_slots since both sides are
 *                             tenant-scoped.
 *
 *   sub_job_notifications   — per-(job, substitute) tier-1 or tier-2
 *                             notification row. response 4-value CHECK
 *                             PENDING, ACCEPTED, DECLINED, EXPIRED.
 *                             Partial INDEX(acceptance_window_expires_at)
 *                             WHERE response='PENDING' for the expiry
 *                             sweep hot path. substitute_id is a soft
 *                             UUID ref to platform_substitute_profiles.
 *
 * 5 new intra-tenant DB-enforced FKs:
 *   sub_job_postings.absent_teacher_id -> hr_employees(id)            NO ACTION (audit)
 *   sub_job_postings.posted_by         -> hr_employees(id)            SET NULL  (audit survives staff leaving)
 *   sub_job_classes.job_id             -> sub_job_postings(id)        CASCADE   (snapshot meaningless without parent job)
 *   sub_job_classes.timetable_slot_id  -> sch_timetable_slots(id)     NO ACTION (admin must close out the job before the slot can be retired)
 *   sub_job_notifications.job_id       -> sub_job_postings(id)        CASCADE   (notifications meaningless without parent job)
 *
 * 0 cross-schema FKs.
 *
 * Splitter rules per Cycles 4 onwards: no semicolons inside any block
 * comment header, single-quoted string, or COMMENT ON ... text. Use
 * em-dashes, periods, or "and" instead.
 */

CREATE TABLE IF NOT EXISTS sub_school_pool (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    substitute_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    added_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    suspended_until DATE,
    suspension_reason TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT sub_school_pool_status_chk CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REMOVED')),
    CONSTRAINT sub_school_pool_suspended_chk CHECK (
        (status <> 'SUSPENDED' AND suspended_until IS NULL)
        OR (status = 'SUSPENDED' AND suspended_until IS NOT NULL)
    ),
    CONSTRAINT sub_school_pool_school_sub_uq UNIQUE (school_id, substitute_id)
);

CREATE INDEX IF NOT EXISTS sub_school_pool_school_status_idx ON sub_school_pool(school_id, status);
CREATE INDEX IF NOT EXISTS sub_school_pool_sub_idx ON sub_school_pool(substitute_id);

COMMENT ON TABLE sub_school_pool IS 'P2-9 — Per-(school, substitute) curated pool record. UNIQUE(school_id, substitute_id) caps the school at one row per substitute. status 3-value CHECK ACTIVE/SUSPENDED/REMOVED. SUSPENDED rows must carry suspended_until populated per the multi-column suspended_chk lockstep. substitute_id is a soft UUID ref to platform.platform_substitute_profiles(id) per ADR-001/020 — no DB-enforced FK across the schema boundary. school_id is a soft ref to platform.schools(id).';
COMMENT ON COLUMN sub_school_pool.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020.';
COMMENT ON COLUMN sub_school_pool.substitute_id IS 'Soft FK to platform.platform_substitute_profiles(id) per ADR-001/020 + ADR-029. Substitutes are platform-portable so the FK lives at the application layer.';


CREATE TABLE IF NOT EXISTS sub_job_postings (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    absent_teacher_id UUID NOT NULL REFERENCES hr_employees(id),
    job_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    job_type TEXT NOT NULL DEFAULT 'FULL_DAY',
    grade_level TEXT,
    subject TEXT,
    special_requirements TEXT,
    posted_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    acceptance_window_minutes INT NOT NULL DEFAULT 30,
    notification_tier TEXT NOT NULL DEFAULT 'POOL',
    escalate_to_marketplace_at TIMESTAMPTZ,
    filled_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    cancelled_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT sub_job_postings_status_chk CHECK (status IN ('OPEN', 'FILLED', 'CANCELLED', 'EXPIRED', 'UNFILLED')),
    CONSTRAINT sub_job_postings_type_chk CHECK (job_type IN ('FULL_DAY', 'HALF_DAY', 'SPECIFIC_PERIODS')),
    CONSTRAINT sub_job_postings_tier_chk CHECK (notification_tier IN ('POOL', 'MARKETPLACE')),
    CONSTRAINT sub_job_postings_window_chk CHECK (acceptance_window_minutes > 0),
    CONSTRAINT sub_job_postings_times_chk CHECK (end_time > start_time),
    CONSTRAINT sub_job_postings_filled_chk CHECK (
        (status <> 'FILLED' AND filled_at IS NULL)
        OR (status = 'FILLED' AND filled_at IS NOT NULL)
    ),
    CONSTRAINT sub_job_postings_cancelled_chk CHECK (
        (status <> 'CANCELLED' AND cancelled_at IS NULL)
        OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS sub_job_postings_school_status_date_idx ON sub_job_postings(school_id, status, job_date);
CREATE INDEX IF NOT EXISTS sub_job_postings_absent_teacher_idx ON sub_job_postings(absent_teacher_id);
CREATE INDEX IF NOT EXISTS sub_job_postings_escalation_idx ON sub_job_postings(escalate_to_marketplace_at) WHERE escalate_to_marketplace_at IS NOT NULL AND status = 'OPEN';

COMMENT ON TABLE sub_job_postings IS 'P2-9 — Substitute job posting. status lifecycle OPEN -> FILLED via JobResponseService.accept (one substitute wins) -> CANCELLED admin-initiated cancellation -> EXPIRED no acceptance within window for any tier -> UNFILLED admin marks the job as gone-without-coverage post-window. notification_tier flips POOL -> MARKETPLACE when escalate_to_marketplace_at passes with no POOL acceptance. escalate_to_marketplace_at is set by JobPostingService at post-time based on acceptance_window_minutes. absent_teacher_id is a real DB-enforced FK to hr_employees because both sides are tenant-scoped per the Cycle 4 Step 0 convention.';
COMMENT ON COLUMN sub_job_postings.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020.';
COMMENT ON COLUMN sub_job_postings.escalate_to_marketplace_at IS 'When set and the JobNotificationWorker tier-1 sweep finds no POOL acceptance by this timestamp, the worker escalates to tier-2 MARKETPLACE notification. NULL means do not escalate.';


CREATE TABLE IF NOT EXISTS sub_job_classes (
    id UUID PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES sub_job_postings(id) ON DELETE CASCADE,
    timetable_slot_id UUID NOT NULL REFERENCES sch_timetable_slots(id),
    class_name TEXT NOT NULL,
    room_name TEXT,
    period_label TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sub_job_classes_job_idx ON sub_job_classes(job_id);
CREATE INDEX IF NOT EXISTS sub_job_classes_slot_idx ON sub_job_classes(timetable_slot_id);

COMMENT ON TABLE sub_job_classes IS 'P2-9 — Per-(job, timetable_slot) snapshot of the classes the substitute will cover. CASCADE on parent job since the snapshot is meaningless without its job. NO ACTION on timetable_slot_id since active jobs against a slot must be cleared before the slot can be retired. class_name plus room_name plus period_label are denormalised at post-time so the historical record survives schedule changes.';


CREATE TABLE IF NOT EXISTS sub_job_notifications (
    id UUID PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES sub_job_postings(id) ON DELETE CASCADE,
    substitute_id UUID NOT NULL,
    notification_tier TEXT NOT NULL,
    notified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    response TEXT NOT NULL DEFAULT 'PENDING',
    responded_at TIMESTAMPTZ,
    acceptance_window_expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT sub_job_notifications_response_chk CHECK (response IN ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED')),
    CONSTRAINT sub_job_notifications_tier_chk CHECK (notification_tier IN ('POOL', 'MARKETPLACE')),
    CONSTRAINT sub_job_notifications_responded_chk CHECK (
        (response = 'PENDING' AND responded_at IS NULL)
        OR (response IN ('ACCEPTED', 'DECLINED', 'EXPIRED') AND responded_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS sub_job_notifications_job_sub_uq ON sub_job_notifications(job_id, substitute_id);
CREATE INDEX IF NOT EXISTS sub_job_notifications_job_response_idx ON sub_job_notifications(job_id, response, acceptance_window_expires_at);
CREATE INDEX IF NOT EXISTS sub_job_notifications_pending_expiry_idx ON sub_job_notifications(acceptance_window_expires_at) WHERE response = 'PENDING';

COMMENT ON TABLE sub_job_notifications IS 'P2-9 — Per-(job, substitute) notification record. UNIQUE(job_id, substitute_id) caps each substitute at one notification per job across both tiers. response 4-value CHECK PENDING, ACCEPTED, DECLINED, EXPIRED. responded_chk lockstep enforces responded_at populated only on terminal responses. The pending_expiry_idx is the AcceptanceExpiryWorker hot path — it polls notifications WHERE response=PENDING AND acceptance_window_expires_at <= now() and flips them to EXPIRED. substitute_id is a soft UUID ref to platform.platform_substitute_profiles(id) per ADR-001/020.';
COMMENT ON COLUMN sub_job_notifications.substitute_id IS 'Soft FK to platform.platform_substitute_profiles(id) per ADR-001/020.';
