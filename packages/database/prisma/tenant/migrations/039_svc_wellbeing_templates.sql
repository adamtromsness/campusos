/* 039_svc_wellbeing_templates.sql
 * Cycle 11.1 Step 1 — Wellbeing survey infrastructure (templates,
 * questions, deployments).
 *
 * Three new tenant base tables for the M27 Student Services Domain 5
 * (Wellbeing Check-Ins). The Step 2 migration adds the student-facing
 * check-in instances, per-question responses, and the alert system on
 * top. Wellbeing is the first student-input surface in CampusOS.
 *
 *   svc_wellbeing_survey_templates  Counsellor-authored reusable
 *                                   survey definitions. The Step 4
 *                                   SurveyTemplateService is the
 *                                   canonical writer. UNIQUE(school_id
 *                                   , name). frequency_recommendation
 *                                   is a 4-value enum CHECK DAILY,
 *                                   WEEKLY, MONTHLY, AS_NEEDED. is
 *                                   active flag for soft deactivation
 *                                   so historical deployments retain
 *                                   their FK target.
 *   svc_wellbeing_questions         Ordered questions belonging to a
 *                                   template. question_type is a
 *                                   5-value enum CHECK SCALE_1_5,
 *                                   SCALE_1_10, YES_NO, FREE_TEXT,
 *                                   EMOJI_SCALE. domain is a 5-value
 *                                   enum CHECK ACADEMIC, SOCIAL,
 *                                   EMOTIONAL, PHYSICAL, SAFETY. The
 *                                   SAFETY domain is the trigger
 *                                   surface for the Step 5 alert
 *                                   evaluation logic. CASCADE on
 *                                   parent template delete since
 *                                   deactivation is the supported
 *                                   path and a hard delete only
 *                                   happens for a template that has
 *                                   no responses.
 *   svc_wellbeing_deployments       Per-deployment instance of a
 *                                   template targeted at a student
 *                                   audience. status is a 4-value
 *                                   enum CHECK SCHEDULED, ACTIVE,
 *                                   COMPLETED, CANCELLED. target_type
 *                                   is a 5-value enum CHECK CASELOAD,
 *                                   CLASS, YEAR_GROUP, SCHOOL,
 *                                   CUSTOM_LIST. target_ids is a UUID
 *                                   array (null for CASELOAD which
 *                                   resolves the deploying counsellor
 *                                   active caseload at activation
 *                                   time, otherwise carries class /
 *                                   year-group / student ids per the
 *                                   target_type). On SCHEDULED to
 *                                   ACTIVE the Step 4 service bulk
 *                                   inserts svc_wellbeing_checkins
 *                                   for every targeted student.
 *
 * Soft cross-schema refs per ADR-001 / ADR-020. school_id columns are
 * UUID with no DB-enforced FK to platform.schools. created_by and
 * deployed_by reference hr_employees(id) NO ACTION because deployments
 * carry audit value beyond a counsellor leaving the school. template
 * to questions is CASCADE on parent template delete because question
 * rows are meaningless without their template.
 *
 * 4 new intra-tenant DB-enforced FKs across the three tables. 0 cross-
 * schema FKs.
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * Block comment header. No semicolons inside any string literal or
 * comment per the splitter trap from Cycles 4 through 11. The splitter
 * cuts on every semicolon regardless of quoting context including
 * inside block comments and inside default expressions.
 */

CREATE TABLE IF NOT EXISTS svc_wellbeing_survey_templates (
  id                          UUID         PRIMARY KEY,
  school_id                   UUID         NOT NULL,
  name                        TEXT         NOT NULL,
  description                 TEXT,
  frequency_recommendation    TEXT         NOT NULL,
  is_active                   BOOLEAN      NOT NULL DEFAULT true,
  created_by                  UUID         NOT NULL REFERENCES hr_employees(id),
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT svc_wellbeing_templates_frequency_chk
    CHECK (frequency_recommendation IN ('DAILY', 'WEEKLY', 'MONTHLY', 'AS_NEEDED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS svc_wellbeing_templates_school_name_uq
  ON svc_wellbeing_survey_templates (school_id, name);

CREATE INDEX IF NOT EXISTS svc_wellbeing_templates_school_active_idx
  ON svc_wellbeing_survey_templates (school_id, is_active);

COMMENT ON TABLE svc_wellbeing_survey_templates IS
  'Counsellor-authored reusable wellbeing survey definitions. The Step 4 SurveyTemplateService is the canonical writer. Each deployment creates a fresh batch of svc_wellbeing_checkins from a template. Templates are deactivated rather than hard-deleted once they have associated deployments — the is_active flag drives counsellor visibility while historical deployment rows retain their template_id FK.';

COMMENT ON COLUMN svc_wellbeing_survey_templates.frequency_recommendation IS
  'DAILY for daily emotional pulse checks. WEEKLY for the canonical weekly check-in pattern. MONTHLY for longer-cadence wellbeing surveys. AS_NEEDED for one-off or crisis-response templates. The recommendation is informational — actual deployment cadence is set at deployment time.';

COMMENT ON COLUMN svc_wellbeing_survey_templates.created_by IS
  'NO ACTION on hr_employees delete because templates carry audit value beyond the authoring counsellor leaving the school. Admin must reassign or archive the template before the employee row can be removed.';

CREATE TABLE IF NOT EXISTS svc_wellbeing_questions (
  id              UUID         PRIMARY KEY,
  template_id     UUID         NOT NULL REFERENCES svc_wellbeing_survey_templates(id) ON DELETE CASCADE,
  question_text   TEXT         NOT NULL,
  question_type   TEXT         NOT NULL,
  domain          TEXT         NOT NULL,
  sort_order      INT          NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT svc_wellbeing_questions_type_chk
    CHECK (question_type IN ('SCALE_1_5', 'SCALE_1_10', 'YES_NO', 'FREE_TEXT', 'EMOJI_SCALE')),
  CONSTRAINT svc_wellbeing_questions_domain_chk
    CHECK (domain IN ('ACADEMIC', 'SOCIAL', 'EMOTIONAL', 'PHYSICAL', 'SAFETY')),
  CONSTRAINT svc_wellbeing_questions_sort_chk
    CHECK (sort_order >= 0)
);

CREATE INDEX IF NOT EXISTS svc_wellbeing_questions_template_sort_idx
  ON svc_wellbeing_questions (template_id, sort_order);

COMMENT ON TABLE svc_wellbeing_questions IS
  'Ordered questions belonging to a survey template. The Step 4 service writes questions inside the same tx as the parent template create. CASCADE on parent template delete since question rows are meaningless without their template — the safe path is template deactivation via is_active=false. Hard-delete only happens when there are no responses against any of the template questions.';

COMMENT ON COLUMN svc_wellbeing_questions.question_type IS
  'SCALE_1_5 renders 5 radio buttons in the Step 7 student UI. SCALE_1_10 renders a slider. YES_NO renders two large toggle buttons (mapped to numeric 1/0 in the response). FREE_TEXT renders a textarea (500 char limit at the API layer). EMOJI_SCALE renders 5 emoji faces (mapped to numeric 1..5). The Step 5 alert evaluation logic reads question_type to decide which response field to inspect.';

COMMENT ON COLUMN svc_wellbeing_questions.domain IS
  'SAFETY is the trigger surface for the Step 5 alert evaluation. SAFETY+SCALE_1_5 with numeric_response<=1 fires SELF_HARM_INDICATOR. SAFETY+YES_NO with numeric_response=1 fires WANTS_TO_TALK. EMOTIONAL+YES_NO with numeric_response=1 also fires WANTS_TO_TALK. ACADEMIC, SOCIAL, and PHYSICAL questions inform the dashboard rollup but do not trigger alerts on single-response evaluation.';

CREATE TABLE IF NOT EXISTS svc_wellbeing_deployments (
  id                  UUID         PRIMARY KEY,
  school_id           UUID         NOT NULL,
  template_id         UUID         NOT NULL REFERENCES svc_wellbeing_survey_templates(id),
  deployed_by         UUID         NOT NULL REFERENCES hr_employees(id),
  deploy_at           TIMESTAMPTZ  NOT NULL,
  expires_at          TIMESTAMPTZ,
  target_type         TEXT         NOT NULL,
  target_ids          UUID[],
  status              TEXT         NOT NULL DEFAULT 'SCHEDULED',
  total_targeted      INT,
  total_completed     INT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT svc_wellbeing_deployments_target_type_chk
    CHECK (target_type IN ('CASELOAD', 'CLASS', 'YEAR_GROUP', 'SCHOOL', 'CUSTOM_LIST')),
  CONSTRAINT svc_wellbeing_deployments_status_chk
    CHECK (status IN ('SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED')),
  CONSTRAINT svc_wellbeing_deployments_window_chk
    CHECK (expires_at IS NULL OR expires_at > deploy_at),
  CONSTRAINT svc_wellbeing_deployments_targeted_chk
    CHECK (total_targeted IS NULL OR total_targeted >= 0),
  CONSTRAINT svc_wellbeing_deployments_completed_chk
    CHECK (total_completed IS NULL OR total_completed >= 0)
);

CREATE INDEX IF NOT EXISTS svc_wellbeing_deployments_school_status_idx
  ON svc_wellbeing_deployments (school_id, status);

CREATE INDEX IF NOT EXISTS svc_wellbeing_deployments_template_idx
  ON svc_wellbeing_deployments (template_id);

CREATE INDEX IF NOT EXISTS svc_wellbeing_deployments_deployed_by_idx
  ON svc_wellbeing_deployments (deployed_by, status);

COMMENT ON TABLE svc_wellbeing_deployments IS
  'Per-deployment instance of a template targeted at a student audience. The Step 4 DeploymentService is the canonical writer. On the SCHEDULED to ACTIVE transition the service resolves the target audience into student ids and bulk-inserts svc_wellbeing_checkins rows with completed_at NULL. NO ACTION on the template_id FK so a counsellor cannot hard-delete a template that still has active or historical deployments — the safe path is is_active=false on the template.';

COMMENT ON COLUMN svc_wellbeing_deployments.target_type IS
  'CASELOAD auto-targets the deploying counsellor active caseload (target_ids is null). CLASS targets all enrolled students for the supplied class ids. YEAR_GROUP targets all students in the supplied grade levels. SCHOOL targets every active student in the school. CUSTOM_LIST targets the specific student ids in target_ids.';

COMMENT ON COLUMN svc_wellbeing_deployments.target_ids IS
  'Null for CASELOAD and SCHOOL targeting. For CLASS this is a UUID array of sis_classes ids. For YEAR_GROUP this is a TEXT-as-UUID array (legacy convention — schools may also pass grade-level strings encoded as UUIDs in a future iteration). The Step 4 service interprets per target_type. For CUSTOM_LIST this is a UUID array of sis_students ids.';

COMMENT ON COLUMN svc_wellbeing_deployments.status IS
  'SCHEDULED on create. ACTIVE after the Step 4 activate endpoint resolves targets and bulk-creates check-in rows. COMPLETED when the counsellor closes out the deployment. CANCELLED when a deployment is pulled before completion. The Step 4 service refuses transitions back from terminal states.';
