/* 034_hlth_iep_nurse_screening_dietary.sql
 * Cycle 10 Step 3 — M23 Health remaining schema.
 *
 * Eight new tenant base tables completing the M23 Health module:
 * the IEP / 504 plan domain (5 tables), nurse visits with live
 * roster (1), screenings (1), and dietary profiles (1). Combined
 * with Steps 1 and 2 this brings Cycle 10 to 15 logical hlth_*
 * tables with the immutable HIPAA access log included.
 *
 *   hlth_iep_plans               One IEP or 504 plan per student.
 *                                plan_type is a 2-value enum CHECK
 *                                IEP / 504. status is a 4-value enum
 *                                CHECK DRAFT / ACTIVE / REVIEW /
 *                                EXPIRED. Partial UNIQUE INDEX on
 *                                (student_id) WHERE status not equal
 *                                EXPIRED so expired plans accumulate
 *                                as history while at most one
 *                                active / draft / review plan exists
 *                                per student. Mirrors the Cycle 9
 *                                svc_behavior_plans partial UNIQUE
 *                                pattern. case_manager_id FK to
 *                                hr_employees SET NULL so the audit
 *                                trail survives a counsellor leaving.
 *
 *   hlth_iep_goals               Per-plan measurable goal. status is
 *                                a 4-value enum CHECK ACTIVE / MET /
 *                                NOT_MET / DISCONTINUED. CASCADE on
 *                                the plan.
 *
 *   hlth_iep_goal_progress       Per-goal progress entry. CASCADE on
 *                                the goal. recorded_by FK to
 *                                hr_employees SET NULL (audit
 *                                survives staff leaving).
 *
 *   hlth_iep_services            Per-plan service. delivery_method
 *                                is a 3-value enum CHECK PULL_OUT /
 *                                PUSH_IN / CONSULT. CASCADE on the
 *                                plan.
 *
 *   hlth_iep_accommodations      Per-plan accommodation. applies_to
 *                                is a 3-value enum CHECK
 *                                ALL_ASSESSMENTS / ALL_ASSIGNMENTS /
 *                                SPECIFIC. Multi-column applies_to_chk
 *                                pins SPECIFIC to a non-empty
 *                                specific_assignment_types array, and
 *                                pins the broad scopes to a NULL
 *                                array. dates_chk enforces
 *                                effective_to greater than or equal
 *                                to effective_from when both set.
 *                                CASCADE on the plan. The Step 7
 *                                IepPlanService emits
 *                                iep.accommodation.updated on every
 *                                INSERT / UPDATE / DELETE so the
 *                                ADR-030 IepAccommodationConsumer
 *                                upserts sis_student_active_
 *                                accommodations for teachers to
 *                                read without touching hlth_*.
 *
 *   hlth_nurse_visits            Live nurse office row. visited_person_id
 *                                plus visited_person_type form a
 *                                soft polymorphic ref. visited_person_type
 *                                is a 2-value enum CHECK STUDENT /
 *                                STAFF. status is a 2-value enum
 *                                CHECK IN_PROGRESS / COMPLETED.
 *                                Multi-column signed_chk pins
 *                                IN_PROGRESS to signed_out_at NULL
 *                                and COMPLETED to signed_out_at
 *                                NOT NULL. Multi-column sent_home_chk
 *                                pins sent_home true to a non-NULL
 *                                sent_home_at. Partial INDEX on
 *                                (school_id, status) WHERE status
 *                                equals IN_PROGRESS for the live
 *                                nurse office roster query. nurse_id
 *                                FK to hr_employees SET NULL.
 *
 *   hlth_screenings              Per-student screening result.
 *                                result is a 4-value enum CHECK
 *                                PASS / REFER / RESCREEN / ABSENT.
 *                                screened_by FK to hr_employees
 *                                SET NULL. CASCADE on the student.
 *
 *   hlth_dietary_profiles        One profile per student.
 *                                dietary_restrictions is TEXT[]
 *                                free-form so schools can add
 *                                school-specific tags beyond the
 *                                standard VEGETARIAN / VEGAN /
 *                                HALAL / KOSHER / GLUTEN_FREE /
 *                                DAIRY_FREE list. allergens is
 *                                JSONB with allergen and severity
 *                                fields. pos_allergen_alert flag
 *                                drives a partial INDEX for the
 *                                POS / cafeteria allergen-alerts
 *                                endpoint.
 *
 * DB-enforced intra-tenant FKs (10 logical):
 *   hlth_iep_plans.student_id              -> sis_students(id) CASCADE
 *   hlth_iep_plans.case_manager_id         -> hr_employees(id) SET NULL
 *   hlth_iep_goals.iep_plan_id             -> hlth_iep_plans(id) CASCADE
 *   hlth_iep_goal_progress.goal_id         -> hlth_iep_goals(id) CASCADE
 *   hlth_iep_goal_progress.recorded_by     -> hr_employees(id) SET NULL
 *   hlth_iep_services.iep_plan_id          -> hlth_iep_plans(id) CASCADE
 *   hlth_iep_accommodations.iep_plan_id    -> hlth_iep_plans(id) CASCADE
 *   hlth_nurse_visits.nurse_id             -> hr_employees(id) SET NULL
 *   hlth_screenings.student_id             -> sis_students(id) CASCADE
 *   hlth_screenings.screened_by            -> hr_employees(id) SET NULL
 *   hlth_dietary_profiles.student_id       -> sis_students(id) CASCADE
 *
 * Soft cross-schema refs per ADR-001 and ADR-020:
 *   hlth_iep_plans.school_id           -> platform.schools(id)
 *   hlth_nurse_visits.school_id        -> platform.schools(id)
 *   hlth_screenings.school_id          -> platform.schools(id)
 *   hlth_dietary_profiles.school_id    -> platform.schools(id)
 *   hlth_dietary_profiles.updated_by   -> platform.platform_users(id) soft per ADR-001
 *   hlth_nurse_visits.visited_person_id is soft polymorphic per the
 *     visited_person_type column. STUDENT references sis_students(id).
 *     STAFF references hr_employees(id). The Step 7 NurseVisitService
 *     is the canonical validator before insert.
 *
 * 0 cross-schema FKs.
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * Block comment header, no semicolons inside any string literal or
 * comment per the splitter trap from Cycles 4 through 10.
 */

CREATE TABLE IF NOT EXISTS hlth_iep_plans (
  id                  UUID         PRIMARY KEY,
  school_id           UUID         NOT NULL,
  student_id          UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  plan_type           TEXT         NOT NULL,
  status              TEXT         NOT NULL DEFAULT 'DRAFT',
  start_date          DATE,
  review_date         DATE,
  end_date            DATE,
  case_manager_id     UUID         REFERENCES hr_employees(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT hlth_iep_plans_type_chk
    CHECK (plan_type IN ('IEP', '504')),
  CONSTRAINT hlth_iep_plans_status_chk
    CHECK (status IN ('DRAFT', 'ACTIVE', 'REVIEW', 'EXPIRED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS hlth_iep_plans_student_active_uq
  ON hlth_iep_plans (student_id)
  WHERE status <> 'EXPIRED';

CREATE INDEX IF NOT EXISTS hlth_iep_plans_school_status_idx
  ON hlth_iep_plans (school_id, status);

COMMENT ON TABLE hlth_iep_plans IS
  'One IEP or 504 plan per student. The partial UNIQUE on (student_id) WHERE status not equal EXPIRED keeps at most one active or draft or review plan per student while expired plans accumulate as history. Mirrors the Cycle 9 svc_behavior_plans partial UNIQUE pattern. The Step 7 IepPlanService is the canonical writer and emits iep.accommodation.updated on accommodation changes so the ADR-030 read model stays in sync.';

COMMENT ON COLUMN hlth_iep_plans.plan_type IS
  'IEP for special education plan under IDEA. 504 for accommodations under Section 504 of the Rehabilitation Act. Mutually exclusive in practice — a student gets one or the other. The partial UNIQUE on student_id enforces one active plan per student regardless of type.';

CREATE TABLE IF NOT EXISTS hlth_iep_goals (
  id                      UUID         PRIMARY KEY,
  iep_plan_id             UUID         NOT NULL REFERENCES hlth_iep_plans(id) ON DELETE CASCADE,
  goal_text               TEXT         NOT NULL,
  measurement_criteria    TEXT,
  baseline                TEXT,
  target_value            TEXT,
  current_value           TEXT,
  goal_area               TEXT,
  status                  TEXT         NOT NULL DEFAULT 'ACTIVE',
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT hlth_iep_goals_status_chk
    CHECK (status IN ('ACTIVE', 'MET', 'NOT_MET', 'DISCONTINUED'))
);

CREATE INDEX IF NOT EXISTS hlth_iep_goals_plan_status_idx
  ON hlth_iep_goals (iep_plan_id, status);

COMMENT ON TABLE hlth_iep_goals IS
  'Per-plan measurable goal. baseline and target_value and current_value are TEXT to accommodate quantitative (90 percent accuracy) and qualitative (independent transition between classes) measurement criteria. The Step 7 IepPlanService writes one progress row per assessment to hlth_iep_goal_progress.';

CREATE TABLE IF NOT EXISTS hlth_iep_goal_progress (
  id                  UUID         PRIMARY KEY,
  goal_id             UUID         NOT NULL REFERENCES hlth_iep_goals(id) ON DELETE CASCADE,
  recorded_by         UUID         REFERENCES hr_employees(id) ON DELETE SET NULL,
  progress_value      TEXT,
  observation_notes   TEXT,
  recorded_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hlth_iep_goal_progress_goal_time_idx
  ON hlth_iep_goal_progress (goal_id, recorded_at DESC);

COMMENT ON TABLE hlth_iep_goal_progress IS
  'Per-goal progress entry. Append-only audit history. The Step 7 IepPlanService writes one row per assessment cycle. recorded_by FK SET NULL preserves the historical row when a counsellor leaves.';

CREATE TABLE IF NOT EXISTS hlth_iep_services (
  id                      UUID         PRIMARY KEY,
  iep_plan_id             UUID         NOT NULL REFERENCES hlth_iep_plans(id) ON DELETE CASCADE,
  service_type            TEXT         NOT NULL,
  provider_name           TEXT,
  frequency               TEXT,
  minutes_per_session     INT,
  delivery_method         TEXT         NOT NULL,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT hlth_iep_services_delivery_chk
    CHECK (delivery_method IN ('PULL_OUT', 'PUSH_IN', 'CONSULT')),
  CONSTRAINT hlth_iep_services_minutes_chk
    CHECK (minutes_per_session IS NULL OR minutes_per_session > 0)
);

CREATE INDEX IF NOT EXISTS hlth_iep_services_plan_idx
  ON hlth_iep_services (iep_plan_id);

COMMENT ON TABLE hlth_iep_services IS
  'Per-plan related service. service_type is free-form text covering speech therapy / occupational therapy / physical therapy / counselling / other. delivery_method enum aligns with the ERD M23 spec.';

COMMENT ON COLUMN hlth_iep_services.delivery_method IS
  'PULL_OUT means the student leaves the classroom to receive the service. PUSH_IN means the provider joins the classroom. CONSULT means the provider supports the teacher rather than working with the student directly.';

CREATE TABLE IF NOT EXISTS hlth_iep_accommodations (
  id                          UUID         PRIMARY KEY,
  iep_plan_id                 UUID         NOT NULL REFERENCES hlth_iep_plans(id) ON DELETE CASCADE,
  accommodation_type          TEXT         NOT NULL,
  description                 TEXT,
  applies_to                  TEXT         NOT NULL,
  specific_assignment_types   TEXT[],
  effective_from              DATE,
  effective_to                DATE,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT hlth_iep_accommodations_applies_to_chk
    CHECK (applies_to IN ('ALL_ASSESSMENTS', 'ALL_ASSIGNMENTS', 'SPECIFIC')),
  CONSTRAINT hlth_iep_accommodations_specific_chk
    CHECK (
      (applies_to <> 'SPECIFIC' AND specific_assignment_types IS NULL)
      OR
      (applies_to = 'SPECIFIC' AND specific_assignment_types IS NOT NULL AND cardinality(specific_assignment_types) > 0)
    ),
  CONSTRAINT hlth_iep_accommodations_dates_chk
    CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS hlth_iep_accommodations_plan_idx
  ON hlth_iep_accommodations (iep_plan_id);

COMMENT ON TABLE hlth_iep_accommodations IS
  'Per-plan accommodation. The Step 7 IepPlanService emits iep.accommodation.updated on INSERT and UPDATE and DELETE with the full accommodation set for the student. The ADR-030 IepAccommodationConsumer upserts sis_student_active_accommodations so teachers read accommodations through the existing student profile without ever touching hlth_* tables.';

COMMENT ON COLUMN hlth_iep_accommodations.accommodation_type IS
  'Free-form text matching the ADR-030 read model. Examples: EXTENDED_TIME, ALTERNATIVE_ASSESSMENT, ASSISTIVE_TECH, READ_ALOUD, REDUCED_DISTRACTION, PREFERENTIAL_SEATING. The Step 8 admin UI offers a curated dropdown but the column accepts any string so schools can add specific accommodations.';

COMMENT ON CONSTRAINT hlth_iep_accommodations_specific_chk ON hlth_iep_accommodations IS
  'Pins applies_to and specific_assignment_types together. SPECIFIC requires a non-empty array of assignment types. ALL_ASSESSMENTS and ALL_ASSIGNMENTS require the array to be NULL — the broad scope cannot also enumerate specific types.';

CREATE TABLE IF NOT EXISTS hlth_nurse_visits (
  id                      UUID         PRIMARY KEY,
  school_id               UUID         NOT NULL,
  visited_person_id       UUID         NOT NULL,
  visited_person_type     TEXT         NOT NULL DEFAULT 'STUDENT',
  nurse_id                UUID         REFERENCES hr_employees(id) ON DELETE SET NULL,
  visit_date              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  status                  TEXT         NOT NULL DEFAULT 'COMPLETED',
  signed_in_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  signed_out_at           TIMESTAMPTZ,
  reason                  TEXT,
  treatment_given         TEXT,
  parent_notified         BOOLEAN      NOT NULL DEFAULT false,
  sent_home               BOOLEAN      NOT NULL DEFAULT false,
  sent_home_at            TIMESTAMPTZ,
  follow_up_required      BOOLEAN      NOT NULL DEFAULT false,
  follow_up_notes         TEXT,
  follow_up_date          DATE,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT hlth_nurse_visits_visited_type_chk
    CHECK (visited_person_type IN ('STUDENT', 'STAFF')),
  CONSTRAINT hlth_nurse_visits_status_chk
    CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  CONSTRAINT hlth_nurse_visits_signed_chk
    CHECK (
      (status = 'IN_PROGRESS' AND signed_out_at IS NULL)
      OR
      (status = 'COMPLETED' AND signed_out_at IS NOT NULL)
    ),
  CONSTRAINT hlth_nurse_visits_sent_home_chk
    CHECK (
      (sent_home = false AND sent_home_at IS NULL)
      OR
      (sent_home = true AND sent_home_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS hlth_nurse_visits_active_idx
  ON hlth_nurse_visits (school_id, status)
  WHERE status = 'IN_PROGRESS';

CREATE INDEX IF NOT EXISTS hlth_nurse_visits_school_visit_idx
  ON hlth_nurse_visits (school_id, visit_date DESC);

CREATE INDEX IF NOT EXISTS hlth_nurse_visits_visited_idx
  ON hlth_nurse_visits (visited_person_id, visit_date DESC);

COMMENT ON TABLE hlth_nurse_visits IS
  'Live nurse office row. The Step 7 NurseVisitService is the canonical writer. visited_person_id and visited_person_type form a soft polymorphic ref because nurses also see staff (a teacher with a headache). The Step 7 service validates the soft ref against sis_students or hr_employees per the type before insert. Partial INDEX on (school_id, status) WHERE status equals IN_PROGRESS backs the live nurse office roster query that the Step 8 dashboard polls.';

COMMENT ON COLUMN hlth_nurse_visits.visited_person_id IS
  'Soft polymorphic ref. Resolves via visited_person_type. STUDENT references sis_students(id). STAFF references hr_employees(id). No DB-enforced FK because the target table differs by row. The Step 7 NurseVisitService is the canonical validator before insert.';

COMMENT ON CONSTRAINT hlth_nurse_visits_signed_chk ON hlth_nurse_visits IS
  'Pins signed_out_at to status. IN_PROGRESS requires signed_out_at NULL. COMPLETED requires signed_out_at NOT NULL. The Step 7 NurseVisitService PATCH /:id sign-out flips status and stamps signed_out_at in the same UPDATE per the locked-row convention.';

COMMENT ON CONSTRAINT hlth_nurse_visits_sent_home_chk ON hlth_nurse_visits IS
  'Pins sent_home to sent_home_at. When sent_home flips true the Step 7 service stamps sent_home_at in the same UPDATE. Both fields are clear when sent_home is false.';

CREATE TABLE IF NOT EXISTS hlth_screenings (
  id                      UUID         PRIMARY KEY,
  school_id               UUID         NOT NULL,
  student_id              UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  screening_type          TEXT         NOT NULL,
  screening_date          DATE         NOT NULL,
  screened_by             UUID         REFERENCES hr_employees(id) ON DELETE SET NULL,
  result                  TEXT,
  result_notes            TEXT,
  follow_up_required      BOOLEAN      NOT NULL DEFAULT false,
  follow_up_completed     BOOLEAN      NOT NULL DEFAULT false,
  referral_notes          TEXT,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT hlth_screenings_result_chk
    CHECK (result IS NULL OR result IN ('PASS', 'REFER', 'RESCREEN', 'ABSENT'))
);

CREATE INDEX IF NOT EXISTS hlth_screenings_student_date_idx
  ON hlth_screenings (student_id, screening_date DESC);

CREATE INDEX IF NOT EXISTS hlth_screenings_followup_idx
  ON hlth_screenings (school_id, follow_up_completed)
  WHERE follow_up_required = true AND follow_up_completed = false;

COMMENT ON TABLE hlth_screenings IS
  'Per-student screening result. screening_type is free-form text covering VISION / HEARING / SCOLIOSIS / BMI / DENTAL / CUSTOM. The Step 7 ScreeningService rolls up REFER results with follow_up_completed = false for the admin follow-up queue via the partial INDEX.';

CREATE TABLE IF NOT EXISTS hlth_dietary_profiles (
  id                          UUID         PRIMARY KEY,
  school_id                   UUID         NOT NULL,
  student_id                  UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  dietary_restrictions        TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  allergens                   JSONB        NOT NULL DEFAULT '[]'::jsonb,
  special_meal_instructions   TEXT,
  pos_allergen_alert          BOOLEAN      NOT NULL DEFAULT false,
  updated_by                  UUID,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS hlth_dietary_profiles_student_uq
  ON hlth_dietary_profiles (student_id);

CREATE INDEX IF NOT EXISTS hlth_dietary_profiles_pos_alert_idx
  ON hlth_dietary_profiles (school_id)
  WHERE pos_allergen_alert = true;

COMMENT ON TABLE hlth_dietary_profiles IS
  'One dietary profile per student. UNIQUE on student_id so the Step 7 DietaryProfileService can upsert. dietary_restrictions is TEXT[] free-form so schools can add school-specific tags beyond the standard VEGETARIAN / VEGAN / HALAL / KOSHER / GLUTEN_FREE / DAIRY_FREE list. allergens is structured JSONB. pos_allergen_alert flag drives a partial INDEX for the GET /health/allergen-alerts endpoint that the future POS / cafeteria integration polls.';

COMMENT ON COLUMN hlth_dietary_profiles.pos_allergen_alert IS
  'When true the future POS / cafeteria integration shows a hard-stop alert at checkout. The Step 7 DietaryProfileService sets this when a SEVERE allergen is recorded. The partial INDEX on (school_id) WHERE pos_allergen_alert = true backs the allergen-alerts endpoint hot path.';

COMMENT ON COLUMN hlth_dietary_profiles.updated_by IS
  'Soft ref to platform.platform_users(id) per ADR-001. Captures the actor account id stamped by the Step 7 service. Nullable because the seed inserts profiles before any actor is set.';
