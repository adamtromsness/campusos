/* 169_pfl_readiness_pathways.sql
 * Phase 2 Cycle 27 — Portfolio Advanced Step 2. Post-Secondary
 * Readiness — 3 tenant tables backing ACH-003.
 *
 *   pfl_readiness_pathways         School-defined post-secondary
 *                                  pathway with 5-value pathway_type
 *                                  CHECK (COLLEGE_PREP, CAREER_
 *                                  TECHNICAL, ARTS_CONSERVATORY,
 *                                  MILITARY, GENERAL). is_active flag
 *                                  for soft deactivation. UNIQUE(
 *                                  school_id, name).
 *
 *   pfl_pathway_milestones         Ordered milestones within a
 *                                  pathway. 6-value category CHECK
 *                                  (ACADEMIC, TESTING, SERVICE,
 *                                  APPLICATION, FINANCIAL_AID,
 *                                  OTHER). is_required determines
 *                                  whether the milestone counts in
 *                                  overall_progress. auto_check_source
 *                                  is the cross-module hook —
 *                                  "graduation_audit:SERVICE_HOURS"
 *                                  auto-completes when P2-13 service
 *                                  learning passes — "transcript:
 *                                  GENERATED" auto-completes when the
 *                                  P2-13 transcript fires. The Step 6
 *                                  MilestoneAutoCheckWorker subscribes
 *                                  to sis.service_learning.approved +
 *                                  sis.transcript.generated and walks
 *                                  pfl_student_pathway_assignments
 *                                  rows whose milestone matches
 *                                  auto_check_source. UNIQUE(
 *                                  pathway_id, milestone_name).
 *                                  CASCADE on pathway_id.
 *
 *   pfl_student_pathway_assignments  One row per (student, pathway).
 *                                  UNIQUE(student_id, pathway_id).
 *                                  milestone_statuses JSONB holds
 *                                  one entry per milestone: {
 *                                  milestone_id, status: NOT_STARTED|
 *                                  IN_PROGRESS|COMPLETED, completed_at,
 *                                  notes, progress_detail}.
 *                                  overall_progress NUMERIC(5,2) is
 *                                  the computed completion percentage
 *                                  (completed_required / total_required
 *                                  × 100). The Step 6 service
 *                                  recomputes on every milestone
 *                                  status change and emits
 *                                  pfl.pathway.milestone_completed
 *                                  when a milestone transitions to
 *                                  COMPLETED. 3-value status CHECK
 *                                  (ACTIVE, COMPLETED, WITHDRAWN).
 *
 * 4 intra-tenant DB-enforced FKs (1 CASCADE on milestones.pathway_id,
 * 1 CASCADE on assignments.pathway_id, 1 NO ACTION on assignments.
 * assigned_by to hr_employees so audit survives the counsellor
 * leaving). 0 cross-schema FKs.
 *
 * Splitter-safe — no semicolons inside string literals or block
 * comments. Idempotent — re-runs are a no-op.
 */

/* ─── 1. pfl_readiness_pathways ─── */

CREATE TABLE IF NOT EXISTS pfl_readiness_pathways (
  id              UUID         PRIMARY KEY,
  school_id       UUID         NOT NULL,
  name            TEXT         NOT NULL,
  description     TEXT,
  pathway_type    TEXT         NOT NULL,
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT pfl_pathway_type_chk CHECK (
    pathway_type IN ('COLLEGE_PREP', 'CAREER_TECHNICAL', 'ARTS_CONSERVATORY', 'MILITARY', 'GENERAL')
  ),
  CONSTRAINT pfl_pathway_uq UNIQUE (school_id, name)
);

CREATE INDEX IF NOT EXISTS pfl_pathway_school_idx
  ON pfl_readiness_pathways (school_id, is_active);

COMMENT ON TABLE pfl_readiness_pathways IS
  'Cycle 27 P2-27 Step 2 — school-defined post-secondary pathway. UNIQUE(school_id, name) so each school names its pathways uniquely. is_active for soft deactivation — admins inactivate rather than delete a pathway that has historical student assignments. 5-value pathway_type CHECK covers COLLEGE_PREP / CAREER_TECHNICAL / ARTS_CONSERVATORY / MILITARY / GENERAL.';

COMMENT ON COLUMN pfl_readiness_pathways.pathway_type IS
  '5-value CHECK. COLLEGE_PREP for 4-year college applicants. CAREER_TECHNICAL for vocational / trade paths. ARTS_CONSERVATORY for specialised arts schools. MILITARY for service academy + enlistment paths. GENERAL for undecided or hybrid.';

/* ─── 2. pfl_pathway_milestones ─── */

CREATE TABLE IF NOT EXISTS pfl_pathway_milestones (
  id                    UUID         PRIMARY KEY,
  pathway_id            UUID         NOT NULL,
  milestone_name        TEXT         NOT NULL,
  description           TEXT,
  category              TEXT         NOT NULL,
  sort_order            INT          NOT NULL,
  is_required           BOOLEAN      NOT NULL DEFAULT true,
  auto_check_source     TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT pfl_milestone_pathway_fk FOREIGN KEY (pathway_id)
    REFERENCES pfl_readiness_pathways(id) ON DELETE CASCADE,
  CONSTRAINT pfl_milestone_uq UNIQUE (pathway_id, milestone_name),
  CONSTRAINT pfl_milestone_category_chk CHECK (
    category IN ('ACADEMIC', 'TESTING', 'SERVICE', 'APPLICATION', 'FINANCIAL_AID', 'OTHER')
  )
);

CREATE INDEX IF NOT EXISTS pfl_milestone_pathway_idx
  ON pfl_pathway_milestones (pathway_id, sort_order);

CREATE INDEX IF NOT EXISTS pfl_milestone_auto_check_idx
  ON pfl_pathway_milestones (auto_check_source)
  WHERE auto_check_source IS NOT NULL;

COMMENT ON TABLE pfl_pathway_milestones IS
  'Cycle 27 P2-27 Step 2 — ordered milestones within a readiness pathway. UNIQUE(pathway_id, milestone_name) so each pathway names its milestones uniquely. CASCADE on pathway_id since a milestone is meaningless without its pathway. 6-value category CHECK (ACADEMIC / TESTING / SERVICE / APPLICATION / FINANCIAL_AID / OTHER). is_required determines whether the milestone counts in overall_progress.';

COMMENT ON COLUMN pfl_pathway_milestones.auto_check_source IS
  'Cross-module hook for the Step 6 MilestoneAutoCheckWorker. Format: <module>:<event-type> — e.g. graduation_audit:SERVICE_HOURS auto-completes when the P2-13 service learning requirement is met. transcript:GENERATED auto-completes when a P2-13 transcript is created. The worker subscribes to the matching Kafka topic and walks pfl_student_pathway_assignments to flip matching milestones to COMPLETED inside one tenant tx.';

/* ─── 3. pfl_student_pathway_assignments ─── */

CREATE TABLE IF NOT EXISTS pfl_student_pathway_assignments (
  id                    UUID            PRIMARY KEY,
  student_id            UUID            NOT NULL,
  pathway_id            UUID            NOT NULL,
  assigned_by           UUID            NOT NULL,
  assigned_at           TIMESTAMPTZ     NOT NULL DEFAULT now(),
  milestone_statuses    JSONB           NOT NULL DEFAULT '[]'::jsonb,
  overall_progress      NUMERIC(5,2)    DEFAULT 0,
  status                TEXT            NOT NULL DEFAULT 'ACTIVE',
  notes                 TEXT,
  updated_at            TIMESTAMPTZ     NOT NULL DEFAULT now(),
  CONSTRAINT pfl_assignment_pathway_fk FOREIGN KEY (pathway_id)
    REFERENCES pfl_readiness_pathways(id) ON DELETE CASCADE,
  CONSTRAINT pfl_assignment_assigned_by_fk FOREIGN KEY (assigned_by)
    REFERENCES hr_employees(id) ON DELETE NO ACTION,
  CONSTRAINT pfl_assignment_uq UNIQUE (student_id, pathway_id),
  CONSTRAINT pfl_assignment_status_chk CHECK (
    status IN ('ACTIVE', 'COMPLETED', 'WITHDRAWN')
  ),
  CONSTRAINT pfl_assignment_progress_chk CHECK (
    overall_progress IS NULL OR (overall_progress >= 0 AND overall_progress <= 100)
  )
);

CREATE INDEX IF NOT EXISTS pfl_assignment_student_idx
  ON pfl_student_pathway_assignments (student_id, status);

CREATE INDEX IF NOT EXISTS pfl_assignment_pathway_idx
  ON pfl_student_pathway_assignments (pathway_id, status);

COMMENT ON TABLE pfl_student_pathway_assignments IS
  'Cycle 27 P2-27 Step 2 — one row per (student, pathway). UNIQUE(student_id, pathway_id). milestone_statuses JSONB holds one entry per milestone with the documented shape. overall_progress is the computed percentage of completed required milestones — the Step 6 ReadinessPathwayService recomputes on every milestone status change. 3-value status CHECK ACTIVE / COMPLETED / WITHDRAWN. NO ACTION on assigned_by — schools must reassign or close out a counsellors caseload before removing the hr_employees row.';

COMMENT ON COLUMN pfl_student_pathway_assignments.milestone_statuses IS
  'JSONB array of milestone status entries. Each entry: {milestone_id, status: NOT_STARTED|IN_PROGRESS|COMPLETED, completed_at, notes, progress_detail}. The Step 6 service initialises this array from pfl_pathway_milestones at assignment time and updates entries in place via individual PATCH calls. overall_progress recomputes on every change.';

COMMENT ON COLUMN pfl_student_pathway_assignments.overall_progress IS
  'Computed percentage of completed required milestones over total required milestones (completed_required / total_required × 100), bounded to [0, 100] by the progress_chk. Recomputed inside the same tenant tx that updates milestone_statuses. Drives the counsellor readiness dashboard sort.';
