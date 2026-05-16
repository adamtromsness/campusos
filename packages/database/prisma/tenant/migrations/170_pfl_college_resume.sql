/* 170_pfl_college_resume.sql
 * Phase 2 Cycle 27 — Portfolio Advanced Step 3. College applications
 * + resume profile — 2 tenant tables completing the M26 deferred
 * surface.
 *
 *   pfl_college_applications   Student-owned college application
 *                              tracker with deadline + status
 *                              management. 4-value application_type
 *                              CHECK (EARLY_DECISION, EARLY_ACTION,
 *                              REGULAR, ROLLING). 7-value status
 *                              CHECK (RESEARCHING, PREPARING,
 *                              SUBMITTED, INTERVIEW_SCHEDULED,
 *                              ACCEPTED, REJECTED, WAITLISTED).
 *                              essay_s3_key carries the application
 *                              essay upload. recommendation_count
 *                              tracks recommendations gathered.
 *                              transcript_sent flips when the
 *                              counsellor sends the P2-13 transcript.
 *                              decision_date is the school decision
 *                              date stamped on ACCEPTED / REJECTED /
 *                              WAITLISTED transitions. INDEX
 *                              (student_id, deadline) for the
 *                              upcoming-deadlines counsellor view.
 *                              INDEX (student_id, status) for the
 *                              status filter chips.
 *
 *   pfl_resume_profiles        One per student. UNIQUE(student_id).
 *                              objective_statement, skills TEXT[],
 *                              work_experience JSONB array,
 *                              extracurriculars JSONB (auto-populated
 *                              from ext_activity_enrollments if
 *                              available — Step 6 resolver), awards
 *                              JSONB (auto-populated from
 *                              pfl_achievements — Step 6 resolver),
 *                              service_hours_total NUMERIC(5,1)
 *                              (auto-populated from P2-13
 *                              sis_service_learning_hours SUM —
 *                              Step 6 resolver), references JSONB
 *                              array, pdf_s3_key holding the latest
 *                              generated PDF. last_generated_at
 *                              stamped on every PDF generation.
 *                              Resume PDF generated on demand from
 *                              profile + portfolio data — the Step 6
 *                              ResumeService assembles skills via
 *                              UNION of endorsement skills + self
 *                              reported, service hours via SUM of
 *                              sis_service_learning_hours, awards
 *                              via pfl_achievements rows, and
 *                              extracurriculars via
 *                              ext_activity_enrollments if available.
 *
 * 0 intra-tenant DB-enforced FKs in this migration — student_id
 * is a soft FK to sis_students per ADR-001/020 matching Cycle 24
 * pfl_portfolios convention. 0 cross-schema FKs.
 *
 * Splitter-safe — no semicolons inside string literals or block
 * comments. Idempotent — re-runs are a no-op.
 */

/* ─── 1. pfl_college_applications ─── */

CREATE TABLE IF NOT EXISTS pfl_college_applications (
  id                       UUID         PRIMARY KEY,
  student_id               UUID         NOT NULL,
  college_name             TEXT         NOT NULL,
  application_type         TEXT         NOT NULL,
  deadline                 DATE,
  status                   TEXT         NOT NULL DEFAULT 'RESEARCHING',
  essay_s3_key             TEXT,
  recommendation_count     INT          NOT NULL DEFAULT 0,
  transcript_sent          BOOLEAN      NOT NULL DEFAULT false,
  financial_aid_applied    BOOLEAN      NOT NULL DEFAULT false,
  notes                    TEXT,
  decision_date            DATE,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT pfl_college_app_type_chk CHECK (
    application_type IN ('EARLY_DECISION', 'EARLY_ACTION', 'REGULAR', 'ROLLING')
  ),
  CONSTRAINT pfl_college_app_status_chk CHECK (
    status IN (
      'RESEARCHING', 'PREPARING', 'SUBMITTED', 'INTERVIEW_SCHEDULED',
      'ACCEPTED', 'REJECTED', 'WAITLISTED'
    )
  ),
  CONSTRAINT pfl_college_app_rec_count_chk CHECK (
    recommendation_count >= 0
  )
);

CREATE INDEX IF NOT EXISTS pfl_college_app_deadline_idx
  ON pfl_college_applications (student_id, deadline)
  WHERE deadline IS NOT NULL;

CREATE INDEX IF NOT EXISTS pfl_college_app_status_idx
  ON pfl_college_applications (student_id, status);

CREATE INDEX IF NOT EXISTS pfl_college_app_school_deadline_idx
  ON pfl_college_applications (deadline)
  WHERE deadline IS NOT NULL
    AND status NOT IN ('ACCEPTED', 'REJECTED', 'WAITLISTED');

COMMENT ON TABLE pfl_college_applications IS
  'Cycle 27 P2-27 Step 3 — student-owned college application tracker. INDEX(student_id, deadline) for upcoming-deadlines counsellor view. INDEX(student_id, status) for status filter chips. Partial INDEX(deadline) where status is open drives the counsellor school-wide upcoming-deadlines list. student_id is a soft FK per ADR-001/020 matching pfl_portfolios convention. Counsellor read access via service-layer ACH-003 grant.';

COMMENT ON COLUMN pfl_college_applications.application_type IS
  '4-value CHECK. EARLY_DECISION is binding. EARLY_ACTION is non-binding but reduces application stress for the student. REGULAR is the standard pool. ROLLING means the school evaluates applications as they arrive until the class fills.';

COMMENT ON COLUMN pfl_college_applications.status IS
  '7-value CHECK lifecycle. RESEARCHING means the student is exploring the school. PREPARING means actively assembling the application package. SUBMITTED means the application is in the schools queue. INTERVIEW_SCHEDULED tracks the interview stage. ACCEPTED / REJECTED / WAITLISTED are terminal decisions — decision_date stamps when one of these flips.';

/* ─── 2. pfl_resume_profiles ─── */

CREATE TABLE IF NOT EXISTS pfl_resume_profiles (
  id                       UUID            PRIMARY KEY,
  student_id               UUID            NOT NULL UNIQUE,
  objective_statement      TEXT,
  skills                   TEXT[]          NOT NULL DEFAULT ARRAY[]::TEXT[],
  work_experience          JSONB           NOT NULL DEFAULT '[]'::jsonb,
  extracurriculars         JSONB           NOT NULL DEFAULT '[]'::jsonb,
  awards                   JSONB           NOT NULL DEFAULT '[]'::jsonb,
  service_hours_total      NUMERIC(5,1)    NOT NULL DEFAULT 0,
  "references"             JSONB           NOT NULL DEFAULT '[]'::jsonb,
  pdf_s3_key               TEXT,
  last_generated_at        TIMESTAMPTZ,
  created_at               TIMESTAMPTZ     NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ     NOT NULL DEFAULT now(),
  CONSTRAINT pfl_resume_service_hours_chk CHECK (
    service_hours_total >= 0
  )
);

CREATE INDEX IF NOT EXISTS pfl_resume_student_idx
  ON pfl_resume_profiles (student_id);

COMMENT ON TABLE pfl_resume_profiles IS
  'Cycle 27 P2-27 Step 3 — student-owned resume profile. UNIQUE(student_id) so each student carries at most one resume profile. Auto-populated fields (skills, extracurriculars, awards, service_hours_total) are refreshed at PDF generation time by the Step 6 ResumeService assembling cross-module data. work_experience and references are student-authored JSONB arrays. pdf_s3_key holds the latest generated PDF — last_generated_at stamped on every generation.';

COMMENT ON COLUMN pfl_resume_profiles.skills IS
  'Aggregated skills from pfl_endorsements.skills UNION self-reported skills (the Step 6 ResumeService merges endorsement skills at generation time). Drives the Skills section on the resume PDF.';

COMMENT ON COLUMN pfl_resume_profiles.work_experience IS
  'JSONB array of work experience entries — {employer, role, start_date, end_date, description}. Student-authored.';

COMMENT ON COLUMN pfl_resume_profiles.extracurriculars IS
  'JSONB array of extracurricular entries auto-populated from ext_activity_enrollments when available (Step 6 resolver). Manually editable for students whose activities are outside the school catalogue.';

COMMENT ON COLUMN pfl_resume_profiles.awards IS
  'JSONB array of award entries auto-populated from pfl_achievements at generation time (Step 6 resolver). Manually editable.';

COMMENT ON COLUMN pfl_resume_profiles.service_hours_total IS
  'Auto-populated from SUM(sis_service_learning_hours.hours_logged) WHERE status=APPROVED for the student. Refreshed at generation time. NUMERIC(5,1) supports half-hour precision up to 9999.9 hours.';

COMMENT ON COLUMN pfl_resume_profiles."references" IS
  'JSONB array of reference entries — {name, title, relationship, email}. Student-authored. Quoted column name avoids the SQL keyword collision.';
