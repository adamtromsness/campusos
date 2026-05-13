/*
 * 161_acc_evidence_selfstudy.sql — P2-23a Step 2.
 *
 * Accreditation Module (M85) — tenant tables. 6 of the 8 P2-23 tables
 * live here (the 2 platform tables — acc_frameworks_platform and
 * acc_standards_platform — ship in the Prisma platform migration
 * 20260513051400_add_p2c23_accreditation_platform_tables).
 *
 *   acc_school_framework_adoptions  Per-school adoption of a platform
 *                                   framework. UNIQUE(school_id,
 *                                   platform_framework_id) so a school
 *                                   adopts each framework at most once.
 *                                   A school can adopt multiple
 *                                   frameworks (e.g. AdvancED + IB)
 *                                   and own ratings/evidence under
 *                                   each. platform_framework_id is a
 *                                   soft ref to
 *                                   platform.acc_frameworks_platform
 *                                   per ADR-001/020.
 *
 *   acc_frameworks                  School-created custom framework
 *                                   (no platform analogue). For
 *                                   in-house standards a school wants
 *                                   to track outside the adopted
 *                                   external framework. UNIQUE(school,
 *                                   name).
 *
 *   acc_evidence_items              Evidence linked to a standard.
 *                                   standard_id is SOFT INTEGRITY —
 *                                   resolves to EITHER
 *                                   acc_standards_platform OR a custom
 *                                   standard within an acc_frameworks
 *                                   row at read time. 5 value
 *                                   evidence_type CHECK DOCUMENT / URL
 *                                   / METRIC / OBSERVATION / SURVEY.
 *                                   4 value status CHECK DRAFT /
 *                                   SUBMITTED / APPROVED / REJECTED.
 *                                   Multi column reviewed_chk pins
 *                                   reviewed_by + reviewed_at + status
 *                                   in lockstep — DRAFT/SUBMITTED
 *                                   require both NULL, APPROVED and
 *                                   REJECTED require both NOT NULL.
 *
 *   acc_self_study_ratings          Coordinator rating per standard
 *                                   per cycle. UNIQUE(standard_id,
 *                                   school_id, cycle_id) so a school
 *                                   carries exactly one rating per
 *                                   standard per cycle. 4 value rating
 *                                   CHECK EXEMPLARY / ACCOMPLISHED /
 *                                   DEVELOPING / NOT_MET. rationale
 *                                   NOT NULL because every rating must
 *                                   carry a written justification for
 *                                   the accrediting body.
 *
 *   acc_action_plans                Improvement plan for a standard.
 *                                   actions JSONB array of
 *                                   {description, due_date, status}.
 *                                   4 value status CHECK PLANNED /
 *                                   IN_PROGRESS / COMPLETE / OVERDUE.
 *                                   ActionPlanOverdueWorker flips
 *                                   IN_PROGRESS to OVERDUE when
 *                                   target_date < CURRENT_DATE and
 *                                   emits acc.action_plan.overdue.
 *                                   responsible_party FK to hr_employees
 *                                   ON DELETE NO ACTION — refuse to
 *                                   drop a staff member who owns
 *                                   active accreditation work.
 *
 *   acc_site_visit_prep             Site visit readiness. 3 value
 *                                   status CHECK PREPARING / READY /
 *                                   VISIT_COMPLETE. readiness_score
 *                                   NUMERIC(3,0) 0 to 100, cached by
 *                                   SiteVisitService.recomputeReadiness.
 *                                   Formula — % of adopted standards
 *                                   with BOTH a self_study_rating for
 *                                   the cycle AND at least one APPROVED
 *                                   evidence item. created_by soft to
 *                                   platform.platform_users per
 *                                   ADR-001/020.
 *
 * FK summary (intra tenant only, 0 cross schema FK constraints):
 *   acc_action_plans.responsible_party  hr_employees(id) NO ACTION
 *
 * All cross schema refs (platform_framework_id, submitted_by,
 * reviewed_by, rated_by, created_by) are soft per ADR-001/020.
 *
 * Splitter discipline — no semicolons inside string literals, default
 * expressions, COMMENT bodies, CHECK predicates, or block comments.
 * Idempotent — safe to re-run.
 */


CREATE TABLE IF NOT EXISTS acc_school_framework_adoptions (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  platform_framework_id    UUID NOT NULL,
  adopted_at               DATE NOT NULL,
  is_active                BOOLEAN NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS acc_school_framework_adoptions_uq
  ON acc_school_framework_adoptions (school_id, platform_framework_id);

CREATE INDEX IF NOT EXISTS acc_school_framework_adoptions_school_idx
  ON acc_school_framework_adoptions (school_id, is_active);

COMMENT ON TABLE acc_school_framework_adoptions IS
  'P2-23 — Per school adoption of a platform.acc_frameworks_platform row. Schools can adopt multiple frameworks simultaneously. The UNIQUE(school_id, platform_framework_id) caps each pair at one adoption. platform_framework_id is a soft ref per ADR-001/020.';


CREATE TABLE IF NOT EXISTS acc_frameworks (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  name                     TEXT NOT NULL,
  description              TEXT,
  is_active                BOOLEAN NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acc_frameworks_name_chk CHECK (length(trim(name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS acc_frameworks_school_name_uq
  ON acc_frameworks (school_id, name);

CREATE INDEX IF NOT EXISTS acc_frameworks_school_idx
  ON acc_frameworks (school_id, is_active);

COMMENT ON TABLE acc_frameworks IS
  'P2-23 — School-created custom accreditation framework (in-house standards). Platform frameworks live in platform.acc_frameworks_platform and are never duplicated here. A schools custom standards live in this row plus per-row child rows authored at the service layer (M85 future: acc_custom_standards table is deferred — current cycle stores them inline via the acc_evidence_items.standard_id soft ref resolved against a JSON catalogue payload on this row, or via a future custom standards child table).';


CREATE TABLE IF NOT EXISTS acc_evidence_items (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  standard_id              UUID NOT NULL,
  evidence_type            TEXT NOT NULL,
  title                    TEXT NOT NULL,
  description              TEXT,
  s3_key                   TEXT,
  url                      TEXT,
  metric_value             TEXT,
  status                   TEXT NOT NULL DEFAULT 'DRAFT',
  submitted_by             UUID NOT NULL,
  submitted_at             TIMESTAMPTZ,
  reviewed_by              UUID,
  reviewed_at              TIMESTAMPTZ,
  reviewer_notes           TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acc_evidence_items_type_chk CHECK (
    evidence_type IN ('DOCUMENT', 'URL', 'METRIC', 'OBSERVATION', 'SURVEY')
  ),
  CONSTRAINT acc_evidence_items_status_chk CHECK (
    status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED')
  ),
  CONSTRAINT acc_evidence_items_title_chk CHECK (length(trim(title)) > 0),
  CONSTRAINT acc_evidence_items_reviewed_chk CHECK (
    (status IN ('DRAFT', 'SUBMITTED') AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR
    (status IN ('APPROVED', 'REJECTED') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS acc_evidence_items_standard_idx
  ON acc_evidence_items (standard_id, school_id, status);

CREATE INDEX IF NOT EXISTS acc_evidence_items_school_status_idx
  ON acc_evidence_items (school_id, status, created_at DESC);

COMMENT ON TABLE acc_evidence_items IS
  'P2-23 — Evidence linked to a standard with SOFT INTEGRITY on standard_id (resolves to acc_standards_platform OR a custom acc_frameworks row at read time per ADR-001/020). 5 value evidence_type, 4 value status with multi column reviewed_chk lockstep pinning reviewed_by + reviewed_at populated when status in (APPROVED, REJECTED) and NULL otherwise. submitted_by + reviewed_by are soft refs to platform.platform_users.';


CREATE TABLE IF NOT EXISTS acc_self_study_ratings (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  standard_id              UUID NOT NULL,
  cycle_id                 TEXT NOT NULL,
  rating                   TEXT NOT NULL,
  rationale                TEXT NOT NULL,
  rated_by                 UUID NOT NULL,
  rated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acc_self_study_ratings_rating_chk CHECK (
    rating IN ('EXEMPLARY', 'ACCOMPLISHED', 'DEVELOPING', 'NOT_MET')
  ),
  CONSTRAINT acc_self_study_ratings_cycle_chk CHECK (length(trim(cycle_id)) > 0),
  CONSTRAINT acc_self_study_ratings_rationale_chk CHECK (length(trim(rationale)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS acc_self_study_ratings_standard_school_cycle_uq
  ON acc_self_study_ratings (standard_id, school_id, cycle_id);

CREATE INDEX IF NOT EXISTS acc_self_study_ratings_school_cycle_idx
  ON acc_self_study_ratings (school_id, cycle_id, rating);

COMMENT ON TABLE acc_self_study_ratings IS
  'P2-23 — Self study rating per (standard, school, cycle). UNIQUE keystone caps each school at one rating per standard per cycle for the entire accreditation period (typically 5 years). rating is a 4 value CHECK EXEMPLARY / ACCOMPLISHED / DEVELOPING / NOT_MET. rationale is NOT NULL because the accrediting body requires a written justification for every rating. standard_id is SOFT INTEGRITY per ADR-001/020.';


CREATE TABLE IF NOT EXISTS acc_action_plans (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  standard_id              UUID NOT NULL,
  goal                     TEXT NOT NULL,
  actions                  JSONB NOT NULL,
  responsible_party        UUID NOT NULL,
  target_date              DATE NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'PLANNED',
  notes                    TEXT,
  created_by               UUID NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acc_action_plans_status_chk CHECK (
    status IN ('PLANNED', 'IN_PROGRESS', 'COMPLETE', 'OVERDUE')
  ),
  CONSTRAINT acc_action_plans_goal_chk CHECK (length(trim(goal)) > 0),
  CONSTRAINT acc_action_plans_actions_array_chk CHECK (jsonb_typeof(actions) = 'array'),
  CONSTRAINT acc_action_plans_responsible_party_fkey FOREIGN KEY (responsible_party)
    REFERENCES hr_employees(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS acc_action_plans_school_status_idx
  ON acc_action_plans (school_id, status, target_date);

CREATE INDEX IF NOT EXISTS acc_action_plans_standard_idx
  ON acc_action_plans (standard_id, school_id);

CREATE INDEX IF NOT EXISTS acc_action_plans_overdue_sweep_idx
  ON acc_action_plans (target_date, status)
  WHERE status = 'IN_PROGRESS';

COMMENT ON TABLE acc_action_plans IS
  'P2-23 — Improvement plan for a standard. actions JSONB array of {description, due_date, status} for individual sub tasks. 4 value status CHECK PLANNED / IN_PROGRESS / COMPLETE / OVERDUE. The partial INDEX(target_date, status) WHERE status=IN_PROGRESS backs the ActionPlanOverdueWorker nightly sweep that flips IN_PROGRESS to OVERDUE when target_date < CURRENT_DATE and emits acc.action_plan.overdue. responsible_party is a real FK to hr_employees(id) NO ACTION — refuse to drop a staff member who owns active accreditation work.';


CREATE TABLE IF NOT EXISTS acc_site_visit_prep (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  visit_date               DATE NOT NULL,
  accreditor_org           TEXT NOT NULL,
  lead_contact_name        TEXT,
  lead_contact_email       TEXT,
  status                   TEXT NOT NULL DEFAULT 'PREPARING',
  readiness_score          NUMERIC(3, 0),
  notes                    TEXT,
  created_by               UUID NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acc_site_visit_prep_status_chk CHECK (
    status IN ('PREPARING', 'READY', 'VISIT_COMPLETE')
  ),
  CONSTRAINT acc_site_visit_prep_org_chk CHECK (length(trim(accreditor_org)) > 0),
  CONSTRAINT acc_site_visit_prep_score_chk CHECK (
    readiness_score IS NULL OR (readiness_score >= 0 AND readiness_score <= 100)
  )
);

CREATE INDEX IF NOT EXISTS acc_site_visit_prep_school_visit_idx
  ON acc_site_visit_prep (school_id, visit_date);

CREATE INDEX IF NOT EXISTS acc_site_visit_prep_status_idx
  ON acc_site_visit_prep (school_id, status);

COMMENT ON TABLE acc_site_visit_prep IS
  'P2-23 — Site visit readiness for an upcoming accrediting body visit. readiness_score NUMERIC(3,0) caches the percentage of adopted standards that have BOTH a self_study_rating for the cycle AND at least one APPROVED evidence item. SiteVisitService.recomputeReadiness recomputes the score on every evidence approval and every rating submission. 3 value status CHECK PREPARING / READY / VISIT_COMPLETE. created_by is a soft ref to platform.platform_users per ADR-001/020.';
