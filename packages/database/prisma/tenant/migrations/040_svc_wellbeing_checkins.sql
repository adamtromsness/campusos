/* 040_svc_wellbeing_checkins.sql
 * Cycle 11.1 Step 2 — Wellbeing check-ins, per-question responses, and
 * the 5-type alert system that flags concerning answers.
 *
 * Three new tenant base tables completing the M27 Student Services
 * Domain 5 schema phase. The Step 1 migration shipped the survey
 * infrastructure (templates, questions, deployments). This migration
 * lands the student-facing check-in instances and the alert lifecycle.
 *
 *   svc_wellbeing_checkins   One row per (student, deployment) or
 *                            ad-hoc check-in. completed_at NULL means
 *                            PENDING — the Step 7 student UI renders
 *                            these as the to-do list. The Step 4
 *                            DeploymentService bulk inserts these
 *                            rows on the SCHEDULED to ACTIVE
 *                            transition. The Step 5 CheckInService
 *                            stamps completed_at on submit and runs
 *                            the alert evaluation logic. The Step 5
 *                            service is the only writer to
 *                            flagged_for_follow_up which is set when
 *                            an alert fires. CASCADE on student
 *                            delete (consistent with all other
 *                            sis_students children). NO ACTION on
 *                            template since templates carry audit
 *                            value beyond a check-in being archived.
 *                            SET NULL on deployment so a cancelled or
 *                            hard-deleted deployment leaves the
 *                            student check-in row intact. SET NULL
 *                            on assigned_counselor_id so the
 *                            assignment can be cleared on counsellor
 *                            departure.
 *   svc_wellbeing_responses  Per-question response within a check-in.
 *                            UNIQUE(checkin_id, question_id) so a
 *                            student answers each question at most
 *                            once. numeric_response carries SCALE_1_5
 *                            (1..5), SCALE_1_10 (1..10), EMOJI_SCALE
 *                            (1..5), and YES_NO (1 for YES, 0 for NO).
 *                            text_response carries FREE_TEXT answers
 *                            (max 500 chars enforced at the API
 *                            layer). response_shape_chk requires at
 *                            least one of (numeric_response,
 *                            text_response) to be populated. CASCADE
 *                            on parent check-in delete since responses
 *                            are meaningless without their check-in.
 *                            NO ACTION on question since the Step 4
 *                            service blocks question delete when any
 *                            response references it.
 *   svc_wellbeing_alerts     5-type alert system. alert_type CHECK
 *                            FEELS_UNSAFE, WANTS_TO_TALK,
 *                            SIGNIFICANT_SCORE_DROP,
 *                            PERSISTENT_LOW_SCORE, SELF_HARM_INDICATOR.
 *                            status CHECK NEW, ACKNOWLEDGED,
 *                            IN_PROGRESS, RESOLVED. SELF_HARM_INDICATOR
 *                            auto-escalates to administrators via the
 *                            Step 5 svc.wellbeing.alert.created Kafka
 *                            emit (the unconditional auto-escalation
 *                            is not configurable by the school).
 *                            CASCADE on student delete and on response
 *                            delete since the alert is meaningless
 *                            without the originating response. SET
 *                            NULL on acknowledged_by so a counsellor
 *                            departure clears the assignment without
 *                            dropping the alert audit.
 *
 * Soft cross-schema refs per ADR-001 / ADR-020. school_id columns are
 * UUID with no DB-enforced FK to platform.schools.
 *
 * 9 new intra-tenant DB-enforced FKs across the three tables. 0 cross-
 * schema FKs.
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * Block comment header. No semicolons inside any string literal or
 * comment per the splitter trap from Cycles 4 through 11.1. The
 * splitter cuts on every semicolon regardless of quoting context.
 */

CREATE TABLE IF NOT EXISTS svc_wellbeing_checkins (
  id                        UUID         PRIMARY KEY,
  school_id                 UUID         NOT NULL,
  student_id                UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  template_id               UUID         NOT NULL REFERENCES svc_wellbeing_survey_templates(id),
  deployment_id             UUID         REFERENCES svc_wellbeing_deployments(id) ON DELETE SET NULL,
  completed_at              TIMESTAMPTZ,
  flagged_for_follow_up     BOOLEAN      NOT NULL DEFAULT false,
  assigned_counselor_id     UUID         REFERENCES hr_employees(id) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS svc_wellbeing_checkins_student_completed_idx
  ON svc_wellbeing_checkins (student_id, completed_at DESC);

CREATE INDEX IF NOT EXISTS svc_wellbeing_checkins_flagged_idx
  ON svc_wellbeing_checkins (flagged_for_follow_up, completed_at)
  WHERE flagged_for_follow_up = true;

CREATE INDEX IF NOT EXISTS svc_wellbeing_checkins_deployment_idx
  ON svc_wellbeing_checkins (deployment_id, completed_at)
  WHERE deployment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS svc_wellbeing_checkins_assigned_counselor_idx
  ON svc_wellbeing_checkins (assigned_counselor_id, completed_at DESC)
  WHERE assigned_counselor_id IS NOT NULL;

COMMENT ON TABLE svc_wellbeing_checkins IS
  'One row per (student, deployment) check-in instance. completed_at NULL means PENDING — the Step 7 student UI renders pending check-ins as the student to-do list. The Step 4 DeploymentService is the only writer that bulk-inserts these rows on the SCHEDULED to ACTIVE deployment transition. The Step 5 CheckInService.submit stamps completed_at, runs the alert evaluation logic, and updates flagged_for_follow_up when triggers fire.';

COMMENT ON COLUMN svc_wellbeing_checkins.deployment_id IS
  'Null for ad-hoc check-ins (e.g. a counsellor manually creates a one-off check-in for a student outside any deployment). Populated for deployment-driven check-ins. SET NULL on deployment delete preserves the student check-in audit even when the originating deployment is cleaned up.';

COMMENT ON COLUMN svc_wellbeing_checkins.flagged_for_follow_up IS
  'Set true by the Step 5 alert evaluation logic when responses match a trigger condition (WANTS_TO_TALK on Q3 YES_NO YES, FEELS_UNSAFE on SAFETY SCALE 1, etc). The counsellor follow-up queue reads this column. Students never see this flag — the partial INDEX svc_wellbeing_checkins_flagged_idx supports the counsellor queue hot path.';

COMMENT ON COLUMN svc_wellbeing_checkins.assigned_counselor_id IS
  'Counsellor responsible for following up on this check-in. The Step 4 DeploymentService stamps this from the deploying counsellor caseload ownership where applicable. SET NULL on hr_employees delete so the assignment clears without dropping the audit.';

CREATE TABLE IF NOT EXISTS svc_wellbeing_responses (
  id                  UUID         PRIMARY KEY,
  checkin_id          UUID         NOT NULL REFERENCES svc_wellbeing_checkins(id) ON DELETE CASCADE,
  question_id         UUID         NOT NULL REFERENCES svc_wellbeing_questions(id),
  numeric_response    SMALLINT,
  text_response       TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT svc_wellbeing_responses_shape_chk
    CHECK (numeric_response IS NOT NULL OR text_response IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS svc_wellbeing_responses_checkin_question_uq
  ON svc_wellbeing_responses (checkin_id, question_id);

CREATE INDEX IF NOT EXISTS svc_wellbeing_responses_question_idx
  ON svc_wellbeing_responses (question_id);

COMMENT ON TABLE svc_wellbeing_responses IS
  'Per-question response within a check-in. The Step 5 CheckInService.submit is the only writer — it bulk-inserts every question response inside one tenant tx. UNIQUE(checkin_id, question_id) means each question gets exactly one answer per check-in. Student-generated self-report data. Access restricted to the counselling team and admin. Students may view own responses only — the Step 5 service strips other students data at the row-scope check.';

COMMENT ON COLUMN svc_wellbeing_responses.numeric_response IS
  'Carries SCALE_1_5 values 1..5. Carries SCALE_1_10 values 1..10. Carries EMOJI_SCALE values 1..5. Carries YES_NO mapped to 1 for YES and 0 for NO. The Step 5 alert evaluation reads this column when the parent question.question_type is one of the numeric variants.';

COMMENT ON COLUMN svc_wellbeing_responses.text_response IS
  'Carries FREE_TEXT answers. Max 500 chars enforced at the API layer (the schema column is unbounded TEXT). The shape_chk constraint allows a row to have either numeric_response or text_response or both. In practice each question type uses one or the other.';

COMMENT ON CONSTRAINT svc_wellbeing_responses_shape_chk ON svc_wellbeing_responses IS
  'Requires at least one of numeric_response or text_response to be populated. A response row with both null carries no information and is rejected.';

CREATE TABLE IF NOT EXISTS svc_wellbeing_alerts (
  id                  UUID         PRIMARY KEY,
  student_id          UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  response_id         UUID         NOT NULL REFERENCES svc_wellbeing_responses(id) ON DELETE CASCADE,
  alert_type          TEXT         NOT NULL,
  status              TEXT         NOT NULL DEFAULT 'NEW',
  acknowledged_by     UUID         REFERENCES hr_employees(id) ON DELETE SET NULL,
  acknowledged_at     TIMESTAMPTZ,
  resolution_notes    TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT svc_wellbeing_alerts_type_chk
    CHECK (alert_type IN ('FEELS_UNSAFE', 'WANTS_TO_TALK', 'SIGNIFICANT_SCORE_DROP', 'PERSISTENT_LOW_SCORE', 'SELF_HARM_INDICATOR')),
  CONSTRAINT svc_wellbeing_alerts_status_chk
    CHECK (status IN ('NEW', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED')),
  CONSTRAINT svc_wellbeing_alerts_acknowledged_chk
    CHECK (
      (status = 'NEW' AND acknowledged_by IS NULL AND acknowledged_at IS NULL)
      OR (status <> 'NEW' AND acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS svc_wellbeing_alerts_student_status_idx
  ON svc_wellbeing_alerts (student_id, status);

CREATE INDEX IF NOT EXISTS svc_wellbeing_alerts_open_idx
  ON svc_wellbeing_alerts (status, created_at DESC)
  WHERE status IN ('NEW', 'ACKNOWLEDGED', 'IN_PROGRESS');

CREATE INDEX IF NOT EXISTS svc_wellbeing_alerts_response_idx
  ON svc_wellbeing_alerts (response_id);

COMMENT ON TABLE svc_wellbeing_alerts IS
  'Alert system that flags concerning responses for counsellor triage. The Step 5 alert evaluation logic is the only writer at create time. The Step 5 AlertService handles the NEW to ACKNOWLEDGED to IN_PROGRESS to RESOLVED lifecycle. SELF_HARM_INDICATOR auto-escalates to administrators via the svc.wellbeing.alert.created Kafka emit — the unconditional auto-escalation is not configurable by the school. CASCADE on student delete and on response delete since the alert is meaningless without the originating response.';

COMMENT ON COLUMN svc_wellbeing_alerts.alert_type IS
  'FEELS_UNSAFE for SAFETY domain SCALE questions with numeric_response<=1. WANTS_TO_TALK for SAFETY or EMOTIONAL domain YES_NO questions with numeric_response=1. SIGNIFICANT_SCORE_DROP for cross-deployment historical comparison (deferred — Cycle 11.1 ships scaffolding only). PERSISTENT_LOW_SCORE for sustained low scores across multiple deployments (deferred). SELF_HARM_INDICATOR for SAFETY questions tagged as self-harm critical with numeric_response=1 — auto-escalates to administrators.';

COMMENT ON CONSTRAINT svc_wellbeing_alerts_acknowledged_chk ON svc_wellbeing_alerts IS
  'Multi-column lockstep. NEW status requires acknowledged_by and acknowledged_at to remain null. Any non-NEW status (ACKNOWLEDGED, IN_PROGRESS, RESOLVED) requires both acknowledged_by AND acknowledged_at to be populated. The Step 5 AlertService stamps both columns atomically on the NEW to ACKNOWLEDGED transition. Direct NEW to RESOLVED transitions also stamp both fields so the audit captures who closed the alert.';

/* Idempotent constraint refresh for tenants that previously ran this
 * migration with a looser predicate. The DROP IF EXISTS and ADD pair
 * is splitter-safe (no DO block with embedded semicolons) and is a
 * no-op on a fresh provision since CREATE TABLE already installed the
 * tightened predicate.
 */
ALTER TABLE svc_wellbeing_alerts DROP CONSTRAINT IF EXISTS svc_wellbeing_alerts_acknowledged_chk;
ALTER TABLE svc_wellbeing_alerts ADD CONSTRAINT svc_wellbeing_alerts_acknowledged_chk
  CHECK (
    (status = 'NEW' AND acknowledged_by IS NULL AND acknowledged_at IS NULL)
    OR (status <> 'NEW' AND acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL)
  );
