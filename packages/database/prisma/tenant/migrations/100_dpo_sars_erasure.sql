/*
  Cycle 30 Step 3 — SARs + Erasure + Consent + Privacy Notices +
  Pseudonymisation + Compliance Config (M120 DPO, ADR-052)

  Six tables completing the DPO compliance surface:

  - dpo_subject_access_requests — GDPR Article 15 / FERPA SAR. 4-value
    request_type CHECK (ACCESS / RECTIFICATION / PORTABILITY /
    RESTRICTION), 6-value status CHECK with OVERDUE state surfacing on
    the dashboard. deadline_date computed from
    dpo_compliance_dashboard_config.sar_default_deadline_days at create
    time. Multi-column completed_chk keeps (status, completed_at) in
    lockstep.

  - dpo_erasure_requests — GDPR Article 17 right to erasure. 5-value
    status CHECK with PARTIALLY_COMPLETED for the common case (FERPA
    legal-hold prevents full erasure). Three TEXT[] columns track the
    forensic trail: categories_erased / categories_retained (with
    denial_basis) / categories_pseudonymised.

  - dpo_processing_consent_records — per-(data_subject, processing
    activity) consent record. 3-value consent_method CHECK. Two
    timestamps for given/withdrawn — the withdrawn_at populated state
    means "consent was given, then revoked".

  - dpo_privacy_notices — version-controlled notices. UNIQUE(school,
    notice_version). superseded_at populated on the prior version when
    a new one is published.

  - dpo_pseudonymisation_log — IMMUTABLE per ADR-010 — service-side
    discipline, no UPDATE / no DELETE method exposed. One row per
    (erasure_request, target_table, target_field) operation. The
    pseudonymisation_token is the opaque identifier that survived the
    erasure (the chain back from the audit_log row to the original
    subject is broken at the application layer).

  - dpo_compliance_dashboard_config — per-school config row.
    UNIQUE(school_id). Tunes the default SAR deadline, breach
    escalation hour, and review reminder windows.

  No cross-schema FKs. data_subject_id soft refs to platform.iam_person
  per ADR-001/020 — application-layer validation in the request services.
*/

CREATE TABLE IF NOT EXISTS dpo_subject_access_requests (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  data_subject_id UUID NOT NULL,
  requested_by UUID NOT NULL,
  request_type TEXT NOT NULL,
  request_details TEXT,
  deadline_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'RECEIVED',
  response_s3_key TEXT,
  completed_at TIMESTAMPTZ,
  denial_reason TEXT,
  extension_reason TEXT,
  extension_until DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dpo_sar_type_chk CHECK (request_type IN ('ACCESS', 'RECTIFICATION', 'PORTABILITY', 'RESTRICTION')),
  CONSTRAINT dpo_sar_status_chk CHECK (
    status IN ('RECEIVED', 'IN_PROGRESS', 'EXTENSION_REQUESTED', 'COMPLETED', 'DENIED', 'OVERDUE')
  ),
  CONSTRAINT dpo_sar_completed_chk CHECK (
    (status IN ('COMPLETED', 'DENIED') AND completed_at IS NOT NULL)
    OR (status NOT IN ('COMPLETED', 'DENIED') AND completed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS dpo_sar_school_status_idx
  ON dpo_subject_access_requests (school_id, status);

CREATE INDEX IF NOT EXISTS dpo_sar_deadline_idx
  ON dpo_subject_access_requests (school_id, deadline_date)
  WHERE status NOT IN ('COMPLETED', 'DENIED');

CREATE INDEX IF NOT EXISTS dpo_sar_data_subject_idx
  ON dpo_subject_access_requests (data_subject_id);

COMMENT ON TABLE dpo_subject_access_requests IS
  'GDPR Article 15 / FERPA SAR. Multi-column completed_chk pins (status, completed_at) lockstep — terminal states require completed_at populated, working states require it null. Partial INDEX on deadline_date filtered to non-terminal rows backs the dashboard countdown.';


CREATE TABLE IF NOT EXISTS dpo_erasure_requests (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  data_subject_id UUID NOT NULL,
  requested_by UUID NOT NULL,
  request_details TEXT,
  status TEXT NOT NULL DEFAULT 'RECEIVED',
  denial_basis TEXT,
  categories_erased TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  categories_retained TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  categories_pseudonymised TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  reviewed_by UUID,
  completed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dpo_erasure_status_chk CHECK (
    status IN ('RECEIVED', 'REVIEWING', 'PARTIALLY_COMPLETED', 'COMPLETED', 'DENIED')
  ),
  CONSTRAINT dpo_erasure_completed_chk CHECK (
    (status IN ('PARTIALLY_COMPLETED', 'COMPLETED', 'DENIED') AND completed_at IS NOT NULL)
    OR (status NOT IN ('PARTIALLY_COMPLETED', 'COMPLETED', 'DENIED') AND completed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS dpo_erasure_school_status_idx
  ON dpo_erasure_requests (school_id, status);

CREATE INDEX IF NOT EXISTS dpo_erasure_data_subject_idx
  ON dpo_erasure_requests (data_subject_id);

COMMENT ON TABLE dpo_erasure_requests IS
  'GDPR Article 17 erasure. 5-value status CHECK. Three TEXT[] columns capture the forensic trail of which categories were erased vs retained (with denial_basis) vs pseudonymised. Multi-column completed_chk pins terminal states to completed_at populated.';


CREATE TABLE IF NOT EXISTS dpo_processing_consent_records (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  data_subject_id UUID NOT NULL,
  processing_activity_id UUID NOT NULL,
  consented BOOLEAN NOT NULL,
  consent_given_at TIMESTAMPTZ,
  consent_withdrawn_at TIMESTAMPTZ,
  consent_method TEXT NOT NULL,
  evidence_s3_key TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dpo_consent_method_chk CHECK (consent_method IN ('DIGITAL', 'PAPER', 'VERBAL'))
);

CREATE INDEX IF NOT EXISTS dpo_consent_subject_idx
  ON dpo_processing_consent_records (data_subject_id, consented);

CREATE INDEX IF NOT EXISTS dpo_consent_activity_idx
  ON dpo_processing_consent_records (school_id, processing_activity_id, consented);

COMMENT ON TABLE dpo_processing_consent_records IS
  'Per-(data_subject, processing_activity) consent record. Both consent_given_at and consent_withdrawn_at populated means consent was given then revoked — the latest action wins per business rule. processing_activity_id soft FK to dpo_processing_activities(id).';


CREATE TABLE IF NOT EXISTS dpo_privacy_notices (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  notice_version TEXT NOT NULL,
  effective_from DATE NOT NULL,
  content_summary TEXT NOT NULL,
  document_s3_key TEXT NOT NULL,
  published_by UUID NOT NULL,
  published_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS dpo_privacy_school_version_uq
  ON dpo_privacy_notices (school_id, notice_version);

CREATE INDEX IF NOT EXISTS dpo_privacy_school_effective_idx
  ON dpo_privacy_notices (school_id, effective_from DESC);

CREATE INDEX IF NOT EXISTS dpo_privacy_school_current_idx
  ON dpo_privacy_notices (school_id, effective_from DESC) WHERE superseded_at IS NULL;

COMMENT ON TABLE dpo_privacy_notices IS
  'Version-controlled privacy notices. UNIQUE(school_id, notice_version). PrivacyNoticeService.publishNew stamps superseded_at on the prior current version atomically with the INSERT of the new version.';


CREATE TABLE IF NOT EXISTS dpo_pseudonymisation_log (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  erasure_request_id UUID NOT NULL REFERENCES dpo_erasure_requests(id) ON DELETE NO ACTION,
  data_subject_id UUID NOT NULL,
  target_table TEXT NOT NULL,
  target_field TEXT NOT NULL,
  rows_pseudonymised INT NOT NULL,
  pseudonymisation_token TEXT NOT NULL,
  pseudonymised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  pseudonymised_by UUID NOT NULL,
  notes TEXT,
  CONSTRAINT dpo_pseudo_rows_chk CHECK (rows_pseudonymised >= 0)
);

CREATE INDEX IF NOT EXISTS dpo_pseudo_erasure_idx
  ON dpo_pseudonymisation_log (erasure_request_id);

CREATE INDEX IF NOT EXISTS dpo_pseudo_subject_idx
  ON dpo_pseudonymisation_log (data_subject_id);

CREATE INDEX IF NOT EXISTS dpo_pseudo_token_idx
  ON dpo_pseudonymisation_log (pseudonymisation_token);

COMMENT ON TABLE dpo_pseudonymisation_log IS
  'IMMUTABLE per ADR-010 — service-side discipline (no UPDATE / no DELETE methods exposed). NO ACTION on erasure_request delete — the audit chain is preserved even when the user-facing erasure record is hard-deleted (admin must archive). Mirrors Cycle 8 tkt_ticket_activity + Cycle 10 hlth_health_access_log + Cycle 11 svc_referral_activity.';

COMMENT ON COLUMN dpo_pseudonymisation_log.pseudonymisation_token IS
  'Opaque identifier that replaced the data subject_id in the target_table.target_field. The chain back from the target row to the original subject is intentionally broken at the application layer.';


CREATE TABLE IF NOT EXISTS dpo_compliance_dashboard_config (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  sar_default_deadline_days INT NOT NULL DEFAULT 30,
  breach_escalation_hours INT NOT NULL DEFAULT 70,
  dpia_review_reminder_days INT NOT NULL DEFAULT 30,
  retention_review_reminder_days INT NOT NULL DEFAULT 60,
  dpa_review_reminder_days INT NOT NULL DEFAULT 90,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dpo_config_sar_chk CHECK (sar_default_deadline_days > 0),
  CONSTRAINT dpo_config_breach_chk CHECK (breach_escalation_hours > 0 AND breach_escalation_hours <= 72),
  CONSTRAINT dpo_config_dpia_chk CHECK (dpia_review_reminder_days >= 0),
  CONSTRAINT dpo_config_retention_chk CHECK (retention_review_reminder_days >= 0),
  CONSTRAINT dpo_config_dpa_chk CHECK (dpa_review_reminder_days >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS dpo_config_school_uq
  ON dpo_compliance_dashboard_config (school_id);

COMMENT ON TABLE dpo_compliance_dashboard_config IS
  'Per-school dashboard config. UNIQUE(school_id). breach_escalation_hours bounded at 72 because anything > 72 misses the GDPR window entirely.';
