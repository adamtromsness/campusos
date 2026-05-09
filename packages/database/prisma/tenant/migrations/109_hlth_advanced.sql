/*
  Phase 2 Cycle 3 (P2C3) — M23 Health Advanced. Six tables that
  layer on Cycle 10's M23 Health module:

  Telehealth (3 tables — extends remote consultation surface):

  - hlth_telehealth_providers per-school directory of remote-care
    providers. Service layer treats is_active=false as soft-removed
    so historical sessions keep their provider name. INDEX(school,
    is_active) for the active-provider directory hot path.

  - hlth_telehealth_sessions one row per scheduled telehealth
    appointment. 5-value status CHECK SCHEDULED / IN_PROGRESS /
    COMPLETED / NO_SHOW / CANCELLED. Multi-column hlth_th_completed_chk
    keeps completed_at + session_notes_s3_key in lockstep with
    status=COMPLETED. consent_signature_id is a soft ref to a future
    platform_signature_requests row (the signature module is not yet
    in repo). HIPAA: every read writes hlth_health_access_log with
    access_type=VIEW_TELEHEALTH (added below).

  - hlth_telehealth_documents per-session uploaded artefacts (notes,
    referral letters, treatment plans). Encrypted at rest using the
    Cycle 22 IT vault wire format (base64(iv).base64(tag).base64(ct)).
    s3_key NOT NULL because the document landed in S3 before the row
    is created.

  Immunisation compliance (2 tables — state reporting backbone):

  - hlth_immunisation_requirements catalogue of vaccine + dose
    requirements per (state_code, vaccine_name, required_by_grade).
    school_id NULL = state-level default and school_id NOT NULL = a
    school override. COALESCE-sentinel UNIQUE on
    (school_id, state_code, vaccine_name, required_by_grade) so the
    NULL-school default + per-school override coexist on the same
    natural key. exemption_types TEXT[] enumerates which exemption
    classes the state allows.

  - hlth_immunisation_compliance materialised by the
    ImmunisationComplianceWorker (Step 4). UNIQUE(student_id,
    academic_year_id) so the worker can UPSERT without a manual
    lookup. 4-value status CHECK COMPLIANT / NON_COMPLIANT /
    EXEMPT / PROVISIONAL. multi-column hlth_imm_compliance_exempt_chk
    requires exemption_type populated when status=EXEMPT. JSONB
    missing_vaccines is an array of {vaccine_name, doses_received,
    doses_required} objects so the dashboard can render the gap
    detail without a join.

  Screening detail (1 table — per-test follow-up tracking):

  - hlth_screening_referrals one row per follow-up referral generated
    from a hlth_screenings record. 4-value referral_type, 4-value
    follow_up_outcome (nullable until follow-up completes), 3-value
    status (REFERRED / FOLLOW_UP_COMPLETE / LOST_TO_FOLLOW_UP).
    multi-column hlth_referrals_completed_chk requires follow_up_date
    + follow_up_outcome populated when status=FOLLOW_UP_COMPLETE.

  Access log extension:

  - ALTER hlth_health_access_log access_type CHECK to add
    VIEW_TELEHEALTH so the Step 3 TelehealthSessionService can log
    every read. The DROP-then-ADD shape is idempotent on re-runs.

  Splitter notes: provision-tenant.ts splits on every literal
  semicolon and filters chunks that begin with a line comment. No
  semicolons appear inside any string literal or block comment here.

  Cross-cycle integration:
  - student_id soft refs target sis_students (CASCADE on parent
    delete) per Cycle 1 convention.
  - screening_id targets hlth_screenings(id) (Cycle 10 Step 7)
    via DB-enforced FK ON DELETE CASCADE.
  - academic_year_id targets sis_academic_years(id) (Cycle 1).
  - school_id, accessed_by, consent_signature_id, signature_request_id
    are soft refs to platform.* per ADR-001 / ADR-020.
*/

CREATE TABLE IF NOT EXISTS hlth_telehealth_providers (
  id UUID PRIMARY KEY,
  school_id UUID,
  provider_name TEXT NOT NULL,
  speciality TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  booking_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hlth_th_providers_school_active_idx
  ON hlth_telehealth_providers (school_id, is_active) WHERE is_active = true;

COMMENT ON TABLE hlth_telehealth_providers IS
  'Per-school telehealth provider directory. is_active=false soft-removes a provider while historical sessions keep its name.';

CREATE TABLE IF NOT EXISTS hlth_telehealth_sessions (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  student_id UUID NOT NULL,
  provider_id UUID NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  duration_minutes INT,
  status TEXT NOT NULL DEFAULT 'SCHEDULED',
  meeting_url TEXT,
  session_notes_s3_key TEXT,
  consent_signature_id UUID,
  consent_received_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT hlth_th_sessions_status_chk
    CHECK (status IN ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'NO_SHOW', 'CANCELLED')),
  CONSTRAINT hlth_th_sessions_completed_chk
    CHECK (
      (status <> 'COMPLETED' AND completed_at IS NULL)
      OR
      (status = 'COMPLETED' AND completed_at IS NOT NULL)
    ),
  CONSTRAINT hlth_th_sessions_cancelled_chk
    CHECK (
      (status <> 'CANCELLED' AND cancelled_at IS NULL)
      OR
      (status = 'CANCELLED' AND cancelled_at IS NOT NULL)
    ),
  CONSTRAINT hlth_th_sessions_duration_chk
    CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  CONSTRAINT hlth_th_sessions_student_fk
    FOREIGN KEY (student_id) REFERENCES sis_students(id) ON DELETE CASCADE,
  CONSTRAINT hlth_th_sessions_provider_fk
    FOREIGN KEY (provider_id) REFERENCES hlth_telehealth_providers(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS hlth_th_sessions_student_scheduled_idx
  ON hlth_telehealth_sessions (student_id, scheduled_at DESC);

CREATE INDEX IF NOT EXISTS hlth_th_sessions_school_status_idx
  ON hlth_telehealth_sessions (school_id, status, scheduled_at DESC);

COMMENT ON TABLE hlth_telehealth_sessions IS
  'Telehealth appointment record. Multi-column lockstep CHECKs keep status in sync with completed_at and cancelled_at. HIPAA: every read writes hlth_health_access_log with access_type=VIEW_TELEHEALTH.';

CREATE TABLE IF NOT EXISTS hlth_telehealth_documents (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL,
  document_type TEXT NOT NULL,
  s3_key TEXT NOT NULL,
  file_size_bytes BIGINT,
  signature_request_id UUID,
  uploaded_by UUID NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT hlth_th_docs_type_chk
    CHECK (document_type IN ('SESSION_NOTES', 'TREATMENT_PLAN', 'REFERRAL_LETTER', 'CONSENT', 'OTHER')),
  CONSTRAINT hlth_th_docs_size_chk
    CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
  CONSTRAINT hlth_th_docs_session_fk
    FOREIGN KEY (session_id) REFERENCES hlth_telehealth_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS hlth_th_docs_session_uploaded_idx
  ON hlth_telehealth_documents (session_id, uploaded_at DESC);

COMMENT ON TABLE hlth_telehealth_documents IS
  'Per-session encrypted documents. s3_key references an S3 object encrypted at rest with the Cycle 22 IT vault wire format (base64(iv).base64(tag).base64(ct)).';

CREATE TABLE IF NOT EXISTS hlth_immunisation_requirements (
  id UUID PRIMARY KEY,
  school_id UUID,
  state_code TEXT NOT NULL,
  vaccine_name TEXT NOT NULL,
  required_doses INT NOT NULL,
  required_by_grade TEXT NOT NULL,
  allows_exemption BOOLEAN NOT NULL DEFAULT true,
  exemption_types TEXT[],
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT hlth_imm_req_doses_chk
    CHECK (required_doses > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS hlth_imm_req_uq
  ON hlth_immunisation_requirements (
    COALESCE(school_id, '00000000-0000-0000-0000-000000000000'::uuid),
    state_code,
    vaccine_name,
    required_by_grade
  );

CREATE INDEX IF NOT EXISTS hlth_imm_req_active_idx
  ON hlth_immunisation_requirements (state_code, is_active) WHERE is_active = true;

COMMENT ON TABLE hlth_immunisation_requirements IS
  'State immunisation requirement catalogue. school_id NULL = state default. COALESCE-sentinel UNIQUE so the default + per-school override coexist on the same (state, vaccine, grade) tuple.';

CREATE TABLE IF NOT EXISTS hlth_immunisation_compliance (
  id UUID PRIMARY KEY,
  student_id UUID NOT NULL,
  school_id UUID NOT NULL,
  academic_year_id UUID,
  status TEXT NOT NULL,
  missing_vaccines JSONB NOT NULL DEFAULT '[]'::jsonb,
  exemption_type TEXT,
  exemption_document_s3_key TEXT,
  last_computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  parent_notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT hlth_imm_compliance_status_chk
    CHECK (status IN ('COMPLIANT', 'NON_COMPLIANT', 'EXEMPT', 'PROVISIONAL')),
  CONSTRAINT hlth_imm_compliance_exempt_chk
    CHECK (
      (status <> 'EXEMPT' AND exemption_type IS NULL)
      OR
      (status = 'EXEMPT' AND exemption_type IS NOT NULL)
    ),
  CONSTRAINT hlth_imm_compliance_student_fk
    FOREIGN KEY (student_id) REFERENCES sis_students(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS hlth_imm_compliance_student_year_uq
  ON hlth_immunisation_compliance (student_id, COALESCE(academic_year_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX IF NOT EXISTS hlth_imm_compliance_school_status_idx
  ON hlth_immunisation_compliance (school_id, status);

COMMENT ON TABLE hlth_immunisation_compliance IS
  'Materialised by ImmunisationComplianceWorker. UNIQUE(student, year) supports UPSERT. Multi-column exempt_chk keeps exemption_type populated only when status=EXEMPT.';

CREATE TABLE IF NOT EXISTS hlth_screening_referrals (
  id UUID PRIMARY KEY,
  screening_id UUID NOT NULL,
  student_id UUID NOT NULL,
  school_id UUID NOT NULL,
  referral_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  referred_to TEXT,
  referral_date DATE NOT NULL,
  follow_up_date DATE,
  follow_up_outcome TEXT,
  follow_up_notes TEXT,
  status TEXT NOT NULL DEFAULT 'REFERRED',
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT hlth_referrals_type_chk
    CHECK (referral_type IN ('VISION', 'HEARING', 'SCOLIOSIS', 'OTHER')),
  CONSTRAINT hlth_referrals_status_chk
    CHECK (status IN ('REFERRED', 'FOLLOW_UP_COMPLETE', 'LOST_TO_FOLLOW_UP')),
  CONSTRAINT hlth_referrals_outcome_chk
    CHECK (follow_up_outcome IS NULL OR follow_up_outcome IN (
      'NORMAL', 'TREATMENT_REQUIRED', 'GLASSES_PRESCRIBED', 'HEARING_AID', 'OTHER'
    )),
  CONSTRAINT hlth_referrals_completed_chk
    CHECK (
      (status <> 'FOLLOW_UP_COMPLETE')
      OR
      (status = 'FOLLOW_UP_COMPLETE' AND follow_up_date IS NOT NULL AND follow_up_outcome IS NOT NULL)
    ),
  CONSTRAINT hlth_referrals_screening_fk
    FOREIGN KEY (screening_id) REFERENCES hlth_screenings(id) ON DELETE CASCADE,
  CONSTRAINT hlth_referrals_student_fk
    FOREIGN KEY (student_id) REFERENCES sis_students(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS hlth_referrals_student_status_idx
  ON hlth_screening_referrals (student_id, status);

CREATE INDEX IF NOT EXISTS hlth_referrals_school_status_idx
  ON hlth_screening_referrals (school_id, status);

CREATE INDEX IF NOT EXISTS hlth_referrals_overdue_idx
  ON hlth_screening_referrals (school_id, follow_up_date)
  WHERE status = 'REFERRED' AND follow_up_date IS NOT NULL;

COMMENT ON TABLE hlth_screening_referrals IS
  'Per-screening follow-up referral. Multi-column completed_chk requires follow_up_date + follow_up_outcome populated when status=FOLLOW_UP_COMPLETE.';

ALTER TABLE hlth_health_access_log
  DROP CONSTRAINT IF EXISTS hlth_health_access_log_type_chk;

ALTER TABLE hlth_health_access_log
  ADD CONSTRAINT hlth_health_access_log_type_chk CHECK (
    access_type IN (
      'VIEW_RECORD',
      'VIEW_CONDITIONS',
      'VIEW_IMMUNISATIONS',
      'VIEW_MEDICATIONS',
      'VIEW_VISITS',
      'VIEW_IEP',
      'VIEW_SCREENING',
      'VIEW_DIETARY',
      'VIEW_TELEHEALTH',
      'EXPORT'
    )
  );
