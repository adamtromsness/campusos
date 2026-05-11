/*
 * 143_sis_graduation_gpa.sql — Phase 2 Cycle 13 sub-cycle b (P2-13b).
 *
 * M20 SIS Advanced — second 8 of 24 tables. The P2-13 cycle ships
 * 24 tables across 3 sub-cycles (P2-13a 8 plus P2-13b 8 plus
 * P2-13c 8). Migration 143 covers P2-13b graduation plus service
 * learning plus GPA.
 *
 *   sis_graduation_requirements         Per-school graduation
 *                                       requirement catalogue.
 *                                       6-value requirement_type
 *                                       CHECK (CREDIT_TOTAL
 *                                       SUBJECT_CREDIT
 *                                       SPECIFIC_COURSE SERVICE_HOURS
 *                                       ASSESSMENT MINIMUM_GPA). Each
 *                                       requirement carries the
 *                                       qualifier columns relevant
 *                                       to its type — subject_area
 *                                       and credits_required for
 *                                       CREDIT_TOTAL and
 *                                       SUBJECT_CREDIT, specific_course_id
 *                                       for SPECIFIC_COURSE, hours_required
 *                                       for SERVICE_HOURS, assessment_name
 *                                       for ASSESSMENT, minimum_gpa
 *                                       for MINIMUM_GPA.
 *                                       Multi-column shape_chk
 *                                       enforces the right qualifier
 *                                       is populated per type.
 *                                       INDEX(school_id, is_active).
 *   sis_student_graduation_audits       Materialised audit row per
 *                                       (student, requirement).
 *                                       3-value status CHECK (MET
 *                                       IN_PROGRESS NOT_MET).
 *                                       credits_earned plus
 *                                       credits_remaining track
 *                                       progress for credit-based
 *                                       requirements. Materialised
 *                                       nightly by GraduationAuditWorker
 *                                       walking sis_students plus
 *                                       cls_grades. Emits
 *                                       sis.graduation.at_risk when
 *                                       any senior has NOT_MET
 *                                       requirements after a run.
 *                                       UNIQUE(student_id requirement_id).
 *   sis_service_learning_requirements   Per-(school, grade_level)
 *                                       service hours requirement.
 *                                       3-value deadline_type CHECK
 *                                       (END_OF_YEAR
 *                                       BEFORE_GRADUATION
 *                                       SPECIFIC_DATE).
 *                                       UNIQUE(school_id grade_level).
 *   sis_service_learning_hours          Student-submitted service
 *                                       hours with supervisor
 *                                       verification. 3-value status
 *                                       CHECK (PENDING APPROVED
 *                                       REJECTED). hours NUMERIC(5,2)
 *                                       enforced positive.
 *                                       Multi-column reviewed_chk
 *                                       lockstep keeps reviewed_by
 *                                       plus reviewed_at populated
 *                                       together for terminal
 *                                       statuses.
 *                                       INDEX(student_id status).
 *   sis_gpa_configurations              Per-school GPA calculation
 *                                       configuration. 3-value
 *                                       calculation_method CHECK
 *                                       (UNWEIGHTED WEIGHTED
 *                                       SUBJECT_AREA). 2-value
 *                                       scale_type CHECK (FOUR_POINT
 *                                       HUNDRED_POINT).
 *                                       grade_point_mapping JSONB
 *                                       maps letter grade to point
 *                                       value. honors_weight_bonus
 *                                       plus ap_weight_bonus apply
 *                                       to WEIGHTED method.
 *                                       Partial UNIQUE on (school_id)
 *                                       WHERE is_default equals true
 *                                       so each school has at most
 *                                       one default config.
 *                                       UNIQUE(school_id config_name).
 *   sis_student_gpa_snapshots           Materialised GPA snapshot
 *                                       per (student, config,
 *                                       academic_year, term).
 *                                       cumulative_gpa plus term_gpa
 *                                       plus credit totals plus
 *                                       class rank within grade.
 *                                       Materialised by GPAWorker at
 *                                       end of each term.
 *                                       UNIQUE(student_id gpa_config_id
 *                                       academic_year_id term_id)
 *                                       — multi-column UNIQUE built
 *                                       with COALESCE sentinels on
 *                                       the nullable year and term
 *                                       columns so a NULL year and
 *                                       NULL term can coexist with
 *                                       named-year and named-term
 *                                       snapshots.
 *   sis_course_prerequisites            Per-(course, prerequisite_course)
 *                                       requirement. is_mandatory
 *                                       flags whether the prerequisite
 *                                       must be met or is merely
 *                                       recommended. min_grade is
 *                                       the minimum letter grade
 *                                       the student must have earned
 *                                       on the prerequisite course.
 *                                       UNIQUE(course_id
 *                                       prerequisite_course_id).
 *                                       CHECK course_id is not equal
 *                                       to prerequisite_course_id so
 *                                       a self-prerequisite cannot
 *                                       land.
 *   sis_grade_scale_entries             Per-school grade-to-percentage
 *                                       mapping. scale_name groups
 *                                       a school may operate two
 *                                       scales such as Standard plus
 *                                       Honors. letter_grade plus
 *                                       min_percentage plus
 *                                       max_percentage plus
 *                                       grade_points plus is_passing.
 *                                       UNIQUE(school_id scale_name
 *                                       letter_grade).
 *
 * Soft FKs to platform.schools and platform.iam_person per ADR-001
 * and ADR-020 are not enforced at the schema layer — the request-path
 * service layer validates the supplied UUIDs against the calling
 * tenant before INSERT. DB-enforced FKs to sis_students plus
 * sis_courses plus sis_academic_years plus sis_terms plus
 * sis_graduation_requirements plus sis_gpa_configurations use ON
 * DELETE CASCADE on child rows where the row carries no value
 * without its parent (audits without their requirement, snapshots
 * without their config, hours without their student, prerequisites
 * without either course).
 *
 * No semicolons inside string literals or block comments. The
 * tenant provisioner splits the migration on every semicolon
 * regardless of quoting context.
 */

CREATE TABLE IF NOT EXISTS sis_graduation_requirements (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  requirement_type         TEXT NOT NULL,
  requirement_name         TEXT NOT NULL,
  subject_area             TEXT,
  credits_required         NUMERIC(4,2),
  specific_course_id       UUID,
  hours_required           INT,
  assessment_name          TEXT,
  minimum_gpa              NUMERIC(3,2),
  applies_to_grade_levels  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  is_active                BOOLEAN NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_grad_req_type_chk CHECK (
    requirement_type IN ('CREDIT_TOTAL','SUBJECT_CREDIT','SPECIFIC_COURSE','SERVICE_HOURS','ASSESSMENT','MINIMUM_GPA')
  ),
  CONSTRAINT sis_grad_req_credits_chk CHECK (
    credits_required IS NULL OR credits_required >= 0
  ),
  CONSTRAINT sis_grad_req_hours_chk CHECK (
    hours_required IS NULL OR hours_required >= 0
  ),
  CONSTRAINT sis_grad_req_min_gpa_chk CHECK (
    minimum_gpa IS NULL OR (minimum_gpa >= 0 AND minimum_gpa <= 5)
  ),
  CONSTRAINT sis_grad_req_shape_chk CHECK (
    (requirement_type = 'CREDIT_TOTAL' AND credits_required IS NOT NULL)
    OR (requirement_type = 'SUBJECT_CREDIT' AND credits_required IS NOT NULL AND subject_area IS NOT NULL)
    OR (requirement_type = 'SPECIFIC_COURSE' AND specific_course_id IS NOT NULL)
    OR (requirement_type = 'SERVICE_HOURS' AND hours_required IS NOT NULL)
    OR (requirement_type = 'ASSESSMENT' AND assessment_name IS NOT NULL)
    OR (requirement_type = 'MINIMUM_GPA' AND minimum_gpa IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS sis_grad_req_school_active_idx
  ON sis_graduation_requirements(school_id, is_active);

CREATE INDEX IF NOT EXISTS sis_grad_req_type_idx
  ON sis_graduation_requirements(school_id, requirement_type);

COMMENT ON TABLE sis_graduation_requirements IS
  'Per-school graduation requirement catalogue. 6-value requirement_type CHECK. Multi-column shape_chk enforces the right qualifier column populated per type. applies_to_grade_levels filters which grades the requirement applies to.';

COMMENT ON COLUMN sis_graduation_requirements.specific_course_id IS
  'Soft FK to sis_courses(id) per ADR-001 and ADR-020. Required when requirement_type equals SPECIFIC_COURSE — enforced via shape_chk.';

CREATE TABLE IF NOT EXISTS sis_student_graduation_audits (
  id                       UUID PRIMARY KEY,
  student_id               UUID NOT NULL,
  requirement_id           UUID NOT NULL,
  status                   TEXT NOT NULL,
  credits_earned           NUMERIC(4,2),
  credits_remaining        NUMERIC(4,2),
  detail                   TEXT,
  last_calculated          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_grad_audit_student_fk FOREIGN KEY (student_id)
    REFERENCES sis_students(id) ON DELETE CASCADE,
  CONSTRAINT sis_grad_audit_req_fk FOREIGN KEY (requirement_id)
    REFERENCES sis_graduation_requirements(id) ON DELETE CASCADE,
  CONSTRAINT sis_grad_audit_status_chk CHECK (
    status IN ('MET','IN_PROGRESS','NOT_MET')
  ),
  CONSTRAINT sis_grad_audit_credits_chk CHECK (
    (credits_earned IS NULL OR credits_earned >= 0)
    AND (credits_remaining IS NULL OR credits_remaining >= 0)
  ),
  CONSTRAINT sis_grad_audit_unique UNIQUE (student_id, requirement_id)
);

CREATE INDEX IF NOT EXISTS sis_grad_audit_student_idx
  ON sis_student_graduation_audits(student_id, status);

CREATE INDEX IF NOT EXISTS sis_grad_audit_status_idx
  ON sis_student_graduation_audits(status, last_calculated DESC);

CREATE INDEX IF NOT EXISTS sis_grad_audit_not_met_idx
  ON sis_student_graduation_audits(student_id) WHERE status = 'NOT_MET';

COMMENT ON TABLE sis_student_graduation_audits IS
  'Materialised audit row per (student, requirement). 3-value status CHECK. Materialised nightly by GraduationAuditWorker. Emits sis.graduation.at_risk for seniors with NOT_MET requirements.';

CREATE TABLE IF NOT EXISTS sis_service_learning_requirements (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  grade_level              TEXT NOT NULL,
  required_hours           INT NOT NULL,
  deadline_type            TEXT NOT NULL,
  specific_deadline        DATE,
  is_active                BOOLEAN NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_svc_learn_req_hours_chk CHECK (required_hours > 0),
  CONSTRAINT sis_svc_learn_req_deadline_chk CHECK (
    deadline_type IN ('END_OF_YEAR','BEFORE_GRADUATION','SPECIFIC_DATE')
  ),
  CONSTRAINT sis_svc_learn_req_specific_chk CHECK (
    (deadline_type = 'SPECIFIC_DATE' AND specific_deadline IS NOT NULL)
    OR (deadline_type IN ('END_OF_YEAR','BEFORE_GRADUATION') AND specific_deadline IS NULL)
  ),
  CONSTRAINT sis_svc_learn_req_unique UNIQUE (school_id, grade_level)
);

CREATE INDEX IF NOT EXISTS sis_svc_learn_req_school_idx
  ON sis_service_learning_requirements(school_id, is_active);

COMMENT ON TABLE sis_service_learning_requirements IS
  'Per-(school, grade_level) service hours requirement. 3-value deadline_type CHECK. specific_deadline required when deadline_type equals SPECIFIC_DATE.';

CREATE TABLE IF NOT EXISTS sis_service_learning_hours (
  id                       UUID PRIMARY KEY,
  student_id               UUID NOT NULL,
  organisation_name        TEXT NOT NULL,
  activity_description     TEXT NOT NULL,
  hours                    NUMERIC(5,2) NOT NULL,
  service_date             DATE NOT NULL,
  supervisor_name          TEXT,
  supervisor_contact       TEXT,
  evidence_s3_key          TEXT,
  status                   TEXT NOT NULL DEFAULT 'PENDING',
  reviewed_by              UUID,
  reviewed_at              TIMESTAMPTZ,
  review_notes             TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_svc_learn_hours_student_fk FOREIGN KEY (student_id)
    REFERENCES sis_students(id) ON DELETE CASCADE,
  CONSTRAINT sis_svc_learn_hours_status_chk CHECK (
    status IN ('PENDING','APPROVED','REJECTED')
  ),
  CONSTRAINT sis_svc_learn_hours_amount_chk CHECK (hours > 0 AND hours <= 24),
  CONSTRAINT sis_svc_learn_hours_reviewed_chk CHECK (
    (status = 'PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (status IN ('APPROVED','REJECTED') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS sis_svc_learn_hours_student_idx
  ON sis_service_learning_hours(student_id, status);

CREATE INDEX IF NOT EXISTS sis_svc_learn_hours_pending_idx
  ON sis_service_learning_hours(status, created_at DESC) WHERE status = 'PENDING';

COMMENT ON TABLE sis_service_learning_hours IS
  'Student-submitted service hours with supervisor verification. 3-value status CHECK. Multi-column reviewed_chk lockstep keeps reviewed_by plus reviewed_at populated together for terminal statuses. hours capped at 24 per row.';

COMMENT ON COLUMN sis_service_learning_hours.reviewed_by IS
  'Soft FK to platform.iam_person(id) per ADR-001 and ADR-020. Identifies the staff member who approved or rejected the hours.';

CREATE TABLE IF NOT EXISTS sis_gpa_configurations (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  config_name              TEXT NOT NULL,
  calculation_method       TEXT NOT NULL,
  scale_type               TEXT NOT NULL,
  grade_point_mapping      JSONB NOT NULL,
  honors_weight_bonus      NUMERIC(2,1) NOT NULL DEFAULT 0.5,
  ap_weight_bonus          NUMERIC(2,1) NOT NULL DEFAULT 1.0,
  is_default               BOOLEAN NOT NULL DEFAULT false,
  is_active                BOOLEAN NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_gpa_config_method_chk CHECK (
    calculation_method IN ('UNWEIGHTED','WEIGHTED','SUBJECT_AREA')
  ),
  CONSTRAINT sis_gpa_config_scale_chk CHECK (
    scale_type IN ('FOUR_POINT','HUNDRED_POINT')
  ),
  CONSTRAINT sis_gpa_config_bonus_chk CHECK (
    honors_weight_bonus >= 0 AND ap_weight_bonus >= 0
  ),
  CONSTRAINT sis_gpa_config_unique UNIQUE (school_id, config_name)
);

CREATE UNIQUE INDEX IF NOT EXISTS sis_gpa_config_default_uq
  ON sis_gpa_configurations(school_id) WHERE is_default = true;

CREATE INDEX IF NOT EXISTS sis_gpa_config_school_idx
  ON sis_gpa_configurations(school_id, is_active);

COMMENT ON TABLE sis_gpa_configurations IS
  'Per-school GPA calculation configuration. 3-value calculation_method CHECK plus 2-value scale_type CHECK. grade_point_mapping JSONB maps letter grade to numeric point value. honors_weight_bonus plus ap_weight_bonus apply on top of the mapped point value when calculation_method equals WEIGHTED. Partial UNIQUE on is_default true so each school has at most one default config.';

CREATE TABLE IF NOT EXISTS sis_student_gpa_snapshots (
  id                       UUID PRIMARY KEY,
  student_id               UUID NOT NULL,
  gpa_config_id            UUID NOT NULL,
  academic_year_id         UUID,
  term_id                  UUID,
  cumulative_gpa           NUMERIC(4,3),
  term_gpa                 NUMERIC(4,3),
  total_credits_attempted  NUMERIC(5,2),
  total_credits_earned     NUMERIC(5,2),
  class_rank               INT,
  class_size               INT,
  calculated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_gpa_snap_student_fk FOREIGN KEY (student_id)
    REFERENCES sis_students(id) ON DELETE CASCADE,
  CONSTRAINT sis_gpa_snap_config_fk FOREIGN KEY (gpa_config_id)
    REFERENCES sis_gpa_configurations(id) ON DELETE CASCADE,
  CONSTRAINT sis_gpa_snap_credits_chk CHECK (
    (total_credits_attempted IS NULL OR total_credits_attempted >= 0)
    AND (total_credits_earned IS NULL OR total_credits_earned >= 0)
  ),
  CONSTRAINT sis_gpa_snap_rank_chk CHECK (
    (class_rank IS NULL OR class_rank > 0)
    AND (class_size IS NULL OR class_size > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS sis_gpa_snap_unique
  ON sis_student_gpa_snapshots(
    student_id,
    gpa_config_id,
    COALESCE(academic_year_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(term_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS sis_gpa_snap_student_idx
  ON sis_student_gpa_snapshots(student_id, calculated_at DESC);

CREATE INDEX IF NOT EXISTS sis_gpa_snap_term_idx
  ON sis_student_gpa_snapshots(academic_year_id, term_id);

COMMENT ON TABLE sis_student_gpa_snapshots IS
  'Materialised GPA snapshot per (student, config, academic_year, term). cumulative_gpa plus term_gpa plus credit totals plus class rank within grade. Materialised by GPAWorker at end of each term. UNIQUE built with COALESCE sentinels on nullable year and term so NULL-year NULL-term cumulative-only rows coexist with named-term snapshots.';

CREATE TABLE IF NOT EXISTS sis_course_prerequisites (
  id                       UUID PRIMARY KEY,
  course_id                UUID NOT NULL,
  prerequisite_course_id   UUID NOT NULL,
  is_mandatory             BOOLEAN NOT NULL DEFAULT true,
  min_grade                TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_course_prereq_course_fk FOREIGN KEY (course_id)
    REFERENCES sis_courses(id) ON DELETE CASCADE,
  CONSTRAINT sis_course_prereq_prereq_fk FOREIGN KEY (prerequisite_course_id)
    REFERENCES sis_courses(id) ON DELETE CASCADE,
  CONSTRAINT sis_course_prereq_not_self_chk CHECK (course_id <> prerequisite_course_id),
  CONSTRAINT sis_course_prereq_unique UNIQUE (course_id, prerequisite_course_id)
);

CREATE INDEX IF NOT EXISTS sis_course_prereq_course_idx
  ON sis_course_prerequisites(course_id);

CREATE INDEX IF NOT EXISTS sis_course_prereq_prereq_idx
  ON sis_course_prerequisites(prerequisite_course_id);

COMMENT ON TABLE sis_course_prerequisites IS
  'Per-(course, prerequisite_course) requirement. is_mandatory flags whether the prerequisite must be met or is merely recommended. min_grade is the minimum letter grade the student must have earned on the prerequisite course before enrolling. CHECK course_id is not equal to prerequisite_course_id so a self-prerequisite cannot land.';

CREATE TABLE IF NOT EXISTS sis_grade_scale_entries (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  scale_name               TEXT NOT NULL,
  letter_grade             TEXT NOT NULL,
  min_percentage           NUMERIC(5,2),
  max_percentage           NUMERIC(5,2),
  grade_points             NUMERIC(3,1),
  is_passing               BOOLEAN NOT NULL DEFAULT true,
  sort_order               INT NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_grade_scale_unique UNIQUE (school_id, scale_name, letter_grade),
  CONSTRAINT sis_grade_scale_percentage_chk CHECK (
    (min_percentage IS NULL OR (min_percentage >= 0 AND min_percentage <= 100))
    AND (max_percentage IS NULL OR (max_percentage >= 0 AND max_percentage <= 100))
    AND (
      min_percentage IS NULL
      OR max_percentage IS NULL
      OR max_percentage >= min_percentage
    )
  ),
  CONSTRAINT sis_grade_scale_points_chk CHECK (
    grade_points IS NULL OR grade_points >= 0
  )
);

CREATE INDEX IF NOT EXISTS sis_grade_scale_lookup_idx
  ON sis_grade_scale_entries(school_id, scale_name, sort_order);

COMMENT ON TABLE sis_grade_scale_entries IS
  'Per-school grade-to-percentage mapping. scale_name groups entries for a single scale — a school may operate two scales such as Standard plus Honors. letter_grade plus min_percentage plus max_percentage plus grade_points plus is_passing. UNIQUE(school_id scale_name letter_grade).';
