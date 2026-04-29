/* 018_enr_enrollment_and_applications.sql
 * Cycle 6 Step 1 — Enrollment foundation.
 *
 * Eight tables forming the admissions pipeline up to (but not including)
 * the offer + waitlist surfaces. Step 2 will land enr_offers and
 * enr_waitlist_entries on top of this foundation.
 *
 *   enr_enrollment_periods  — per-school admissions windows tied to an
 *                              academic year. status enum UPCOMING / OPEN /
 *                              CLOSED. opens_at and closes_at are
 *                              advisory timestamps (status is the
 *                              authoritative gate the application service
 *                              checks). allows_mid_year_applications
 *                              flag controls whether mid-year admissions
 *                              are accepted under this period.
 *   enr_admission_streams   — named parallel intake streams within a
 *                              period (Standard, Music Scholarship, SEND
 *                              Specialist). UNIQUE(period_id, name) and
 *                              ON DELETE CASCADE so streams disappear
 *                              when a period is hard-deleted.
 *   enr_intake_capacities   — places per grade per period (and
 *                              optionally per stream). nullable stream_id
 *                              with COALESCE-to-sentinel-UUID in the
 *                              UNIQUE index so a NULL-stream row and a
 *                              specific-stream row can both exist for
 *                              the same (period, grade).
 *   enr_capacity_summary    — materialised dashboard per (period, grade).
 *                              the application/offer services maintain
 *                              the counters via UPSERT — no DB triggers
 *                              per ADR-codebase-rule. UNIQUE(period_id,
 *                              grade_level).
 *   enr_applications        — the application itself. 8-status lifecycle
 *                              DRAFT / SUBMITTED / UNDER_REVIEW /
 *                              ACCEPTED / REJECTED / WAITLISTED /
 *                              WITHDRAWN / ENROLLED. 3-admission_type
 *                              NEW_STUDENT / TRANSFER / MID_YEAR_ADMISSION.
 *                              Multi-column CHECK that DRAFT rows have
 *                              submitted_at NULL and non-DRAFT rows have
 *                              submitted_at NOT NULL — keeps the seed
 *                              and service in sync without a trigger.
 *                              Soft refs guardian_person_id and
 *                              reviewed_by are nullable UUIDs (parents
 *                              may not yet exist as iam_person rows when
 *                              they apply).
 *   enr_application_screening_responses — JSONB response_value keyed on
 *                              an application + question_key tuple.
 *                              Schema is intentionally schemaless on
 *                              the value side so schools can configure
 *                              their own screening questions without
 *                              schema migrations.
 *   enr_application_documents — signed-S3-URL pattern matching
 *                              hr_employee_documents from Cycle 4. The
 *                              pre-sign + PUT flow is Phase-2 ops work.
 *   enr_application_notes   — admin review notes. 6-note_type enum
 *                              INTERVIEW_NOTES / ASSESSMENT_RESULT /
 *                              STAFF_OBSERVATION / REFERENCE_CHECK /
 *                              VISIT_NOTES / GENERAL. is_confidential
 *                              flag — the parent-facing application
 *                              status tracker (Step 9) hides
 *                              confidential rows.
 *
 * Seven intra-tenant DB-enforced FKs:
 *   enr_admission_streams.enrollment_period_id            CASCADE
 *   enr_intake_capacities.enrollment_period_id            CASCADE
 *   enr_intake_capacities.stream_id                       CASCADE (nullable)
 *   enr_capacity_summary.enrollment_period_id             CASCADE
 *   enr_applications.enrollment_period_id                 NO ACTION (admin closes out before delete)
 *   enr_applications.stream_id                            NO ACTION (nullable)
 *   enr_application_screening_responses.application_id    CASCADE
 *   enr_application_documents.application_id              CASCADE
 *   enr_application_notes.application_id                  CASCADE
 *
 * Plus the FK on enr_enrollment_periods.academic_year_id to
 * sis_academic_years(id) — both intra-tenant, no cascade. Cross-schema
 * refs (school_id, guardian_person_id, reviewed_by, created_by) stay
 * soft per ADR-001/020/055.
 *
 * No PG ENUM types — TEXT plus CHECK in lockstep with the application
 * DTOs. Block-comment style and no semicolons inside any string literal
 * or block comment per the splitter trap.
 *
 * Idempotent — safe to re-run.
 */
CREATE TABLE IF NOT EXISTS enr_enrollment_periods (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    academic_year_id UUID NOT NULL REFERENCES sis_academic_years(id),
    name TEXT NOT NULL,
    opens_at TIMESTAMPTZ NOT NULL,
    closes_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'UPCOMING',
    allows_mid_year_applications BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT enr_enrollment_periods_school_year_name_uq UNIQUE (school_id, academic_year_id, name),
    CONSTRAINT enr_enrollment_periods_window_chk CHECK (closes_at > opens_at),
    CONSTRAINT enr_enrollment_periods_status_chk CHECK (status IN ('UPCOMING','OPEN','CLOSED'))
);
CREATE INDEX IF NOT EXISTS enr_enrollment_periods_school_status_idx ON enr_enrollment_periods(school_id, status);
CREATE INDEX IF NOT EXISTS enr_enrollment_periods_academic_year_idx ON enr_enrollment_periods(academic_year_id);
COMMENT ON COLUMN enr_enrollment_periods.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020.';
COMMENT ON COLUMN enr_enrollment_periods.status IS 'Lifecycle. UPCOMING is the pre-launch state, OPEN means the application service accepts submissions, CLOSED means the window is shut. opens_at and closes_at are advisory only — the service checks status, not the timestamps.';
COMMENT ON COLUMN enr_enrollment_periods.allows_mid_year_applications IS 'When true, the application service accepts admission_type=MID_YEAR_ADMISSION submissions even after the academic year has begun. When false, only applications dated before opens_at are accepted.';
CREATE TABLE IF NOT EXISTS enr_admission_streams (
    id UUID PRIMARY KEY,
    enrollment_period_id UUID NOT NULL REFERENCES enr_enrollment_periods(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    grade_level TEXT,
    opens_at TIMESTAMPTZ,
    closes_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT enr_admission_streams_period_name_uq UNIQUE (enrollment_period_id, name),
    CONSTRAINT enr_admission_streams_window_chk CHECK (opens_at IS NULL OR closes_at IS NULL OR closes_at > opens_at)
);
CREATE INDEX IF NOT EXISTS enr_admission_streams_period_active_idx ON enr_admission_streams(enrollment_period_id) WHERE is_active = true;
COMMENT ON COLUMN enr_admission_streams.grade_level IS 'Optional grade restriction. NULL means the stream is open to any grade in the period.';
COMMENT ON COLUMN enr_admission_streams.opens_at IS 'Optional per-stream window. NULL means inherit the parent period window.';
CREATE TABLE IF NOT EXISTS enr_intake_capacities (
    id UUID PRIMARY KEY,
    enrollment_period_id UUID NOT NULL REFERENCES enr_enrollment_periods(id) ON DELETE CASCADE,
    stream_id UUID REFERENCES enr_admission_streams(id) ON DELETE CASCADE,
    grade_level TEXT NOT NULL,
    total_places INT NOT NULL,
    reserved_places INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT enr_intake_capacities_total_chk CHECK (total_places >= 0),
    CONSTRAINT enr_intake_capacities_reserved_chk CHECK (reserved_places >= 0 AND reserved_places <= total_places)
);
CREATE UNIQUE INDEX IF NOT EXISTS enr_intake_capacities_period_stream_grade_uq ON enr_intake_capacities(enrollment_period_id, COALESCE(stream_id, '00000000-0000-0000-0000-000000000000'::uuid), grade_level);
CREATE INDEX IF NOT EXISTS enr_intake_capacities_period_idx ON enr_intake_capacities(enrollment_period_id);
COMMENT ON COLUMN enr_intake_capacities.stream_id IS 'NULL means capacity applies to the whole period regardless of stream. Non-NULL constrains to that stream. The COALESCE-with-sentinel-UUID in the UNIQUE index lets a NULL-stream row and a specific-stream row coexist for the same (period, grade).';
CREATE TABLE IF NOT EXISTS enr_capacity_summary (
    id UUID PRIMARY KEY,
    enrollment_period_id UUID NOT NULL REFERENCES enr_enrollment_periods(id) ON DELETE CASCADE,
    grade_level TEXT NOT NULL,
    total_places INT NOT NULL DEFAULT 0,
    reserved INT NOT NULL DEFAULT 0,
    applications_received INT NOT NULL DEFAULT 0,
    offers_issued INT NOT NULL DEFAULT 0,
    offers_accepted INT NOT NULL DEFAULT 0,
    waitlisted INT NOT NULL DEFAULT 0,
    available INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT enr_capacity_summary_period_grade_uq UNIQUE (enrollment_period_id, grade_level),
    CONSTRAINT enr_capacity_summary_nonneg_chk CHECK (
        total_places >= 0 AND reserved >= 0 AND applications_received >= 0
        AND offers_issued >= 0 AND offers_accepted >= 0 AND waitlisted >= 0
    )
);
CREATE INDEX IF NOT EXISTS enr_capacity_summary_period_idx ON enr_capacity_summary(enrollment_period_id);
COMMENT ON COLUMN enr_capacity_summary.available IS 'Maintained by the CapacitySummaryService on every application/offer status change. Conventionally available = total_places - reserved - offers_accepted, but the service owns the formula so future tweaks (e.g. counting outstanding offers) do not require a schema change.';
CREATE TABLE IF NOT EXISTS enr_applications (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    enrollment_period_id UUID NOT NULL REFERENCES enr_enrollment_periods(id),
    stream_id UUID REFERENCES enr_admission_streams(id),
    student_first_name TEXT NOT NULL,
    student_last_name TEXT NOT NULL,
    student_date_of_birth DATE NOT NULL,
    applying_for_grade TEXT NOT NULL,
    guardian_person_id UUID,
    guardian_email TEXT NOT NULL,
    guardian_phone TEXT,
    admission_type TEXT NOT NULL DEFAULT 'NEW_STUDENT',
    status TEXT NOT NULL DEFAULT 'DRAFT',
    submitted_at TIMESTAMPTZ,
    reviewed_by UUID,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT enr_applications_admission_type_chk CHECK (admission_type IN ('NEW_STUDENT','TRANSFER','MID_YEAR_ADMISSION')),
    CONSTRAINT enr_applications_status_chk CHECK (status IN ('DRAFT','SUBMITTED','UNDER_REVIEW','ACCEPTED','REJECTED','WAITLISTED','WITHDRAWN','ENROLLED')),
    CONSTRAINT enr_applications_submitted_chk CHECK (
        (status = 'DRAFT' AND submitted_at IS NULL)
        OR
        (status <> 'DRAFT' AND submitted_at IS NOT NULL)
    ),
    CONSTRAINT enr_applications_reviewed_chk CHECK (
        (reviewed_at IS NULL AND reviewed_by IS NULL)
        OR
        (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS enr_applications_school_period_status_idx ON enr_applications(school_id, enrollment_period_id, status);
CREATE INDEX IF NOT EXISTS enr_applications_guardian_idx ON enr_applications(guardian_person_id) WHERE guardian_person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS enr_applications_period_grade_idx ON enr_applications(enrollment_period_id, applying_for_grade);
CREATE INDEX IF NOT EXISTS enr_applications_stream_idx ON enr_applications(stream_id) WHERE stream_id IS NOT NULL;
COMMENT ON COLUMN enr_applications.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020.';
COMMENT ON COLUMN enr_applications.guardian_person_id IS 'Soft FK to platform.iam_person(id). Nullable because a parent applying for the first time may not yet have an iam_person row — the OfferService creates one on accept and back-fills this column.';
COMMENT ON COLUMN enr_applications.reviewed_by IS 'Soft FK to platform.platform_users(id) — the admin who last moved the application out of SUBMITTED. Audit-only.';
COMMENT ON COLUMN enr_applications.status IS 'Lifecycle. DRAFT is parent-only (never visible to admin), SUBMITTED enters the admin queue, UNDER_REVIEW means an admin has opened it, ACCEPTED gates offer creation, REJECTED / WITHDRAWN are terminal failure states, WAITLISTED means an offer was not issued because capacity was reached, ENROLLED is the terminal success state set when the parent accepts an offer.';
CREATE TABLE IF NOT EXISTS enr_application_screening_responses (
    id UUID PRIMARY KEY,
    application_id UUID NOT NULL REFERENCES enr_applications(id) ON DELETE CASCADE,
    question_key TEXT NOT NULL,
    response_value JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT enr_application_screening_responses_app_question_uq UNIQUE (application_id, question_key)
);
CREATE INDEX IF NOT EXISTS enr_application_screening_responses_app_idx ON enr_application_screening_responses(application_id);
COMMENT ON COLUMN enr_application_screening_responses.response_value IS 'JSONB so schools can configure their own question shapes (free text, single choice, multi-choice, file ref) without a schema migration. The application form in Step 9 renders questions from a school-side catalogue.';
CREATE TABLE IF NOT EXISTS enr_application_documents (
    id UUID PRIMARY KEY,
    application_id UUID NOT NULL REFERENCES enr_applications(id) ON DELETE CASCADE,
    document_type TEXT NOT NULL,
    s3_key TEXT NOT NULL,
    file_name TEXT,
    content_type TEXT,
    file_size_bytes BIGINT,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT enr_application_documents_size_chk CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0)
);
CREATE INDEX IF NOT EXISTS enr_application_documents_app_idx ON enr_application_documents(application_id);
COMMENT ON COLUMN enr_application_documents.s3_key IS 'Signed-URL pattern. The pre-sign + PUT pipeline is Phase-2 ops work — Cycle 6 only stores the s3_key.';
CREATE TABLE IF NOT EXISTS enr_application_notes (
    id UUID PRIMARY KEY,
    application_id UUID NOT NULL REFERENCES enr_applications(id) ON DELETE CASCADE,
    note_type TEXT NOT NULL DEFAULT 'GENERAL',
    note_text TEXT NOT NULL,
    is_confidential BOOLEAN NOT NULL DEFAULT false,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT enr_application_notes_type_chk CHECK (note_type IN ('INTERVIEW_NOTES','ASSESSMENT_RESULT','STAFF_OBSERVATION','REFERENCE_CHECK','VISIT_NOTES','GENERAL'))
);
CREATE INDEX IF NOT EXISTS enr_application_notes_app_idx ON enr_application_notes(application_id, created_at DESC);
COMMENT ON COLUMN enr_application_notes.is_confidential IS 'When true, the parent-facing application status tracker (Step 9) hides the row. Admin pipeline (Step 8) shows everything.';
COMMENT ON COLUMN enr_application_notes.created_by IS 'Soft FK to platform.platform_users(id) — admin who wrote the note. Audit-only.';
