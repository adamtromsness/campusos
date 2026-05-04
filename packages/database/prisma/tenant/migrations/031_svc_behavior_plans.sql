/* 031_svc_behavior_plans.sql
 * Cycle 9 Step 2 — Behaviour Plans schema.
 *
 * Three new tenant base tables for the M27 Student Services Behaviour
 * Plans module. These are the FIRST svc_ tables in the system. The
 * Step 1 migration shipped the M20 sis_discipline_* tables that the
 * Step 2 svc_behavior_plans table soft-references via
 * source_incident_id.
 *
 *   svc_behavior_plans          One row per BIP, BSP, or SAFETY_PLAN
 *                               for a student. plan_type is a 3-value
 *                               enum CHECK BIP / BSP / SAFETY_PLAN.
 *                               status is a 4-value enum CHECK
 *                               DRAFT / ACTIVE / REVIEW / EXPIRED.
 *                               target_behaviors is NOT NULL with a
 *                               cardinality greater than zero CHECK
 *                               so an empty array is rejected.
 *                               Replacement_behaviors and
 *                               reinforcement_strategies are
 *                               nullable arrays. Partial UNIQUE on
 *                               (student_id, plan_type) WHERE status
 *                               equals ACTIVE so each student has at
 *                               most one active plan per type. Soft
 *                               refs caseload_id and review_meeting_id
 *                               are forward-compat for Cycle 11
 *                               svc_caseloads and the future
 *                               mtg_meetings table. source_incident_id
 *                               is a soft ref to
 *                               sis_discipline_incidents and links the
 *                               BIP to the originating discipline
 *                               record when the plan was triggered by
 *                               a specific incident.
 *   svc_behavior_plan_goals     Measurable goals attached to a plan.
 *                               progress is a 4-value enum CHECK
 *                               NOT_STARTED / IN_PROGRESS / MET /
 *                               NOT_MET. CASCADE on the plan since a
 *                               goal has no meaning without its plan.
 *   svc_bip_teacher_feedback    Structured teacher input on strategy
 *                               effectiveness. requested_by is the
 *                               counsellor who requested the
 *                               feedback. submitted_at is null while
 *                               the request is pending. When the
 *                               teacher submits, submitted_at is
 *                               populated and the optional fields
 *                               (strategies_observed,
 *                               overall_effectiveness,
 *                               classroom_observations,
 *                               recommended_adjustments) carry the
 *                               response. overall_effectiveness is a
 *                               4-value enum CHECK NOT_EFFECTIVE /
 *                               SOMEWHAT_EFFECTIVE / EFFECTIVE /
 *                               VERY_EFFECTIVE. Partial UNIQUE on
 *                               (plan_id, teacher_id) WHERE
 *                               submitted_at IS NULL so a counsellor
 *                               cannot stack two pending requests on
 *                               the same teacher. Once the teacher
 *                               submits, a new request can be opened
 *                               on the same plan and teacher.
 *
 * Soft cross-schema refs per ADR-001 and ADR-020:
 *   svc_behavior_plans.school_id           -> platform.schools(id)
 *   svc_behavior_plans.caseload_id         -> svc_caseloads(id) future Cycle 11, soft + nullable
 *   svc_behavior_plans.review_meeting_id   -> mtg_meetings(id) future, soft + nullable
 *   svc_behavior_plans.source_incident_id  -> sis_discipline_incidents(id) intra-tenant but kept soft for forward-compat with cross-module reads
 *
 * DB-enforced intra-tenant FKs (5 logical):
 *   svc_behavior_plans.student_id           -> sis_students(id) CASCADE
 *     When a student is removed from the system the BIP history goes
 *     with them. Mirrors the Step 1 sis_discipline_incidents pattern
 *     and the conservative privacy choice.
 *   svc_behavior_plans.created_by           -> hr_employees(id) SET NULL
 *     Audit trail survives a counsellor leaving the school.
 *   svc_behavior_plan_goals.plan_id         -> svc_behavior_plans(id) CASCADE
 *     A goal has no meaning without its plan.
 *   svc_bip_teacher_feedback.plan_id        -> svc_behavior_plans(id) CASCADE
 *     Feedback rows carry the audit trail for the plan they were
 *     attached to. Dropping the plan drops its feedback chain.
 *   svc_bip_teacher_feedback.teacher_id     -> hr_employees(id) SET NULL
 *     Audit trail survives a teacher leaving the school. The row
 *     remains for counsellor review.
 *   svc_bip_teacher_feedback.requested_by   -> hr_employees(id) SET NULL
 *     Same audit-survival reasoning for the requesting counsellor.
 *
 * Total Cycle 9 FKs after Step 2: 11 (5 from Step 1 plus 6 from Step 2).
 * Total Cycle 9 logical base tables after Step 2: 7 (4 from Step 1 plus 3 from Step 2).
 *
 * 0 cross-schema FKs.
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * Block comment header, no semicolons inside any string literal or
 * comment per the splitter trap from Cycles 4 through 8. The splitter
 * cuts on every semicolon regardless of quoting context including
 * inside block comments and inside default expressions.
 */

CREATE TABLE IF NOT EXISTS svc_behavior_plans (
  id                          UUID         PRIMARY KEY,
  school_id                   UUID         NOT NULL,
  student_id                  UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  caseload_id                 UUID,
  plan_type                   TEXT         NOT NULL,
  status                      TEXT         NOT NULL DEFAULT 'DRAFT',
  created_by                  UUID         REFERENCES hr_employees(id) ON DELETE SET NULL,
  review_date                 DATE         NOT NULL,
  review_meeting_id           UUID,
  target_behaviors            TEXT[]       NOT NULL,
  replacement_behaviors       TEXT[],
  reinforcement_strategies    TEXT[],
  plan_document_s3_key        TEXT,
  source_incident_id          UUID,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT svc_behavior_plans_type_chk
    CHECK (plan_type IN ('BIP', 'BSP', 'SAFETY_PLAN')),
  CONSTRAINT svc_behavior_plans_status_chk
    CHECK (status IN ('DRAFT', 'ACTIVE', 'REVIEW', 'EXPIRED')),
  CONSTRAINT svc_behavior_plans_target_behaviors_chk
    CHECK (cardinality(target_behaviors) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS svc_behavior_plans_active_per_student_type_uq
  ON svc_behavior_plans (student_id, plan_type)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS svc_behavior_plans_student_status_idx
  ON svc_behavior_plans (student_id, status);

CREATE INDEX IF NOT EXISTS svc_behavior_plans_school_status_idx
  ON svc_behavior_plans (school_id, status);

CREATE INDEX IF NOT EXISTS svc_behavior_plans_source_incident_idx
  ON svc_behavior_plans (source_incident_id)
  WHERE source_incident_id IS NOT NULL;

COMMENT ON TABLE svc_behavior_plans IS
  'Behaviour Intervention Plans (BIP), Behaviour Support Plans (BSP), and Safety Plans for students. The Step 5 BehaviorPlanService is the canonical writer. The partial UNIQUE on (student_id, plan_type) WHERE status equals ACTIVE keeps the count of active plans per type per student capped at one — a counsellor cannot accidentally land two competing ACTIVE BIPs on the same student.';

COMMENT ON COLUMN svc_behavior_plans.target_behaviors IS
  'Required, non-empty array of behaviours the plan is designed to reduce. Cardinality greater than zero CHECK at the schema layer prevents a NULL or empty BIP from landing.';

COMMENT ON COLUMN svc_behavior_plans.caseload_id IS
  'Soft ref to the future svc_caseloads table that ships in Cycle 11. Nullable so Cycle 9 can ship plans without a caseload column being populated.';

COMMENT ON COLUMN svc_behavior_plans.review_meeting_id IS
  'Soft ref to the future mtg_meetings table. Counsellors record the BIP review meeting once the meetings module ships. Nullable so Cycle 9 can ship plans before the meetings module is available.';

COMMENT ON COLUMN svc_behavior_plans.source_incident_id IS
  'Soft ref to sis_discipline_incidents(id). Kept soft so a future admin-deletion path on incidents does not cascade through to BIPs. Nullable since not every BIP is triggered by a specific incident.';

CREATE TABLE IF NOT EXISTS svc_behavior_plan_goals (
  id                    UUID         PRIMARY KEY,
  plan_id               UUID         NOT NULL REFERENCES svc_behavior_plans(id) ON DELETE CASCADE,
  goal_text             TEXT         NOT NULL,
  baseline_frequency    TEXT,
  target_frequency      TEXT,
  measurement_method    TEXT,
  progress              TEXT         NOT NULL DEFAULT 'NOT_STARTED',
  last_assessed_at      DATE,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT svc_behavior_plan_goals_progress_chk
    CHECK (progress IN ('NOT_STARTED', 'IN_PROGRESS', 'MET', 'NOT_MET'))
);

CREATE INDEX IF NOT EXISTS svc_behavior_plan_goals_plan_idx
  ON svc_behavior_plan_goals (plan_id);

COMMENT ON TABLE svc_behavior_plan_goals IS
  'Measurable goals attached to a behaviour plan. The Step 5 GoalService writes per-row progress updates with last_assessed_at populated from now() on each transition. CASCADE on the plan since a goal has no meaning without its plan.';

COMMENT ON COLUMN svc_behavior_plan_goals.progress IS
  'NOT_STARTED for newly added goals. IN_PROGRESS once the counsellor records first observation. MET when the target_frequency is hit consistently. NOT_MET when the review identifies the goal needs revision. The Step 5 GoalService bumps last_assessed_at on every progress transition.';

CREATE TABLE IF NOT EXISTS svc_bip_teacher_feedback (
  id                            UUID         PRIMARY KEY,
  plan_id                       UUID         NOT NULL REFERENCES svc_behavior_plans(id) ON DELETE CASCADE,
  teacher_id                    UUID         REFERENCES hr_employees(id) ON DELETE SET NULL,
  requested_by                  UUID         REFERENCES hr_employees(id) ON DELETE SET NULL,
  requested_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  submitted_at                  TIMESTAMPTZ,
  strategies_observed           TEXT[],
  overall_effectiveness         TEXT,
  classroom_observations        TEXT,
  recommended_adjustments       TEXT,
  created_at                    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT svc_bip_teacher_feedback_effectiveness_chk
    CHECK (overall_effectiveness IS NULL OR overall_effectiveness IN ('NOT_EFFECTIVE', 'SOMEWHAT_EFFECTIVE', 'EFFECTIVE', 'VERY_EFFECTIVE'))
);

CREATE UNIQUE INDEX IF NOT EXISTS svc_bip_teacher_feedback_pending_uq
  ON svc_bip_teacher_feedback (plan_id, teacher_id)
  WHERE submitted_at IS NULL;

CREATE INDEX IF NOT EXISTS svc_bip_teacher_feedback_plan_submitted_idx
  ON svc_bip_teacher_feedback (plan_id, submitted_at);

CREATE INDEX IF NOT EXISTS svc_bip_teacher_feedback_teacher_pending_idx
  ON svc_bip_teacher_feedback (teacher_id, submitted_at)
  WHERE submitted_at IS NULL;

COMMENT ON TABLE svc_bip_teacher_feedback IS
  'Structured teacher input on the effectiveness of a behaviour plan. The counsellor (requested_by) opens a feedback row with submitted_at NULL. The teacher fills out strategies_observed plus overall_effectiveness plus the two text fields and the Step 5 FeedbackService stamps submitted_at. Partial UNIQUE on (plan_id, teacher_id) WHERE submitted_at IS NULL caps pending requests at one per (plan, teacher) so the counsellor cannot accidentally double-request.';

COMMENT ON COLUMN svc_bip_teacher_feedback.submitted_at IS
  'Null while the request is pending. Set by the Step 5 FeedbackService when the teacher submits. Once non-null, the partial UNIQUE constraint releases and a new feedback request can be opened against the same (plan, teacher) pair if the counsellor needs another round of observation.';

COMMENT ON COLUMN svc_bip_teacher_feedback.overall_effectiveness IS
  'Null while the request is pending. Optional even after submission since a teacher may submit qualitative feedback without committing to a Likert rating. NOT_EFFECTIVE / SOMEWHAT_EFFECTIVE / EFFECTIVE / VERY_EFFECTIVE when set.';
