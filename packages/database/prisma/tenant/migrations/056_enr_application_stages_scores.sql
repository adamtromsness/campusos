/* 056_enr_application_stages_scores.sql
 * Cycle 16 Step 2 — M81 Enrolment. Multi-stage application review
 * with immutable audit trail and per-criterion scoring for ranked
 * selection. Plus extends the enr_applications status CHECK to
 * accept INTERVIEW + ASSESSMENT + OFFERED so the Step 6
 * ApplicationStageService can drive the full review pipeline the
 * Cycle 16 plan specifies.
 *
 * Tables (2):
 *   enr_application_stages   IMMUTABLE per ADR-010. Service-side
 *                            discipline. No UPDATE no DELETE.
 *                            Records every status transition.
 *   enr_application_scores   Per-criterion scoring with
 *                            UNIQUE(application, criterion) so
 *                            re-scoring updates the existing row.
 *
 * Status enum extension. Cycle 6 shipped the 8-value CHECK
 * DRAFT/SUBMITTED/UNDER_REVIEW/ACCEPTED/REJECTED/WAITLISTED/
 * WITHDRAWN/ENROLLED. Cycle 16 extends to 11 values by adding
 * INTERVIEW + ASSESSMENT + OFFERED so the EO can drive the
 * intermediate review stages the plan describes. The Cycle 6 values
 * stay valid so existing rows continue to satisfy the constraint.
 *
 * Splitter discipline. This file is splitter-clean per the
 * Cycles 4-15 unbroken streak. Comment text contains no
 * statement-terminator characters.
 */

ALTER TABLE enr_applications DROP CONSTRAINT IF EXISTS enr_applications_status_chk;

ALTER TABLE enr_applications
  ADD CONSTRAINT enr_applications_status_chk CHECK (status IN (
    'DRAFT','SUBMITTED','UNDER_REVIEW','INTERVIEW','ASSESSMENT',
    'OFFERED','ACCEPTED','REJECTED','WAITLISTED','WITHDRAWN','ENROLLED'
  ));

CREATE TABLE IF NOT EXISTS enr_application_stages (
  id             UUID PRIMARY KEY,
  application_id UUID NOT NULL REFERENCES enr_applications(id) ON DELETE CASCADE,
  from_status    TEXT,
  to_status      TEXT NOT NULL,
  changed_by     UUID NOT NULL,
  notes          TEXT,
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS enr_application_stages_application_idx
  ON enr_application_stages (application_id, changed_at ASC);

COMMENT ON TABLE enr_application_stages IS
  'Cycle 16 Step 2. IMMUTABLE per ADR-010. Service-side discipline. The Step 6 ApplicationStageService.advance writes one row per status transition inside the same tenant tx that flips enr_applications.status. No UPDATE no DELETE.';

CREATE TABLE IF NOT EXISTS enr_application_scores (
  id             UUID PRIMARY KEY,
  application_id UUID NOT NULL REFERENCES enr_applications(id) ON DELETE CASCADE,
  criterion_name TEXT NOT NULL,
  score          NUMERIC(5,2) NOT NULL,
  max_score      NUMERIC(5,2),
  scored_by      UUID NOT NULL,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT enr_application_scores_application_criterion_uq UNIQUE (application_id, criterion_name),
  CONSTRAINT enr_application_scores_score_chk CHECK (score >= 0),
  CONSTRAINT enr_application_scores_max_chk CHECK (max_score IS NULL OR max_score >= score)
);

CREATE INDEX IF NOT EXISTS enr_application_scores_application_idx
  ON enr_application_scores (application_id);

COMMENT ON TABLE enr_application_scores IS
  'Cycle 16 Step 2. Per-criterion scoring. UNIQUE(application_id, criterion_name) so re-scoring a criterion updates the existing row. The Step 7 OfferService aggregates scores into waitlist priority_score on WAITLISTED transitions.';
