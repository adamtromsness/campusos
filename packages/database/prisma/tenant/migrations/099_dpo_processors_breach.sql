/*
  Cycle 30 Step 2 — Processors + DPAs + Breach Records (M120 DPO, ADR-052)

  Three tables that drive the third-party-processor surface + the
  72-hour breach notification keystone:

  - dpo_third_party_processors — GDPR Article 28 register of every
    processor a school engages. 9-value processor_type CHECK + 4-value
    transfer_mechanism CHECK. The GAP RULE dpa_in_place=false surfaces
    on the DPO compliance dashboard as a red row.

  - dpo_data_processing_agreements — per-processor DPA documents +
    review tracking. 4-value status CHECK DRAFT/ACTIVE/EXPIRED/TERMINATED.
    DB-enforced FK to dpo_third_party_processors with ON DELETE CASCADE
    because a DPA without its processor is unaddressable.

  - dpo_data_breach_records — THE 72-HOUR COUNTDOWN KEYSTONE.
    On INSERT with supervisory_authority_notification_required=true,
    the Cycle 7 TaskWorker creates an URGENT escalating task with a
    72-hour deadline and the dpo.breach.discovered Kafka envelope fires
    AFTER tx commits. 8-value breach_type CHECK + 4-value risk_level
    CHECK + 4-value risk_to_individuals CHECK + 4-value status CHECK.
    Multi-column resolved_chk keeps (is_resolved, resolved_at) in
    lockstep — RESOLVED status requires both populated, every other
    state requires resolved_at NULL.

  No cross-schema FKs. school_id soft per ADR-001/020. reported_by /
  signed_by soft refs to platform_users(id).
*/

CREATE TABLE IF NOT EXISTS dpo_third_party_processors (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  processor_name TEXT NOT NULL,
  processor_type TEXT NOT NULL,
  registered_country TEXT NOT NULL,
  data_categories_processed TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  dpa_in_place BOOLEAN NOT NULL DEFAULT false,
  dpa_id UUID,
  adequacy_decision_applicable BOOLEAN NOT NULL DEFAULT false,
  transfer_mechanism TEXT,
  last_reviewed_at DATE,
  next_review_date DATE NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dpo_proc_type_chk CHECK (
    processor_type IN ('CLOUD_INFRASTRUCTURE', 'PAYMENT_PROCESSOR', 'AI_PROVIDER', 'MDM_PROVIDER',
                       'VIDEO_CONFERENCING', 'EMAIL_PROVIDER', 'IDENTITY_PROVIDER', 'ANALYTICS', 'OTHER')
  ),
  CONSTRAINT dpo_proc_transfer_chk CHECK (
    transfer_mechanism IS NULL OR transfer_mechanism IN ('ADEQUACY_DECISION', 'SCCs', 'BCRs', 'DEROGATION')
  ),
  CONSTRAINT dpo_proc_categories_nonempty_chk CHECK (cardinality(data_categories_processed) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS dpo_proc_school_name_uq
  ON dpo_third_party_processors (school_id, processor_name);

CREATE INDEX IF NOT EXISTS dpo_proc_dpa_gap_idx
  ON dpo_third_party_processors (school_id) WHERE dpa_in_place = false;

CREATE INDEX IF NOT EXISTS dpo_proc_next_review_idx
  ON dpo_third_party_processors (school_id, next_review_date);

COMMENT ON TABLE dpo_third_party_processors IS
  'GDPR Article 28 third-party processor register. UNIQUE(school_id, processor_name). The partial INDEX on dpa_in_place=false backs the DPO compliance dashboard DPA-gap query.';

COMMENT ON COLUMN dpo_third_party_processors.dpa_id IS
  'Soft FK to dpo_data_processing_agreements(id) — kept soft to avoid the circular dependency with that table.';


CREATE TABLE IF NOT EXISTS dpo_data_processing_agreements (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  processor_id UUID NOT NULL REFERENCES dpo_third_party_processors(id) ON DELETE CASCADE,
  agreement_reference TEXT NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  document_s3_key TEXT NOT NULL,
  sub_processors_disclosed BOOLEAN NOT NULL DEFAULT false,
  sub_processor_list_s3_key TEXT,
  review_date DATE NOT NULL,
  signed_by UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dpo_dpa_status_chk CHECK (status IN ('DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED')),
  CONSTRAINT dpo_dpa_dates_chk CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS dpo_dpa_processor_status_idx
  ON dpo_data_processing_agreements (processor_id, status);

CREATE INDEX IF NOT EXISTS dpo_dpa_school_review_idx
  ON dpo_data_processing_agreements (school_id, review_date);

COMMENT ON TABLE dpo_data_processing_agreements IS
  'Per-processor DPA documents. CASCADE on processor delete — a DPA without its processor is unaddressable. document_s3_key is the signed-PDF path. sub_processor_list_s3_key carries the disclosed sub-processor list when sub_processors_disclosed=true.';


CREATE TABLE IF NOT EXISTS dpo_data_breach_records (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  breach_title TEXT NOT NULL,
  breach_type TEXT NOT NULL,
  discovery_date TIMESTAMPTZ NOT NULL,
  breach_start_date DATE,
  personal_data_categories_involved TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  estimated_affected_individuals INT,
  risk_level TEXT NOT NULL,
  risk_to_individuals TEXT NOT NULL,
  supervisory_authority_notification_required BOOLEAN NOT NULL DEFAULT false,
  supervisory_authority_notified_at TIMESTAMPTZ,
  supervisory_authority_reference TEXT,
  data_subjects_notification_required BOOLEAN NOT NULL DEFAULT false,
  data_subjects_notified_at TIMESTAMPTZ,
  breach_cause TEXT NOT NULL,
  remediation_actions TEXT NOT NULL,
  is_resolved BOOLEAN NOT NULL DEFAULT false,
  resolved_at TIMESTAMPTZ,
  reported_by UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNDER_INVESTIGATION',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dpo_breach_type_chk CHECK (
    breach_type IN ('UNAUTHORISED_ACCESS', 'ACCIDENTAL_DISCLOSURE', 'RANSOMWARE', 'THEFT',
                    'LOSS_OF_DEVICE', 'SYSTEM_MISCONFIGURATION', 'THIRD_PARTY_BREACH', 'OTHER')
  ),
  CONSTRAINT dpo_breach_risk_level_chk CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH')),
  CONSTRAINT dpo_breach_risk_to_chk CHECK (risk_to_individuals IN ('UNLIKELY', 'POSSIBLE', 'LIKELY', 'VERY_LIKELY')),
  CONSTRAINT dpo_breach_status_chk CHECK (status IN ('UNDER_INVESTIGATION', 'NOTIFIED', 'CONTAINED', 'RESOLVED')),
  CONSTRAINT dpo_breach_categories_nonempty_chk CHECK (cardinality(personal_data_categories_involved) > 0),
  CONSTRAINT dpo_breach_affected_chk CHECK (estimated_affected_individuals IS NULL OR estimated_affected_individuals >= 0),
  CONSTRAINT dpo_breach_resolved_chk CHECK (
    (status = 'RESOLVED' AND is_resolved = true AND resolved_at IS NOT NULL)
    OR (status <> 'RESOLVED' AND is_resolved = false AND resolved_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS dpo_breach_school_status_idx
  ON dpo_data_breach_records (school_id, status);

CREATE INDEX IF NOT EXISTS dpo_breach_pending_notification_idx
  ON dpo_data_breach_records (discovery_date)
  WHERE supervisory_authority_notification_required = true AND supervisory_authority_notified_at IS NULL;

COMMENT ON TABLE dpo_data_breach_records IS
  '72-HOUR COUNTDOWN KEYSTONE. discovery_date starts the GDPR Article 33 supervisory authority notification window. Multi-column resolved_chk pins (status, is_resolved, resolved_at) in lockstep. Partial INDEX on pending notifications backs the dashboard countdown query.';

COMMENT ON COLUMN dpo_data_breach_records.discovery_date IS
  'GDPR Article 33 clock starts here. Cycle 7 TaskWorker creates an URGENT 72-hour task on INSERT when supervisory_authority_notification_required=true. dpo.breach.discovered Kafka envelope fires AFTER tx commits.';
