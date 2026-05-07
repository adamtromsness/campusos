/*
  Cycle 30 Step 1 — ROPA + Retention + DPIA Schema (M120 DPO Compliance, ADR-052)

  Three foundation tables for the data governance surface:

  - dpo_processing_activities — GDPR Article 30 Register of Processing
    Activities. Each row documents one processing operation (purpose +
    legal_basis + data_categories + data_subjects + transfer model).
    Two key flags drive the compliance dashboard:
      * high_risk_processing — when true, a DPIA is required.
      * automated_decision_making + profiling — Article 22 indicators.
    The GAP RULE high_risk_processing=true AND dpia_id IS NULL surfaces
    on the DPO compliance dashboard as a red row.

  - dpo_retention_policies — per-(school, data_category) documentation of
    how long the school retains each category and the legal basis for
    retention. review_frequency is a 3-value CHECK. next_review_date
    drives the dashboard reminder when within retention_review_reminder_days.

  - dpo_dpias — GDPR Article 35 Data Protection Impact Assessment. 5-value
    status workflow SCOPING → IN_PROGRESS → COMPLETED → APPROVED/REJECTED.
    risks_identified JSONB carries the full risk register — residual_risk_level
    is the 3-value CHECK conclusion.

  Forward-compatible cross-table FKs: dpo_processing_activities has soft
  refs to dpo_retention_policies + dpo_dpias (both nullable, no DB FK
  yet — the migration order would otherwise force a circular dependency
  since dpo_dpias references dpo_processing_activities via its own
  processing_activity_id FK). Step 5 service validates both at
  application layer.

  No cross-schema FKs. school_id soft per ADR-001/020. reviewed_by /
  completed_by / approved_by all soft refs to platform_users(id).
*/

CREATE TABLE IF NOT EXISTS dpo_processing_activities (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  activity_name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  legal_basis TEXT NOT NULL,
  data_categories TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  data_subjects TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  retention_policy_id UUID,
  transfers_outside_uk_eea BOOLEAN NOT NULL DEFAULT false,
  transfer_safeguards TEXT,
  automated_decision_making BOOLEAN NOT NULL DEFAULT false,
  profiling BOOLEAN NOT NULL DEFAULT false,
  high_risk_processing BOOLEAN NOT NULL DEFAULT false,
  dpia_id UUID,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_reviewed_at DATE,
  reviewed_by UUID,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dpo_pa_legal_basis_chk CHECK (
    legal_basis IN ('LEGAL_OBLIGATION', 'PUBLIC_TASK', 'LEGITIMATE_INTERESTS', 'VITAL_INTERESTS', 'CONTRACT', 'CONSENT')
  ),
  CONSTRAINT dpo_pa_data_categories_nonempty_chk CHECK (cardinality(data_categories) > 0),
  CONSTRAINT dpo_pa_data_subjects_nonempty_chk CHECK (cardinality(data_subjects) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS dpo_pa_school_name_uq
  ON dpo_processing_activities (school_id, activity_name);

CREATE INDEX IF NOT EXISTS dpo_pa_school_active_idx
  ON dpo_processing_activities (school_id) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS dpo_pa_high_risk_no_dpia_idx
  ON dpo_processing_activities (school_id) WHERE high_risk_processing = true AND dpia_id IS NULL;

COMMENT ON TABLE dpo_processing_activities IS
  'GDPR Article 30 Register of Processing Activities (ROPA). UNIQUE(school_id, activity_name). The partial INDEX on high_risk_processing AND dpia_id IS NULL backs the DPO compliance dashboard gap query.';

COMMENT ON COLUMN dpo_processing_activities.legal_basis IS
  '6-value CHECK aligned to GDPR Article 6(1): LEGAL_OBLIGATION (a), PUBLIC_TASK (e), LEGITIMATE_INTERESTS (f), VITAL_INTERESTS (d), CONTRACT (b), CONSENT (a).';

COMMENT ON COLUMN dpo_processing_activities.dpia_id IS
  'Soft FK to dpo_dpias(id) — kept soft to avoid the circular dependency with dpo_dpias.processing_activity_id which references this table. ProcessingActivityService validates existence at application layer.';

COMMENT ON COLUMN dpo_processing_activities.retention_policy_id IS
  'Soft FK to dpo_retention_policies(id). Nullable when an activity has no documented retention.';


CREATE TABLE IF NOT EXISTS dpo_retention_policies (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  data_category TEXT NOT NULL,
  retention_period TEXT NOT NULL,
  legal_basis_for_retention TEXT NOT NULL,
  review_frequency TEXT NOT NULL DEFAULT 'ANNUAL',
  last_reviewed_at DATE,
  next_review_date DATE NOT NULL,
  reviewed_by UUID,
  links_to_archive_tier TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dpo_rp_review_freq_chk CHECK (review_frequency IN ('ANNUAL', 'BIENNIAL', 'ON_CHANGE'))
);

CREATE UNIQUE INDEX IF NOT EXISTS dpo_rp_school_category_uq
  ON dpo_retention_policies (school_id, data_category);

CREATE INDEX IF NOT EXISTS dpo_rp_next_review_idx
  ON dpo_retention_policies (school_id, next_review_date);

COMMENT ON TABLE dpo_retention_policies IS
  'Per-(school, data_category) retention documentation. UNIQUE(school_id, data_category) so each data category carries exactly one policy per school. next_review_date drives the dashboard reminder.';


CREATE TABLE IF NOT EXISTS dpo_dpias (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  processing_activity_id UUID,
  dpia_title TEXT NOT NULL,
  trigger_reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SCOPING',
  description_of_processing TEXT NOT NULL,
  necessity_proportionality_assessment TEXT,
  risks_identified JSONB NOT NULL DEFAULT '[]'::jsonb,
  residual_risk_level TEXT,
  dpo_opinion TEXT,
  supervisory_authority_consultation_required BOOLEAN NOT NULL DEFAULT false,
  completed_at DATE,
  completed_by UUID,
  approved_by UUID,
  document_s3_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dpo_dpia_status_chk CHECK (status IN ('SCOPING', 'IN_PROGRESS', 'COMPLETED', 'APPROVED', 'REJECTED')),
  CONSTRAINT dpo_dpia_residual_risk_chk CHECK (residual_risk_level IS NULL OR residual_risk_level IN ('LOW', 'MEDIUM', 'HIGH'))
);

CREATE INDEX IF NOT EXISTS dpo_dpia_school_status_idx
  ON dpo_dpias (school_id, status);

CREATE INDEX IF NOT EXISTS dpo_dpia_processing_activity_idx
  ON dpo_dpias (processing_activity_id) WHERE processing_activity_id IS NOT NULL;

COMMENT ON TABLE dpo_dpias IS
  'GDPR Article 35 Data Protection Impact Assessment. 5-value status workflow. processing_activity_id is a soft FK (kept soft for circular-dependency avoidance with dpo_processing_activities.dpia_id). risks_identified JSONB shape: array of {risk_description, likelihood, severity, mitigation_measures}.';

COMMENT ON COLUMN dpo_dpias.processing_activity_id IS
  'Soft FK to dpo_processing_activities(id). DPIAService validates the supplied id at application layer.';
