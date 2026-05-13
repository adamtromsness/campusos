/*
 * 163_eng_scores_surveys.sql — P2-24a Step 2.
 *
 * Parent Engagement Module (M100) — engagement scoring + survey tables.
 *
 *   eng_family_engagement_scores  Materialised per-(family, score_date)
 *                                 composite engagement score from 5
 *                                 cross-module source aggregates:
 *                                 attendance (school event attendance),
 *                                 communication (msg read rate),
 *                                 conference (PTCs attended over offered),
 *                                 volunteer (confirmed volunteer hours),
 *                                 payment (on-time payment rate).
 *                                 4 value engagement_level CHECK
 *                                 HIGHLY_ENGAGED / ENGAGED / MINIMAL /
 *                                 AT_RISK derived from composite_score
 *                                 thresholds configurable via
 *                                 platform_tenant_configs key
 *                                 engagement_level_thresholds. UNIQUE on
 *                                 (family_account_id, score_date) so the
 *                                 EngagementScoreWorker UPSERTs idempotently
 *                                 on weekly re-materialisation. No
 *                                 individual student data — aggregated at
 *                                 the family level so the dashboard can
 *                                 surface relationship health without
 *                                 leaking per-child detail.
 *
 *   eng_parent_surveys           Per-school satisfaction / feedback survey.
 *                                3 value status CHECK DRAFT / OPEN /
 *                                CLOSED. questions JSONB array of
 *                                {question_text, question_type, options}.
 *                                5 value question_type implied by the
 *                                application layer (RATING_1_5,
 *                                RATING_1_10, YES_NO, FREE_TEXT,
 *                                MULTIPLE_CHOICE) with no DB CHECK
 *                                because the JSONB shape is validated
 *                                in the service. is_anonymous BOOLEAN
 *                                drives a STRICT contract — when true,
 *                                respondent_id MUST NOT be stored on
 *                                any response row. Individual responses
 *                                live in a separate responses JSONB
 *                                array within the survey record with
 *                                respondent_id always NULL on anonymous
 *                                surveys (the schema enforces this
 *                                contract at the service layer because
 *                                the JSON shape changes between
 *                                anonymous and identified surveys).
 *                                response_data_aggregated JSONB stores
 *                                per-question rollups never individual
 *                                responses. Emits eng.survey.opened on
 *                                DRAFT to OPEN transition.
 *
 * FK summary (intra tenant only, 0 cross schema FK constraints):
 *   eng_family_engagement_scores.family_account_id  pay_family_accounts(id) NO ACTION
 *
 * All other cross schema refs (created_by, respondent_id when present
 * on identified surveys) are soft per ADR-001/020.
 *
 * Splitter discipline — no semicolons inside string literals, default
 * expressions, COMMENT bodies, CHECK predicates, or block comments.
 * Idempotent — safe to re-run.
 */


CREATE TABLE IF NOT EXISTS eng_family_engagement_scores (
  id                              UUID PRIMARY KEY,
  school_id                       UUID NOT NULL,
  family_account_id               UUID NOT NULL,
  score_date                      DATE NOT NULL,
  composite_score                 INT NOT NULL,
  attendance_component            INT,
  communication_component         INT,
  conference_component            INT,
  volunteer_component             INT,
  payment_component               INT,
  engagement_level                TEXT NOT NULL,
  component_weights               JSONB,
  notes                           TEXT,
  computed_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT eng_family_engagement_scores_composite_chk CHECK (
    composite_score >= 0 AND composite_score <= 100
  ),
  CONSTRAINT eng_family_engagement_scores_components_chk CHECK (
    (attendance_component    IS NULL OR (attendance_component    >= 0 AND attendance_component    <= 100))
    AND
    (communication_component IS NULL OR (communication_component >= 0 AND communication_component <= 100))
    AND
    (conference_component    IS NULL OR (conference_component    >= 0 AND conference_component    <= 100))
    AND
    (volunteer_component     IS NULL OR (volunteer_component     >= 0 AND volunteer_component     <= 100))
    AND
    (payment_component       IS NULL OR (payment_component       >= 0 AND payment_component       <= 100))
  ),
  CONSTRAINT eng_family_engagement_scores_level_chk CHECK (
    engagement_level IN ('HIGHLY_ENGAGED', 'ENGAGED', 'MINIMAL', 'AT_RISK')
  ),
  CONSTRAINT eng_family_engagement_scores_family_fkey FOREIGN KEY (family_account_id)
    REFERENCES pay_family_accounts(id) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS eng_family_engagement_scores_family_date_uq
  ON eng_family_engagement_scores (family_account_id, score_date);

CREATE INDEX IF NOT EXISTS eng_family_engagement_scores_school_level_idx
  ON eng_family_engagement_scores (school_id, engagement_level, score_date DESC);

CREATE INDEX IF NOT EXISTS eng_family_engagement_scores_school_date_idx
  ON eng_family_engagement_scores (school_id, score_date DESC);

CREATE INDEX IF NOT EXISTS eng_family_engagement_scores_at_risk_idx
  ON eng_family_engagement_scores (school_id, score_date DESC)
  WHERE engagement_level = 'AT_RISK';

COMMENT ON TABLE eng_family_engagement_scores IS
  'P2-24 — Materialised per-(family, score_date) composite engagement score from 5 cross-module source aggregates. 4 value engagement_level CHECK derived from composite_score via configurable thresholds. UNIQUE(family_account_id, score_date) backs idempotent UPSERT by EngagementScoreWorker. family_account_id is a real DB FK to pay_family_accounts(id) NO ACTION because dropping a family account with engagement history would silently lose audit. component_weights JSONB captures the snapshot of weights used at materialisation time so a future weights change does not invalidate historical scores.';


CREATE TABLE IF NOT EXISTS eng_parent_surveys (
  id                              UUID PRIMARY KEY,
  school_id                       UUID NOT NULL,
  title                           TEXT NOT NULL,
  description                     TEXT,
  questions                       JSONB NOT NULL,
  is_anonymous                    BOOLEAN NOT NULL DEFAULT true,
  opens_at                        TIMESTAMPTZ,
  closes_at                       TIMESTAMPTZ,
  status                          TEXT NOT NULL DEFAULT 'DRAFT',
  total_responses                 INT NOT NULL DEFAULT 0,
  response_data_aggregated        JSONB,
  responses                       JSONB,
  created_by                      UUID NOT NULL,
  opened_at                       TIMESTAMPTZ,
  closed_at                       TIMESTAMPTZ,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT eng_parent_surveys_status_chk CHECK (
    status IN ('DRAFT', 'OPEN', 'CLOSED')
  ),
  CONSTRAINT eng_parent_surveys_title_chk CHECK (length(trim(title)) > 0),
  CONSTRAINT eng_parent_surveys_questions_array_chk CHECK (
    jsonb_typeof(questions) = 'array' AND jsonb_array_length(questions) > 0
  ),
  CONSTRAINT eng_parent_surveys_responses_array_chk CHECK (
    responses IS NULL OR jsonb_typeof(responses) = 'array'
  ),
  CONSTRAINT eng_parent_surveys_total_chk CHECK (total_responses >= 0),
  CONSTRAINT eng_parent_surveys_window_chk CHECK (
    closes_at IS NULL OR opens_at IS NULL OR closes_at > opens_at
  )
);

CREATE INDEX IF NOT EXISTS eng_parent_surveys_school_status_idx
  ON eng_parent_surveys (school_id, status);

CREATE INDEX IF NOT EXISTS eng_parent_surveys_school_created_idx
  ON eng_parent_surveys (school_id, created_at DESC);

CREATE INDEX IF NOT EXISTS eng_parent_surveys_open_idx
  ON eng_parent_surveys (school_id, opens_at)
  WHERE status = 'OPEN';

COMMENT ON TABLE eng_parent_surveys IS
  'P2-24 — Per-school parent satisfaction / feedback survey. 3 value status CHECK DRAFT / OPEN / CLOSED. questions JSONB array of {question_text, question_type, options} validated at the service layer. is_anonymous BOOLEAN drives the STRICT respondent contract — when true, responses[] rows MUST omit respondent_id. response_data_aggregated JSONB stores per-question rollups (averages for ratings, counts for multiple choice, never raw free text). Emits eng.survey.opened on DRAFT to OPEN transition. created_by soft to platform.platform_users per ADR-001/020.';
